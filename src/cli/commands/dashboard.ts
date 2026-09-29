import type { CliContext } from "../context.js";
import { EXIT, buildEnvelope, encodeAlert, encodeCapability, encodeFilesystem, writeEnvelope } from "../output.js";
import { alertLines, filesystemLines, warningLines } from "../text.js";

/** `disktop --json`, and the text dashboard when there is no terminal to draw on. */
export async function runDashboard(context: CliContext, asJson: boolean): Promise<number> {
  const view = await context.dashboard.dashboard();
  const status = view.complete ? "complete" : "incomplete";
  const exitCode = view.complete ? EXIT.complete : EXIT.incomplete;

  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "dashboard",
        generatedAt: context.now(),
        status,
        exitCode,
        warnings: view.warnings,
        data: {
          capability: encodeCapability(view.capability),
          filesystems: view.filesystems.map(encodeFilesystem),
          alerts: view.alerts.map(encodeAlert),
        },
      }),
    );
    return exitCode;
  }

  for (const line of filesystemLines(view.filesystems, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of alertLines(view.alerts)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(view.warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}
