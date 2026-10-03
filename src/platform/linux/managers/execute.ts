import { statfs as readStatfs } from "node:fs/promises";
import type { ActionPlan, ActionResult, VerificationCheck } from "../../../domain/actions.js";
import { CapabilityUnavailable } from "../../../domain/errors.js";
import type { ManagerScope } from "../../../domain/managers.js";
import { rawPathFromUtf8 } from "../../../domain/paths.js";
import type { HelperStart } from "../../../native/client.js";
import { parseActionResult } from "../../../native/protocol.js";
import type { ActionPort } from "../../../ports/actions.js";
import type { CommandRun, CommandRunner, ManagerAdapter } from "../../../ports/managers.js";
import { ActionRefused, connect, refuseError, toResult } from "../actions/index.js";

export interface ManagerExecutorOptions {
  readonly adapters: readonly ManagerAdapter[];
  readonly runner: CommandRunner;
  readonly journalDirectory: string;
  readonly start: () => Promise<HelperStart>;
  readonly statfs?: (path: string) => Promise<bigint | undefined>;
}

const NOT_RUN = "Stopped before this command; it was never run.";

export function createManagerExecutor(options: ManagerExecutorOptions): Pick<ActionPort, "apply"> {
  const journalDirectory = rawPathFromUtf8(options.journalDirectory).bytesBase64;
  const statfs = options.statfs ?? freeBytes;

  return {
    async apply(plan, signal, applyOptions = {}) {
      const scope = plan.manager;
      if (scope === undefined) {
        throw new Error(`Plan ${plan.id} reached the manager executor without a manager selection`);
      }
      const adapter = options.adapters.find((candidate) => candidate.id === scope.adapter);
      if (adapter === undefined) {
        throw new CapabilityUnavailable({
          status: "missing-tool",
          explanation: `Disktop has no ${scope.adapter} adapter on this machine.`,
        });
      }

      const preflight = await adapter.preflight(scope);
      if (preflight.refusal !== undefined) {
        throw new ActionRefused({ code: "changed-target", message: preflight.refusal });
      }

      const client = await connect(options.start);
      try {
        const request = async (operation: string, operationArguments: Record<string, unknown>) => {
          const event = await client.request(operation, operationArguments, signal);
          refuseError(event, client);
          return event;
        };

        const spacePath = await adapter.spacePath(scope);
        const freeBefore = spacePath === undefined ? undefined : await statfs(spacePath);
        const begun = await request("manager-begin", beginArguments(plan, scope, journalDirectory, freeBefore));
        const actionId = (begun.result as { actionId?: unknown } | undefined)?.actionId;
        if (typeof actionId !== "string") {
          throw new Error("The helper began a manager action without naming it.");
        }

        const skipped = new Map(preflight.skipped);
        const attempted = new Set<number>();
        const runs: CommandRun[] = [];
        const exitFailures = new Map<number, string>();
        let stopped: string | undefined;

        for (const [index, command] of scope.commands.entries()) {
          const positions = scope.perItem ? [index] : scope.items.map((_item, position) => position);
          if (scope.perItem && skipped.has(index)) {
            continue;
          }
          if (stopped === undefined && signal.aborted) {
            stopped = NOT_RUN;
          }
          if (stopped !== undefined) {
            for (const position of positions) {
              if (!skipped.has(position)) {
                skipped.set(position, stopped);
              }
            }
            continue;
          }

          await request("manager-append", { journalDirectory, actionId, command: String(index), phase: "started" });
          const run = await options.runner.run(command, scope.privilege, {
            interactive: applyOptions.interactive ?? false,
            signal,
          });
          await request("manager-append", {
            journalDirectory,
            actionId,
            command: String(index),
            phase: "finished",
            ...(run.exitCode === null ? {} : { exitCode: String(run.exitCode) }),
            output: run.output === "" ? run.explanation : run.output,
          });
          runs.push(run);

          if (run.status === "ran" || run.status === "cancelled") {
            for (const position of positions) {
              if (!skipped.has(position)) {
                attempted.add(position);
                if (scope.perItem && run.status === "ran" && run.exitCode !== 0) {
                  exitFailures.set(position, `${command.tool} exited with status ${String(run.exitCode)}, so Disktop does not count it as removed.`);
                }
              }
            }
            if (run.status === "cancelled") {
              stopped = NOT_RUN;
            }
            continue;
          }
          stopped =
            run.status === "denied"
              ? `Administrator rights were refused: ${run.explanation}`
              : run.explanation;
          for (const position of positions) {
            if (!skipped.has(position)) {
              skipped.set(position, stopped);
            }
          }
        }

        const verification = await adapter.verify(scope, attempted, runs);
        const freeAfter = spacePath === undefined ? undefined : await statfs(spacePath);
        const verdicts = scope.items.map((_item, position) => {
          const reason = skipped.get(position);
          if (reason !== undefined) {
            return { position: String(position), outcome: "skipped", message: reason };
          }
          const exited = exitFailures.get(position);
          const verdict =
            exited !== undefined
              ? { outcome: "failed" as const, message: exited }
              : (verification.verdicts.get(position) ?? {
                  outcome: "failed" as const,
                  message: "Disktop could not confirm the manager removed it.",
                });
          return {
            position: String(position),
            outcome: verdict.outcome,
            ...(verdict.message === undefined ? {} : { message: verdict.message }),
          };
        });

        const finished = await request("manager-finish", {
          journalDirectory,
          actionId,
          items: verdicts,
          observed: verification.observed.map((item) => ({ id: item.id })),
          ...(freeAfter === undefined ? {} : { freeBytesAfter: freeAfter.toString(10) }),
        });
        const result = toResult(parseActionResult(finished.result));
        return {
          ...result,
          planId: plan.id,
          verification: [...verification.checks, commandCheck(runs, stopped)],
        } satisfies ActionResult;
      } finally {
        await client.close();
      }
    },
  };
}

function beginArguments(
  plan: ActionPlan,
  scope: ManagerScope,
  journalDirectory: string,
  freeBefore: bigint | undefined,
): Record<string, unknown> {
  return {
    planId: plan.id,
    journalDirectory,
    adapter: scope.adapter,
    action: scope.action,
    privilege: scope.privilege,
    commands: scope.commands.map((command) => ({ tool: command.tool, arguments: [...command.arguments] })),
    items: scope.items.map((item) => ({
      id: item.id,
      ...(item.bytes === undefined ? {} : { bytes: item.bytes.toString(10) }),
    })),
    ...(scope.estimatedBytes === undefined ? {} : { estimatedBytes: scope.estimatedBytes.toString(10) }),
    ...(freeBefore === undefined ? {} : { freeBytesBefore: freeBefore.toString(10) }),
  };
}

function commandCheck(runs: readonly CommandRun[], stopped: string | undefined): VerificationCheck {
  const failing = runs.filter((run) => run.status !== "ran" || run.exitCode !== 0);
  if (runs.length > 0 && failing.length === 0 && stopped === undefined) {
    return { check: "manager-command", outcome: "passed", detail: `All ${runs.length} command(s) finished with status 0.` };
  }
  return {
    check: "manager-command",
    outcome: "failed",
    detail:
      stopped ??
      `${failing.length} of ${runs.length} command(s) did not finish cleanly: ${failing[0]?.explanation ?? "nothing ran"}`,
  };
}

async function freeBytes(path: string): Promise<bigint | undefined> {
  try {
    const reading = await readStatfs(path, { bigint: true });
    return reading.bavail * reading.bsize;
  } catch {
    return undefined;
  }
}
