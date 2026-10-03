/**
 * Ask a helper `hello`, the request the client sends at startup.
 *
 * As a module, `helperHello(command, args)` runs one process and returns its
 * answer. As a script it checks a release binary wherever it has to run, for
 * example inside a container:
 *
 *   node scripts/helper-hello.mjs --expect-version 1.0.0 --expect-release -- \
 *     docker run --rm -i -v "$PWD/vendor/bin:/helpers:ro" alpine:3.24 /helpers/disktop-fs-linux-x64-musl
 *
 * Every command is a fixed argument vector with no shell. Closing stdin after
 * the answer is how the client ends a helper, so a helper that does not then
 * exit cleanly is a failure too.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REQUEST_ID = "release-hello";

export function helperHello(command, args = [], { timeoutMilliseconds = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let buffered = "";
    let stderr = "";
    let answer;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} did not answer hello within ${timeoutMilliseconds} ms; stderr: ${stderr}`));
    }, timeoutMilliseconds);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while (answer === undefined && (newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          answer = new Error(`${command} wrote something that is not a protocol message: ${line.slice(0, 200)}`);
          break;
        }
        if (message.requestId === REQUEST_ID && (message.event === "complete" || message.event === "error")) {
          answer = message.event === "complete" && typeof message.result === "object"
            ? message.result
            : new Error(`${command} refused hello: ${line.slice(0, 500)}`);
        }
      }
      if (answer !== undefined) {
        child.stdin.end();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (answer instanceof Error) {
        reject(answer);
      } else if (answer === undefined || status !== 0) {
        reject(new Error(`${command} exited ${signal ?? status} ${answer === undefined ? "without answering hello" : "after hello"}; stderr: ${stderr}`));
      } else {
        resolve(answer);
      }
    });

    child.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId: REQUEST_ID, operation: "hello", arguments: {} })}\n`);
  });
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const options = separator === -1 ? [] : argv.slice(0, separator);
  const [command, ...args] = separator === -1 ? [] : argv.slice(separator + 1);
  const versionIndex = options.indexOf("--expect-version");
  const expectedVersion = versionIndex === -1 ? undefined : options[versionIndex + 1];
  const expectRelease = options.includes("--expect-release");

  if (command === undefined) {
    console.error("usage: node scripts/helper-hello.mjs [--expect-version X] [--expect-release] -- <command> [args...]");
    process.exit(2);
  }
  const hello = await helperHello(command, args);
  const problems = [];
  if (hello.platform !== "linux") problems.push(`platform ${hello.platform}`);
  if (expectedVersion !== undefined && hello.helperVersion !== expectedVersion) problems.push(`helperVersion ${hello.helperVersion}, expected ${expectedVersion}`);
  if (expectRelease && !/^[0-9a-f]{64}$/.test(hello.buildChecksum ?? "")) problems.push(`buildChecksum ${hello.buildChecksum}, expected a release build's`);
  console.log(JSON.stringify({ helperVersion: hello.helperVersion, buildChecksum: hello.buildChecksum, architecture: hello.architecture, openat2: hello.kernelCapabilities?.openat2 }));
  if (problems.length > 0) {
    console.error(`hello did not match: ${problems.join("; ")}`);
    process.exitCode = 1;
  }
}
