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
    use std::{
        io::Read,
        os::unix::process::CommandExt,
        path::PathBuf,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    let shell = PathBuf::from(env::var_os("SHELL")?);
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
    let deadline = Instant::now() + Duration::from_secs(3);
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
    use super::merge;
    use std::ffi::OsStr;

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
