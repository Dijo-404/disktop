import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkNoticeInputs, runtimePackages } from "../../scripts/native-notices.mjs";

test("native notices are current and cover the embedded libraries and all runtime assets", async () => {
  await checkNoticeInputs();
  const notices = await readFile("THIRD_PARTY_NOTICES", "utf8");
  for (const required of ["Rust crate sha2 ", "Rust crate zstd ", "Rust crate libc ", "Embedded SQLite", "disclaims copyright", "Embedded Zstandard", "BSD 2-Clause", "LICENSE-UNICODE"]) {
    assert.ok(notices.includes(required), `missing full attribution: ${required}`);
  }
  const runtime = JSON.parse(await readFile("scripts/licenses/runtime.json", "utf8"));
  for (const asset of runtime.assets) {
    assert.ok(notices.includes(`=== ${asset.name} ${asset.version} ===`), asset.name);
    assert.ok(notices.includes(await readFile(asset.file, "utf8")), `${asset.name} text was truncated or replaced`);
  }
});

test("a dependency update, altered runtime licence, or truncated notice body fails the offline gate", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "disktop-native-notices-"));
  try {
    const notices = await readFile("THIRD_PARTY_NOTICES", "utf8");
    const inputs = /\nSource inputs \(SHA-256\):\n([\s\S]*?)\nEnd source inputs\.\n/.exec(notices)[1];
    const paths = inputs.split("\n").map((line) => line.slice(66));
    for (const path of ["THIRD_PARTY_NOTICES", ...paths]) {
      await mkdir(dirname(join(sandbox, path)), { recursive: true });
      await writeFile(join(sandbox, path), await readFile(path));
    }
    await checkNoticeInputs(sandbox);
    const lock = "native/disktop-fs/Cargo.lock";
    await writeFile(join(sandbox, lock), `${await readFile(lock, "utf8")}\n`);
    await assert.rejects(checkNoticeInputs(sandbox), /stale/);
    await writeFile(join(sandbox, lock), await readFile(lock));
    await writeFile(join(sandbox, "THIRD_PARTY_NOTICES"), notices.slice(0, -64));
    await assert.rejects(checkNoticeInputs(sandbox), /incomplete or changed/);
    await writeFile(join(sandbox, "THIRD_PARTY_NOTICES"), notices);
    const runtime = JSON.parse(await readFile("scripts/licenses/runtime.json", "utf8"));
    await writeFile(join(sandbox, runtime.assets[0].file), "not the upstream copyright text\n");
    await assert.rejects(checkNoticeInputs(sandbox), /Runtime licence asset changed/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("normal transitive and generated-code dependencies are covered, while build and dev tools are excluded", () => {
  const dependency = (pkg, kind) => ({ pkg, dep_kinds: [{ kind }] });
  const metadata = {
    packages: ["helper", "runtime", "proc-macro", "unicode", "build-tool", "test-only"].map((id) => ({ id, name: id })),
    resolve: {
      root: "helper",
      nodes: [
        { id: "helper", deps: [dependency("runtime", null), dependency("proc-macro", null), dependency("build-tool", "build"), dependency("test-only", "dev")] },
        { id: "runtime", deps: [dependency("unicode", null)] },
        { id: "proc-macro", deps: [dependency("unicode", null)] },
        { id: "unicode", deps: [] },
      ],
    },
  };
  assert.deepEqual(runtimePackages(metadata).map((entry) => entry.name).sort(), ["proc-macro", "runtime", "unicode"]);
});
