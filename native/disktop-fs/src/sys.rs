//! The Linux syscalls the scanner is allowed to make.
//!
//! Every descent is one `openat2` from an already-open parent descriptor with
//! `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`, and `RESOLVE_NO_MAGICLINKS`, so a
//! symlink, a `..`, or a procfs magic link cannot move the walk out of the
//! subtree it was given. Without `crossFilesystems`, `RESOLVE_NO_XDEV` also
//! refuses mount points, including bind mounts. There is no fallback path that
//! drops those guarantees: a kernel that cannot provide them refuses the scan.

use std::ffi::{CString, c_void};
use std::io;
use std::os::unix::io::RawFd;

/// `stx_mnt_id` needs Linux 5.8; below that the device number is the only
/// mount identity available, and a bind mount of one filesystem is
/// indistinguishable from the original.
pub struct Metadata {
    pub kind: EntryKind,
    pub device: u64,
    pub inode: u64,
    pub mount_id: u64,
    pub link_count: u64,
    pub apparent_bytes: u64,
    pub allocated_bytes: u64,
    pub owner_id: u32,
    pub modified_nanoseconds: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::File => "file",
            EntryKind::Directory => "directory",
            EntryKind::Symlink => "symlink",
            EntryKind::Other => "other",
        }
    }

    pub fn code(self) -> i64 {
        match self {
            EntryKind::File => 0,
            EntryKind::Directory => 1,
            EntryKind::Symlink => 2,
            EntryKind::Other => 3,
        }
    }

    pub fn from_code(code: i64) -> EntryKind {
        match code {
            0 => EntryKind::File,
            1 => EntryKind::Directory,
            2 => EntryKind::Symlink,
            _ => EntryKind::Other,
        }
    }
}

/// True when the kernel accepts `openat2` with the containment flags the
/// scanner depends on. A false answer disables scanning rather than relaxing it.
pub fn openat2_available() -> Result<(), io::Error> {
    let directory = CString::new(".").expect("a literal without a NUL byte");
    let descriptor = openat2_raw(
        libc::AT_FDCWD,
        &directory,
        (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY) as u64,
        libc::RESOLVE_BENEATH | libc::RESOLVE_NO_MAGICLINKS,
    )?;
    close(descriptor);
    Ok(())
}

/// Open a scan root. Intermediate symlinks in a path the user typed are
/// resolved here, once; every descent below it is contained.
pub fn open_root(path: &[u8]) -> io::Result<RawFd> {
    let name = cstring(path)?;
    let descriptor = unsafe {
        libc::open(
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(descriptor)
}

/// Open one child directory of `parent` by name, contained and never through a
/// symlink. `cross_filesystems` is the only thing that relaxes mount crossing.
pub fn open_child_directory(
    parent: RawFd,
    name: &[u8],
    cross_filesystems: bool,
) -> io::Result<RawFd> {
    let child = cstring(name)?;
    let mut resolve =
        libc::RESOLVE_BENEATH | libc::RESOLVE_NO_MAGICLINKS | libc::RESOLVE_NO_SYMLINKS;
    if !cross_filesystems {
        resolve |= libc::RESOLVE_NO_XDEV;
    }
    openat2_raw(
        parent,
        &child,
        (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW) as u64,
        resolve,
    )
}

fn openat2_raw(parent: RawFd, name: &CString, flags: u64, resolve: u64) -> io::Result<RawFd> {
    // `libc::open_how` is non-exhaustive, so it is zeroed and filled in
    // rather than built with a struct literal; the kernel requires the
    // unnamed tail to be zero anyway.
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = flags;
    how.mode = 0;
    how.resolve = resolve;
    let result = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent,
            name.as_ptr(),
            &how as *const libc::open_how as *const c_void,
            size_of::<libc::open_how>(),
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(result as RawFd)
}

/// Metadata for one directory entry, never following a final symlink.
pub fn metadata_at(parent: RawFd, name: &[u8]) -> io::Result<Metadata> {
    metadata_at_flags(
        parent,
        name,
        libc::AT_SYMLINK_NOFOLLOW | libc::AT_STATX_DONT_SYNC,
    )
}

fn metadata_at_flags(parent: RawFd, name: &[u8], flags: libc::c_int) -> io::Result<Metadata> {
    let child = cstring(name)?;
    let mut buffer = std::mem::MaybeUninit::<libc::statx>::zeroed();
    let result = unsafe {
        libc::statx(
            parent,
            child.as_ptr(),
            flags,
            libc::STATX_BASIC_STATS | libc::STATX_MNT_ID,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { buffer.assume_init() };

    let mode = u32::from(stat.stx_mode);
    let kind = match mode & libc::S_IFMT {
        libc::S_IFREG => EntryKind::File,
        libc::S_IFDIR => EntryKind::Directory,
        libc::S_IFLNK => EntryKind::Symlink,
        _ => EntryKind::Other,
    };

    let device = device_number(stat.stx_dev_major, stat.stx_dev_minor);
    let mount_id = if stat.stx_mask & libc::STATX_MNT_ID != 0 {
        stat.stx_mnt_id
    } else {
        device
    };

    Ok(Metadata {
        kind,
        device,
        inode: stat.stx_ino,
        mount_id,
        link_count: u64::from(stat.stx_nlink),
        apparent_bytes: stat.stx_size,
        // st_blocks is always in 512-byte units, whatever the filesystem's
        // block size is, so allocated bytes are exact rather than estimated.
        allocated_bytes: stat.stx_blocks.saturating_mul(512),
        owner_id: stat.stx_uid,
        modified_nanoseconds: nanoseconds(stat.stx_mtime.tv_sec, stat.stx_mtime.tv_nsec),
    })
}

/// Whether the name resolves to anything at all, following a final symlink.
///
/// This is how a dangling link is told from a live one. It is a metadata read
/// and never an open, so nothing the link points at is held, executed, or
/// descended into; a link that leaves the subtree is answered for and then
/// forgotten.
pub fn target_exists(parent: RawFd, name: &[u8]) -> bool {
    let Ok(child) = cstring(name) else {
        return false;
    };
    let mut buffer = std::mem::MaybeUninit::<libc::statx>::zeroed();
    let result = unsafe {
        libc::statx(
            parent,
            child.as_ptr(),
            libc::AT_STATX_DONT_SYNC | libc::AT_NO_AUTOMOUNT,
            libc::STATX_TYPE,
            buffer.as_mut_ptr(),
        )
    };
    result == 0
}

/// Metadata for an already-open descriptor, used for a scan root.
pub fn metadata_of(descriptor: RawFd) -> io::Result<Metadata> {
    metadata_at_flags(
        descriptor,
        b"",
        libc::AT_EMPTY_PATH | libc::AT_STATX_DONT_SYNC,
    )
}

fn device_number(major: u32, minor: u32) -> u64 {
    libc::makedev(major, minor)
}

/// Clamp pre-epoch timestamps to zero: the contract's nanosecond field is an
/// unsigned decimal, and a negative time is not worth a signed wire format.
fn nanoseconds(seconds: i64, nanoseconds: u32) -> u64 {
    if seconds < 0 {
        return 0;
    }
    (seconds as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(u64::from(nanoseconds))
}

pub fn close(descriptor: RawFd) {
    unsafe { libc::close(descriptor) };
}

fn cstring(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

/// A directory stream that owns its descriptor and closes it once.
///
/// The descriptor stays reachable while the stream is open, so `openat2` and
/// `statx` below it resolve from the directory this walk actually opened rather
/// than from a path that could have been replaced in between.
pub struct Directory {
    stream: *mut libc::DIR,
}

impl Directory {
    /// Takes ownership of `descriptor`; it is closed when the stream is dropped.
    pub fn from_descriptor(descriptor: RawFd) -> io::Result<Directory> {
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            close(descriptor);
            return Err(error);
        }
        Ok(Directory { stream })
    }

    pub fn descriptor(&self) -> RawFd {
        unsafe { libc::dirfd(self.stream) }
    }

    /// The next name in the stream, as raw bytes, skipping `.` and `..`.
    pub fn next_name(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            // readdir reports end-of-stream and failure the same way, so errno
            // is cleared first to tell them apart.
            unsafe { *libc::__errno_location() = 0 };
            let entry = unsafe { libc::readdir64(self.stream) };
            if entry.is_null() {
                let error = io::Error::last_os_error();
                return match error.raw_os_error() {
                    Some(0) | None => Ok(None),
                    _ => Err(error),
                };
            }
            let name = unsafe { name_bytes(&(*entry).d_name) };
            if name == b"." || name == b".." {
                continue;
            }
            return Ok(Some(name));
        }
    }
}

unsafe fn name_bytes(field: &[libc::c_char]) -> Vec<u8> {
    let mut name = Vec::new();
    for byte in field {
        if *byte == 0 {
            break;
        }
        name.push(*byte as u8);
    }
    name
}

impl Drop for Directory {
    fn drop(&mut self) {
        unsafe { libc::closedir(self.stream) };
    }
}

// The stream is only ever touched by the thread that owns the walk; the raw
// pointer is what keeps `Directory` from deriving this on its own.
unsafe impl Send for Directory {}
