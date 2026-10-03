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

/// How many directories deep below a reviewed one any action will go.
///
/// The same ceiling as the scan's walk, so a tree the index holds completely
/// is a tree an action can review, copy, archive, and remove, and anything
/// deeper is refused when it is planned rather than halfway through an action.
/// Every walk over a tree keeps its directories on an explicit stack, one open
/// descriptor per level, so this bounds descriptors and memory; the call stack
/// does not grow with the tree at all.
pub const MAX_DEPTH: usize = 512;

/// What every tree walk says when it refuses past `MAX_DEPTH`.
pub const TOO_DEEP: &str = "It is nested more than 512 levels deep, deeper than Disktop will \
     review, copy, archive, or remove in one action, so it was left as it is.";

/// The error a tree walk returns past `MAX_DEPTH`, recognisable by type so a
/// caller can say what happened rather than calling it an internal failure.
#[derive(Debug)]
pub struct TooDeep;

impl std::fmt::Display for TooDeep {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(TOO_DEEP)
    }
}

impl std::error::Error for TooDeep {}

pub fn too_deep() -> std::io::Error {
    std::io::Error::other(TooDeep)
}

pub fn is_too_deep(error: &std::io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<TooDeep>())
}

pub fn digest(parent: RawFd, name: &[u8], cancelled: &AtomicBool) -> Result<Subtree, Refusal> {
    let root = sys::open_child_directory(parent, name, false).map_err(|error| refusal(&error))?;
    let mut hasher = Sha256::new();
    let mut entries = 0u64;
    // The path of the entry being digested, relative to the reviewed
    // directory. Each frame remembers where its own directory's path ends.
    let mut relative = Vec::new();
    let mut stack = vec![Frame::enter(root, 0, cancelled)?];

    while let Some(frame) = stack.last_mut() {
        let Some(name) = frame.names.pop() else {
            stack.pop();
            continue;
        };
        let directory = frame.directory.descriptor();
        let base = frame.base;
        let metadata = sys::metadata_at(directory, &name).map_err(|error| refusal(&error))?;

        relative.truncate(base);
        if base > 0 {
            relative.push(b'/');
        }
        relative.extend_from_slice(&name);
        hasher.update((relative.len() as u32).to_be_bytes());
        hasher.update(&relative);
        hasher.update([kind_byte(metadata.kind)]);
        hasher.update(metadata.inode.to_be_bytes());
        hasher.update(metadata.apparent_bytes.to_be_bytes());
        hasher.update(metadata.modified_nanoseconds.to_be_bytes());
        entries += 1;

        if metadata.kind == EntryKind::Directory {
            // The frames on the stack are this directory's ancestors, so how
            // many there are is how deep it is.
            if stack.len() > MAX_DEPTH {
                return Err(Refusal::new("invalid-arguments", TOO_DEEP));
            }
            let child = sys::open_child_directory(directory, &name, false)
                .map_err(|error| refusal(&error))?;
            stack.push(Frame::enter(child, relative.len(), cancelled)?);
        }
    }

    Ok(Subtree {
        entries,
        digest: hasher.finalize().into(),
    })
}

/// One directory being read: its stream, the names it has left in reverse
/// byte order so the next one is a `pop`, and where its own path ends.
struct Frame {
    directory: sys::Directory,
    names: Vec<Vec<u8>>,
    base: usize,
}

impl Frame {
    /// Takes ownership of `descriptor` whatever it returns.
    fn enter(descriptor: RawFd, base: usize, cancelled: &AtomicBool) -> Result<Frame, Refusal> {
        if cancelled.load(Ordering::Relaxed) {
            sys::close(descriptor);
            return Err(Refusal::new(
                "cancelled",
                "Stopped before the directory's contents were all read.",
            ));
        }
        let mut directory =
            sys::Directory::from_descriptor(descriptor).map_err(|error| refusal(&error))?;
        let mut names = Vec::new();
        while let Some(name) = directory.next_name().map_err(|error| refusal(&error))? {
            names.push(name);
        }
        // Byte order, so the digest does not depend on the order a filesystem
        // happens to return names in.
        names.sort();
        names.reverse();
        Ok(Frame {
            directory,
            names,
            base,
        })
    }
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

    /// Digest `tree` on a thread with the stack a helper worker gets, so a walk
    /// that recursed once per level would overflow here exactly as it would in
    /// the helper — where it takes the whole process down mid-action.
    fn read_on_a_worker(sandbox: &Sandbox) -> Result<Subtree, Refusal> {
        let root = sandbox.bytes();
        std::thread::Builder::new()
            .spawn(move || {
                let parent = sys::open_root(&root).unwrap();
                let outcome = digest(parent, b"tree", &AtomicBool::new(false));
                sys::close(parent);
                outcome
            })
            .unwrap()
            .join()
            .expect("the digest returned rather than crashing")
    }

    #[test]
    fn a_tree_ten_thousand_levels_deep_is_refused_rather_than_crashing_the_helper() {
        crate::testing::raise_descriptor_limit();
        let sandbox = Sandbox::new("subtree-very-deep");
        sandbox.deep_directory(b"tree", 10_000);
        let refusal = read_on_a_worker(&sandbox).expect_err("too deep to review");
        assert_eq!(refusal.code, "invalid-arguments");
        assert!(
            refusal.message.contains("levels deep"),
            "{}",
            refusal.message
        );
    }

    #[test]
    fn a_tree_exactly_as_deep_as_the_limit_is_reviewed() {
        crate::testing::raise_descriptor_limit();
        let sandbox = Sandbox::new("subtree-at-limit");
        sandbox.deep_directory(b"tree", MAX_DEPTH);
        let reviewed = read_on_a_worker(&sandbox).expect("a tree at the limit reads");
        assert_eq!(
            reviewed.entries,
            MAX_DEPTH as u64 + 1,
            "every level and the file"
        );

        let deeper = Sandbox::new("subtree-past-limit");
        deeper.deep_directory(b"tree", MAX_DEPTH + 1);
        assert_eq!(
            read_on_a_worker(&deeper).expect_err("one level more").code,
            "invalid-arguments"
        );
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
