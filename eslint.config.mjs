import tseslint from "typescript-eslint";

const DESTRUCTIVE_FS = ["rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "rename", "renameSync"];

const destructiveCallRefusal =
  "Only the Rust helper may mutate arbitrary filesystem paths. Route this through a reviewed action plan.";

/** Refuse `fs.rm(...)` and friends reached through a namespace or default import. */
const noDestructiveMemberCalls = {
  "no-restricted-syntax": [
    "error",
    ...DESTRUCTIVE_FS.map((name) => ({
      selector: `CallExpression > MemberExpression[property.name='${name}']`,
      message: destructiveCallRefusal,
    })),
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

  layer(
    ["src/providers/**/*.ts"],
    [
      { name: "node:child_process", message: "A provider discovers findings; it never runs a command." },
      { name: "node:fs", importNames: DESTRUCTIVE_FS, message: "A provider discovers findings; it never deletes." },
      { name: "node:fs/promises", importNames: DESTRUCTIVE_FS, message: "A provider discovers findings; it never deletes." },
    ],
    [
      {
        group: ["**/native/**", "**/platform/linux/managers/**"],
        message: "A provider proposes a plan; the reviewed action pipeline carries it out.",
      },
    ],
  ),

);
