//! What differs between operating systems, in one place: canonical paths,
//! paths as the page and git's own files write them, running programs
//! without a console window, and opening files and web pages with the
//! system's applications.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where removed files go, as the user knows it.
pub const TRASH: &str = if cfg!(windows) { "Recycle Bin" } else { "Trash" };

/// `path` made absolute, with symbolic links resolved. On Windows,
/// `std::fs::canonicalize` returns "verbatim" paths (`\\?\C:\…`), which git
/// can't use (it reads `\\?\` as a network host); this returns `C:\…` instead.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// `path` with `/` between folders on every system, as git writes paths: for
/// the page, which compares them with git's (`rev-parse --show-toplevel`
/// prints `C:/…` on Windows), and for git's own files (`gitdir:`, `core.worktree`).
pub fn slash_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

/// A command for `program`. On Windows, a program run from the app (which
/// has no console of its own in a release build) would otherwise open a
/// console window, flashing up for every git command.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Why `open` failed.
pub enum OpenError {
    /// Windows has no application for this kind of file.
    NoApplication,
    Failed(String),
}

/// Opens `target`, a file or a web address, with the system's default application.
///
/// On Windows this asks the shell directly (`ShellExecuteEx`). Not through
/// `cmd /C start`: cmd would treat characters in the name such as `&` and
/// `%` as its own, so opening a file named `x&calc` would run `calc`.
pub fn open(target: &OsStr) -> Result<(), OpenError> {
    #[cfg(windows)]
    {
        windows_shell::open(target)
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(program).arg(target).spawn().map(|_| ()).map_err(|e| OpenError::Failed(e.to_string()))
    }
}

/// Windows' "Open with" dialog for `file`, to choose the application. Returns
/// once the user has chosen (or cancelled).
#[cfg(windows)]
pub fn open_with_dialog(file: &Path) -> Result<(), String> {
    windows_shell::open_with_dialog(file)
}

#[cfg(windows)]
mod windows_shell {
    use super::OpenError;
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::UI::Shell::{
        SHOpenWithDialog, ShellExecuteExW, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT, OPENASINFO, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC,
        SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    const ERROR_NO_ASSOCIATION: i32 = 1155;
    /// HRESULT_FROM_WIN32(ERROR_CANCELLED): the user closed the dialog.
    const CANCELLED: i32 = 0x8007_04C7_u32 as i32;

    /// NUL-terminated UTF-16, for the shell's functions.
    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }

    /// Runs `f` on a thread of its own with COM set up, as the shell's
    /// functions require (they may hand the work to COM components).
    fn on_com_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
        std::thread::spawn(move || {
            let init = unsafe { CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
            let out = f();
            if init >= 0 {
                unsafe { CoUninitialize() };
            }
            out
        })
        .join()
        .map_err(|_| "the Windows shell stopped unexpectedly".to_string())
    }

    pub fn open(target: &OsStr) -> Result<(), OpenError> {
        let target: OsString = target.to_owned();
        on_com_thread(move || {
            let file = wide(&target);
            let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            // NOASYNC: this thread ends straight afterwards. FLAG_NO_UI: a failure comes back here, not in a message box.
            info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
            info.lpFile = file.as_ptr();
            info.nShow = SW_SHOWNORMAL;
            if unsafe { ShellExecuteExW(&mut info) } != 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            Err(if error.raw_os_error() == Some(ERROR_NO_ASSOCIATION) { OpenError::NoApplication } else { OpenError::Failed(error.to_string()) })
        })
        .map_err(OpenError::Failed)?
    }

    pub fn open_with_dialog(file: &Path) -> Result<(), String> {
        let file: OsString = file.as_os_str().to_owned();
        let result = on_com_thread(move || {
            let name = wide(&file);
            let info = OPENASINFO { pcszFile: name.as_ptr(), pcszClass: std::ptr::null(), oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC };
            unsafe { SHOpenWithDialog(std::ptr::null_mut(), &info) }
        })?;
        if result >= 0 || result == CANCELLED {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(result & 0xFFFF).to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_paths_are_ones_git_can_use() {
        let dir = std::env::temp_dir();
        let real = canonical(&dir).unwrap();
        assert!(!real.to_string_lossy().starts_with(r"\\?\"), "{}", real.display());
        let out = command("git").arg("-C").arg(&real).args(["rev-parse", "--git-dir"]).output().unwrap();
        // Not a repository is fine; what matters is that git could find the folder.
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success() || err.contains("not a git repository"), "{err}");
    }

    #[test]
    fn slash_paths() {
        assert_eq!(slash_path(Path::new("a/b")), "a/b");
        if cfg!(windows) {
            assert_eq!(slash_path(Path::new(r"C:\Users\me\repo")), "C:/Users/me/repo");
            assert_eq!(slash_path(&Path::new(r"C:\ws").join("group").join("app")), "C:/ws/group/app");
        }
    }
}
