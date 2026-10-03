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
use crate::sys::{self, EntryKind};
use sha2::{Digest, Sha256};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::io::RawFd;

/// Bytes per read while streaming. The same order as the index's batch size:
/// large enough that the syscall cost disappears, small enough to stay out of
/// the way of everything else on the machine.
const COPY_BYTES: usize = 256 * 1024;

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
) -> io::Result<u64> {
    let staged = sys::openat_create_exclusive(destination_parent, name, permissions)?;
    if let Err(error) = on_created(staged) {
        sys::close(staged);
        return Err(error);
    }
    // The umask masked the mode the create asked for, so the bits are set
    // again here; otherwise a copy of a 0o666 file arrives as 0o644.
    let outcome = sys::fchmod(staged, permissions)
        .and_then(|()| stream_and_verify(source, staged))
        .and_then(|bytes| {
            // The modification time comes across last, after the write that
            // would otherwise have set it to now. A copy of a file is the same
            // file, and one dated today is a different answer to the question
            // "when did this last change?".
            if let Some(nanoseconds) = modified_nanoseconds {
                sys::set_modified(staged, nanoseconds)?;
            }
            Ok(bytes)
        });
    sys::close(staged);
    outcome
}

fn stream_and_verify(source: RawFd, staged: RawFd) -> io::Result<u64> {
    let mut buffer = vec![0u8; COPY_BYTES];
    let mut hasher = Sha256::new();
    let mut offset = 0u64;

    loop {
        let read = pread(source, &mut buffer, offset)?;
        if read == 0 {
            break;
        }
        write_all(staged, &buffer[..read], offset)?;
        hasher.update(&buffer[..read]);
        offset += read as u64;
    }

    // The bytes have to be on the device before they are read back, or the
    // verification reads the page cache and proves nothing about the disk.
    sys::fsync(staged)?;

    let written: [u8; 32] = hasher.finalize().into();
    let readback = content::full_digest(staged)?;
    if written != readback {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the copy does not match what was read, so it was not published",
        ));
    }
    Ok(offset)
}

/// Copy a whole tree into `destination_parent` under `name`.
///
/// The root directory is created under the staging name; everything below it
/// keeps its own name, because only the thing being published needs hiding
/// until it is complete.
pub fn copy_tree(
    source: RawFd,
    destination_parent: RawFd,
    name: &[u8],
    permissions: u32,
    on_created: &mut dyn FnMut(RawFd) -> io::Result<()>,
) -> io::Result<Copied> {
    sys::mkdirat(destination_parent, name, permissions)?;
    let staged = owned(sys::open_directory_no_symlinks(destination_parent, name)?);
    on_created(staged.as_raw_fd())?;
    sys::fchmod(staged.as_raw_fd(), permissions)?;
    let mut copied = Copied { files: 0, bytes: 0 };
    copy_children(source, staged, &mut copied)?;
    Ok(copied)
}

/// One directory being copied: where it is read from, where it is written to,
/// and the names it has left, in reverse so the next one is a `pop`.
struct Frame {
    source: OwnedFd,
    destination: OwnedFd,
    names: Vec<Vec<u8>>,
}

impl Frame {
    fn enter(source: OwnedFd, destination: OwnedFd) -> io::Result<Frame> {
        // Names are read before anything is written, so what `readdir` returns
        // is not affected by what this is creating elsewhere.
        let mut stream = sys::Directory::from_descriptor(duplicate(source.as_raw_fd())?)?;
        let mut names = Vec::new();
        while let Some(name) = stream.next_name()? {
            names.push(name);
        }
        names.reverse();
        Ok(Frame {
            source,
            destination,
            names,
        })
    }
}

/// Copy everything under `source` into `destination`, depth first.
///
/// The directories being copied are kept on an explicit stack rather than the
/// call stack, so no tree is deep enough to crash the helper partway through a
/// copy; past `subtree::MAX_DEPTH` levels it stops with an error instead.
fn copy_children(source: RawFd, destination: OwnedFd, copied: &mut Copied) -> io::Result<()> {
    let mut stack = vec![Frame::enter(owned(duplicate(source)?), destination)?];
    while let Some(frame) = stack.last_mut() {
        let Some(name) = frame.names.pop() else {
            let finished = stack.pop().expect("the frame being copied is on the stack");
            // The directory's own entries have to be durable too, or a crash
            // could leave a published name pointing at a directory missing
            // half of what was copied into it.
            let _ = sys::fsync(finished.destination.as_raw_fd());
            continue;
        };
        let source = frame.source.as_raw_fd();
        let destination = frame.destination.as_raw_fd();
        let metadata = sys::metadata_at(source, &name)?;
        match metadata.kind {
            EntryKind::Directory => {
                // The frames on the stack are this directory's ancestors, so
                // their count is how deep it is.
                if stack.len() > crate::subtree::MAX_DEPTH {
                    return Err(crate::subtree::too_deep());
                }
                // No mount crossing: a nested mount inside the source is
                // another filesystem, and copying it here would quietly pull
                // in something nobody reviewed.
                let child = owned(sys::open_child_directory(source, &name, false)?);
                sys::mkdirat(destination, &name, metadata.permissions)?;
                let into = owned(sys::open_directory_no_symlinks(destination, &name)?);
                sys::fchmod(into.as_raw_fd(), metadata.permissions)?;
                stack.push(Frame::enter(child, into)?);
            }
            EntryKind::File => {
                let descriptor = owned(sys::openat_read_no_symlinks(source, &name)?);
                let bytes = copy_file(
                    descriptor.as_raw_fd(),
                    destination,
                    &name,
                    metadata.permissions,
                    Some(metadata.modified_nanoseconds),
                    &mut |_| Ok(()),
                )?;
                copied.files += 1;
                copied.bytes += bytes;
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
        let outcome = copy_file(source, parent, b"copy.bin", 0o600, None, &mut |_| {
            Err(io::Error::other("the journal refused"))
        });
        sys::close(source);
        sys::close(parent);
        assert!(outcome.is_err());
    }
}
