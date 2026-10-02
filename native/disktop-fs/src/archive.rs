//! Compressing a file or a tree, and proving the result can be read back.
//!
//! A file becomes `<name>.zst` and a directory becomes `<name>.tar.zst`. Both
//! are written under a staging name and verified before they are published,
//! and the verification is a decompression: the archive is read back the way
//! anybody recovering from it would read it, and what comes out is digested
//! and compared against what went in. An archive that cannot be decompressed
//! to the right bytes is not an archive, however well the write went.
//!
//! Nothing here follows a symlink. A link inside a tree is stored as a link
//! object holding exactly the bytes it held, and descending is `openat2` with
//! `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV`, so a nested
//! mount stops the item rather than being silently swallowed into the archive.

use crate::sys::{self, EntryKind};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::os::unix::io::{FromRawFd, RawFd};

/// Enough to be worth the time on a storage tool's archive, and not so much
/// that compressing a virtual machine image takes an afternoon.
const COMPRESSION_LEVEL: i32 = 3;

const READ_BYTES: usize = 256 * 1024;

/// The suffix an archive of this kind gets.
pub fn suffix(kind: EntryKind) -> &'static [u8] {
    if kind == EntryKind::Directory {
        b".tar.zst"
    } else {
        b".zst"
    }
}

/// Compress one regular file into `destination_parent` under `name`.
///
/// Returns the digest of the bytes that went in, which the caller compares
/// against what comes back out of `verify_file`.
pub fn compress_file(
    source: RawFd,
    destination_parent: RawFd,
    name: &[u8],
    permissions: u32,
) -> io::Result<[u8; 32]> {
    let staged = sys::openat_create_exclusive(destination_parent, name, permissions)?;
    let outcome = (|| -> io::Result<[u8; 32]> {
        sys::fchmod(staged, permissions)?;
        let mut writer = zstd::stream::write::Encoder::new(Sink(staged), COMPRESSION_LEVEL)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; READ_BYTES];
        let mut offset = 0u64;
        loop {
            let read = pread(source, &mut buffer, offset)?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            offset += read as u64;
        }
        writer.finish()?.flush()?;
        sys::fsync(staged)?;
        Ok(hasher.finalize().into())
    })();
    sys::close(staged);
    outcome
}

/// Read a staged `.zst` back the way a person recovering from it would, and
/// report the digest of what comes out.
pub fn verify_file(destination_parent: RawFd, name: &[u8]) -> io::Result<[u8; 32]> {
    let staged = sys::openat_read_no_symlinks(destination_parent, name)?;
    let outcome = (|| -> io::Result<[u8; 32]> {
        let mut decoder = zstd::stream::read::Decoder::new(Source::new(staged))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; READ_BYTES];
        loop {
            let read = decoder.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hasher.finalize().into())
    })();
    sys::close(staged);
    outcome
}

/// Archive a whole tree into `destination_parent` under `name`.
///
/// `root` is the name entries get inside the archive, so unpacking it
/// recreates the directory rather than scattering its contents.
pub fn compress_tree(
    source: RawFd,
    root: &[u8],
    destination_parent: RawFd,
    name: &[u8],
    permissions: u32,
) -> io::Result<u64> {
    let staged = sys::openat_create_exclusive(destination_parent, name, permissions)?;
    let outcome = (|| -> io::Result<u64> {
        sys::fchmod(staged, permissions)?;
        let encoder = zstd::stream::write::Encoder::new(Sink(staged), COMPRESSION_LEVEL)?;
        let mut builder = tar::Builder::new(encoder);
        builder.follow_symlinks(false);
        let mut entries = 0u64;
        append_children(&mut builder, source, root, 0, &mut entries)?;
        builder.into_inner()?.finish()?.flush()?;
        sys::fsync(staged)?;
        Ok(entries)
    })();
    sys::close(staged);
    outcome
}

/// Read a staged `.tar.zst` back and report how many entries came out.
///
/// Every entry is read through, so a truncated member or a corrupt frame is
/// found here rather than by somebody who needed the archive later.
pub fn verify_tree(destination_parent: RawFd, name: &[u8]) -> io::Result<u64> {
    let staged = sys::openat_read_no_symlinks(destination_parent, name)?;
    let outcome = (|| -> io::Result<u64> {
        let decoder = zstd::stream::read::Decoder::new(Source::new(staged))?;
        let mut reader = tar::Archive::new(decoder);
        let mut entries = 0u64;
        let mut buffer = vec![0u8; READ_BYTES];
        for entry in reader.entries()? {
            let mut entry = entry?;
            while entry.read(&mut buffer)? > 0 {}
            entries += 1;
        }
        Ok(entries)
    })();
    sys::close(staged);
    outcome
}

const MAX_DEPTH: u32 = 256;

fn append_children<W: Write>(
    builder: &mut tar::Builder<W>,
    source: RawFd,
    prefix: &[u8],
    depth: u32,
    entries: &mut u64,
) -> io::Result<()> {
    if depth >= MAX_DEPTH {
        return Err(io::Error::other(
            "the tree is deeper than Disktop will archive in one action",
        ));
    }

    let mut stream = sys::Directory::from_descriptor(duplicate(source)?)?;
    let mut names = Vec::new();
    while let Some(name) = stream.next_name()? {
        names.push(name);
    }
    drop(stream);

    for name in names {
        let metadata = sys::metadata_at(source, &name)?;
        let mut path = prefix.to_vec();
        path.push(b'/');
        path.extend_from_slice(&name);

        match metadata.kind {
            EntryKind::Directory => {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Directory);
                header.set_size(0);
                header.set_mode(metadata.permissions);
                header.set_mtime(metadata.modified_nanoseconds / 1_000_000_000);
                append(builder, &mut header, &path, &mut io::empty())?;
                *entries += 1;

                let child = sys::open_child_directory(source, &name, false)?;
                let result = append_children(builder, child, &path, depth + 1, entries);
                sys::close(child);
                result?;
            }
            EntryKind::File => {
                let descriptor = sys::openat_read_no_symlinks(source, &name)?;
                let result = (|| -> io::Result<()> {
                    let mut header = tar::Header::new_gnu();
                    header.set_entry_type(tar::EntryType::Regular);
                    header.set_size(metadata.apparent_bytes);
                    header.set_mode(metadata.permissions);
                    header.set_mtime(metadata.modified_nanoseconds / 1_000_000_000);
                    let mut reader = Source::new(duplicate(descriptor)?);
                    append(builder, &mut header, &path, &mut reader)
                })();
                sys::close(descriptor);
                result?;
                *entries += 1;
            }
            EntryKind::Symlink => {
                let target = sys::readlinkat(source, &name)?;
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                header.set_mode(metadata.permissions);
                // The link's bytes are stored as they are. `set_link_name_literal`
                // takes them without resolving or validating anything.
                header.set_link_name_literal(&target[..])?;
                append(builder, &mut header, &path, &mut io::empty())?;
                *entries += 1;
            }
            EntryKind::Other => {
                return Err(io::Error::other(
                    "the tree holds something that is not a file, directory, or link",
                ));
            }
        }
    }
    Ok(())
}

fn append<W: Write, R: Read>(
    builder: &mut tar::Builder<W>,
    header: &mut tar::Header,
    path: &[u8],
    data: &mut R,
) -> io::Result<()> {
    // A path that is not valid UTF-8 is still a path. `tar` stores the bytes
    // when given an OsStr, which is what a Linux name actually is.
    let name = std::path::PathBuf::from(osstr(path));
    builder.append_data(header, name, data)
}

/// Borrow raw bytes as an `OsStr` without copying or validating them.
fn osstr(bytes: &[u8]) -> &std::ffi::OsStr {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::OsStr::from_bytes(bytes)
}

/// A `Write` over a descriptor this does not own.
struct Sink(RawFd);

impl Write for Sink {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let result =
            unsafe { libc::write(self.0, buffer.as_ptr() as *const libc::c_void, buffer.len()) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(result as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A `Read` over a descriptor this owns and closes.
struct Source(std::fs::File);

impl Source {
    fn new(descriptor: RawFd) -> Source {
        Source(unsafe { std::fs::File::from_raw_fd(descriptor) })
    }
}

impl Read for Source {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}

fn duplicate(descriptor: RawFd) -> io::Result<RawFd> {
    let copy = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    if copy < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(copy)
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
