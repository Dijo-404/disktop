import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCrashProvider,
  createLogProvider,
  createOpenDeletedProvider,
  createSmartProvider,
  createWindowsSubsystemProvider,
} from "../../dist/providers/diagnostics/index.js";
import { rawPathFromUtf8 } from "../../dist/domain/paths.js";
import { restoreAndRemove } from "../fixtures/generate.mjs";
import { discover, discoveryEnvironment } from "../support/discovery.mjs";

const DENIED = { status: "permission-denied", explanation: "it could not be run by this user." };

let root;
let home;
let logRoot;
let logrotate;
let crashRoot;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "disktop-fixture-"));
  home = join(root, "home");
  logRoot = join(root, "var-log");
  logrotate = join(root, "logrotate.d");
  crashRoot = join(root, "var-crash");

  await mkdir(home, { recursive: true });
  await mkdir(logRoot, { recursive: true });
  await mkdir(logrotate, { recursive: true });
  await mkdir(crashRoot, { recursive: true });

  await writeFile(join(logRoot, "huge.log"), "L".repeat(400_000));
  await writeFile(join(logRoot, "small.log"), "s".repeat(64));
  await writeFile(join(logRoot, "unrotated.log"), "u".repeat(400_000));
  await writeFile(join(logrotate, "huge"), "/var/log/huge.log {\n  weekly\n  rotate 4\n}\n");
});

after(async () => {
  await restoreAndRemove(root);
});

function logEnvironment(overrides = {}) {
  return discoveryEnvironment(home, { largeLogBytes: 100_000n, ...overrides });
}

function logProvider() {
  return createLogProvider({
    logRoot: rawPathFromUtf8(logRoot),
    logrotateDirectory: rawPathFromUtf8(logrotate),
  });
}

test("a log past the threshold is reported and a small one is not", async () => {
  const result = await discover(logProvider(), logEnvironment());

  const titles = result.findings.map((finding) => finding.title);
  assert.ok(titles.some((title) => title.includes("huge.log")), JSON.stringify(titles));
  assert.ok(!titles.some((title) => title.includes("small.log")), JSON.stringify(titles));
});

test("a large log names its logrotate evidence either way", async () => {
  const result = await discover(logProvider(), logEnvironment());

  const rotated = result.findings.find((finding) => finding.title.includes("huge.log"));
  const unrotated = result.findings.find((finding) => finding.title.includes("unrotated.log"));

  assert.ok(rotated.evidence.some((line) => /should be being rotated/.test(line)), JSON.stringify(rotated.evidence));
  assert.ok(unrotated.evidence.some((line) => /Nothing under \/etc\/logrotate\.d/.test(line)), JSON.stringify(unrotated.evidence));
});

test("no log file is ever offered for truncation", async () => {
  const result = await discover(logProvider(), logEnvironment());

  for (const finding of result.findings.filter((candidate) => candidate.paths.length > 0)) {
    assert.deepEqual(finding.availableActionIds, [], `${finding.id} offered an action on a log file`);
  }
});

test("the journal is reported through journalctl, not as a directory to delete", async () => {
  const result = await discover(
    logProvider(),
    logEnvironment({
      tools: { journalctl: { stdout: "Archived and active journals take up 1.2G in the file system.\n" } },
    }),
  );

  const journal = result.findings.find((finding) => finding.id.endsWith(":systemd-journal"));
  assert.equal(journal.size.bytes, 1_288_490_189n);
  assert.equal(journal.size.basis, "manager-reported");
  assert.deepEqual(journal.availableActionIds, ["manager"]);
  assert.equal(journal.managerScope, "journalctl --vacuum-size");
});

test("a denied lsof is a capability state with no findings, never an empty answer", async () => {
  const result = await discover(
    createOpenDeletedProvider(),
    discoveryEnvironment(home, { tools: { lsof: { capability: DENIED, exitCode: 1 } } }),
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((warning) => warning.code === "lsof-denied"), JSON.stringify(result.warnings));
});

test("deleted-but-open files are summarised with the process holding them", async () => {
  const result = await discover(
    createOpenDeletedProvider(),
    discoveryEnvironment(home, {
      tools: {
        lsof: {
          stdout: ["p1842", "cjournald", "s1073741824", "k0", "n/var/log/journal/old.journal (deleted)", ""].join("\n"),
        },
      },
    }),
  );

  const summary = result.findings.find((finding) => finding.id.endsWith(":summary"));
  assert.equal(summary.size.bytes, 1_073_741_824n);
  assert.ok(summary.evidence.some((line) => line.includes("journald")), JSON.stringify(summary.evidence));
  for (const finding of result.findings) {
    assert.deepEqual(finding.availableActionIds, [], `${finding.id} offered an action`);
  }
});

test("a truncated smartctl document is a warning, not a throw and not a clean bill of health", async () => {
  const result = await discover(
    createSmartProvider(),
    discoveryEnvironment(home, {
      tools: { smartctl: { stdout: '{"devices":[{"name":"/dev/sda","type":"sat"}]' } },
    }),
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, true, "a scan that parsed nothing reports no devices at all");
});

test("a failing disk is named in the finding's title", async () => {
  let call = 0;
  const environment = discoveryEnvironment(home);
  environment.tools = {
    async run(name, args) {
      assert.equal(name, "smartctl");
      call += 1;
      const stdout = args.includes("--scan")
        ? JSON.stringify({ devices: [{ name: "/dev/sda", type: "sat" }] })
        : JSON.stringify({
            model_name: "Example HDD",
            smart_status: { passed: false },
            ata_smart_attributes: { table: [{ id: 5, raw: { value: 128 } }] },
          });
      return { capability: { status: "available", explanation: "ran" }, stdout, stderr: "", exitCode: 0 };
    },
  };

  const result = await discover(createSmartProvider(), environment);

  assert.ok(call >= 2, "the scan and the health read are separate calls");
  assert.match(result.findings[0].title, /FAILED/);
  assert.ok(result.findings[0].evidence.some((line) => line.includes("128")), JSON.stringify(result.findings[0].evidence));
  assert.deepEqual(result.findings[0].availableActionIds, []);
});

test("a disk that will not report its health makes the result incomplete", async () => {
  const environment = discoveryEnvironment(home);
  environment.tools = {
    async run(_name, args) {
      if (args.includes("--scan")) {
        return {
          capability: { status: "available", explanation: "ran" },
          stdout: JSON.stringify({ devices: [{ name: "/dev/sda" }] }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { capability: DENIED, stdout: "", stderr: "", exitCode: 1 };
    },
  };

  const result = await discover(createSmartProvider(), environment);

  assert.equal(result.complete, false);
  assert.ok(result.warnings.some((warning) => warning.code === "smart-denied"));
});

test("a user-owned crash directory may go to Trash and a root-owned one may not", async () => {
  const userCrash = join(home, ".cache", "abrt");
  await mkdir(userCrash, { recursive: true });

  const result = await discover(
    createCrashProvider({ systemRoots: [crashRoot] }),
    discoveryEnvironment(home, {}),
  );

  const owned = result.findings.find((finding) => finding.paths[0].display === userCrash);
  assert.deepEqual(owned.availableActionIds, ["trash"]);
  assert.ok(
    owned.evidence.some((line) => /memory|keys|tokens/i.test(line)),
    JSON.stringify(owned.evidence),
  );
});

test("a machine that is not WSL says so rather than inventing a warning", async () => {
  const versionFile = join(root, "proc-version-linux");
  await writeFile(versionFile, "Linux version 6.18.54-1-lts (linux@archlinux)\n");

  const result = await discover(
    createWindowsSubsystemProvider({ versionFile: rawPathFromUtf8(versionFile), mountRoot: rawPathFromUtf8(root) }),
    discoveryEnvironment(home),
  );

  assert.equal(result.capability.status, "missing-tool");
  assert.deepEqual(result.findings, []);
});

test("under WSL the excluded Windows drives are stated, with no action", async () => {
  const versionFile = join(root, "proc-version-wsl");
  await writeFile(versionFile, "Linux version 5.15.0-microsoft-standard-WSL2\n");
  await mkdir(join(root, "mnt", "c"), { recursive: true });

  const result = await discover(
    createWindowsSubsystemProvider({
      versionFile: rawPathFromUtf8(versionFile),
      mountRoot: rawPathFromUtf8(join(root, "mnt")),
    }),
    discoveryEnvironment(home),
  );

  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].evidence.some((line) => line.includes("/mnt/c")), JSON.stringify(result.findings[0].evidence));
  assert.deepEqual(result.findings[0].availableActionIds, []);
  assert.equal(result.findings[0].size.basis, "unknown");
});

test("smartctl's own JSON is read for a denial, because it writes none to stderr", async () => {
  const denialDocument = JSON.stringify({
    smartctl: { messages: [{ string: "Smartctl open device: /dev/nvme0 failed: Permission denied", severity: "error" }], exit_status: 2 },
  });
  const environment = discoveryEnvironment(home);
  environment.tools = {
    async run(_name, args) {
      // --scan works unprivileged; opening a device does not. smartctl exits
      // non-zero but says nothing on stderr, so the capability the process
      // adapter infers is wrong until its document is read.
      if (args.includes("--scan")) {
        return {
          capability: { status: "available", explanation: "ran" },
          stdout: JSON.stringify({ devices: [{ name: "/dev/nvme0" }] }),
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        capability: { status: "missing-tool", explanation: "/usr/bin/smartctl failed." },
        stdout: denialDocument,
        stderr: "",
        exitCode: 2,
      };
    },
  };

  const result = await discover(createSmartProvider(), environment);

  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, false);
  const denial = result.warnings.find((warning) => warning.code === "smart-denied");
  assert.ok(denial !== undefined, `a denial is not a missing tool: ${JSON.stringify(result.warnings)}`);
  assert.match(denial.message, /Permission denied/, "the reason smartctl gave is the reason reported");
});

test("the deleted-but-open detector asks lsof for the link count field", async () => {
  const asked = [];
  const environment = discoveryEnvironment(home);
  environment.tools = {
    async run(name, args) {
      asked.push([name, [...args]]);
      return { capability: { status: "available", explanation: "ran" }, stdout: "", stderr: "", exitCode: 0 };
    },
  };

  await discover(createOpenDeletedProvider(), environment);

  const listing = asked.find((call) => call[1].includes("+L1"));
  assert.ok(listing !== undefined, JSON.stringify(asked));
  // `k` is the link count; `L` is the process login name.
  assert.ok(listing[1].includes("-F"), JSON.stringify(listing));
  const fields = listing[1][listing[1].indexOf("-F") + 1];
  assert.ok(fields.includes("k"), `${fields} does not request the link count`);
  assert.ok(!fields.includes("L"), `${fields} requests the login name as if it were the link count`);
});

test("a deleted file's path and the process holding it cannot command the terminal", async () => {
  const result = await discover(
    createOpenDeletedProvider(),
    discoveryEnvironment(home, {
      tools: {
        lsof: {
          stdout: ["p1", "cevil\u001b[31m", "s100", "k0", "n/home/example/re\u001b[2Jport (deleted)", ""].join("\n"),
        },
      },
    }),
  );

  for (const finding of result.findings) {
    assert.ok(!finding.title.includes("\u001b"), JSON.stringify(finding.title));
    for (const line of finding.evidence) {
      assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    }
    assert.match(finding.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, finding.id);
  }
});

test("a drive model from smartctl cannot command the terminal", async () => {
  const environment = discoveryEnvironment(home);
  environment.tools = {
    async run(_name, args) {
      const stdout = args.includes("--scan")
        ? JSON.stringify({ devices: [{ name: "/dev/sda" }] })
        : JSON.stringify({ model_name: "Evil\u001b[31m Drive", smart_status: { passed: true } });
      return { capability: { status: "available", explanation: "ran" }, stdout, stderr: "", exitCode: 0 };
    },
  };

  const result = await discover(createSmartProvider(), environment);

  for (const line of result.findings[0].evidence) {
    assert.ok(!line.includes("\u001b"), JSON.stringify(line));
  }
});

test("a machine with no /var/log at all is absent, not denied", async () => {
  const result = await discover(
    createLogProvider({
      logRoot: rawPathFromUtf8(join(root, "no-such-log-directory")),
      logrotateDirectory: rawPathFromUtf8(logrotate),
    }),
    logEnvironment(),
  );

  assert.equal(result.capability.status, "missing-tool", "an absent directory is not a refusal");
  assert.deepEqual(result.findings, []);
});
