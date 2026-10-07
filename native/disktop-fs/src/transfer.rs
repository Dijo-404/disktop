//! Copying a file or a tree onto another filesystem.
//!
//! Everything here writes under a staging name and never under the name the
//! plan reviewed. The publish is a separate, atomic step the caller takes once
//! the copy has been verified, so a destination that already exists, a crash
//! halfway through, or a failed read all leave the same thing behind: the
//! source where it was, and a staged file that the caller removes.
//!
//! Nothing here follows a symlink. A link inside a tree is copied as the link
//! object it is, with exactly the bytes it held, so a tree full of links to
//! somewhere else arrives as a tree full of links to somewhere else rather than
//! as copies of whatever they happened to point at. Descending is `openat2`
//! with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV`, so a nested
//! mount inside the source stops the copy instead of silently pulling another
//! filesystem across.

use crate::content;
use crate::directory_names::{Names, Store};
use crate::sys::{self, EntryKind};
use sha2::{Digest, Sha256};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::io::RawFd;
use std::sync::atomic::{AtomicBool, Ordering};

/// Bytes per read while streaming. The same order as the index's batch size:
/// large enough that the syscall cost disappears, small enough to stay out of
/// the way of everything else on the machine.
const COPY_BYTES: usize = 256 * 1024;

/// What a copy or an archive stops with when its action is cancelled,
/// recognisable by type so the item can be reported as stopped rather than
/// failed. Nothing has been published when it is returned, and whatever was
/// staged is the caller's to take back.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the action was cancelled while this was being written")
    }
}

impl std::error::Error for Cancelled {}

pub fn is_cancelled(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<Cancelled>())
}

/// Stop here if somebody cancelled. Asked between chunks and between
/// entries, so a copy of something large stops promptly rather than only once
/// it has finished.
pub fn check(cancelled: &AtomicBool) -> io::Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(io::Error::other(Cancelled));
    }
    Ok(())
}

pub struct Copied {
    /// Files written, not counting directories or links.
    pub files: u64,
    pub bytes: u64,
}

/// Copy one regular file into `destination_parent` under `name`.
///
/// The digest is taken over the bytes as they are read and then again over the
/// bytes that were written, read back after the `fsync`. Comparing the two is
/// what makes "it arrived whole" a statement rather than a hope: a short write,
/// a silently dropped block, or a file that changed under the read all show up
/// as a mismatch and the caller removes what it staged.
pub fn copy_file(
    source: RawFd,
    destination_parent: RawFd,
    name: &[u8],
    permissions: u32,
    modified_nanoseconds: Option<u64>,
    on_created: &mut dyn FnMut(RawFd) -> io::Result<()>,
    cancelled: &AtomicBool,
) -> io::Result<u64> {
    let staged = sys::openat_create_exclusive(destination_parent, name, permissions)?;
    if let Err(error) = on_created(staged) {
        sys::close(staged);
        return Err(error);
    }
    // The umask masked the mode the create asked for, so the bits are set
    // again here; otherwise a copy of a 0o666 file arrives as 0o644.
    let outcome = sys::fchmod(staged, permissions)
        .and_then(|()| stream(source, staged, cancelled))
        .and_then(|(bytes, written)| {
            // The modification time comes across after the last write, which
            // would otherwise have set it to now. A copy of a file is the same
            // file, and one dated today is a different answer to the question
            // "when did this last change?". It is set before the `fsync` so it
            // is as durable as the bytes are.
            if let Some(nanoseconds) = modified_nanoseconds {
                sys::set_modified(staged, nanoseconds)?;
            }
            // The bytes have to be on the device before they are read back, or
            // the verification reads the page cache and proves nothing about
            // the disk.
            sys::fsync(staged)?;
            verify(staged, &written, cancelled)?;
            Ok(bytes)
        });
    sys::close(staged);
    outcome
}

/// Copy every byte, returning how many there were and their digest.
///
/// A hole in the source stays a hole in the copy. It reads as zeros, and
/// writing those zeros would allocate every one of them, so a sparse disk
/// image would arrive as large as it claims to be — more than the plan
/// measured and more than the free-space check asked the destination for.
/// The holes are found with `SEEK_DATA` and `SEEK_HOLE`, only the data between
/// them is written, and the length is set at the end so a trailing hole keeps
/// its size. The digest still covers every byte a reader sees, zeros
/// included, because that is what the verification reads back.
///
/// The length is the source's length when the copy starts. A source that
/// grows or shrinks while it is read is a source that changed, and the caller
/// refuses to publish it on that ground; a short read here is an error of its
/// own so a truncated file never verifies against itself.
fn stream(source: RawFd, staged: RawFd, cancelled: &AtomicBool) -> io::Result<(u64, [u8; 32])> {
    let length = sys::metadata_of(source)?.apparent_bytes;
    let mut buffer = vec![0u8; COPY_BYTES];
    let mut hasher = Sha256::new();
    let mut offset = 0u64;

    while offset < length {
        let data = seek(source, offset, libc::SEEK_DATA)?
            .unwrap_or(length)
            .min(length);
        hash_zeros(&mut hasher, data - offset, cancelled)?;
        offset = data;
        if offset == length {
            break;
        }
        // The end of the file counts as a hole, so this always finds one.
        let hole = seek(source, offset, libc::SEEK_HOLE)?
            .unwrap_or(length)
            .min(length);
        while offset < hole {
            check(cancelled)?;
            let wanted = usize::try_from(hole - offset)
                .unwrap_or(usize::MAX)
                .min(COPY_BYTES);
            let read = pread(source, &mut buffer[..wanted], offset)?;
            if read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the file shrank while it was being copied",
                ));
            }
            write_all(staged, &buffer[..read], offset)?;
            hasher.update(&buffer[..read]);
            offset += read as u64;
        }
    }
    ftruncate(staged, length)?;
    Ok((length, hasher.finalize().into()))
}

/// Digest `count` zero bytes: what a hole reads as.
fn hash_zeros(hasher: &mut Sha256, mut count: u64, cancelled: &AtomicBool) -> io::Result<()> {
    static ZEROS: [u8; 64 * 1024] = [0; 64 * 1024];
    while count > 0 {
        check(cancelled)?;
        let chunk = count.min(ZEROS.len() as u64) as usize;
        hasher.update(&ZEROS[..chunk]);
        count -= chunk as u64;
    }
    Ok(())
}

/// The next data or hole at or after `offset`, or `None` past the last data.
///
/// A filesystem that cannot answer is treated as having no holes, which is
/// exactly what every byte-for-byte copy assumed before.
fn seek(descriptor: RawFd, offset: u64, whence: libc::c_int) -> io::Result<Option<u64>> {
    let result = unsafe { libc::lseek(descriptor, offset as libc::off_t, whence) };
    if result >= 0 {
        return Ok(Some(result as u64));
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ENXIO) => Ok(None),
        Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) if whence == libc::SEEK_DATA => {
            Ok(Some(offset))
        }
        Some(libc::EINVAL) | Some(libc::EOPNOTSUPP) => Ok(None),
        _ => Err(error),
    }
}

fn ftruncate(descriptor: RawFd, length: u64) -> io::Result<()> {
    loop {
        if unsafe { libc::ftruncate(descriptor, length as libc::off_t) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// Read the staged copy back and compare it with what was read from the source.
fn verify(staged: RawFd, written: &[u8; 32], cancelled: &AtomicBool) -> io::Result<()> {
    if content::full_digest_cancellable(staged, cancelled)? != *written {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the copy does not match what was read, so it was not published",
        ));
    }
    Ok(())
}

/// The mode a directory is written with while its contents are copied into it.
///
/// Its own permissions are applied once everything inside it has arrived: a
/// read-only directory — a Go module cache is full of them — could not be
/// copied into at all if it took its final mode first.
const WORKING_DIRECTORY_MODE: u32 = 0o700;

/// Copy a whole tree into `destination_parent` under `name`.
///
/// The root directory is created under the staging name; everything below it
/// keeps its own name, because only the thing being published needs hiding
/// until it is complete. The staging name must be free: a directory already
/// there is somebody else's, and is neither written into nor reported as
/// created.
pub fn copy_tree(
    source: RawFd,
    destination_parent: RawFd,
    name: &[u8],
    permissions: u32,
    on_created: &mut dyn FnMut(RawFd) -> io::Result<()>,
    cancelled: &AtomicBool,
) -> io::Result<Copied> {
    sys::mkdirat_exclusive(destination_parent, name, WORKING_DIRECTORY_MODE)?;
    let staged = owned(sys::open_directory_no_symlinks(destination_parent, name)?);
    on_created(staged.as_raw_fd())?;
    let mut copied = Copied { files: 0, bytes: 0 };
    copy_children(source, staged, permissions, &mut copied, cancelled)?;
    Ok(copied)
}

/// One directory being copied: where it is read from, where it is written to,
/// where that is below the staged root, the permissions it gets once it is
/// complete, and the names it has left, in reverse so the next one is a `pop`.
struct Frame {
    source: OwnedFd,
    destination: OwnedFd,
    path: Vec<Vec<u8>>,
    permissions: u32,
    names: Names,
}

impl Frame {
    fn enter(
        source: OwnedFd,
        destination: OwnedFd,
        path: Vec<Vec<u8>>,
        permissions: u32,
        store: &Store,
        cancelled: &AtomicBool,
    ) -> io::Result<Frame> {
        // Names are read before anything is written, so what `readdir` returns
        // is not affected by what this is creating elsewhere.
        let mut stream = sys::Directory::from_descriptor(duplicate(source.as_raw_fd())?)?;
        let names = Names::read(&mut stream, store, cancelled)?;
        Ok(Frame {
            source,
            destination,
            path,
            permissions,
            names,
        })
    }
}

/// The first copy made of a file that has more than one name, so its other
/// names inside the tree become links to it rather than copies of it.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct FirstCopy {
    /// The directories from the staged root down to it, one name each.
    directory: Vec<Vec<u8>>,
    name: Vec<u8>,
    device: u64,
    inode: u64,
}

/// Give a file inside the copy another name, the way it had in the source.
///
/// The first copy is reached again from the staged root one directory at a
/// time, never through a symlink and never onto another filesystem, and the
/// new name is accepted only if it is that very inode: the staged tree is in a
/// directory other people may be able to write to, and a link to whatever is
/// there now would be a link to something nobody copied.
fn link_to(root: RawFd, first: &FirstCopy, destination: RawFd, name: &[u8]) -> io::Result<()> {
    let mut directory = owned(duplicate(root)?);
    for component in &first.directory {
        directory = owned(sys::open_child_directory(
            directory.as_raw_fd(),
            component,
            false,
        )?);
    }
    sys::linkat(directory.as_raw_fd(), &first.name, destination, name)?;
    let linked = sys::metadata_at(destination, name)?;
    if linked.device != first.device || linked.inode != first.inode {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "a file inside the copy changed while it was being written, so it was not published",
        ));
    }
    Ok(())
}

/// Copy everything under `source` into `destination`, depth first.
///
/// The directories being copied are kept on an explicit stack rather than the
/// call stack, so no tree is deep enough to crash the helper partway through a
/// copy; past `subtree::MAX_DEPTH` levels it stops with an error instead.
///
/// A file with several names inside the tree is copied once and linked under
/// the rest, so the copy needs the room the plan measured — the scan counts
/// such a file once — and is still one file. A name whose other names are
/// outside the tree is copied as a file of its own, because what it shares
/// with is not being moved.
fn copy_children(
    source: RawFd,
    destination: OwnedFd,
    permissions: u32,
    copied: &mut Copied,
    cancelled: &AtomicBool,
) -> io::Result<()> {
    let root = owned(duplicate(destination.as_raw_fd())?);
    let mut first_copies = crate::inode_map::Map::<FirstCopy>::new();
    let store = Store::default();
    let mut stack = vec![Frame::enter(
        owned(duplicate(source)?),
        destination,
        Vec::new(),
        permissions,
        &store,
        cancelled,
    )?];
    while let Some(frame) = stack.last_mut() {
        let Some(name) = frame.names.pop()? else {
            let finished = stack.pop().expect("the frame being copied is on the stack");
            // Everything inside it has arrived, so it can take its own mode
            // now, even one that would have refused the writes above.
            sys::fchmod(finished.destination.as_raw_fd(), finished.permissions)?;
            // The directory's own entries have to be durable too, or a crash
            // could leave a published name pointing at a directory missing
            // half of what was copied into it. A directory that cannot be made
            // durable stops the copy: it is not published on a hope.
            sys::fsync(finished.destination.as_raw_fd())?;
            continue;
        };
        check(cancelled)?;
        let source = frame.source.as_raw_fd();
        let destination = frame.destination.as_raw_fd();
        let metadata = sys::metadata_at(source, &name)?;
        match metadata.kind {
            EntryKind::Directory => {
                let mut path = frame.path.clone();
                // The frames on the stack are this directory's ancestors, so
                // their count is how deep it is.
                if stack.len() > crate::subtree::MAX_DEPTH {
                    return Err(crate::subtree::too_deep());
                }
                // No mount crossing: a nested mount inside the source is
                // another filesystem, and copying it here would quietly pull
                // in something nobody reviewed.
                let child = owned(sys::open_child_directory(source, &name, false)?);
                sys::mkdirat_exclusive(destination, &name, WORKING_DIRECTORY_MODE)?;
                let into = owned(sys::open_directory_no_symlinks(destination, &name)?);
                path.push(name);
                stack.push(Frame::enter(
                    child,
                    into,
                    path,
                    metadata.permissions,
                    &store,
                    cancelled,
                )?);
            }
            EntryKind::File => {
                let key = (metadata.device, metadata.inode);
                if metadata.link_count > 1
                    && let Some(first) = first_copies.get(&key)?
                {
                    link_to(root.as_raw_fd(), &first, destination, &name)?;
                    continue;
                }
                let descriptor = owned(sys::openat_read_no_symlinks(source, &name)?);
                let bytes = copy_file(
                    descriptor.as_raw_fd(),
                    destination,
                    &name,
                    metadata.permissions,
                    Some(metadata.modified_nanoseconds),
                    &mut |_| Ok(()),
                    cancelled,
                )?;
                copied.files += 1;
                copied.bytes += bytes;
                if metadata.link_count > 1 {
                    let made = sys::metadata_at(destination, &name)?;
                    first_copies.insert(
                        key,
                        FirstCopy {
                            directory: frame.path.clone(),
                            name,
                            device: made.device,
                            inode: made.inode,
                        },
                    )?;
                }
            }
            EntryKind::Symlink => {
                let target = sys::readlinkat(source, &name)?;
                sys::symlinkat(&target, destination, &name)?;
            }
            EntryKind::Other => {
                // A socket, a device node, or a fifo. Copying one would make a
                // different object with the same name, which is worse than
                // saying it was not copied.
                return Err(io::Error::other(
                    "the tree holds something that is not a file, directory, or link",
                ));
            }
        }
    }
    Ok(())
}

/// Take ownership of a descriptor nothing else will close.
fn owned(descriptor: RawFd) -> OwnedFd {
    unsafe { OwnedFd::from_raw_fd(descriptor) }
}

/// A private copy of a directory descriptor, so a stream can own one without
/// closing the caller's.
fn duplicate(descriptor: RawFd) -> io::Result<RawFd> {
    let copy = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    if copy < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(copy)
}

fn write_all(descriptor: RawFd, bytes: &[u8], offset: u64) -> io::Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        let result = unsafe {
            libc::pwrite(
                descriptor,
                bytes[written..].as_ptr() as *const libc::c_void,
                bytes.len() - written,
                (offset + written as u64) as libc::off_t,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if result == 0 {
            return Err(io::Error::other("the write made no progress"));
        }
        written += result as usize;
    }
    Ok(())
}

fn pread(descriptor: RawFd, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    loop {
        let result = unsafe {
            libc::pread(
                descriptor,
                buffer.as_mut_ptr() as *mut libc::c_void,
                buffer.len(),
                offset as libc::off_t,
            )
        };
        if result >= 0 {
            return Ok(result as usize);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;

    #[test]
    fn cancellation_during_read_back_keeps_the_source_and_staged_copy_intact() {
        use std::os::fd::AsRawFd;
        let sandbox = Sandbox::new("transfer-cancel-verify");
        sandbox.file(b"source.bin", 4096);
        sandbox.file(b"staged.bin", 4096);
        let staged = std::fs::File::open(sandbox.path().join("staged.bin")).unwrap();
        let expected = content::full_digest(staged.as_raw_fd()).unwrap();
        let error = verify(staged.as_raw_fd(), &expected, &AtomicBool::new(true)).unwrap_err();
        assert!(is_cancelled(&error));
        assert!(sandbox.path().join("source.bin").exists());
        assert!(sandbox.path().join("staged.bin").exists());
    }

    #[test]
    fn the_caller_learns_what_was_created_before_a_byte_is_copied() {
        let sandbox = Sandbox::new("transfer-created");
        sandbox.file(b"source.bin", 4096);
        let parent = sys::open_root(&sandbox.bytes()).unwrap();
        let source = sys::openat_read_no_symlinks(parent, b"source.bin").unwrap();
        let mut seen = None;
        copy_file(
            source,
            parent,
            b"copy.bin",
            0o600,
            None,
            &mut |descriptor| {
                let metadata = sys::metadata_of(descriptor)?;
                seen = Some((metadata.inode, metadata.apparent_bytes));
                Ok(())
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let copied = sys::metadata_at(parent, b"copy.bin").unwrap();
        sys::close(source);
        sys::close(parent);
        assert_eq!(
            seen,
            Some((copied.inode, 0)),
            "the hook ran on the new, still empty file"
        );
    }

    #[test]
    fn a_hook_that_fails_stops_the_copy() {
        let sandbox = Sandbox::new("transfer-hook-fails");
        sandbox.file(b"source.bin", 4096);
        let parent = sys::open_root(&sandbox.bytes()).unwrap();
        let source = sys::openat_read_no_symlinks(parent, b"source.bin").unwrap();
        let outcome = copy_file(
            source,
            parent,
            b"copy.bin",
            0o600,
            None,
            &mut |_| Err(io::Error::other("the journal refused")),
            &AtomicBool::new(false),
        );
        sys::close(source);
        sys::close(parent);
        assert!(outcome.is_err());
    }

    fn allocated(path: &std::path::Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).unwrap().blocks() * 512
    }

    /// A file with `data` written at each offset and `length` bytes in all,
    /// or `None` when this filesystem allocates the holes anyway and so has
    /// nothing sparse to copy.
    fn sparse(sandbox: &Sandbox, name: &str, data: &[u64], length: u64) -> Option<()> {
        use std::os::unix::fs::FileExt;
        let path = sandbox.path().join(name);
        let file = std::fs::File::create(&path).unwrap();
        for offset in data {
            file.write_all_at(&[7u8; 4096], *offset).unwrap();
        }
        file.set_len(length).unwrap();
        drop(file);
        (allocated(&path) < length / 2).then_some(())
    }

    fn copied(sandbox: &Sandbox, from: &[u8], to: &[u8]) -> u64 {
        let parent = sys::open_root(&sandbox.bytes()).unwrap();
        let source = sys::openat_read_no_symlinks(parent, from).unwrap();
        let bytes = copy_file(
            source,
            parent,
            to,
            0o600,
            None,
            &mut |_| Ok(()),
            &AtomicBool::new(false),
        )
        .unwrap();
        sys::close(source);
        sys::close(parent);
        bytes
    }

    /// A hole reads as zeros. Writing those zeros out would allocate every one
    /// of them, so a sparse disk image would arrive as large as it claims to be
    /// and could fill a destination the plan's free-space check said it fit.
    #[test]
    fn a_sparse_file_arrives_with_its_holes() {
        const LENGTH: u64 = 16 * 1024 * 1024;
        for (name, data) in [
            ("leading-data", &[0, 8 * 1024 * 1024][..]),
            ("leading-hole", &[4 * 1024 * 1024][..]),
            ("only-holes", &[][..]),
            ("ends-in-data", &[0, LENGTH - 4096][..]),
        ] {
            let sandbox = Sandbox::new(&format!("transfer-sparse-{name}"));
            if sparse(&sandbox, "source.img", data, LENGTH).is_none() {
                eprintln!("{name}: this filesystem does not keep holes; nothing to check");
                continue;
            }
            assert_eq!(copied(&sandbox, b"source.img", b"copy.img"), LENGTH);

            let source = sandbox.path().join("source.img");
            let copy = sandbox.path().join("copy.img");
            assert_eq!(std::fs::metadata(&copy).unwrap().len(), LENGTH, "{name}");
            assert!(
                allocated(&copy) <= allocated(&source) + 1024 * 1024,
                "{name}: the copy allocated {} bytes for a source that holds {}",
                allocated(&copy),
                allocated(&source),
            );
            assert!(
                std::fs::read(&copy).unwrap() == std::fs::read(&source).unwrap(),
                "{name}: the copy reads back as different bytes",
            );
        }
    }

    /// Two names for one file inside a tree are one file in its copy too.
    /// Copied separately they would need room for each, more than the tree
    /// the plan measured, and would stop being the same file.
    #[test]
    fn names_for_one_file_inside_a_tree_stay_one_file_when_it_is_copied() {
        use std::os::unix::fs::MetadataExt;
        let sandbox = Sandbox::new("transfer-hardlinks");
        sandbox.directory(b"work/inner/deeper");
        sandbox.directory(b"outside");
        sandbox.directory(b"elsewhere");
        sandbox.file(b"work/first", 8192);
        sandbox.hardlink(b"work/first", b"work/inner/second");
        sandbox.hardlink(b"work/first", b"work/inner/deeper/third");
        sandbox.file(b"work/alone", 4096);
        sandbox.file(b"outside/shared", 2048);
        sandbox.hardlink(b"outside/shared", b"work/inner/from-outside");

        let source = sys::open_root(&joined(&sandbox, b"work")).unwrap();
        let destination = sys::open_root(&joined(&sandbox, b"elsewhere")).unwrap();
        let outcome = copy_tree(
            source,
            destination,
            b"work",
            0o700,
            &mut |_| Ok(()),
            &AtomicBool::new(false),
        );
        sys::close(source);
        sys::close(destination);
        let copied = outcome.expect("the tree is copied");

        let copy = sandbox.path().join("elsewhere/work");
        let inode = |relative: &str| std::fs::metadata(copy.join(relative)).unwrap().ino();
        assert_eq!(inode("first"), inode("inner/second"));
        assert_eq!(inode("first"), inode("inner/deeper/third"));
        assert_eq!(std::fs::metadata(copy.join("first")).unwrap().nlink(), 3);
        assert_ne!(inode("first"), inode("alone"));
        assert_eq!(
            std::fs::metadata(copy.join("inner/from-outside"))
                .unwrap()
                .nlink(),
            1,
            "a name whose other names are outside the tree arrives as a file of its own",
        );
        assert_eq!(
            std::fs::read(copy.join("inner/deeper/third")).unwrap(),
            vec![b'x'; 8192]
        );
        assert_eq!(
            copied.bytes,
            8192 + 4096 + 2048,
            "a file's bytes are written once, however many names it has",
        );
    }

    fn joined(sandbox: &Sandbox, relative: &[u8]) -> Vec<u8> {
        let mut path = sandbox.bytes();
        path.push(b'/');
        path.extend_from_slice(relative);
        path
    }

    /// A cancelled copy stops at the next chunk with an error the caller can
    /// recognise, rather than running to the end of a large file first.
    #[test]
    fn a_cancelled_copy_stops_and_says_why() {
        let sandbox = Sandbox::new("transfer-cancelled");
        sandbox.file(b"source.bin", 4 * COPY_BYTES);
        let parent = sys::open_root(&sandbox.bytes()).unwrap();
        let source = sys::openat_read_no_symlinks(parent, b"source.bin").unwrap();
        let outcome = copy_file(
            source,
            parent,
            b"copy.bin",
            0o600,
            None,
            &mut |_| Ok(()),
            &AtomicBool::new(true),
        );
        sys::close(source);
        sys::close(parent);
        let error = outcome.expect_err("a cancelled copy does not finish");
        assert!(is_cancelled(&error), "{error}");
    }
}
