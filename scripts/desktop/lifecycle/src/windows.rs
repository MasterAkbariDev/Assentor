use std::{error::Error, ffi::OsString, io, mem::size_of, os::windows::io::AsRawHandle, ptr::null};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

use crate::{exit_if_supervisor_leaves, launch_fixture, start_fixture};

struct Job(HANDLE);

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn kill_on_close_job() -> io::Result<Job> {
    // No name and no inheritable handle. Only the owner can keep the job alive.
    let handle = unsafe { CreateJobObjectW(null(), null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = Job(handle);
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

pub(super) fn run(args: &[OsString]) -> Result<(), Box<dyn Error>> {
    exit_if_supervisor_leaves();
    let job = kill_on_close_job()?;
    let mut child = launch_fixture(args)?;
    let assigned = unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle().cast()) };
    if assigned == 0 {
        let error = io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }
    start_fixture(&mut child)?;
    let status = child.wait()?;
    Err(format!("Fixture exited while its owner was alive: {status}").into())
}
