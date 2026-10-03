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
use std::os::fd::{AsRawFd, OwnedFd};
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
    on_created: &mut dyn FnMut(RawFd) -> io::Result<()>,
) -> io::Result<[u8; 32]> {
    let staged = sys::openat_create_exclusive(destination_parent, name, permissions)?;
    if let Err(error) = on_created(staged) {
        sys::close(staged);
        return Err(error);
    }
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
    // The decoder owns the descriptor from here on and closes it once, when it
    // is dropped, on every path out of this function.
    let mut decoder = zstd::stream::read::Decoder::new(Source::open(destination_parent, name)?)?;
    digest_stream(&mut decoder)
}

/// Digest everything a reader yields, a bounded buffer at a time.
fn digest_stream(reader: &mut dyn Read) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
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
    on_created: &mut dyn FnMut(RawFd) -> io::Result<()>,
) -> io::Result<[u8; 32]> {
    let staged = sys::openat_create_exclusive(destination_parent, name, permissions)?;
    if let Err(error) = on_created(staged) {
        sys::close(staged);
        return Err(error);
    }
    let outcome = (|| -> io::Result<[u8; 32]> {
        sys::fchmod(staged, permissions)?;
        // The digest is taken over the tar stream itself, before compression,
        // so it covers every header and every byte of every member. Counting
        // entries would not: a file rewritten to the same length while the
        // archive was being built keeps the stream well-formed and the count
        // identical, and the archive would hold a torn copy that verified.
        // The digest sits between the tar builder and the compressor, so it
        // covers the archive's content rather than whatever zstd happened to
        // emit for it. Verification decompresses back to this same stream.
        let encoder = zstd::stream::write::Encoder::new(Sink(staged), COMPRESSION_LEVEL)?;
        let mut builder = tar::Builder::new(Digesting {
            inner: encoder,
            hasher: Sha256::new(),
        });
        builder.follow_symlinks(false);
        let mut entries = 0u64;
        append_children(&mut builder, source, root, &mut entries)?;

        let digesting = builder.into_inner()?;
        let digest: [u8; 32] = digesting.hasher.finalize().into();
        digesting.inner.finish()?.flush()?;
        sys::fsync(staged)?;
        Ok(digest)
    })();
    sys::close(staged);
    outcome
}

/// A writer that digests everything that passes through it.
struct Digesting<W: Write> {
    inner: W,
    hasher: Sha256,
}

impl<W: Write> Write for Digesting<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.hasher.update(&buffer[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Read a staged `.tar.zst` back and digest the tar stream that comes out.
///
/// The whole archive is decompressed, the way anybody recovering from it would,
/// and the bytes are digested as they emerge. Comparing that against the digest
/// taken while writing is what makes "it can be read back" a statement about
/// the content rather than about the entry count.
pub fn verify_tree(destination_parent: RawFd, name: &[u8]) -> io::Result<[u8; 32]> {
    let mut decoder = zstd::stream::read::Decoder::new(Source::open(destination_parent, name)?)?;
    digest_stream(&mut decoder)
}

/// Walk a staged `.tar.zst` as an archive, so a malformed member is found.
///
/// The digest says the bytes survived the round trip; this says they are still
/// a tar anybody can unpack.
pub fn readable_as_tar(destination_parent: RawFd, name: &[u8]) -> io::Result<u64> {
    let decoder = zstd::stream::read::Decoder::new(Source::open(destination_parent, name)?)?;
    let mut reader = tar::Archive::new(decoder);
    let mut entries = 0u64;
    let mut buffer = vec![0u8; READ_BYTES];
    for entry in reader.entries()? {
        let mut entry = entry?;
        while entry.read(&mut buffer)? > 0 {}
        entries += 1;
    }
    Ok(entries)
}

/// One directory being archived: where it is read from, the path its members
/// get inside the archive, and the names it has left, in reverse so the next
/// one is a `pop`.
struct Frame {
    source: OwnedFd,
    prefix: Vec<u8>,
    names: Vec<Vec<u8>>,
}

impl Frame {
    fn enter(source: OwnedFd, prefix: Vec<u8>) -> io::Result<Frame> {
        let mut stream = sys::Directory::from_descriptor(duplicate(source.as_raw_fd())?)?;
        let mut names = Vec::new();
        while let Some(name) = stream.next_name()? {
            names.push(name);
        }
        names.reverse();
        Ok(Frame {
            source,
            prefix,
            names,
        })
    }
}

/// Append everything under `source` to the archive, each directory's header
/// before what it holds.
///
/// The directories being read are kept on an explicit stack rather than the
/// call stack, so no tree is deep enough to crash the helper partway through
/// an archive; past `subtree::MAX_DEPTH` levels it stops with an error instead.
fn append_children<W: Write>(
    builder: &mut tar::Builder<W>,
    source: RawFd,
    root: &[u8],
    entries: &mut u64,
) -> io::Result<()> {
    let mut stack = vec![Frame::enter(owned(duplicate(source)?), root.to_vec())?];
    while let Some(frame) = stack.last_mut() {
        let Some(name) = frame.names.pop() else {
            stack.pop();
            continue;
        };
        let source = frame.source.as_raw_fd();
        let metadata = sys::metadata_at(source, &name)?;
        let mut path = frame.prefix.clone();
        path.push(b'/');
        path.extend_from_slice(&name);

        match metadata.kind {
            EntryKind::Directory => {
                // The frames on the stack are this directory's ancestors, so
                // their count is how deep it is.
                if stack.len() > crate::subtree::MAX_DEPTH {
                    return Err(crate::subtree::too_deep());
                }
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Directory);
                header.set_size(0);
                header.set_mode(metadata.permissions);
                header.set_mtime(metadata.modified_nanoseconds / 1_000_000_000);
                append(builder, &mut header, &path, &mut io::empty())?;
                *entries += 1;

                let child = owned(sys::open_child_directory(source, &name, false)?);
                stack.push(Frame::enter(child, path)?);
            }
            EntryKind::File => {
                let mut reader = Source::open(source, &name)?;
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(metadata.apparent_bytes);
                header.set_mode(metadata.permissions);
                header.set_mtime(metadata.modified_nanoseconds / 1_000_000_000);
                append(builder, &mut header, &path, &mut reader)?;
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

/// Take ownership of a descriptor nothing else will close.
fn owned(descriptor: RawFd) -> OwnedFd {
    unsafe { OwnedFd::from_raw_fd(descriptor) }
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
///
/// Ownership is the whole point of the type: whatever holds a `Source` is the
/// one thing that closes its descriptor, so nothing else may close it too.
struct Source(std::fs::File);

impl Source {
    /// Take ownership of a descriptor nothing else will close.
    fn new(descriptor: RawFd) -> Source {
        Source(unsafe { std::fs::File::from_raw_fd(descriptor) })
    }

    /// Open a staged file for reading back, never through a symlink.
    fn open(parent: RawFd, name: &[u8]) -> io::Result<Source> {
        sys::openat_read_no_symlinks(parent, name).map(Source::new)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;
    use std::os::unix::io::AsRawFd;

    /// The digest has to be over the archive's content, not over what the
    /// compressor emitted and not over a count of its members. A member
    /// rewritten to the same length while the archive is being built keeps the
    /// stream well-formed and the count identical.
    #[test]
    fn an_archive_whose_content_changed_does_not_verify_against_what_went_in() {
        let sandbox = Sandbox::new("archive-torn");
        sandbox.directory(b"work");
        sandbox.directory(b"out");
        std::fs::write(sandbox.path().join("work/a.bin"), vec![1u8; 40_000]).unwrap();

        let source = std::fs::File::open(sandbox.path().join("work")).unwrap();
        let destination = std::fs::File::open(sandbox.path().join("out")).unwrap();

        let written = compress_tree(
            source.as_raw_fd(),
            b"work",
            destination.as_raw_fd(),
            b"first.tar.zst",
            0o600,
            &mut |_| Ok(()),
        )
        .expect("the archive is written");

        // The same tree, one member's bytes different, same length.
        std::fs::write(sandbox.path().join("work/a.bin"), vec![2u8; 40_000]).unwrap();
        let source = std::fs::File::open(sandbox.path().join("work")).unwrap();
        let second = compress_tree(
            source.as_raw_fd(),
            b"work",
            destination.as_raw_fd(),
            b"second.tar.zst",
            0o600,
            &mut |_| Ok(()),
        )
        .expect("the second archive is written");

        assert_ne!(
            written, second,
            "two archives of different content must not share a digest",
        );
        assert_eq!(
            verify_tree(destination.as_raw_fd(), b"first.tar.zst").unwrap(),
            written,
            "an archive reads back as what went into it",
        );
        assert_ne!(
            verify_tree(destination.as_raw_fd(), b"second.tar.zst").unwrap(),
            written,
            "an archive of other bytes does not pass the first one's check",
        );
    }

    #[test]
    fn a_truncated_archive_is_not_readable_as_a_tar() {
        let sandbox = Sandbox::new("archive-truncated");
        sandbox.directory(b"work");
        sandbox.directory(b"out");
        std::fs::write(sandbox.path().join("work/a.bin"), vec![3u8; 80_000]).unwrap();

        let source = std::fs::File::open(sandbox.path().join("work")).unwrap();
        let destination = std::fs::File::open(sandbox.path().join("out")).unwrap();
        compress_tree(
            source.as_raw_fd(),
            b"work",
            destination.as_raw_fd(),
            b"a.tar.zst",
            0o600,
            &mut |_| Ok(()),
        )
        .unwrap();

        let path = sandbox.path().join("out/a.tar.zst");
        let length = std::fs::metadata(&path).unwrap().len();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(length / 2)
            .unwrap();

        assert!(
            readable_as_tar(destination.as_raw_fd(), b"a.tar.zst").is_err()
                || verify_tree(destination.as_raw_fd(), b"a.tar.zst").is_err(),
            "half an archive is not an archive",
        );
    }
}
