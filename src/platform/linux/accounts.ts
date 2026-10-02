import { readFile } from "node:fs/promises";
import { sanitizeText } from "../../domain/paths.js";
import type { AccountNamesPort } from "../../ports/accounts.js";

const PASSWD_BYTES = 1024 * 1024;

export function createAccountNames(passwdFile = "/etc/passwd"): AccountNamesPort {
  return {
    async names() {
      let text: string;
      try {
        text = (await readFile(passwdFile)).subarray(0, PASSWD_BYTES).toString("utf8");
      } catch {
        return new Map();
      }
      const names = new Map<bigint, string>();
      for (const line of text.split("\n")) {
        const [name, , id] = line.split(":");
        if (name === undefined || name === "" || id === undefined || !/^[0-9]{1,10}$/.test(id)) {
          continue;
        }
        names.set(BigInt(id), sanitizeText(name).slice(0, 64));
      }
      return names;
    },
  };
}
