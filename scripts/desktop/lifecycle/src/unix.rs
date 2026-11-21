use std::{
    env,
    error::Error,
    ffi::{OsStr, OsString},
    io::{self, Read},
    os::unix::process::CommandExt,
    process::{Command, Stdio},
};

use crate::{exit_if_supervisor_leaves, launch_fixture, start_fixture};

const WATCH: &str = "--watch-owner";

pub(super) fn run(args: &[OsString]) -> Result<(), Box<dyn Error>> {
    if let Some((first, rest)) = args.split_first() {
        if first == OsStr::new(WATCH) {
            return watch_owner(rest);
        }
    }
    exit_if_supervisor_leaves();
    let mut watchdog = Command::new(env::current_exe()?)
        .arg(WATCH)
        .args(args)
        .stdin(Stdio::piped())
        .process_group(0)
        .spawn()?;
    // Child::wait closes its own stdin handle, so keep the writer separately.
    let _keepalive = watchdog.stdin.take().ok_or("missing watchdog pipe")?;
    let status = watchdog.wait()?;
    Err(format!("Watchdog exited while its owner was alive: {status}").into())
}

fn watch_owner(args: &[OsString]) -> Result<(), Box<dyn Error>> {
    let mut child = launch_fixture(args)?;
    let group = child.id() as libc::pid_t;
    let result = start_fixture(&mut child).and_then(|()| {
        io::copy(&mut io::stdin().lock().take(1), &mut io::sink())?;
        Ok(())
    });
    // The worker is still unreaped, so its PID cannot be reused for another group.
    if unsafe { libc::kill(-group, libc::SIGKILL) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error.into());
        }
    }
    child.wait()?;
    result
}
