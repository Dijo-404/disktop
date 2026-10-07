import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { sanitizeText } from "../../domain/paths.js";
import type { AccountNamesPort } from "../../ports/accounts.js";

const PASSWD_BYTES = 1024 * 1024;

export function createAccountNames(passwdFile = "/etc/passwd"): AccountNamesPort {
  return {
    async names() {
      let text: string;
      try {
        // The account database is a fixed system file, but NSS setups can
        // make it unexpectedly large. Never read it whole merely to take a
        // prefix, and do not block on a substituted pipe or device.
        const file = await open(passwdFile, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stats = await file.stat();
          if (!stats.isFile()) return new Map();
          const buffer = Buffer.allocUnsafe(PASSWD_BYTES);
          let read = 0;
          while (read < buffer.length) {
            const { bytesRead } = await file.read(buffer, read, buffer.length - read, read);
            if (bytesRead === 0) break;
            read += bytesRead;
          }
          let prefix = buffer.subarray(0, read);
          // A record cut at the limit cannot authorise an account name.
          if (stats.size > read) prefix = prefix.subarray(0, prefix.lastIndexOf(0x0a) + 1);
          text = prefix.toString("utf8");
        } finally {
          await file.close();
        }
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
