use std::{env, ffi::OsString};

#[cfg(windows)]
pub fn resolved_path() -> Option<OsString> {
    env::var_os("PATH")
}

#[cfg(unix)]
pub fn resolved_path() -> Option<OsString> {
    use std::sync::OnceLock;
    static RESOLVED: OnceLock<Option<OsString>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let inherited = env::var_os("PATH");
            login_output()
                .and_then(|output| merge(inherited.as_deref(), &output))
                .or(inherited)
        })
        .clone()
}

#[cfg(unix)]
fn merge(inherited: Option<&std::ffi::OsStr>, output: &str) -> Option<OsString> {
    use std::{collections::HashSet, ffi::OsStr};
    // The marker distinguishes the actual PATH from profile startup messages.
    let line = output
        .lines()
        .rfind(|line| line.starts_with("ASSENTOR_PATH="))?;
    let login = OsStr::new(line.strip_prefix("ASSENTOR_PATH=")?);
    let mut seen = HashSet::new();
    env::join_paths(
        inherited
            .into_iter()
            .flat_map(env::split_paths)
            .chain(env::split_paths(login))
            .filter(|entry| entry.is_absolute() && seen.insert(entry.clone())),
    )
    .ok()
}

#[cfg(unix)]
fn login_output() -> Option<String> {
    use std::{path::Path, time::Duration};
    let shell = env::var_os("SHELL")?;
    run_login_shell(Path::new(&shell), Duration::from_secs(3))
}

#[cfg(unix)]
fn run_login_shell(shell: &std::path::Path, timeout: std::time::Duration) -> Option<String> {
    use std::{
        io::Read,
        os::unix::process::CommandExt,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    if !shell.is_absolute() {
        return None;
    }
    let mut child = Command::new(shell)
        .args(["-ilc", "printf 'ASSENTOR_PATH=%s\\n' \"$PATH\""])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let read = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(65537).read_to_end(&mut bytes).ok()?;
        (bytes.len() <= 65536)
            .then(|| String::from_utf8(bytes).ok())
            .flatten()
    });
    let deadline = Instant::now() + timeout;
    // Wait for the pipe to drain first, so a profile leaving a background
    // child with an open pipe cannot make this resolver hang indefinitely.
    while Instant::now() < deadline {
        if read.is_finished() {
            if let Some(status) = child.try_wait().ok()? {
                return if status.success() {
                    read.join().ok().flatten()
                } else {
                    None
                };
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    // The leader hasn't been reaped, so the group ID is still ours.
    unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    let _ = child.wait();
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::{merge, run_login_shell};
    use std::{
        env,
        ffi::OsStr,
        fs,
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };

    #[test]
    fn fake_login_shells_report_paths_or_fall_back_after_failure() {
        let directory =
            env::temp_dir().join(format!("assentor-shell-fixture-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let shell = directory.join("shell");
        let run = |contents: &str, timeout| {
            fs::write(&shell, contents).unwrap();
            fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
            run_login_shell(&shell, timeout)
        };
        let output = run(
            "#!/bin/sh\nprintf 'profile started\\nASSENTOR_PATH=/opt/homebrew/bin:relative\\n'",
            Duration::from_secs(1),
        );
        let failed = run("#!/bin/sh\nexit 9", Duration::from_secs(1));
        let started = Instant::now();
        let timed_out = run(
            "#!/bin/sh\n/bin/sleep 10 &\nexit 0",
            Duration::from_millis(120),
        );
        let elapsed = started.elapsed();
        fs::remove_file(shell).unwrap();
        fs::remove_dir(directory).unwrap();

        assert_eq!(merge(None, &output.unwrap()).unwrap(), "/opt/homebrew/bin");
        assert!(failed.is_none());
        assert!(timed_out.is_none());
        assert!(elapsed < Duration::from_secs(2));
    }

    #[test]
    fn ignores_profile_noise_duplicates_and_relative_paths() {
        assert_eq!(
            merge(
                Some(OsStr::new("/usr/bin:/bin")),
                "greeting\nASSENTOR_PATH=.:/opt/bin:/bin\ntrailing noise"
            )
            .unwrap(),
            OsStr::new("/usr/bin:/bin:/opt/bin"),
        );
        assert!(merge(None, "profile did not report a path").is_none());
    }
}
