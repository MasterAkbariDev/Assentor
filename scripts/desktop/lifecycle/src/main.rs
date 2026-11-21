use std::{
    env,
    error::Error,
    ffi::OsString,
    io::{self, Read, Write},
    process::{Child, Command, Stdio},
    thread,
};

#[cfg(unix)]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;

fn launch_fixture(args: &[OsString]) -> Result<Child, Box<dyn Error>> {
    let (node, rest) = args.split_first().ok_or("expected Node executable")?;
    let mut command = Command::new(node);
    command
        .args(rest)
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    Ok(command.spawn()?)
}

fn start_fixture(child: &mut Child) -> Result<(), Box<dyn Error>> {
    // The launcher only starts descendants after the platform guard exists.
    child
        .stdin
        .take()
        .ok_or("missing fixture pipe")?
        .write_all(b"1")?;
    Ok(())
}

fn exit_if_supervisor_leaves() {
    thread::spawn(|| {
        let _ = io::stdin().read(&mut [0]);
        std::process::exit(2);
    });
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    platform::run(&args)
}
