//! A digest of everything under a reviewed directory.
//!
//! A plan records it and an action compares it again immediately before the
//! directory is moved or removed, so an entry added, removed, renamed, or
//! rewritten below it since review stops the item.

use crate::guard::Refusal;
use crate::sys::{self, EntryKind};
use sha2::{Digest, Sha256};
use std::os::unix::io::RawFd;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Subtree {
    pub entries: u64,
    pub digest: [u8; 32],
}

impl Subtree {
    pub fn hex(&self) -> String {
        crate::content::hex(&self.digest)
    }

    pub fn from_hex(entries: u64, text: &str) -> Option<Subtree> {
        if text.len() != 64 {
            return None;
        }
        let mut digest = [0u8; 32];
        for (index, pair) in text.as_bytes().chunks(2).enumerate() {
            let pair = std::str::from_utf8(pair).ok()?;
            if pair.chars().any(|c| c.is_ascii_uppercase()) {
                return None;
            }
            digest[index] = u8::from_str_radix(pair, 16).ok()?;
        }
        Some(Subtree { entries, digest })
    }
}

pub fn digest(parent: RawFd, name: &[u8], cancelled: &AtomicBool) -> Result<Subtree, Refusal> {
    let root = sys::open_child_directory(parent, name, false).map_err(|error| refusal(&error))?;
    let mut hasher = Sha256::new();
    let mut entries = 0u64;
    let mut relative = Vec::new();
    walk(root, &mut relative, &mut hasher, &mut entries, cancelled)?;
    Ok(Subtree {
        entries,
        digest: hasher.finalize().into(),
    })
}

fn walk(
    descriptor: RawFd,
    relative: &mut Vec<u8>,
    hasher: &mut Sha256,
    entries: &mut u64,
    cancelled: &AtomicBool,
) -> Result<(), Refusal> {
    if cancelled.load(Ordering::Relaxed) {
        sys::close(descriptor);
        return Err(Refusal::new(
            "cancelled",
            "Stopped before the directory's contents were all read.",
        ));
    }
    let mut stream =
        sys::Directory::from_descriptor(descriptor).map_err(|error| refusal(&error))?;
    let mut names = Vec::new();
    while let Some(name) = stream.next_name().map_err(|error| refusal(&error))? {
        names.push(name);
    }
    names.sort();
    let directory = stream.descriptor();
    for name in names {
        let metadata = sys::metadata_at(directory, &name).map_err(|error| refusal(&error))?;
        let length = relative.len();
        if length > 0 {
            relative.push(b'/');
        }
        relative.extend_from_slice(&name);
        hasher.update((relative.len() as u32).to_be_bytes());
        hasher.update(&relative);
        hasher.update([kind_byte(metadata.kind)]);
        hasher.update(metadata.inode.to_be_bytes());
        hasher.update(metadata.apparent_bytes.to_be_bytes());
        hasher.update(metadata.modified_nanoseconds.to_be_bytes());
        *entries += 1;
        if metadata.kind == EntryKind::Directory {
            let child = sys::open_child_directory(directory, &name, false)
                .map_err(|error| refusal(&error))?;
            walk(child, relative, hasher, entries, cancelled)?;
        }
        relative.truncate(length);
    }
    Ok(())
}

fn kind_byte(kind: EntryKind) -> u8 {
    match kind {
        EntryKind::File => 1,
        EntryKind::Directory => 2,
        EntryKind::Symlink => 3,
        EntryKind::Other => 4,
    }
}

fn refusal(error: &std::io::Error) -> Refusal {
    match error.raw_os_error() {
        Some(libc::EXDEV) => Refusal::new(
            "protected-path",
            "Another filesystem is mounted inside this directory.",
        ),
        Some(libc::EACCES) | Some(libc::EPERM) => Refusal::new(
            "permission-denied",
            format!("Part of this directory could not be read: {error}"),
        ),
        Some(libc::ENOENT) | Some(libc::ELOOP) | Some(libc::ENOTDIR) => Refusal::new(
            "changed-target",
            format!("The directory changed while it was being read: {error}"),
        ),
        _ => Refusal::new(
            "internal-error",
            format!("The directory could not be read: {error}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;

    fn read(sandbox: &Sandbox) -> Result<Subtree, Refusal> {
        let parent = sys::open_root(&sandbox.bytes()).unwrap();
        let outcome = digest(parent, b"tree", &AtomicBool::new(false));
        sys::close(parent);
        outcome
    }

    fn tree(label: &str) -> Sandbox {
        let sandbox = Sandbox::new(label);
        sandbox.directory(b"tree/inner");
        sandbox.file(b"tree/a.bin", 64);
        sandbox.file(b"tree/inner/b.bin", 128);
        sandbox.symlink(b"/etc/passwd", b"tree/link");
        sandbox
    }

    #[test]
    fn the_same_tree_digests_the_same_twice() {
        let sandbox = tree("subtree-stable");
        let first = read(&sandbox).unwrap();
        assert_eq!(first, read(&sandbox).unwrap());
        assert_eq!(first.entries, 4);
    }

    #[test]
    fn an_added_file_changes_the_digest() {
        let sandbox = tree("subtree-added");
        let before = read(&sandbox).unwrap();
        sandbox.file(b"tree/inner/new.bin", 1);
        assert_ne!(before, read(&sandbox).unwrap());
    }

    #[test]
    fn a_renamed_file_changes_the_digest() {
        let sandbox = tree("subtree-renamed");
        let before = read(&sandbox).unwrap();
        std::fs::rename(
            sandbox.path().join("tree/a.bin"),
            sandbox.path().join("tree/c.bin"),
        )
        .unwrap();
        assert_ne!(before, read(&sandbox).unwrap());
    }

    #[test]
    fn a_file_rewritten_to_the_same_length_changes_the_digest() {
        let sandbox = tree("subtree-rewritten");
        let before = read(&sandbox).unwrap();
        let path = sandbox.path().join("tree/inner/b.bin");
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, vec![b'y'; 128]).unwrap();
        assert_ne!(before, read(&sandbox).unwrap());
    }

    #[test]
    fn a_file_replaced_by_a_symlink_changes_the_digest() {
        let sandbox = tree("subtree-symlinked");
        let before = read(&sandbox).unwrap();
        std::fs::remove_file(sandbox.path().join("tree/a.bin")).unwrap();
        sandbox.symlink(b"/tmp", b"tree/a.bin");
        assert_ne!(before, read(&sandbox).unwrap());
    }

    #[test]
    fn an_unreadable_directory_inside_is_a_refusal() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let sandbox = tree("subtree-unreadable");
        sandbox.chmod(b"tree/inner", 0o000);
        let refusal = read(&sandbox).expect_err("a tree nobody can read is not reviewed");
        sandbox.chmod(b"tree/inner", 0o700);
        assert_eq!(refusal.code, "permission-denied");
    }

    #[test]
    fn a_cancelled_digest_stops() {
        let sandbox = tree("subtree-cancelled");
        let parent = sys::open_root(&sandbox.bytes()).unwrap();
        let outcome = digest(parent, b"tree", &AtomicBool::new(true));
        sys::close(parent);
        assert_eq!(outcome.expect_err("cancelled").code, "cancelled");
    }
}
