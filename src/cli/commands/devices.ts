import type { CliContext } from "../context.js";
import { EXIT, buildEnvelope, encodeCapability, encodeDevice, encodeFilesystem, writeEnvelope } from "../output.js";
import { deviceLines, filesystemLines, warningLines } from "../text.js";

export async function runDevices(context: CliContext, asJson: boolean): Promise<number> {
  const view = await context.dashboard.inventory();
  const status = view.complete ? "complete" : "incomplete";
  const exitCode = view.complete ? EXIT.complete : EXIT.incomplete;

  if (asJson) {
    writeEnvelope(
      context.output.stdout,
      buildEnvelope({
        command: "devices",
        generatedAt: context.now(),
        status,
        exitCode,
        warnings: view.warnings,
        data: {
          capability: encodeCapability(view.capability),
          devices: view.devices.map(encodeDevice),
          filesystems: view.filesystems.map(encodeFilesystem),
        },
      }),
    );
    return exitCode;
  }

  for (const line of deviceLines(view.devices, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  context.output.stdout("\n");
  for (const line of filesystemLines(view.filesystems, context.settings.units)) {
    context.output.stdout(`${line}\n`);
  }
  for (const line of warningLines(view.warnings)) {
    context.output.stderr(`${line}\n`);
  }
  return exitCode;
}
