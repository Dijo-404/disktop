import tseslint from "typescript-eslint";

const DESTRUCTIVE_FS = ["rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "rename", "renameSync"];

const destructiveCallRefusal =
  "Only the Rust helper may mutate arbitrary filesystem paths. Route this through a reviewed action plan.";

/**
 * Refuse `fs.rm(...)` and friends reached through a namespace or default import.
 *
 * Each selector is anchored to `.callee`, because `>` alone also matches a call's
 * arguments: `parse(row["rm"])` reading an lsblk column is not a deletion, and a
 * rule that refuses it teaches people to work around the rule.
 */
const noDestructiveMemberCalls = {
  "no-restricted-syntax": [
    "error",
    ...DESTRUCTIVE_FS.flatMap((name) => [
      { selector: `CallExpression > MemberExpression.callee[property.name='${name}']`, message: destructiveCallRefusal },
      // fs["rm"](...) reaches the same function without a dotted name.
      { selector: `CallExpression > MemberExpression.callee[computed=true][property.value='${name}']`, message: destructiveCallRefusal },
      // const { rm } = fs; escapes no-restricted-imports, which sees only the default import.
      { selector: `ObjectPattern > Property[key.name='${name}']`, message: destructiveCallRefusal },
    ]),
  ],
};

const destructiveImportRefusals = ["node:fs", "node:fs/promises"].map((name) => ({
  name,
  importNames: DESTRUCTIVE_FS,
  message: destructiveCallRefusal,
}));

// Later config objects replace a rule rather than merging with it, so every
// layer restates the destructive-import refusal it inherits.
const layer = (files, paths, patterns) => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          ...destructiveImportRefusals.filter((refusal) => !paths.some((path) => path.name === refusal.name)),
          ...paths,
        ],
        patterns,
      },
    ],
  },
});

export default tseslint.config(
  { ignores: ["dist/**", "native/**/target/**"] },
  ...tseslint.configs.recommended,

  {
    files: ["src/**/*.ts"],
    rules: noDestructiveMemberCalls,
  },

  {
    files: ["src/**/*.ts"],
    ignores: ["src/storage/**/*.ts", "src/platform/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { paths: destructiveImportRefusals }] },
  },

  layer(
    ["src/bin/**/*.ts"],
    [
      { name: "node:child_process", message: "The entry point bootstraps the CLI; it never runs a Linux command." },
    ],
    [
      {
        group: ["**/platform/**", "**/providers/**", "**/native/**"],
        message: "The entry point chooses a surface; adapters are built in src/composition, never here.",
      },
    ],
  ),

  layer(
    ["src/ports/**/*.ts"],
    [
      { name: "node:child_process", message: "A port is an interface; it performs no I/O." },
      { name: "node:fs", message: "A port is an interface; it performs no I/O." },
      { name: "node:fs/promises", message: "A port is an interface; it performs no I/O." },
    ],
    [
      {
        group: ["../platform/**", "../providers/**", "../native/**", "../storage/**", "../application/**", "../cli/**", "../tui/**", "../reports/**"],
        message: "A port names what application needs; it imports domain types only.",
      },
    ],
  ),

  layer(
    ["src/domain/**/*.ts"],
    [{ name: "node:fs", message: "domain is pure data and policy; it performs no I/O." }],
    [
      {
        group: ["node:*", "../*", "../**"],
        message: "domain is pure data and policy; it imports nothing outside src/domain.",
      },
    ],
  ),

  layer(
    ["src/application/**/*.ts"],
    [],
    [
      {
        group: ["../platform/**", "../providers/**", "../native/**", "../storage/**", "../cli/**", "../tui/**", "../reports/**"],
        message: "application depends on domain and ports only; adapters arrive through a port.",
      },
    ],
  ),

  layer(
    ["src/cli/**/*.ts", "src/tui/**/*.ts", "src/reports/**/*.ts"],
    [
      { name: "node:child_process", message: "CLI, TUI, and reports call application use cases; they never run a Linux command." },
    ],
    [
      {
        group: ["**/platform/**", "**/providers/**", "**/native/**"],
        message: "CLI, TUI, and reports call application use cases; they never reach an adapter or the helper directly.",
      },
    ],
  ),

  // The one layer allowed to build an adapter. Everything else receives what it
  // needs as an argument, which is what lets the rules above forbid the reach.
  layer(
    ["src/composition/**/*.ts"],
    [],
    [
      {
        group: ["../cli/**", "../tui/**", "../reports/**", "**/cli/**", "**/tui/**", "**/reports/**"],
        message: "The composition root builds services for a surface; it never imports one.",
      },
    ],
  ),

  layer(
    ["src/providers/**/*.ts"],
    [
      { name: "node:child_process", message: "A provider discovers findings; it never runs a command." },
      { name: "node:fs", importNames: DESTRUCTIVE_FS, message: "A provider discovers findings; it never deletes." },
      { name: "node:fs/promises", importNames: DESTRUCTIVE_FS, message: "A provider discovers findings; it never deletes." },
    ],
    [
      {
        group: ["**/native/**", "**/platform/**"],
        message: "A provider receives what it needs through a port; it never reaches an adapter or the helper.",
      },
    ],
  ),

);
