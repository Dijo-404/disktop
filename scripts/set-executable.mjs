import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/bin/disktop.js", import.meta.url));
await chmod(entry, 0o755);
