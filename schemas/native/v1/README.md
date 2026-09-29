# Native protocol schemas

Add formal request and event schemas as the helper gains scan and action operations. The current helper accepts a strict versioned `hello` or `probe` request and returns one `complete` or `error` event. `src/native/protocol.ts`, `native/disktop-fs/src/protocol.rs`, and tests/contract currently define that narrow scaffold contract. See docs/native-protocol.md.
