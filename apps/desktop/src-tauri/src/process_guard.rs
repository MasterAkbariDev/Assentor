use std::{
    env, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tokio::process::{Child, Command as AsyncCommand};

pub const WORKER_ARG: &str = "--engine-worker";

pub fn executable() -> io::Result<PathBuf> {
    Ok(env::current_exe()?.with_file_name(format!("assentor-engine{}", env::consts::EXE_SUFFIX)))
}

pub struct GuardedChild {
    pub child: Child,
    #[cfg(windows)]
    _job: windows::Job,
}

impl GuardedChild {
    pub fn start(project: &Path, resources: &Path, resolve_login: bool) -> io::Result<Self> {
        let mut command = AsyncCommand::new(env::current_exe()?);
        command
            .arg(WORKER_ARG)
            .arg(std::process::id().to_string())
            .arg(if resolve_login { "login" } else { "inherited" })
            .arg(project)
            .arg(resources)
            .current_dir(project)
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if resolve_login {
                Stdio::null()
            } else {
                Stdio::inherit()
            });
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
            command.kill_on_drop(true);
            let job = windows::Job::new()?;
            let child = command.spawn()?;
            job.assign(&child)?;
            Ok(Self { child, _job: job })
        }
        #[cfg(unix)]
        {
            // Its pipe is also the liveness signal. Keep the watchdog alive when its owner dies.
            Ok(Self {
                child: command.spawn()?,
            })
        }
    }
}

pub fn run_worker() -> io::Result<()> {
    use std::io::{Read, Write};

    let mut input = io::stdin().lock();
    let mut start = [0];
    input.read_exact(&mut start)?;
    if start != [1] {
        return Err(io::Error::other("invalid desktop worker start"));
    }

    let mut command = Command::new(executable()?);
    command
        .args(env::args_os().skip(4))
        .env("ASSENTOR_DESKTOP_HOST", env::current_exe()?)
        .stderr(Stdio::null());
    if env::args_os().nth(3).as_deref() == Some(std::ffi::OsStr::new("login")) {
        if let Some(path) = crate::login_path::resolved_path() {
            command.env("PATH", path);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        // Wait for the ready marker before writing additional bytes to the shared stdin handle.
        writeln!(io::stdout().lock(), "ready")?;
        io::stdout().flush()?;
        drop(input);
        let status = command.status()?;
        if !status.success() {
            return Err(io::Error::other(format!("engine exited with {status}")));
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        use std::{os::unix::process::CommandExt, sync::mpsc, thread, time::Duration};
        let owner = env::args()
            .nth(2)
            .and_then(|value| value.parse::<libc::pid_t>().ok())
            .ok_or_else(|| io::Error::other("missing desktop worker owner"))?;
        if unsafe { libc::getppid() } != owner {
            return Ok(());
        }
        let mut child = command.process_group(0).stdin(Stdio::piped()).spawn()?;
        let group = child.id() as libc::pid_t;
        drop(input);
        let mut output = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("missing engine input"))?;
        let (closed, forwarding) = mpsc::channel();
        thread::spawn(move || {
            let result = io::copy(&mut io::stdin().lock(), &mut output);
            drop(output);
            let _ = closed.send(result);
        });
        let announced = writeln!(io::stdout().lock(), "ready").and_then(|_| io::stdout().flush());
        if announced.is_ok() {
            while unsafe { libc::getppid() } == owner {
                if !matches!(
                    forwarding.recv_timeout(Duration::from_millis(100)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    break;
                }
            }
        }
        // EOF lets the engine flush its event log. Keep the PID unreaped until
        // the group is signalled so the ID cannot refer to an unrelated process.
        thread::sleep(Duration::from_secs(4));
        if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
            let error = io::Error::last_os_error();
            // Darwin can report EPERM when only the already-exited group
            // leader remains. Confirm it exited before accepting that case.
            let finished = cfg!(target_os = "macos")
                && error.raw_os_error() == Some(libc::EPERM)
                && child.try_wait()?.is_some();
            if error.raw_os_error() != Some(libc::ESRCH) && !finished {
                return Err(error);
            }
        }
        child.wait()?;
        announced
    }
}

#[cfg(windows)]
mod windows {
    use std::{io, mem::size_of, ptr::null};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct Job(HANDLE);

    // A Windows kernel handle can be closed from any thread. Each Job owns its handle.
    unsafe impl Send for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Job {
        pub fn new() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(null(), null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub fn assign(&self, child: &tokio::process::Child) -> io::Result<()> {
            let handle = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("missing process handle"))?;
            if unsafe { AssignProcessToJobObject(self.0, handle.cast()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }
}
