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

    /// A chain of `levels` directories called `d` below `relative`, with one
    /// file at the bottom.
    ///
    /// Built one level at a time from the descriptor above, because a path to
    /// the bottom of a deep enough chain is longer than `PATH_MAX` and no
    /// path-based call can reach it.
    pub fn deep_directory(&self, relative: &[u8], levels: usize) {
        let top = self.directory(relative);
        let mut descriptor = crate::sys::open_root(top.as_os_str().as_bytes()).expect("the top");
        for _ in 0..levels {
            crate::sys::mkdirat(descriptor, b"d", 0o700).expect("one more level");
            let next = crate::sys::open_child_directory(descriptor, b"d", false)
                .expect("the level just made");
            crate::sys::close(descriptor);
            descriptor = next;
        }
        let file = crate::sys::openat_create_exclusive(descriptor, b"bottom", 0o600)
            .expect("the file at the bottom");
        crate::sys::close(file);
        crate::sys::close(descriptor);
    }
}

/// What the helper does at startup, for a test process that did not.
pub fn raise_descriptor_limit() {
    crate::sys::raise_descriptor_limit();
}

/// Remove a sandbox without recursion, so a fixture deeper than any stack
/// can still be cleaned up after the test that built it.
///
/// One directory is held open per level, which is why the descriptor limit is
/// raised first. Every directory is made searchable before it is entered: a
/// deliberately unreadable fixture would otherwise defeat the cleanup just as
/// it defeats the scanner.
fn remove_without_recursion(root: &Path) {
    raise_descriptor_limit();
    struct Frame {
        directory: crate::sys::Directory,
        names: Vec<Vec<u8>>,
        entered_as: Option<Vec<u8>>,
    }
    // Every name is read before any is removed: what `readdir` returns once
    // entries have been unlinked under it is unspecified.
    let open = |descriptor, entered_as| -> Option<Frame> {
        let mut directory = crate::sys::Directory::from_descriptor(descriptor).ok()?;
        let mut names = Vec::new();
        while let Ok(Some(name)) = directory.next_name() {
            names.push(name);
        }
        Some(Frame {
            directory,
            names,
            entered_as,
        })
    };

    let Some(top) = crate::sys::open_root(root.as_os_str().as_bytes())
        .ok()
        .and_then(|descriptor| open(descriptor, None))
    else {
        return;
    };
    let mut stack = vec![top];
    while let Some(frame) = stack.last_mut() {
        let parent = frame.directory.descriptor();
        let Some(name) = frame.names.pop() else {
            let finished = stack.pop().expect("the frame just read");
            let entered_as = finished.entered_as.clone();
            drop(finished);
            if let (Some(name), Some(above)) = (entered_as, stack.last()) {
                let _ = crate::sys::unlinkat(above.directory.descriptor(), &name, true);
            }
            continue;
        };
        let Ok(metadata) = crate::sys::metadata_at(parent, &name) else {
            continue;
        };
        if metadata.kind != crate::sys::EntryKind::Directory {
            let _ = crate::sys::unlinkat(parent, &name, false);
            continue;
        }
        if let Ok(child) = CString::new(name.clone()) {
            unsafe { libc::fchmodat(parent, child.as_ptr(), 0o700, 0) };
        }
        if let Some(child) = crate::sys::open_child_directory(parent, &name, true)
            .ok()
            .and_then(|descriptor| open(descriptor, Some(name)))
        {
            stack.push(child);
        }
    }
    let _ = std::fs::remove_dir(root);
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        remove_without_recursion(&self.root);
    }
}
