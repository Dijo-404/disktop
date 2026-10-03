import { sanitizeText } from "../../domain/paths.js";
import { SHELLS, completionScript, isShell } from "../completions.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../output.js";

/**
 * Print the completion script for one shell to stdout.
 *
 * The script is generated from the same command table the parser reads, so
 * it can only offer what this version accepts. Nothing is installed: where
 * the script goes is the person's choice, and docs/cli.md says where each
 * shell looks.
 */
export function runCompletion(context: CliContext, shell: string): number {
  if (!isShell(shell)) {
    context.output.stderr(
      `'completion' generates a script for ${SHELLS.join(", ")}; '${sanitizeText(shell)}' is not one of them. Run, for example, 'disktop completion bash'.\n`,
    );
    return EXIT.operationalError;
  }
  context.output.stdout(completionScript(shell));
  return EXIT.complete;
}
