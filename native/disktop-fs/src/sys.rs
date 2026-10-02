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
#[derive(Debug)]
pub struct Metadata {
    pub kind: EntryKind,
    pub device: u64,
    pub inode: u64,
    pub mount_id: u64,
    pub link_count: u64,
    pub apparent_bytes: u64,
    pub allocated_bytes: u64,
    pub owner_id: u32,
    pub group_id: u32,
    /// Permission bits only, without the file-type bits `kind` already carries.
    pub permissions: u32,
    pub modified_nanoseconds: u64,
    /// Group- or world-writable with no sticky bit. Any user can then create,
    /// rename, and unlink entries inside it, whoever owns it, so a reviewed
    /// target in such a directory can be swapped under a check nobody can win.
    pub writable_by_anyone_without_sticky: bool,
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

/// Open one child directory of `parent` by name, never through a symlink, and
/// allowing the descent to cross a mount.
///
/// A mutation resolves its target from `/` one segment at a time, and a home
/// directory is routinely its own mount, so refusing to cross one here would
/// refuse most of the paths a person actually wants cleaned. Containment comes
/// from `RESOLVE_BENEATH` and `RESOLVE_NO_SYMLINKS`: each step can only reach
/// the single name it was given, and never through a link.
pub fn open_directory_no_symlinks(parent: RawFd, name: &[u8]) -> io::Result<RawFd> {
    let child = cstring(name)?;
    openat2_raw(
        parent,
        &child,
        (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW) as u64,
        libc::RESOLVE_BENEATH | libc::RESOLVE_NO_MAGICLINKS | libc::RESOLVE_NO_SYMLINKS,
    )
}

/// Open one child file of `parent` for reading, never through a symlink.
///
/// This is how content is read: a digest, a byte compare, and a copy all go
/// through it, so none of them can be pointed at something outside the
/// directory the walk actually reached.
pub fn openat_read_no_symlinks(parent: RawFd, name: &[u8]) -> io::Result<RawFd> {
    let child = cstring(name)?;
    openat2_raw(
        parent,
        &child,
        (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
        libc::RESOLVE_BENEATH | libc::RESOLVE_NO_MAGICLINKS | libc::RESOLVE_NO_SYMLINKS,
    )
}

/// Open the filesystem root. It has no component that could be a symlink.
pub fn open_filesystem_root() -> io::Result<RawFd> {
    let name = CString::new("/").expect("a literal without a NUL byte");
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

/// Create and open a file that must not already exist, never through a symlink.
///
/// This is how Trash metadata is reserved: the exclusive create is what makes
/// two Disktops, or a Disktop and a file manager, unable to claim one name.
pub fn openat_write_exclusive(parent: RawFd, name: &[u8], mode: u32) -> io::Result<RawFd> {
    let child = cstring(name)?;
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags =
        (libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64;
    how.mode = u64::from(mode);
    how.resolve = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_MAGICLINKS | libc::RESOLVE_NO_SYMLINKS;
    let result = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent,
            child.as_ptr(),
            &how as *const libc::open_how as *const c_void,
            size_of::<libc::open_how>(),
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(result as RawFd)
}

/// Create a directory under `parent`. An existing one is not an error here;
/// the caller checks what it found.
pub fn mkdirat(parent: RawFd, name: &[u8], mode: u32) -> io::Result<()> {
    let child = cstring(name)?;
    let result = unsafe { libc::mkdirat(parent, child.as_ptr(), mode as libc::mode_t) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EEXIST) {
            return Ok(());
        }
        return Err(error);
    }
    Ok(())
}

/// Remove one name. `directory` chooses `rmdir` semantics over `unlink`.
pub fn unlinkat(parent: RawFd, name: &[u8], directory: bool) -> io::Result<()> {
    let child = cstring(name)?;
    let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
    let result = unsafe { libc::unlinkat(parent, child.as_ptr(), flags) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Rename without ever replacing what is already at the destination.
///
/// `RENAME_NOREPLACE` is the whole safety property of a Trash move and of an
/// undo: the kernel refuses rather than overwriting, so no race between the
/// check and the rename can cost somebody a file. A kernel or filesystem that
/// cannot offer it refuses the action; there is no fallback that checks first
/// and renames afterwards.
pub fn renameat_no_replace(
    old_parent: RawFd,
    old_name: &[u8],
    new_parent: RawFd,
    new_name: &[u8],
) -> io::Result<()> {
    let old = cstring(old_name)?;
    let new = cstring(new_name)?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            old_parent,
            old.as_ptr(),
            new_parent,
            new.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Give an existing file a second name under `new_parent`.
///
/// `flags` is zero, so the old name is never followed through a symlink: a link
/// is made to the link object itself, which is what a caller that already
/// validated the file it opened means. The new name must not exist; `EEXIST` is
/// what makes a staging name exclusive without a separate check.
pub fn linkat(
    old_parent: RawFd,
    old_name: &[u8],
    new_parent: RawFd,
    new_name: &[u8],
) -> io::Result<()> {
    let old = cstring(old_name)?;
    let new = cstring(new_name)?;
    let result = unsafe {
        libc::linkat(
            old_parent,
            old.as_ptr(),
            new_parent,
            new.as_ptr(),
            // Deliberately not AT_SYMLINK_FOLLOW: following here would link to
            // whatever a symlink points at, outside everything that was checked.
            0,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Swap two names atomically. Both must exist.
///
/// This is how a file is replaced without the name ever pointing at nothing:
/// after the exchange the reviewed name holds the new inode and the staging
/// name holds the old one, and removing the staging name is what releases it.
/// `RENAME_EXCHANGE` needs Linux 3.15 and a filesystem that supports it; one
/// that does not refuses with `EINVAL` and the caller reports that rather than
/// falling back to a sequence that has a window where the name is gone.
pub fn renameat_exchange(
    first_parent: RawFd,
    first_name: &[u8],
    second_parent: RawFd,
    second_name: &[u8],
) -> io::Result<()> {
    let first = cstring(first_name)?;
    let second = cstring(second_name)?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            first_parent,
            first.as_ptr(),
            second_parent,
            second.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Space an unprivileged process can still use on the filesystem holding
/// `path`: what `df` calls available and what a person means by free space.
/// The blocks reserved for root are left out, because they are not space this
/// user could reclaim.
pub fn available_bytes_at(path: &[u8]) -> io::Result<u64> {
    let name = cstring(path)?;
    let mut buffer = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    let result = unsafe { libc::statvfs(name.as_ptr(), buffer.as_mut_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    let stat = unsafe { buffer.assume_init() };
    let unit = if stat.f_frsize == 0 {
        stat.f_bsize
    } else {
        stat.f_frsize
    };
    Ok(stat.f_bavail.saturating_mul(unit))
}

/// Make a file's bytes durable before anything else depends on them existing.
pub fn fsync(descriptor: RawFd) -> io::Result<()> {
    if unsafe { libc::fsync(descriptor) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
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

    let shared_write = mode & (libc::S_IWGRP | libc::S_IWOTH) != 0;
    let sticky = mode & libc::S_ISVTX != 0;

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
        group_id: stat.stx_gid,
        permissions: mode & 0o7777,
        modified_nanoseconds: nanoseconds(stat.stx_mtime.tv_sec, stat.stx_mtime.tv_nsec),
        writable_by_anyone_without_sticky: shared_write && !sticky,
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
