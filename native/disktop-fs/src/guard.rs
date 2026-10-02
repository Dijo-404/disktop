//! What the helper checks before it is allowed to change anything.
//!
//! Node already classified the target against `src/domain/protected-paths.ts`.
//! This does it again, from the other side of the process boundary, because a
//! bug on the Node side must not be enough to delete the wrong thing
//! (`adr/0004`). The helper is also the side holding descriptors, so it is the
//! only side that can check what a path *is* rather than what it is spelled.
//!
//! Three things happen here and nothing else: a target is judged against a
//! policy that no flag unlocks, its parent is resolved one segment at a time
//! without ever following a symlink, and its live identity is compared against
//! the fingerprint the reviewed plan recorded.

use crate::sys::{self, EntryKind, Metadata};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::RawFd;

/// Deliberately the same list as `PROTECTED_ROOTS` in
/// `src/domain/protected-paths.ts`. The duplication is the point: two
/// independent checks are worth more than one shared one. The two lists change
/// together, in the same commit.
const PROTECTED_ROOTS: [&[u8]; 19] = [
    b"/", b"/bin", b"/boot", b"/dev", b"/efi", b"/etc", b"/lib", b"/lib32", b"/lib64", b"/libx32",
    b"/opt", b"/proc", b"/root", b"/run", b"/sbin", b"/srv", b"/sys", b"/usr", b"/var",
];

/// Likewise `SHARED_CONTAINER_ROOTS`. These may hold a legitimate target; they
/// are never one themselves.
const SHARED_CONTAINER_ROOTS: [&[u8]; 6] = [
    b"/home",
    b"/media",
    b"/mnt",
    b"/run/media",
    b"/tmp",
    b"/var/tmp",
];

#[derive(Debug)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>) -> Refusal {
        Refusal {
            code,
            message: message.into(),
        }
    }
}

#[derive(Default)]
pub struct GuardContext {
    /// Disktop's own durable record. An action that could remove it could
    /// erase the evidence of what it did.
    pub journal_directory: Option<Vec<u8>>,
}

/// What a reviewed plan observed about one entry.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fingerprint {
    pub device: u64,
    pub inode: u64,
    pub mount_id: u64,
    pub kind: EntryKind,
    pub apparent_bytes: u64,
    pub modified_nanoseconds: u64,
}

/// A target's parent, held open, plus the final name to act on.
///
/// Holding the descriptor is what makes the operation that follows refer to
/// the directory this walk actually reached, rather than to a path somebody
/// could replace in between. The remaining race is on the final component
/// alone, and `docs/threat-model.md` says so rather than claiming otherwise.
#[derive(Debug)]
pub struct ResolvedParent {
    descriptor: RawFd,
    pub name: Vec<u8>,
}

impl ResolvedParent {
    pub fn descriptor(&self) -> RawFd {
        self.descriptor
    }
}

impl Drop for ResolvedParent {
    fn drop(&mut self) {
        sys::close(self.descriptor);
    }
}

#[derive(Debug)]
pub struct Guard {
    home: Vec<u8>,
    mount_roots: Vec<Vec<u8>>,
    excluded: Vec<Vec<u8>>,
}

impl Guard {
    pub fn new(context: &GuardContext) -> Result<Guard, Refusal> {
        Guard::from_parts(home_directory(), mount_roots(), context)
    }

    /// Fails closed. An empty mount table or an unresolvable home is a reading
    /// that did not work, not a system with nothing to protect, so it refuses
    /// every target rather than allowing every target.
    pub fn from_parts(
        home: Option<Vec<u8>>,
        mount_roots: Vec<Vec<u8>>,
        context: &GuardContext,
    ) -> Result<Guard, Refusal> {
        let Some(home) = home else {
            return Err(Refusal::new(
                "protected-path",
                "This user's home directory could not be resolved, so no target can be judged.",
            ));
        };
        if mount_roots.is_empty() {
            return Err(Refusal::new(
                "protected-path",
                "The mount table could not be read, so no target can be judged.",
            ));
        }
        let mut excluded = Vec::new();
        if let Some(journal) = &context.journal_directory {
            excluded.push(journal.clone());
        }
        Ok(Guard {
            home,
            mount_roots,
            excluded,
        })
    }

    /// The policy no option overrides.
    pub fn classify(&self, target: &[u8]) -> Result<(), Refusal> {
        if !is_absolute_normalised(target) {
            return Err(Refusal::new(
                "protected-path",
                "A target must be an absolute path with no empty, '.', or '..' segment.",
            ));
        }
        for root in PROTECTED_ROOTS {
            let hit = if root == b"/" {
                target == b"/"
            } else {
                is_within(root, target)
            };
            if hit {
                return Err(Refusal::new(
                    "protected-path",
                    "The target is a protected system root or below one.",
                ));
            }
        }
        if SHARED_CONTAINER_ROOTS.contains(&target) {
            return Err(Refusal::new(
                "protected-path",
                "The target is a shared container root holding other accounts' or programs' data.",
            ));
        }
        if target == self.home.as_slice() {
            return Err(Refusal::new(
                "protected-path",
                "The home directory itself is never a cleanup target.",
            ));
        }
        if self.mount_roots.iter().any(|mount| mount == target) {
            return Err(Refusal::new(
                "protected-path",
                "The target is a mount root.",
            ));
        }
        if self
            .mount_roots
            .iter()
            .any(|mount| mount != target && is_within(target, mount))
        {
            return Err(Refusal::new(
                "protected-path",
                "The target has another filesystem's mount point below it.",
            ));
        }
        if self
            .excluded
            .iter()
            .any(|excluded| is_within(excluded, target))
        {
            return Err(Refusal::new(
                "protected-path",
                "The target is inside Disktop's own state, which holds the record of what it did.",
            ));
        }
        Ok(())
    }

    /// Whether a move or a compress may publish into this directory.
    ///
    /// This is deliberately a different question from `classify`, and the
    /// mirror of `classifyDestination` in `src/domain/protected-paths.ts`. A
    /// target is something Disktop removes, so Node bounds it to roots the
    /// user allowed. A destination is somewhere Disktop writes, and the whole
    /// point of a cross-disk move is that the other disk is outside those
    /// roots — `/mnt/archive` is a correct answer here and an incorrect one
    /// there, so neither the allowlist nor the mount-root rule applies.
    ///
    /// What does apply is everything that says "not yours to write into": the
    /// protected system roots, the shared container roots themselves, and
    /// Disktop's own state, where an archive would sit beside the record of
    /// what Disktop did. Node checks this too; the helper does not take its
    /// word for it.
    pub fn classify_destination(&self, destination: &[u8]) -> Result<(), Refusal> {
        if !is_absolute_normalised(destination) {
            return Err(Refusal::new(
                "protected-path",
                "A destination must be an absolute path with no empty, '.', or '..' segment.",
            ));
        }
        for root in PROTECTED_ROOTS {
            let hit = if root == b"/" {
                destination == b"/"
            } else {
                is_within(root, destination)
            };
            if hit {
                return Err(Refusal::new(
                    "protected-path",
                    "The destination is a protected system root or below one.",
                ));
            }
        }
        if SHARED_CONTAINER_ROOTS.contains(&destination) {
            return Err(Refusal::new(
                "protected-path",
                "The destination is a shared container root holding other accounts' or programs' \
                 data; publish into a directory inside it instead.",
            ));
        }
        if self
            .excluded
            .iter()
            .any(|excluded| is_within(excluded, destination))
        {
            return Err(Refusal::new(
                "protected-path",
                "The destination is inside Disktop's own state, which holds the record of what it \
                 did.",
            ));
        }
        Ok(())
    }

    /// The longest mount point that holds this path. Trash selection needs it:
    /// a file's Trash lives at the top of the filesystem it is on.
    pub fn mount_point_for(&self, path: &[u8]) -> Option<Vec<u8>> {
        self.mount_roots
            .iter()
            .filter(|mount| is_within(mount, path))
            .max_by_key(|mount| mount.len())
            .cloned()
    }
}

/// Resolve everything above the final component, one segment at a time, never
/// through a symlink.
pub fn resolve_parent(target: &[u8]) -> Result<ResolvedParent, Refusal> {
    if !is_absolute_normalised(target) || target == b"/" {
        return Err(Refusal::new(
            "protected-path",
            "A target must be an absolute path with a final component.",
        ));
    }
    let segments = segments(target);
    let (name, parents) = segments
        .split_last()
        .expect("a normalised path has a segment");

    let mut descriptor = sys::open_filesystem_root().map_err(|error| {
        Refusal::new(
            "permission-denied",
            format!("The filesystem root could not be opened: {error}"),
        )
    })?;
    for segment in parents {
        match sys::open_directory_no_symlinks(descriptor, segment) {
            Ok(next) => {
                sys::close(descriptor);
                descriptor = next;
            }
            Err(error) => {
                // A refused open says little on its own: ENOTDIR is what this
                // kernel answers both for a symlink the walk will not follow
                // and for a directory that has become a file. The difference
                // is what the person needs to read, so it is looked up here
                // while the parent descriptor is still open.
                let link = sys::metadata_at(descriptor, segment)
                    .map(|metadata| metadata.kind == EntryKind::Symlink)
                    .unwrap_or(false);
                sys::close(descriptor);
                return Err(describe_resolution(segment, &error, link));
            }
        }
    }

    Ok(ResolvedParent {
        descriptor,
        name: name.to_vec(),
    })
}

/// Compare the live entry against what the plan reviewed.
///
/// Anything that differs stops the item: a replaced inode, a changed size, a
/// directory something was added to since review. A directory's modification
/// time is what makes that last case visible, which is how an addition to a
/// reviewed directory stops an erase.
pub fn revalidate(parent: &ResolvedParent, expected: &Fingerprint) -> Result<Metadata, Refusal> {
    let parent_metadata = sys::metadata_of(parent.descriptor()).map_err(|error| {
        Refusal::new(
            "permission-denied",
            format!("The target's parent directory could not be read: {error}"),
        )
    })?;
    if parent_metadata.writable_by_anyone_without_sticky {
        return Err(Refusal::new(
            "unsafe-parent",
            "The target's parent directory can be written by any user and is not sticky, so \
             another process could swap the target between the check and the operation.",
        ));
    }

    let live = sys::metadata_at(parent.descriptor(), &parent.name).map_err(|error| {
        if error.raw_os_error() == Some(libc::ENOENT) {
            Refusal::new(
                "changed-target",
                "The target is no longer there; nothing was changed.",
            )
        } else {
            Refusal::new(
                "permission-denied",
                format!("The target could not be read: {error}"),
            )
        }
    })?;

    // Identity is the device, the inode, the kind, the size, and the
    // modification time. The mount id is deliberately not part of it: Node
    // cannot read `stx_mnt_id` through its filesystem API, so it would be
    // comparing a number it had to invent. Nothing is lost by leaving it out
    // — a filesystem swapped under the parent has a different device number,
    // and a bind mount of the same filesystem reaching the same inode is the
    // same file.
    let matches = live.device == expected.device
        && live.inode == expected.inode
        && live.kind == expected.kind
        && live.apparent_bytes == expected.apparent_bytes
        && live.modified_nanoseconds == expected.modified_nanoseconds;
    if !matches {
        return Err(Refusal::new(
            "changed-target",
            "The live entry differs from the one the plan reviewed; nothing was changed.",
        ));
    }
    Ok(live)
}

/// Space an unprivileged process can still use on the filesystem holding
/// `path`. Read before and after an action so the result can report what
/// actually changed instead of what was selected.
pub fn free_bytes(path: &[u8]) -> Option<u64> {
    sys::available_bytes_at(path).ok()
}

/// Mount points as the kernel currently reports them, including bind mounts.
pub fn mount_roots() -> Vec<Vec<u8>> {
    let Ok(table) = std::fs::read("/proc/self/mountinfo") else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for line in table.split(|byte| *byte == b'\n') {
        // Field 5 is the mount point, after mount id, parent id, major:minor
        // and root. It is octal-escaped for space, tab, newline and backslash.
        let Some(field) = line.split(|byte| *byte == b' ').nth(4) else {
            continue;
        };
        let decoded = unescape_octal(field);
        if decoded.first() == Some(&b'/') {
            roots.push(decoded);
        }
    }
    roots
}

/// This process's home directory, from the password database first and the
/// environment second. Node is not asked: a guard that took its boundary from
/// the side it is guarding would not be one.
pub fn home_directory() -> Option<Vec<u8>> {
    if let Some(home) = passwd_home() {
        return Some(home);
    }
    let home = std::env::var_os("HOME")?;
    let bytes = home.as_bytes().to_vec();
    if bytes.first() == Some(&b'/') {
        Some(trim_trailing_slash(bytes))
    } else {
        None
    }
}

fn passwd_home() -> Option<Vec<u8>> {
    let mut buffer = vec![0i8; 4096];
    let mut passwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut passwd,
            buffer.as_mut_ptr() as *mut libc::c_char,
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() || passwd.pw_dir.is_null() {
        return None;
    }
    let directory = unsafe { std::ffi::CStr::from_ptr(passwd.pw_dir) }
        .to_bytes()
        .to_vec();
    if directory.first() == Some(&b'/') {
        Some(trim_trailing_slash(directory))
    } else {
        None
    }
}

fn trim_trailing_slash(mut path: Vec<u8>) -> Vec<u8> {
    while path.len() > 1 && path.last() == Some(&b'/') {
        path.pop();
    }
    path
}

/// mountinfo escapes space, tab, newline and backslash as three octal digits.
fn unescape_octal(field: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(field.len());
    let mut index = 0;
    while index < field.len() {
        if field[index] == b'\\' && index + 3 < field.len() {
            let digits = &field[index + 1..index + 4];
            if digits.iter().all(|byte| (b'0'..=b'7').contains(byte)) {
                let value = digits
                    .iter()
                    .fold(0u16, |total, byte| total * 8 + u16::from(byte - b'0'));
                decoded.push(value as u8);
                index += 4;
                continue;
            }
        }
        decoded.push(field[index]);
        index += 1;
    }
    decoded
}

fn describe_resolution(segment: &[u8], error: &io::Error, is_symlink: bool) -> Refusal {
    let name = String::from_utf8_lossy(segment).into_owned();
    if is_symlink {
        return Refusal::new(
            "protected-path",
            format!("'{name}' is a symlink, and a mutation never resolves one."),
        );
    }
    match error.raw_os_error() {
        Some(libc::ELOOP) | Some(libc::EXDEV) => Refusal::new(
            "protected-path",
            format!("'{name}' is a symlink, and a mutation never resolves one."),
        ),
        Some(libc::ENOENT) => Refusal::new(
            "changed-target",
            format!("'{name}' is no longer there; nothing was changed."),
        ),
        Some(libc::ENOTDIR) => Refusal::new(
            "changed-target",
            format!("'{name}' is not a directory any more; nothing was changed."),
        ),
        Some(libc::EINVAL) | Some(libc::ENOSYS) | Some(libc::EOPNOTSUPP) => Refusal::new(
            "unsupported-kernel",
            format!("This kernel refused the contained open of '{name}': {error}."),
        ),
        _ => Refusal::new(
            "permission-denied",
            format!("'{name}' could not be opened: {error}."),
        ),
    }
}

/// Absolute, no empty segment, no `.` or `..`, no trailing slash except the
/// root. The same rule as `isAbsoluteNormalized` in `src/domain/paths.ts`.
pub fn is_absolute_normalised(path: &[u8]) -> bool {
    if path.first() != Some(&b'/') {
        return false;
    }
    if path.len() == 1 {
        return true;
    }
    segments(path)
        .iter()
        .all(|segment| !segment.is_empty() && segment != b"." && segment != b"..")
}

fn segments(path: &[u8]) -> Vec<&[u8]> {
    path[1..].split(|byte| *byte == b'/').collect()
}

/// True when `child` is `parent` or below it, compared segment by segment, so
/// `/etc` does not contain `/etcetera`.
pub fn is_within(parent: &[u8], child: &[u8]) -> bool {
    if child.len() < parent.len() || !child.starts_with(parent) {
        return false;
    }
    child.len() == parent.len() || parent.last() == Some(&b'/') || child[parent.len()] == b'/'
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Sandbox;

    fn guard(sandbox: &Sandbox) -> Guard {
        Guard::new(&GuardContext {
            journal_directory: Some(sandbox.path().join("state").as_os_str().as_bytes().to_vec()),
        })
        .expect("this machine has a mount table and a home directory")
    }

    #[test]
    fn no_request_can_name_a_protected_root_or_anything_below_one() {
        let sandbox = Sandbox::new("guard-protected");
        let guard = guard(&sandbox);
        for target in [
            &b"/"[..],
            b"/etc",
            b"/etc/passwd",
            b"/usr",
            b"/usr/lib/x",
            b"/boot/vmlinuz",
            b"/var/log/syslog",
        ] {
            let refusal = guard.classify(target).expect_err("must be refused");
            assert_eq!(
                refusal.code,
                "protected-path",
                "{:?}",
                String::from_utf8_lossy(target)
            );
        }
    }

    #[test]
    fn a_shared_container_root_is_never_a_target_itself() {
        let sandbox = Sandbox::new("guard-container");
        let guard = guard(&sandbox);
        for target in [&b"/home"[..], b"/tmp", b"/mnt", b"/media"] {
            assert_eq!(
                guard.classify(target).expect_err("must be refused").code,
                "protected-path"
            );
        }
    }

    #[test]
    fn a_path_that_is_not_absolute_and_normalised_is_refused_rather_than_resolved() {
        let sandbox = Sandbox::new("guard-shape");
        let guard = guard(&sandbox);
        for target in [&b"tmp/x"[..], b"/a/../b", b"/a/./b", b"/a//b", b"/a/", b""] {
            assert_eq!(
                guard.classify(target).expect_err("must be refused").code,
                "protected-path",
                "{:?}",
                String::from_utf8_lossy(target)
            );
        }
    }

    #[test]
    fn the_home_directory_itself_is_never_a_target_but_what_is_under_it_can_be() {
        let sandbox = Sandbox::new("guard-home");
        let guard = guard(&sandbox);
        let home = home_directory().expect("this machine has a home directory");
        assert_eq!(
            guard
                .classify(&home)
                .expect_err("home itself is refused")
                .code,
            "protected-path"
        );

        let mut below = home.clone();
        below.extend_from_slice(b"/.cache/disktop-not-real");
        assert!(
            guard.classify(&below).is_ok(),
            "a path under home is a legitimate target"
        );
    }

    #[test]
    fn disktops_own_journal_is_not_something_an_action_may_remove() {
        let sandbox = Sandbox::new("guard-journal");
        let guard = guard(&sandbox);
        let mut inside = sandbox.bytes();
        inside.extend_from_slice(b"/state/journal-v1.sqlite");
        assert_eq!(
            guard.classify(&inside).expect_err("must be refused").code,
            "protected-path"
        );
    }

    #[test]
    fn a_sandbox_path_is_allowed() {
        let sandbox = Sandbox::new("guard-allowed");
        let guard = guard(&sandbox);
        let mut target = sandbox.bytes();
        target.extend_from_slice(b"/cache");
        assert!(guard.classify(&target).is_ok());
    }

    #[test]
    fn an_unreadable_mount_table_refuses_every_target_rather_than_none() {
        let refusal = Guard::from_parts(
            Some(b"/home/example".to_vec()),
            Vec::new(),
            &GuardContext::default(),
        )
        .expect_err("an empty mount table is a reading that failed");
        assert_eq!(refusal.code, "protected-path");

        let refusal = Guard::from_parts(None, vec![b"/".to_vec()], &GuardContext::default())
            .expect_err("an unresolvable home is a reading that failed");
        assert_eq!(refusal.code, "protected-path");
    }

    #[test]
    fn a_directory_with_a_mount_below_it_is_refused() {
        let guard = Guard::from_parts(
            Some(b"/home/example".to_vec()),
            vec![b"/".to_vec(), b"/home/example/projects/data".to_vec()],
            &GuardContext::default(),
        )
        .unwrap();
        let refusal = guard
            .classify(b"/home/example/projects")
            .expect_err("a tree holding a mount point is not a target");
        assert_eq!(refusal.code, "protected-path");
        assert!(guard.classify(b"/home/example/projects-old").is_ok());
        assert!(guard.classify(b"/home/example/projects/data/cache").is_ok());
    }

    #[test]
    fn a_mount_root_is_refused_even_though_nothing_above_it_is() {
        let guard = Guard::from_parts(
            Some(b"/home/example".to_vec()),
            vec![
                b"/".to_vec(),
                b"/srv/data".to_vec(),
                b"/home/example/vault".to_vec(),
            ],
            &GuardContext::default(),
        )
        .unwrap();
        assert_eq!(
            guard
                .classify(b"/home/example/vault")
                .expect_err("a mount root is not a target")
                .code,
            "protected-path"
        );
        assert!(guard.classify(b"/home/example/vault/cache").is_ok());
    }

    #[test]
    fn a_parent_reached_through_a_symlink_is_refused_rather_than_followed() {
        let sandbox = Sandbox::new("guard-symlink");
        sandbox.directory(b"real");
        sandbox.file(b"real/target", 16);
        sandbox.symlink(b"real", b"link");

        let mut through_link = sandbox.bytes();
        through_link.extend_from_slice(b"/link/target");
        let refusal = resolve_parent(&through_link).expect_err("a symlinked parent is refused");
        assert_eq!(refusal.code, "protected-path", "{}", refusal.message);

        let mut direct = sandbox.bytes();
        direct.extend_from_slice(b"/real/target");
        let resolved = resolve_parent(&direct).expect("a real parent resolves");
        assert_eq!(resolved.name, b"target");
    }

    #[test]
    fn revalidation_accepts_what_the_plan_saw_and_refuses_what_replaced_it() {
        let sandbox = Sandbox::new("guard-revalidate");
        sandbox.directory(b"work");
        let file = sandbox.file(b"work/data.bin", 1024);

        let mut target = sandbox.bytes();
        target.extend_from_slice(b"/work/data.bin");
        let parent = resolve_parent(&target).unwrap();
        let live = crate::sys::metadata_at(parent.descriptor(), &parent.name).unwrap();
        let expected = Fingerprint {
            device: live.device,
            inode: live.inode,
            mount_id: live.mount_id,
            kind: live.kind,
            apparent_bytes: live.apparent_bytes,
            modified_nanoseconds: live.modified_nanoseconds,
        };
        assert!(revalidate(&parent, &expected).is_ok());

        std::fs::remove_file(&file).unwrap();
        sandbox.file(b"work/data.bin", 2048);
        let parent = resolve_parent(&target).unwrap();
        assert_eq!(
            revalidate(&parent, &expected)
                .expect_err("a replaced file is not the reviewed one")
                .code,
            "changed-target"
        );
    }

    #[test]
    fn a_parent_anybody_can_write_to_is_refused_even_when_this_user_owns_it() {
        let sandbox = Sandbox::new("guard-unsafe-parent");
        sandbox.directory(b"open");
        sandbox.file(b"open/data.bin", 16);
        sandbox.chmod(b"open", 0o777);

        let mut target = sandbox.bytes();
        target.extend_from_slice(b"/open/data.bin");
        let parent = resolve_parent(&target).unwrap();
        let live = crate::sys::metadata_at(parent.descriptor(), &parent.name).unwrap();
        let expected = Fingerprint {
            device: live.device,
            inode: live.inode,
            mount_id: live.mount_id,
            kind: live.kind,
            apparent_bytes: live.apparent_bytes,
            modified_nanoseconds: live.modified_nanoseconds,
        };
        assert_eq!(
            revalidate(&parent, &expected)
                .expect_err("a world-writable parent is a race nobody can win")
                .code,
            "unsafe-parent"
        );
    }

    #[test]
    fn the_mount_holding_a_path_and_its_free_space_are_both_readable() {
        let sandbox = Sandbox::new("guard-mount");
        let guard = guard(&sandbox);
        let mount = guard
            .mount_point_for(&sandbox.bytes())
            .expect("every path is on a mount");
        assert!(
            sandbox.bytes().starts_with(&mount),
            "the mount point is a prefix of the path it holds"
        );
        assert!(free_bytes(&sandbox.bytes()).unwrap() > 0);
    }
}
