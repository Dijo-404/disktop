//! Reading a file's content without changing it.
//!
//! Two questions get asked about content here and they are not the same
//! question. "Are these worth comparing?" is answered by a digest, which is
//! cheap, can be taken of part of a file, and is allowed to be wrong in the
//! direction of saying two different files might match. "Are these the same
//! bytes?" is answered by `bytes_equal` and only by `bytes_equal`, because a
//! mutation that replaces one file with a link to another has no second chance
//! to notice it was wrong.
//!
//! Everything here reads through `pread`, so no function depends on or disturbs
//! a descriptor's file offset and two of them can run against the same open
//! file without agreeing on whose turn it is.

use sha2::{Digest, Sha256};
use std::io;
use std::os::unix::io::RawFd;

/// How much of each end `edge_digest` reads. Large enough that two unrelated
/// files of the same size almost never agree, small enough that taking it over
/// a whole size class costs two seeks per file.
pub const CHUNK_BYTES: u64 = 64 * 1024;

/// How much is read per `pread` while streaming. One page order larger than the
/// usual filesystem block, so a long file is not a syscall per 4 KiB.
const READ_BYTES: usize = 128 * 1024;

/// A digest of the first and last `CHUNK_BYTES` of a file.
///
/// A file no larger than two chunks is digested whole, so the result is never
/// weaker than the full digest for a small file. The file's length is mixed in,
/// so two files whose common ends match but whose lengths differ cannot collide
/// here just because the caller grouped them wrongly.
pub fn edge_digest(descriptor: RawFd, size: u64) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());

    if size <= CHUNK_BYTES * 2 {
        digest_range(descriptor, 0, size, &mut hasher)?;
    } else {
        digest_range(descriptor, 0, CHUNK_BYTES, &mut hasher)?;
        digest_range(descriptor, size - CHUNK_BYTES, CHUNK_BYTES, &mut hasher)?;
    }

    Ok(hasher.finalize().into())
}

/// A digest of every byte of the file, streamed.
///
/// The whole file never exists in memory at once; this runs against a virtual
/// machine image as happily as against a text file.
pub fn full_digest(descriptor: RawFd) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_BYTES];
    let mut offset = 0u64;

    loop {
        let read = pread(descriptor, &mut buffer, offset)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        offset += read as u64;
    }

    Ok(hasher.finalize().into())
}

/// Whether two open files hold exactly the same bytes.
///
/// This is the gate every content-equality mutation passes through. A digest
/// never stands in for it: a digest says two files are probably the same, and
/// "probably" is not a basis for releasing somebody's only copy of something.
pub fn bytes_equal(left: RawFd, right: RawFd) -> io::Result<bool> {
    if crate::sys::metadata_of(left)?.apparent_bytes
        != crate::sys::metadata_of(right)?.apparent_bytes
    {
        return Ok(false);
    }

    let mut left_buffer = vec![0u8; READ_BYTES];
    let mut right_buffer = vec![0u8; READ_BYTES];
    let mut offset = 0u64;

    loop {
        let read = pread(left, &mut left_buffer, offset)?;
        if read == 0 {
            // The other file was the same length a moment ago, so a short read
            // here means it is being written underneath us. Reading the rest
            // settles it rather than assuming either answer.
            return Ok(pread(right, &mut right_buffer, offset)? == 0);
        }
        if pread_exact(right, &mut right_buffer[..read], offset)? != read {
            return Ok(false);
        }
        if left_buffer[..read] != right_buffer[..read] {
            return Ok(false);
        }
        offset += read as u64;
    }
}

/// A digest as the lowercase hexadecimal a JSON field carries.
pub fn hex(digest: &[u8; 32]) -> String {
    let mut text = String::with_capacity(digest.len() * 2);
    for byte in digest {
        text.push(char::from_digit((byte >> 4) as u32, 16).expect("a hexadecimal nibble"));
        text.push(char::from_digit((byte & 0x0f) as u32, 16).expect("a hexadecimal nibble"));
    }
    text
}

/// Digest exactly `length` bytes starting at `offset`, refusing a short file.
///
/// A file that shrank between the `stat` and the read is a changed file, and a
/// digest taken over whatever was left would quietly describe something the
/// caller never saw.
fn digest_range(
    descriptor: RawFd,
    offset: u64,
    length: u64,
    hasher: &mut Sha256,
) -> io::Result<()> {
    let mut buffer = vec![0u8; READ_BYTES.min(length.max(1) as usize)];
    let mut remaining = length;
    let mut position = offset;

    while remaining > 0 {
        let wanted = remaining.min(buffer.len() as u64) as usize;
        let read = pread_exact(descriptor, &mut buffer[..wanted], position)?;
        if read != wanted {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the file ended before the range being digested",
            ));
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
        position += read as u64;
    }

    Ok(())
}

/// Fill `buffer` from `offset`, repeating the read until the file ends.
///
/// `pread` is allowed to return fewer bytes than asked for without the file
/// having ended, so a single call is never proof of anything.
fn pread_exact(descriptor: RawFd, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let read = pread(descriptor, &mut buffer[filled..], offset + filled as u64)?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(filled)
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
    use std::fs::File;
    use std::os::unix::io::AsRawFd;

    fn write(sandbox: &Sandbox, name: &str, bytes: &[u8]) -> File {
        let path = sandbox.path().join(name);
        std::fs::write(&path, bytes).expect("a sandbox file");
        File::open(&path).expect("the sandbox file opens")
    }

    fn sized(seed: u8, length: usize) -> Vec<u8> {
        (0..length)
            .map(|index| seed.wrapping_add(index as u8))
            .collect()
    }

    #[test]
    fn identical_files_hold_the_same_bytes() {
        let sandbox = Sandbox::new("content-equal");
        let left = write(&sandbox, "left", &sized(1, 300_000));
        let right = write(&sandbox, "right", &sized(1, 300_000));

        assert!(bytes_equal(left.as_raw_fd(), right.as_raw_fd()).expect("the compare runs"));
    }

    #[test]
    fn a_difference_in_the_final_byte_is_not_equality() {
        let sandbox = Sandbox::new("content-last-byte");
        let mut other = sized(1, 300_000);
        let last = other.len() - 1;
        other[last] ^= 0xff;

        let left = write(&sandbox, "left", &sized(1, 300_000));
        let right = write(&sandbox, "right", &other);

        assert!(!bytes_equal(left.as_raw_fd(), right.as_raw_fd()).expect("the compare runs"));
    }

    #[test]
    fn files_of_different_length_are_not_equal() {
        let sandbox = Sandbox::new("content-length");
        let left = write(&sandbox, "left", &sized(1, 4096));
        let right = write(&sandbox, "right", &sized(1, 4097));

        assert!(!bytes_equal(left.as_raw_fd(), right.as_raw_fd()).expect("the compare runs"));
    }

    #[test]
    fn two_empty_files_are_equal_and_digest_without_error() {
        let sandbox = Sandbox::new("content-empty");
        let left = write(&sandbox, "left", b"");
        let right = write(&sandbox, "right", b"");

        assert!(bytes_equal(left.as_raw_fd(), right.as_raw_fd()).expect("the compare runs"));
        assert_eq!(
            full_digest(left.as_raw_fd()).expect("an empty file digests"),
            full_digest(right.as_raw_fd()).expect("an empty file digests"),
        );
        assert_eq!(
            edge_digest(left.as_raw_fd(), 0).expect("an empty file digests at the edges"),
            edge_digest(right.as_raw_fd(), 0).expect("an empty file digests at the edges"),
        );
    }

    #[test]
    fn a_short_file_is_digested_whole_so_its_tail_still_counts() {
        let sandbox = Sandbox::new("content-short-tail");
        let mut other = sized(1, 1024);
        other[1023] ^= 0xff;

        let left = write(&sandbox, "left", &sized(1, 1024));
        let right = write(&sandbox, "right", &other);

        assert_ne!(
            edge_digest(left.as_raw_fd(), 1024).expect("the edge digest runs"),
            edge_digest(right.as_raw_fd(), 1024).expect("the edge digest runs"),
        );
    }

    #[test]
    fn the_edge_digest_reads_the_end_of_a_long_file() {
        let sandbox = Sandbox::new("content-long-tail");
        let length = 300_000;
        let mut other = sized(1, length);
        other[length - 1] ^= 0xff;

        let left = write(&sandbox, "left", &sized(1, length));
        let right = write(&sandbox, "right", &other);

        assert_ne!(
            edge_digest(left.as_raw_fd(), length as u64).expect("the edge digest runs"),
            edge_digest(right.as_raw_fd(), length as u64).expect("the edge digest runs"),
        );
    }

    #[test]
    fn the_edge_digest_cannot_see_a_change_in_the_middle_but_the_full_one_can() {
        let sandbox = Sandbox::new("content-middle");
        let length = 300_000;
        let mut other = sized(1, length);
        other[length / 2] ^= 0xff;

        let left = write(&sandbox, "left", &sized(1, length));
        let right = write(&sandbox, "right", &other);

        assert_eq!(
            edge_digest(left.as_raw_fd(), length as u64).expect("the edge digest runs"),
            edge_digest(right.as_raw_fd(), length as u64).expect("the edge digest runs"),
            "the edges are identical, which is exactly why a full digest follows it",
        );
        assert_ne!(
            full_digest(left.as_raw_fd()).expect("the full digest runs"),
            full_digest(right.as_raw_fd()).expect("the full digest runs"),
        );
        assert!(!bytes_equal(left.as_raw_fd(), right.as_raw_fd()).expect("the compare runs"));
    }

    #[test]
    fn the_edge_digest_separates_files_whose_common_ends_match() {
        let sandbox = Sandbox::new("content-length-mixed");
        let short = write(&sandbox, "short", &sized(1, 200_000));
        let long = write(&sandbox, "long", &sized(1, 300_000));

        assert_ne!(
            edge_digest(short.as_raw_fd(), 200_000).expect("the edge digest runs"),
            edge_digest(long.as_raw_fd(), 300_000).expect("the edge digest runs"),
        );
    }

    #[test]
    fn a_digest_reads_as_sixty_four_lowercase_hexadecimal_characters() {
        let sandbox = Sandbox::new("content-hex");
        let file = write(&sandbox, "file", b"disktop");

        let text = hex(&full_digest(file.as_raw_fd()).expect("the full digest runs"));

        assert_eq!(text.len(), 64);
        assert!(text.chars().all(|character| character.is_ascii_hexdigit()));
        assert_eq!(text, text.to_lowercase());
    }

    #[test]
    fn a_digest_does_not_depend_on_the_descriptor_offset() {
        let sandbox = Sandbox::new("content-offset");
        let file = write(&sandbox, "file", &sized(3, 300_000));

        let first = full_digest(file.as_raw_fd()).expect("the full digest runs");
        let second = full_digest(file.as_raw_fd()).expect("the full digest runs again");

        assert_eq!(first, second);
    }
}
