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

use crate::directory_names::{Names, Store};
use crate::sys::{self, EntryKind};
use crate::transfer::check;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::io::{FromRawFd, RawFd};
use std::sync::atomic::AtomicBool;

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
    cancelled: &AtomicBool,
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
            check(cancelled)?;
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
pub fn verify_file(
    destination_parent: RawFd,
    name: &[u8],
    cancelled: &AtomicBool,
) -> io::Result<[u8; 32]> {
    // The decoder owns the descriptor from here on and closes it once, when it
    // is dropped, on every path out of this function.
    let mut decoder = zstd::stream::read::Decoder::new(Source::open(destination_parent, name)?)?;
    digest_stream(&mut decoder, cancelled)
}

/// Digest everything a reader yields, a bounded buffer at a time.
fn digest_stream(reader: &mut dyn Read, cancelled: &AtomicBool) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_BYTES];
    loop {
        check(cancelled)?;
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
    cancelled: &AtomicBool,
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
        append_children(&mut builder, source, root, &mut entries, cancelled)?;

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
pub fn verify_tree(
    destination_parent: RawFd,
    name: &[u8],
    cancelled: &AtomicBool,
) -> io::Result<[u8; 32]> {
    let mut decoder = zstd::stream::read::Decoder::new(Source::open(destination_parent, name)?)?;
    digest_stream(&mut decoder, cancelled)
}

/// Walk a staged `.tar.zst` as an archive, so a malformed member is found.
///
/// The digest says the bytes survived the round trip; this says they are still
/// a tar anybody can unpack.
pub fn readable_as_tar(
    destination_parent: RawFd,
    name: &[u8],
    cancelled: &AtomicBool,
) -> io::Result<u64> {
    let decoder = zstd::stream::read::Decoder::new(Source::open(destination_parent, name)?)?;
    let mut reader = tar::Archive::new(decoder);
    let mut entries = 0u64;
    let mut buffer = vec![0u8; READ_BYTES];
    for entry in reader.entries()? {
        let mut entry = entry?;
        loop {
            check(cancelled)?;
            if entry.read(&mut buffer)? == 0 {
                break;
            }
        }
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
    names: Names,
}

impl Frame {
    fn enter(
        source: OwnedFd,
        prefix: Vec<u8>,
        store: &Store,
        cancelled: &AtomicBool,
    ) -> io::Result<Frame> {
        let mut stream = sys::Directory::from_descriptor(duplicate(source.as_raw_fd())?)?;
        let names = Names::read(&mut stream, store, cancelled)?;
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
///
/// A file with several names inside the tree is stored once, under the first
/// name the walk reaches, and every later name is a hard-link member pointing
/// at it — what `tar` itself writes. Unpacking gives back one file with all
/// its names, and the archive holds its bytes once rather than once a name.
fn append_children<W: Write>(
    builder: &mut tar::Builder<W>,
    source: RawFd,
    root: &[u8],
    entries: &mut u64,
    cancelled: &AtomicBool,
) -> io::Result<()> {
    let mut archived = crate::inode_map::Map::<Vec<u8>>::new();
    let store = Store::default();
    let mut stack = vec![Frame::enter(
        owned(duplicate(source)?),
        root.to_vec(),
        &store,
        cancelled,
    )?];
    while let Some(frame) = stack.last_mut() {
        let Some(name) = frame.names.pop()? else {
            stack.pop();
            continue;
        };
        check(cancelled)?;
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
                stack.push(Frame::enter(child, path, &store, cancelled)?);
            }
            EntryKind::File => {
                let key = (metadata.device, metadata.inode);
                if metadata.link_count > 1
                    && let Some(first) = archived.get(&key)?
                {
                    let mut header = tar::Header::new_gnu();
                    header.set_entry_type(tar::EntryType::Link);
                    header.set_size(0);
                    header.set_mode(metadata.permissions);
                    header.set_mtime(metadata.modified_nanoseconds / 1_000_000_000);
                    builder.append_link(&mut header, osstr(&path), osstr(&first))?;
                    *entries += 1;
                    continue;
                }
                if metadata.link_count > 1 {
                    archived.insert(key, path.clone())?;
                }
                let mut reader = Member::new(
                    Source::open(source, &name)?,
                    metadata.apparent_bytes,
                    cancelled,
                );
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(metadata.apparent_bytes);
                header.set_mode(metadata.permissions);
                header.set_mtime(metadata.modified_nanoseconds / 1_000_000_000);
                append(builder, &mut header, &path, &mut reader)?;
                reader.finish()?;
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

/// A file's bytes as one archive member: exactly as many as its header says.
///
/// A tar header fixes a member's length before its data is written, and the
/// archive writer copies whatever the reader yields. A file that grew while it
/// was archived would spill into where the next header belongs, and one that
/// shrank would leave the next header early; either way every member after it
/// is misread, and a tail of zeros reads as the end of the archive, silently
/// dropping the rest. A member that does not match its header is an error, and
/// the archive is not published.
struct Member<'a> {
    source: Source,
    remaining: u64,
    cancelled: &'a AtomicBool,
}

impl<'a> Member<'a> {
    fn new(source: Source, length: u64, cancelled: &'a AtomicBool) -> Member<'a> {
        Member {
            source,
            remaining: length,
            cancelled,
        }
    }

    /// Fail if the file holds more than its header said.
    fn finish(mut self) -> io::Result<()> {
        let mut probe = [0u8; 1];
        if self.source.read(&mut probe)? != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a file grew while it was being archived",
            ));
        }
        Ok(())
    }
}

impl Read for Member<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 || buffer.is_empty() {
            return Ok(0);
        }
        // A single member can be most of a large archive, so a cancel is
        // heard inside it rather than only between members.
        check(self.cancelled)?;
        let wanted = buffer
            .len()
            .min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        let read = self.source.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a file shrank while it was being archived",
            ));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
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

    static NOT_CANCELLED: AtomicBool = AtomicBool::new(false);

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
            &NOT_CANCELLED,
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
            &NOT_CANCELLED,
        )
        .expect("the second archive is written");

        assert_ne!(
            written, second,
            "two archives of different content must not share a digest",
        );
        assert_eq!(
            verify_tree(destination.as_raw_fd(), b"first.tar.zst", &NOT_CANCELLED).unwrap(),
            written,
            "an archive reads back as what went into it",
        );
        assert_ne!(
            verify_tree(destination.as_raw_fd(), b"second.tar.zst", &NOT_CANCELLED).unwrap(),
            written,
            "an archive of other bytes does not pass the first one's check",
        );
    }

    fn member_over(sandbox: &Sandbox, bytes: usize, length: u64) -> Member<'static> {
        sandbox.file(b"member.bin", bytes);
        let parent = sys::open_root(&sandbox.bytes()).unwrap();
        let source = Source::open(parent, b"member.bin").unwrap();
        sys::close(parent);
        Member::new(source, length, &NOT_CANCELLED)
    }

    #[test]
    fn a_member_holds_exactly_the_bytes_its_header_promised() {
        let sandbox = Sandbox::new("archive-member-exact");
        let mut member = member_over(&sandbox, 300_000, 300_000);
        let mut read = Vec::new();
        member.read_to_end(&mut read).unwrap();
        assert_eq!(read.len(), 300_000);
        member.finish().expect("nothing beyond the header's length");
    }

    #[test]
    fn a_file_that_grew_past_its_header_is_not_archived() {
        let sandbox = Sandbox::new("archive-member-grew");
        let mut member = member_over(&sandbox, 300_000, 200_000);
        let mut read = Vec::new();
        member.read_to_end(&mut read).unwrap();
        assert_eq!(read.len(), 200_000, "never more than the header says");
        let error = member.finish().expect_err("the rest is noticed");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_file_that_shrank_under_its_header_is_not_archived() {
        let sandbox = Sandbox::new("archive-member-shrank");
        let mut member = member_over(&sandbox, 100_000, 200_000);
        let error = member
            .read_to_end(&mut Vec::new())
            .expect_err("the missing bytes are noticed");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    /// Two names for one file inside a tree are archived as one member and a
    /// link to it, the way `tar` itself archives them, so unpacking gives back
    /// one file with two names rather than two copies of it.
    #[test]
    fn names_for_one_file_inside_a_tree_are_archived_once() {
        use std::os::unix::fs::MetadataExt;
        let sandbox = Sandbox::new("archive-hardlinks");
        sandbox.directory(b"work/inner");
        sandbox.directory(b"out");
        sandbox.directory(b"unpacked");
        std::fs::write(sandbox.path().join("work/first"), vec![5u8; 50_000]).unwrap();
        sandbox.hardlink(b"work/first", b"work/inner/second");
        sandbox.file(b"work/alone", 1000);

        let source = std::fs::File::open(sandbox.path().join("work")).unwrap();
        let destination = std::fs::File::open(sandbox.path().join("out")).unwrap();
        let written = compress_tree(
            source.as_raw_fd(),
            b"work",
            destination.as_raw_fd(),
            b"work.tar.zst",
            0o600,
            &mut |_| Ok(()),
            &NOT_CANCELLED,
        )
        .expect("the archive is written");
        assert_eq!(
            verify_tree(destination.as_raw_fd(), b"work.tar.zst", &NOT_CANCELLED).unwrap(),
            written,
        );
        assert_eq!(
            readable_as_tar(destination.as_raw_fd(), b"work.tar.zst", &NOT_CANCELLED).unwrap(),
            4,
            "work/first, work/inner, work/inner/second, and work/alone",
        );

        let archive = || {
            let file = std::fs::File::open(sandbox.path().join("out/work.tar.zst")).unwrap();
            tar::Archive::new(zstd::stream::read::Decoder::new(file).unwrap())
        };
        let mut regular = 0;
        let mut links = Vec::new();
        for entry in archive().entries().unwrap() {
            let entry = entry.unwrap();
            match entry.header().entry_type() {
                tar::EntryType::Regular => regular += 1,
                tar::EntryType::Link => links.push((
                    entry.path().unwrap().into_owned(),
                    entry.link_name().unwrap().unwrap().into_owned(),
                )),
                _ => {}
            }
        }
        assert_eq!(regular, 2, "the shared file's bytes are stored once");
        assert_eq!(links.len(), 1);
        let names = [links[0].0.clone(), links[0].1.clone()];
        assert!(
            names.contains(&"work/first".into()) && names.contains(&"work/inner/second".into()),
            "{links:?}"
        );

        archive()
            .unpack(sandbox.path().join("unpacked"))
            .expect("the archive unpacks");
        let unpacked = sandbox.path().join("unpacked/work");
        let first = std::fs::metadata(unpacked.join("first")).unwrap();
        assert_eq!(
            first.ino(),
            std::fs::metadata(unpacked.join("inner/second"))
                .unwrap()
                .ino()
        );
        assert_eq!(
            std::fs::read(unpacked.join("inner/second")).unwrap(),
            vec![5u8; 50_000]
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
            &NOT_CANCELLED,
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
            readable_as_tar(destination.as_raw_fd(), b"a.tar.zst", &NOT_CANCELLED).is_err()
                || verify_tree(destination.as_raw_fd(), b"a.tar.zst", &NOT_CANCELLED).is_err(),
            "half an archive is not an archive",
        );
    }
}
