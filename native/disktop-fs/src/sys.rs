//! The Linux syscalls the scanner is allowed to make.
//!
//! Every descent is one `openat2` from an already-open parent descriptor with
//! `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`, and `RESOLVE_NO_MAGICLINKS`, so a
//! symlink, a `..`, or a procfs magic link cannot move the walk out of the
//! subtree it was given. Without `crossFilesystems`, `RESOLVE_NO_XDEV` also
//! refuses mount points, including bind mounts, and the walk enters only a
//! mount `mounts::SameFilesystem` has shown to be more of the same filesystem.
//! There is no fallback path that drops those guarantees: a kernel that cannot
//! provide them refuses the scan.

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

/// Where an open descriptor really is, as this process's mount namespace names
/// it, with every symlink in the path that opened it resolved.
pub fn descriptor_path(descriptor: RawFd) -> io::Result<Vec<u8>> {
    let link = std::fs::read_link(format!("/proc/self/fd/{descriptor}"))?;
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(link.as_os_str()).to_vec();
    if bytes.first() != Some(&b'/') {
        return Err(io::Error::from_raw_os_error(libc::ENOENT));
    }
    Ok(bytes)
}

/// Open one child directory of `parent` by name, contained and never through a
/// symlink. `cross_filesystems` relaxes mount crossing; the walk also passes it
/// for one mount it has already established belongs to the scanned filesystem.
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

/// Create a directory that must not already exist.
///
/// This is how anything Disktop stages as a directory is created: `EEXIST` is
/// the refusal, so a directory somebody else put at that name is never
/// mistaken for one this process made, written into, published, or removed.
pub fn mkdirat_exclusive(parent: RawFd, name: &[u8], mode: u32) -> io::Result<()> {
    let child = cstring(name)?;
    if unsafe { libc::mkdirat(parent, child.as_ptr(), mode as libc::mode_t) } < 0 {
        return Err(io::Error::last_os_error());
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
    #[cfg(test)]
    trace::record(trace::Event::Unlink {
        name: name.to_vec(),
    });
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
    #[cfg(test)]
    trace::record(trace::Event::Rename {
        to: new_name.to_vec(),
    });
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

/// Read where a symlink points, without following it.
pub fn readlinkat(parent: RawFd, name: &[u8]) -> io::Result<Vec<u8>> {
    let child = cstring(name)?;
    // PATH_MAX is a limit on a path, not on a link's contents; a few
    // filesystems allow longer. The buffer grows until the answer fits.
    let mut capacity = 1024;
    loop {
        let mut buffer = vec![0u8; capacity];
        let written = unsafe {
            libc::readlinkat(
                parent,
                child.as_ptr(),
                buffer.as_mut_ptr() as *mut libc::c_char,
                buffer.len(),
            )
        };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }
        let written = written as usize;
        if written < buffer.len() {
            buffer.truncate(written);
            return Ok(buffer);
        }
        if capacity >= 64 * 1024 {
            return Err(io::Error::other("the symlink's target is implausibly long"));
        }
        capacity *= 2;
    }
}

/// Create a symlink holding exactly these target bytes. The target is never
/// resolved, validated, or followed: it is copied as the string it is.
pub fn symlinkat(target: &[u8], parent: RawFd, name: &[u8]) -> io::Result<()> {
    let target = cstring(target)?;
    let child = cstring(name)?;
    let result = unsafe { libc::symlinkat(target.as_ptr(), parent, child.as_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Set an open file's permission bits.
///
/// Creating a file or a directory with a mode is not enough: the process umask
/// masks it, so a 0o666 file arrives as 0o644 and a copy quietly loses bits the
/// original had. Setting them afterwards is the only way a copy keeps them.
pub fn fchmod(descriptor: RawFd, permissions: u32) -> io::Result<()> {
    let result = unsafe { libc::fchmod(descriptor, permissions as libc::mode_t) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Copy a file's modification time onto an open descriptor.
pub fn set_modified(descriptor: RawFd, nanoseconds: u64) -> io::Result<()> {
    // Converted into whatever `tv_sec` is on this target rather than named:
    // the libc crate deprecates naming `time_t` on musl, and a value that does
    // not fit is refused rather than wrapped into a different date.
    let seconds = (nanoseconds / 1_000_000_000).try_into().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "The modification time does not fit this system's time type.",
        )
    })?;
    let times = [
        libc::timespec {
            tv_sec: 0,
            tv_nsec: libc::UTIME_OMIT,
        },
        libc::timespec {
            tv_sec: seconds,
            tv_nsec: (nanoseconds % 1_000_000_000) as i64,
        },
    ];
    let result = unsafe { libc::futimens(descriptor, times.as_ptr()) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Create a file that must not already exist, open for reading and writing,
/// with the given permission bits, never through a symlink.
///
/// Read-write rather than write-only because a staged copy is read back and
/// digested before it is published: a descriptor that could only be written
/// would make that verification impossible.
pub fn openat_create_exclusive(parent: RawFd, name: &[u8], mode: u32) -> io::Result<RawFd> {
    let child = cstring(name)?;
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags =
        (libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64;
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

/// Let this process hold as many descriptors as its hard limit allows.
///
/// Every walk over a tree keeps one directory open per level, and a copy keeps
/// two, so a tree at the depth limit needs more than the 1024 some machines
/// set as the soft limit. The hard limit is the administrator's ceiling and is
/// left alone; a failure here only means a very deep tree is refused with
/// `EMFILE` rather than handled.
pub fn raise_descriptor_limit() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0
        && limit.rlim_cur < limit.rlim_max
    {
        limit.rlim_cur = limit.rlim_max;
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) };
    }
}

/// Make a file's bytes durable before anything else depends on them existing.
///
/// For a directory, what becomes durable is its entries: a name created or
/// renamed into it is only certain to survive a crash once this returns.
pub fn fsync(descriptor: RawFd) -> io::Result<()> {
    if unsafe { libc::fsync(descriptor) } < 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(test)]
    trace::record(trace::Event::Fsync {
        inode: metadata_of(descriptor).map_or(0, |metadata| metadata.inode),
    });
    Ok(())
}

/// The order in which this thread made the calls a crash is judged by.
///
/// Durability cannot be observed from inside a running test — nothing is
/// lost until the power goes — but its precondition can: a name has to be
/// `fsync`ed into its directory before anything that depends on it surviving
/// happens. A test starts a trace, runs an action on the same thread, and
/// reads back the sequence.
#[cfg(test)]
pub mod trace {
    use std::cell::RefCell;

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Event {
        Fsync { inode: u64 },
        Rename { to: Vec<u8> },
        Unlink { name: Vec<u8> },
    }

    thread_local! {
        static EVENTS: RefCell<Option<Vec<Event>>> = const { RefCell::new(None) };
    }

    pub fn start() {
        EVENTS.with(|events| *events.borrow_mut() = Some(Vec::new()));
    }

    pub fn take() -> Vec<Event> {
        EVENTS.with(|events| events.borrow_mut().take().unwrap_or_default())
    }

    pub(super) fn record(event: Event) {
        EVENTS.with(|events| {
            if let Some(events) = events.borrow_mut().as_mut() {
                events.push(event);
            }
        });
    }
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

/// `struct statx_timestamp` from `<linux/stat.h>`.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct StatxTimestamp {
    tv_sec: i64,
    tv_nsec: u32,
    reserved: i32,
}

/// `struct statx` from `<linux/stat.h>`, as the kernel lays it out.
///
/// The helper calls `statx(2)` as a raw syscall with its own copy of the
/// structure rather than through libc's wrapper, because the `libc` crate only
/// exposes the wrapper, the structure, and the flags for musl when built with a
/// cfg asserting musl 1.2.3 — a static musl release build would otherwise need
/// that flag to compile at all. The layout is the kernel's ABI: fixed at 256
/// bytes since the call was added in Linux 4.11, with later fields taken from
/// the spare space at the end, so a buffer of this size is right for every
/// kernel.
#[repr(C)]
#[derive(Clone, Copy)]
// Fields this helper does not read are still part of the layout the kernel
// writes into.
#[allow(dead_code)]
struct RawStatx {
    stx_mask: u32,
    stx_blksize: u32,
    stx_attributes: u64,
    stx_nlink: u32,
    stx_uid: u32,
    stx_gid: u32,
    stx_mode: u16,
    spare0: u16,
    stx_ino: u64,
    stx_size: u64,
    stx_blocks: u64,
    stx_attributes_mask: u64,
    stx_atime: StatxTimestamp,
    stx_btime: StatxTimestamp,
    stx_ctime: StatxTimestamp,
    stx_mtime: StatxTimestamp,
    stx_rdev_major: u32,
    stx_rdev_minor: u32,
    stx_dev_major: u32,
    stx_dev_minor: u32,
    stx_mnt_id: u64,
    stx_dio_mem_align: u32,
    stx_dio_offset_align: u32,
    spare3: [u64; 12],
}

const _: () = assert!(size_of::<RawStatx>() == 0x100);

// From `<linux/fcntl.h>` and `<linux/stat.h>`; see `RawStatx` for why they are
// spelled out here.
const AT_STATX_DONT_SYNC: libc::c_int = 0x4000;
const STATX_TYPE: u32 = 0x0001;
const STATX_BASIC_STATS: u32 = 0x07ff;
const STATX_MNT_ID: u32 = 0x1000;

/// `statx(2)` into a zeroed buffer; the kernel fills in what `mask` asks for
/// and reports in `stx_mask` what it actually filled in.
fn raw_statx(parent: RawFd, name: &CString, flags: libc::c_int, mask: u32) -> io::Result<RawStatx> {
    let mut buffer = std::mem::MaybeUninit::<RawStatx>::zeroed();
    let result = unsafe {
        libc::syscall(
            libc::SYS_statx,
            parent,
            name.as_ptr(),
            flags,
            mask,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    // Every field is an integer and the buffer started zeroed, so whatever the
    // kernel did not write is a valid zero rather than uninitialised memory.
    Ok(unsafe { buffer.assume_init() })
}

/// Metadata for one directory entry, never following a final symlink.
pub fn metadata_at(parent: RawFd, name: &[u8]) -> io::Result<Metadata> {
    metadata_at_flags(parent, name, libc::AT_SYMLINK_NOFOLLOW | AT_STATX_DONT_SYNC)
}

fn metadata_at_flags(parent: RawFd, name: &[u8], flags: libc::c_int) -> io::Result<Metadata> {
    let child = cstring(name)?;
    let stat = raw_statx(parent, &child, flags, STATX_BASIC_STATS | STATX_MNT_ID)?;

    let mode = u32::from(stat.stx_mode);
    let kind = match mode & libc::S_IFMT {
        libc::S_IFREG => EntryKind::File,
        libc::S_IFDIR => EntryKind::Directory,
        libc::S_IFLNK => EntryKind::Symlink,
        _ => EntryKind::Other,
    };

    let device = device_number(stat.stx_dev_major, stat.stx_dev_minor);
    let mount_id = if stat.stx_mask & STATX_MNT_ID != 0 {
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
    raw_statx(
        parent,
        &child,
        AT_STATX_DONT_SYNC | libc::AT_NO_AUTOMOUNT,
        STATX_TYPE,
    )
    .is_ok()
}

/// Metadata for an already-open descriptor, used for a scan root.
pub fn metadata_of(descriptor: RawFd) -> io::Result<Metadata> {
    metadata_at_flags(descriptor, b"", libc::AT_EMPTY_PATH | AT_STATX_DONT_SYNC)
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

/// Close a descriptor this code owns, exactly once.
///
/// A second close of the same number is not harmless: between the two, any
/// other thread may have been handed that number for something else — the
/// journal's database, a file being copied — and the second close would take
/// it away from under it. `EBADF` is the only trace a double close leaves when
/// nothing reused the number, so a debug build treats it as the bug it is.
pub fn close(descriptor: RawFd) {
    let result = unsafe { libc::close(descriptor) };
    debug_assert!(
        result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::EBADF),
        "descriptor {descriptor} was closed although nothing owned it any more",
    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;

    /// The raw `statx` call reads its own copy of the kernel's structure, so it
    /// is checked field by field against what the standard library's `lstat`
    /// says about the same entries: a file, a directory, a symlink, and an
    /// open descriptor.
    #[test]
    fn the_raw_statx_call_reads_what_lstat_reads() {
        use std::os::unix::fs::MetadataExt;
        let sandbox = Sandbox::new("sys-raw-statx");
        sandbox.file(b"file", 70_000);
        sandbox.directory(b"directory");
        sandbox.symlink(b"/nonexistent/target", b"link");
        sandbox.hardlink(b"file", b"second-name");
        sandbox.chmod(b"directory", 0o1750);
        let parent = open_root(&sandbox.bytes()).unwrap();

        for (name, kind) in [
            (&b"file"[..], EntryKind::File),
            (b"directory", EntryKind::Directory),
            (b"link", EntryKind::Symlink),
        ] {
            let ours = metadata_at(parent, name).unwrap();
            let theirs =
                std::fs::symlink_metadata(sandbox.path().join(std::str::from_utf8(name).unwrap()))
                    .unwrap();
            let label = String::from_utf8_lossy(name);
            assert_eq!(ours.kind, kind, "{label}");
            assert_eq!(ours.device, theirs.dev(), "{label}");
            assert_eq!(ours.inode, theirs.ino(), "{label}");
            assert_eq!(ours.link_count, theirs.nlink(), "{label}");
            assert_eq!(ours.apparent_bytes, theirs.size(), "{label}");
            assert_eq!(ours.allocated_bytes, theirs.blocks() * 512, "{label}");
            assert_eq!(ours.owner_id, theirs.uid(), "{label}");
            assert_eq!(ours.group_id, theirs.gid(), "{label}");
            assert_eq!(ours.permissions, theirs.mode() & 0o7777, "{label}");
            assert_eq!(
                ours.modified_nanoseconds,
                theirs.mtime() as u64 * 1_000_000_000 + theirs.mtime_nsec() as u64,
                "{label}"
            );
        }
        assert_eq!(metadata_at(parent, b"file").unwrap().link_count, 2);
        assert_eq!(
            metadata_at(parent, b"directory").unwrap().permissions,
            0o1750,
            "the sticky bit comes through"
        );

        let descriptor = openat_read_no_symlinks(parent, b"file").unwrap();
        let through_descriptor = metadata_of(descriptor).unwrap();
        assert_eq!(
            through_descriptor.inode,
            metadata_at(parent, b"file").unwrap().inode
        );
        close(descriptor);

        assert!(target_exists(parent, b"file"));
        assert!(
            !target_exists(parent, b"link"),
            "a dangling link resolves to nothing"
        );
        assert_eq!(
            metadata_at(parent, b"missing").unwrap_err().raw_os_error(),
            Some(libc::ENOENT),
            "an error comes back with its errno",
        );
        close(parent);
    }

    /// The check every other test relies on to catch a descriptor closed by two
    /// owners: without it, a double close only shows up as some other thread's
    /// file vanishing, which is a flaky test rather than a failing one.
    #[test]
    #[should_panic(expected = "closed although nothing owned it")]
    fn closing_a_descriptor_twice_is_caught_in_a_debug_build() {
        let sandbox = Sandbox::new("sys-double-close");
        sandbox.file(b"file", 1);
        let parent = open_root(&sandbox.bytes()).unwrap();
        let descriptor = openat_read_no_symlinks(parent, b"file").unwrap();
        close(parent);
        close(descriptor);
        close(descriptor);
    }
}
