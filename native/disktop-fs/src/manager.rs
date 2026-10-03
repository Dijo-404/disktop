//! Journal records for an action a package or container manager carries out.
//!
//! The helper never runs a manager command. Node runs the reviewed command and
//! reports each step here, so the record of what was asked, what started, and
//! what came back stays in the one journal a crash is judged against.

use crate::journal::{Journal, Outcome, State};
use std::path::PathBuf;

pub const MANAGER_TOOLS: [&str; 11] = [
    "apt-get",
    "dpkg",
    "dnf",
    "rpm",
    "pacman",
    "journalctl",
    "snap",
    "flatpak",
    "docker",
    "podman",
    "systemd-tmpfiles",
];

const MAX_COMMANDS: usize = 500;
const MAX_ITEMS: usize = 10_000;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 512;
const MAX_ITEM_BYTES: usize = 256;
const MAX_OUTPUT_BYTES: usize = 16 * 1024;

pub struct ManagerCommand {
    pub tool: String,
    pub arguments: Vec<String>,
}

pub struct ManagerItem {
    pub id: String,
    pub bytes: Option<u64>,
}

pub struct BeginRequest {
    pub plan_id: String,
    pub journal_directory: PathBuf,
    pub adapter: String,
    pub action: String,
    pub privilege: String,
    pub commands: Vec<ManagerCommand>,
    pub items: Vec<ManagerItem>,
    pub estimated_bytes: Option<u64>,
    pub free_bytes_before: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Started,
    Finished,
}

pub struct AppendRequest {
    pub journal_directory: PathBuf,
    pub action_id: String,
    pub command: u64,
    pub phase: Phase,
    pub exit_code: Option<i64>,
    pub output: Option<String>,
}

pub struct Verdict {
    pub position: u64,
    pub outcome: Outcome,
    pub message: Option<String>,
}

pub struct FinishRequest {
    pub journal_directory: PathBuf,
    pub action_id: String,
    pub items: Vec<Verdict>,
    pub observed: Vec<String>,
    pub free_bytes_after: Option<u64>,
}

pub struct ManagerSummary {
    pub journal_id: String,
    pub state: State,
    pub completed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub selected_bytes: Option<u64>,
    pub free_bytes_before: Option<u64>,
    pub free_bytes_after: Option<u64>,
}

pub type Refused = (&'static str, String);

fn invalid(message: impl Into<String>) -> Refused {
    ("invalid-arguments", message.into())
}

fn printable(value: &str, max: usize) -> bool {
    value.len() <= max && !value.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn open(directory: &std::path::Path) -> Result<Journal, Refused> {
    Journal::open(directory).map_err(|error| {
        (
            "journal-write-failed",
            format!("The action journal could not be opened: {error}"),
        )
    })
}

fn recorded<T>(outcome: rusqlite::Result<T>) -> Result<T, Refused> {
    outcome.map_err(|error| {
        (
            "journal-write-failed",
            format!("The manager action could not be recorded: {error}"),
        )
    })
}

/// Only the helper that began an action may add to it, and only while it runs.
fn owned(journal: &Journal, action_id: &str) -> Result<(), Refused> {
    match recorded(journal.owner(action_id))? {
        Some((pid, State::InProgress)) if pid == i64::from(std::process::id()) => Ok(()),
        _ => Err((
            "unknown-request",
            "That manager action is not one this helper has open.".to_owned(),
        )),
    }
}

pub fn begin(request: &BeginRequest) -> Result<String, Refused> {
    if !identifier(&request.plan_id) {
        return Err(invalid(
            "planId must be 1 to 128 letters, digits, '.', '-', or '_'",
        ));
    }
    for name in [&request.adapter, &request.action] {
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || matches!(byte, b'.' | b'-'))
        {
            return Err(invalid("adapter and action are lowercase names"));
        }
    }
    if request.privilege != "user" && request.privilege != "root" {
        return Err(invalid("privilege is 'user' or 'root'"));
    }
    if request.commands.is_empty() || request.commands.len() > MAX_COMMANDS {
        return Err(invalid(format!(
            "A manager action runs 1 to {MAX_COMMANDS} commands"
        )));
    }
    for command in &request.commands {
        if !MANAGER_TOOLS.contains(&command.tool.as_str()) {
            return Err(invalid(format!(
                "'{}' is not a manager tool this helper journals",
                command.tool
            )));
        }
        if command.arguments.len() > MAX_ARGUMENTS
            || command
                .arguments
                .iter()
                .any(|argument| !printable(argument, MAX_ARGUMENT_BYTES))
        {
            return Err(invalid(
                "A command argument is too long or holds a control byte",
            ));
        }
    }
    if request.items.len() > MAX_ITEMS {
        return Err(invalid(format!(
            "A manager action names at most {MAX_ITEMS} items"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for item in &request.items {
        if item.id.is_empty() || !printable(&item.id, MAX_ITEM_BYTES) || !seen.insert(&item.id) {
            return Err(invalid(
                "An item id is empty, too long, repeated, or holds a control byte",
            ));
        }
    }

    let journal = open(&request.journal_directory)?;
    let commands: Vec<(String, Vec<String>)> = request
        .commands
        .iter()
        .map(|command| (command.tool.clone(), command.arguments.clone()))
        .collect();
    let items: Vec<(Vec<u8>, u64)> = request
        .items
        .iter()
        .map(|item| (item.id.as_bytes().to_vec(), item.bytes.unwrap_or(0)))
        .collect();
    recorded(journal.begin_manager(
        &request.plan_id,
        &request.adapter,
        &request.action,
        &request.privilege,
        &commands,
        &items,
        request.estimated_bytes,
        request.free_bytes_before,
    ))
}

pub fn append(request: &AppendRequest) -> Result<(), Refused> {
    if let Some(output) = &request.output
        && (output.len() > MAX_OUTPUT_BYTES || output.contains('\0'))
    {
        return Err(invalid("output is at most 16 KiB of text"));
    }
    if request.phase == Phase::Started && (request.exit_code.is_some() || request.output.is_some())
    {
        return Err(invalid(
            "A command that has only started has no exit status or output yet",
        ));
    }
    let journal = open(&request.journal_directory)?;
    owned(&journal, &request.action_id)?;
    let current = recorded(journal.command_state(&request.action_id, request.command))?
        .ok_or_else(|| invalid("That action has no command at that position"))?;
    let (required, next) = match request.phase {
        Phase::Started => ("pending", "started"),
        Phase::Finished => ("started", "finished"),
    };
    if current != required {
        return Err(invalid(format!(
            "That command is {current}, so it cannot be marked {next}"
        )));
    }
    recorded(journal.set_command(
        &request.action_id,
        request.command,
        next,
        request.exit_code,
        request.output.as_deref(),
    ))
}

pub fn finish(request: &FinishRequest) -> Result<ManagerSummary, Refused> {
    let journal = open(&request.journal_directory)?;
    owned(&journal, &request.action_id)?;
    let record = recorded(journal.get(&request.action_id))?.ok_or_else(|| {
        (
            "unknown-request",
            "That action is not in the journal.".to_owned(),
        )
    })?;
    let manager = record
        .manager
        .as_ref()
        .ok_or_else(|| invalid("That action was not begun as a manager action"))?;
    if manager
        .commands
        .iter()
        .any(|command| command.state == "started")
    {
        return Err(invalid(
            "A command started and has not finished, so the action cannot be finished",
        ));
    }

    let declared = record.items.len();
    let mut verdicts: Vec<Option<&Verdict>> = vec![None; declared];
    for verdict in &request.items {
        let slot = usize::try_from(verdict.position)
            .ok()
            .and_then(|position| verdicts.get_mut(position))
            .ok_or_else(|| invalid("A verdict names an item this action did not declare"))?;
        if slot.is_some() {
            return Err(invalid("A verdict names the same item twice"));
        }
        if !matches!(
            verdict.outcome,
            Outcome::Completed | Outcome::Skipped | Outcome::Failed
        ) {
            return Err(invalid("An item ends completed, skipped, or failed"));
        }
        if let Some(message) = &verdict.message
            && !printable(message, MAX_OUTPUT_BYTES)
        {
            return Err(invalid(
                "A verdict's message is too long or holds a control byte",
            ));
        }
        *slot = Some(verdict);
    }
    if verdicts.iter().any(Option::is_none) {
        return Err(invalid("A finish names what became of every declared item"));
    }
    if request.observed.len() > MAX_ITEMS
        || request
            .observed
            .iter()
            .any(|id| id.is_empty() || !printable(id, MAX_ITEM_BYTES))
    {
        return Err(invalid(
            "An observed item id is empty, too long, or holds a control byte",
        ));
    }

    let mut completed = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    for (item, verdict) in record.items.iter().zip(verdicts.iter().flatten()) {
        recorded(journal.record_outcome(
            &request.action_id,
            item.position,
            verdict.outcome,
            verdict.message.as_deref(),
            item.bytes,
            None,
        ))?;
        match verdict.outcome {
            Outcome::Completed => completed += 1,
            Outcome::Skipped => skipped += 1,
            _ => failed += 1,
        }
    }
    for (offset, id) in request.observed.iter().enumerate() {
        recorded(journal.add_observed(
            &request.action_id,
            (declared + offset) as u64,
            id.as_bytes(),
        ))?;
        completed += 1;
    }

    let clean = manager
        .commands
        .iter()
        .all(|command| command.state == "finished" && command.exit_code == Some(0));
    let state = if skipped == 0 && failed == 0 && clean {
        State::Complete
    } else {
        State::Partial
    };
    recorded(journal.finish(
        &request.action_id,
        state,
        &crate::journal::Counts {
            completed,
            skipped,
            failed,
            selected_bytes: manager.estimated_bytes.unwrap_or(0),
            trashed_bytes: 0,
        },
        request.free_bytes_after,
    ))?;

    Ok(ManagerSummary {
        journal_id: request.action_id.clone(),
        state,
        completed,
        skipped,
        failed,
        selected_bytes: manager.estimated_bytes,
        free_bytes_before: record.free_bytes_before,
        free_bytes_after: request.free_bytes_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::tests_support::abandon;
    use crate::testing::Sandbox;

    fn request(sandbox: &Sandbox, commands: usize, items: usize) -> BeginRequest {
        BeginRequest {
            plan_id: "plan-0123456789abcd".to_owned(),
            journal_directory: sandbox.path().join("state"),
            adapter: "docker".to_owned(),
            action: "docker.remove-dangling-images".to_owned(),
            privilege: "user".to_owned(),
            commands: (0..commands)
                .map(|index| ManagerCommand {
                    tool: "docker".to_owned(),
                    arguments: vec![
                        "image".into(),
                        "rm".into(),
                        "--".into(),
                        format!("sha256:{index}"),
                    ],
                })
                .collect(),
            items: (0..items)
                .map(|index| ManagerItem {
                    id: format!("sha256:{index}"),
                    bytes: Some(100),
                })
                .collect(),
            estimated_bytes: Some(100 * items as u64),
            free_bytes_before: Some(1_000),
        }
    }

    fn step(
        sandbox: &Sandbox,
        id: &str,
        command: u64,
        phase: Phase,
        exit_code: Option<i64>,
    ) -> Result<(), Refused> {
        append(&AppendRequest {
            journal_directory: sandbox.path().join("state"),
            action_id: id.to_owned(),
            command,
            phase,
            exit_code,
            output: None,
        })
    }

    fn verdicts(outcomes: &[Outcome]) -> Vec<Verdict> {
        outcomes
            .iter()
            .enumerate()
            .map(|(position, outcome)| Verdict {
                position: position as u64,
                outcome: *outcome,
                message: None,
            })
            .collect()
    }

    fn close(
        sandbox: &Sandbox,
        id: &str,
        items: Vec<Verdict>,
        observed: Vec<String>,
    ) -> Result<ManagerSummary, Refused> {
        finish(&FinishRequest {
            journal_directory: sandbox.path().join("state"),
            action_id: id.to_owned(),
            items,
            observed,
            free_bytes_after: Some(1_100),
        })
    }

    fn journal(sandbox: &Sandbox) -> Journal {
        Journal::open(&sandbox.path().join("state")).unwrap()
    }

    #[test]
    fn every_item_removed_and_every_command_clean_reads_complete() {
        let sandbox = Sandbox::new("manager-complete");
        let id = begin(&request(&sandbox, 2, 2)).unwrap();
        for command in 0..2 {
            step(&sandbox, &id, command, Phase::Started, None).unwrap();
            step(&sandbox, &id, command, Phase::Finished, Some(0)).unwrap();
        }
        let summary = close(
            &sandbox,
            &id,
            verdicts(&[Outcome::Completed, Outcome::Completed]),
            vec![],
        )
        .unwrap();
        assert_eq!(summary.state, State::Complete);
        assert_eq!(summary.completed, 2);
        assert_eq!(summary.selected_bytes, Some(200));
        let record = journal(&sandbox).get(&id).unwrap().unwrap();
        assert_eq!(record.operation, "manager");
        let manager = record.manager.expect("a manager record");
        assert_eq!(manager.action, "docker.remove-dangling-images");
        assert_eq!(manager.commands[1].state, "finished");
        assert_eq!(manager.commands[1].exit_code, Some(0));
    }

    #[test]
    fn a_command_that_exited_non_zero_keeps_the_action_partial() {
        let sandbox = Sandbox::new("manager-exit");
        let id = begin(&request(&sandbox, 1, 1)).unwrap();
        step(&sandbox, &id, 0, Phase::Started, None).unwrap();
        step(&sandbox, &id, 0, Phase::Finished, Some(1)).unwrap();
        let summary = close(&sandbox, &id, verdicts(&[Outcome::Completed]), vec![]).unwrap();
        assert_eq!(summary.state, State::Partial);
    }

    #[test]
    fn a_command_never_started_keeps_the_action_partial() {
        let sandbox = Sandbox::new("manager-unstarted");
        let id = begin(&request(&sandbox, 2, 2)).unwrap();
        step(&sandbox, &id, 0, Phase::Started, None).unwrap();
        step(&sandbox, &id, 0, Phase::Finished, Some(0)).unwrap();
        let summary = close(
            &sandbox,
            &id,
            verdicts(&[Outcome::Completed, Outcome::Skipped]),
            vec![],
        )
        .unwrap();
        assert_eq!(summary.state, State::Partial);
        assert_eq!(summary.skipped, 1);
    }

    #[test]
    fn finishing_while_a_command_is_still_running_is_refused() {
        let sandbox = Sandbox::new("manager-running");
        let id = begin(&request(&sandbox, 1, 1)).unwrap();
        step(&sandbox, &id, 0, Phase::Started, None).unwrap();
        let refused = close(&sandbox, &id, verdicts(&[Outcome::Completed]), vec![])
            .err()
            .unwrap();
        assert_eq!(refused.0, "invalid-arguments");
    }

    #[test]
    fn a_finish_that_leaves_out_a_declared_item_is_refused() {
        let sandbox = Sandbox::new("manager-missing-verdict");
        let id = begin(&request(&sandbox, 2, 2)).unwrap();
        assert!(close(&sandbox, &id, verdicts(&[Outcome::Skipped]), vec![]).is_err());
    }

    #[test]
    fn phases_go_in_order_and_only_once() {
        let sandbox = Sandbox::new("manager-order");
        let id = begin(&request(&sandbox, 1, 1)).unwrap();
        assert!(
            step(&sandbox, &id, 0, Phase::Finished, Some(0)).is_err(),
            "finished before started"
        );
        step(&sandbox, &id, 0, Phase::Started, None).unwrap();
        assert!(
            step(&sandbox, &id, 0, Phase::Started, None).is_err(),
            "started twice"
        );
        assert!(
            step(&sandbox, &id, 1, Phase::Started, None).is_err(),
            "no such command"
        );
    }

    #[test]
    fn another_process_cannot_append_to_or_finish_this_action() {
        let sandbox = Sandbox::new("manager-owner");
        let id = begin(&request(&sandbox, 1, 1)).unwrap();
        journal(&sandbox)
            .connection_for_tests()
            .execute("UPDATE action SET owner_pid = 1 WHERE id = ?1", [&id])
            .unwrap();
        assert_eq!(
            step(&sandbox, &id, 0, Phase::Started, None)
                .err()
                .unwrap()
                .0,
            "unknown-request"
        );
        assert_eq!(
            close(&sandbox, &id, verdicts(&[Outcome::Skipped]), vec![])
                .err()
                .unwrap()
                .0,
            "unknown-request"
        );
    }

    #[test]
    fn a_shell_or_a_nul_byte_never_reaches_the_journal() {
        let sandbox = Sandbox::new("manager-shell");
        let mut shell = request(&sandbox, 1, 0);
        shell.commands[0].tool = "sh".to_owned();
        assert_eq!(begin(&shell).err().unwrap().0, "invalid-arguments");
        let mut nul = request(&sandbox, 1, 0);
        nul.commands[0].arguments.push("a\0b".to_owned());
        assert_eq!(begin(&nul).err().unwrap().0, "invalid-arguments");
        let mut privilege = request(&sandbox, 1, 0);
        privilege.privilege = "admin".to_owned();
        assert!(begin(&privilege).is_err());
    }

    #[test]
    fn a_crash_after_a_command_started_reads_uncertain() {
        let sandbox = Sandbox::new("manager-crash-started");
        let id = begin(&request(&sandbox, 1, 1)).unwrap();
        step(&sandbox, &id, 0, Phase::Started, None).unwrap();
        let journal = journal(&sandbox);
        abandon(&journal, &id);
        assert_eq!(journal.reconcile().unwrap(), 1);
        let record = journal.get(&id).unwrap().unwrap();
        assert_eq!(record.state, State::Uncertain);
        assert_eq!(record.manager.unwrap().commands[0].state, "uncertain");
        assert_eq!(record.items[0].outcome, Outcome::Uncertain);
        assert_eq!(
            journal.reconcile().unwrap(),
            0,
            "reconciling again changes nothing"
        );
    }

    #[test]
    fn a_crash_before_anything_ran_with_no_items_reads_partial() {
        let sandbox = Sandbox::new("manager-crash-early");
        let mut empty = request(&sandbox, 1, 0);
        empty.action = "docker.prune-build-cache".to_owned();
        empty.estimated_bytes = None;
        let id = begin(&empty).unwrap();
        let journal = journal(&sandbox);
        abandon(&journal, &id);
        journal.reconcile().unwrap();
        assert_eq!(journal.get(&id).unwrap().unwrap().state, State::Partial);
    }

    #[test]
    fn what_a_manager_chose_for_itself_is_recorded_as_observed() {
        let sandbox = Sandbox::new("manager-observed");
        let mut flatpak = request(&sandbox, 1, 0);
        flatpak.adapter = "flatpak".to_owned();
        flatpak.action = "flatpak.remove-unused-user".to_owned();
        flatpak.commands[0].tool = "flatpak".to_owned();
        flatpak.estimated_bytes = None;
        let id = begin(&flatpak).unwrap();
        step(&sandbox, &id, 0, Phase::Started, None).unwrap();
        step(&sandbox, &id, 0, Phase::Finished, Some(0)).unwrap();
        let summary = close(
            &sandbox,
            &id,
            vec![],
            vec!["runtime/org.gnome.Platform/x86_64/44".to_owned()],
        )
        .unwrap();
        assert_eq!(summary.state, State::Complete);
        assert_eq!(summary.completed, 1);
        assert_eq!(summary.selected_bytes, None);
        let record = journal(&sandbox).get(&id).unwrap().unwrap();
        assert_eq!(
            record.items[0].path,
            b"runtime/org.gnome.Platform/x86_64/44"
        );
        assert_eq!(record.items[0].outcome, Outcome::Completed);
    }
}
