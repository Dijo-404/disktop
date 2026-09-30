//! Throwaway trees for the helper's own tests.
//!
//! A sandbox is always a fresh directory directly under the system temporary
//! directory, named with this process's ID, and it is the only thing its
//! cleanup will remove. Nothing here is compiled into a release binary.

use std::ffi::{CString, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

pub struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    pub fn new(label: &str) -> Sandbox {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "disktop-helper-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&root).expect("a fresh sandbox directory");
        Sandbox { root }
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.root.as_os_str().as_bytes().to_vec()
    }

    fn resolve(&self, relative: &[u8]) -> PathBuf {
        self.root.join(OsStr::from_bytes(relative))
    }

    pub fn directory(&self, relative: &[u8]) -> PathBuf {
        let path = self.resolve(relative);
        std::fs::create_dir_all(&path).expect("a sandbox directory");
        path
    }

    pub fn file(&self, relative: &[u8], size: usize) -> PathBuf {
        let path = self.resolve(relative);
        std::fs::write(&path, vec![b'x'; size]).expect("a sandbox file");
        path
    }

    pub fn hardlink(&self, existing: &[u8], link: &[u8]) {
        std::fs::hard_link(self.resolve(existing), self.resolve(link)).expect("a sandbox hardlink");
    }

    pub fn symlink(&self, target: &[u8], link: &[u8]) {
        std::os::unix::fs::symlink(OsStr::from_bytes(target), self.resolve(link))
            .expect("a sandbox symlink");
    }

    pub fn chmod(&self, relative: &[u8], mode: u32) {
        let path = CString::new(self.resolve(relative).as_os_str().as_bytes())
            .expect("a sandbox path without a NUL byte");
        let result = unsafe { libc::chmod(path.as_ptr(), mode as libc::mode_t) };
        assert_eq!(result, 0, "chmod failed in the sandbox");
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // Make a deliberately unreadable fixture removable again; 0o000 defeats
        // a recursive delete just as it defeats the scanner.
        if let Ok(entries) = std::fs::read_dir(&self.root) {
            for entry in entries.flatten() {
                let _ = std::fs::set_permissions(
                    entry.path(),
                    std::os::unix::fs::PermissionsExt::from_mode(0o700),
                );
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
