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
use std::os::unix::io::RawFd;

/// Bytes per read while streaming. The same order as the index's batch size:
/// large enough that the syscall cost disappears, small enough to stay out of
/// the way of everything else on the machine.
const COPY_BYTES: usize = 256 * 1024;

/// How deep a tree may be copied. A loop cannot be made with `RESOLVE_NO_SYMLINKS`,
/// but a genuinely pathological tree should stop rather than exhaust the stack.
const MAX_DEPTH: u32 = 256;

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
) -> io::Result<u64> {
    let staged = sys::openat_create_exclusive(destination_parent, name, permissions)?;
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
) -> io::Result<Copied> {
    sys::mkdirat(destination_parent, name, permissions)?;
    let staged = sys::open_directory_no_symlinks(destination_parent, name)?;
    sys::fchmod(staged, permissions)?;
    let mut copied = Copied { files: 0, bytes: 0 };
    let outcome = copy_children(source, staged, 0, &mut copied);
    // The directory's own bytes have to be durable too, or a crash could leave
    // a published name pointing at a directory missing half its entries.
    let _ = sys::fsync(staged);
    sys::close(staged);
    outcome.map(|()| copied)
}

fn copy_children(
    source: RawFd,
    destination: RawFd,
    depth: u32,
    copied: &mut Copied,
) -> io::Result<()> {
    if depth >= MAX_DEPTH {
        return Err(io::Error::other(
            "the tree is deeper than Disktop will copy in one action",
        ));
    }

    // Names are read before anything is written, so what `readdir` returns is
    // not affected by what this is creating elsewhere.
    let mut stream = sys::Directory::from_descriptor(duplicate(source)?)?;
    let mut names = Vec::new();
    while let Some(name) = stream.next_name()? {
        names.push(name);
    }
    drop(stream);

    for name in names {
        let metadata = sys::metadata_at(source, &name)?;
        match metadata.kind {
            EntryKind::Directory => {
                // No mount crossing: a nested mount inside the source is
                // another filesystem, and copying it here would quietly pull
                // in something nobody reviewed.
                let child = sys::open_child_directory(source, &name, false)?;
                let result = (|| -> io::Result<()> {
                    sys::mkdirat(destination, &name, metadata.permissions)?;
                    let into = sys::open_directory_no_symlinks(destination, &name)?;
                    sys::fchmod(into, metadata.permissions)?;
                    let outcome = copy_children(child, into, depth + 1, copied);
                    let _ = sys::fsync(into);
                    sys::close(into);
                    outcome
                })();
                sys::close(child);
                result?;
            }
            EntryKind::File => {
                let descriptor = sys::openat_read_no_symlinks(source, &name)?;
                let outcome = copy_file(
                    descriptor,
                    destination,
                    &name,
                    metadata.permissions,
                    Some(metadata.modified_nanoseconds),
                );
                sys::close(descriptor);
                let bytes = outcome?;
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
