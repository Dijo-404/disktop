import { findingSize, type Finding } from "../../domain/findings.js";
import type { Warning } from "../../domain/models.js";
import type { FindingProvider } from "../../ports/providers.js";
import { buildFinding } from "../support.js";
import {
  parseSmartHealth,
  parseSmartMessages,
  parseSmartScan,
  type SmartHealth,
} from "../../platform/linux/diagnostics/parsers.js";

const ID = "diagnostic.smart";
const VERSION = 1;

/**
 * What each disk says about its own health.
 *
 * This occupies no space and offers no action; it is here because the reason a
 * disk is nearly full is sometimes that it is also failing, and a person
 * deciding what to delete should know that before they start. Reading SMART
 * usually needs privilege, which is reported as a denial rather than as a
 * clean bill of health.
 */
export function createSmartProvider(): FindingProvider {
  return {
    id: ID,
    version: VERSION,
    categories: ["diagnostic"],

    async probe(environment) {
      const outcome = await environment.tools.run("smartctl", ["--scan", "-j"]);
      if (parseSmartMessages(outcome.stdout).denied) {
        return { status: "permission-denied", explanation: "smartctl needs privilege to open a device on this machine." };
      }
      if (outcome.capability.status === "missing-tool") {
        return { status: "missing-tool", explanation: "smartctl is not installed, so disk health cannot be read." };
      }
      if (outcome.capability.status === "permission-denied") {
        return { status: "permission-denied", explanation: outcome.capability.explanation };
      }
      return { status: "available", explanation: "smartctl responded." };
    },

    async discover(environment) {
      const scan = await environment.tools.run("smartctl", ["--scan", "-j"]);
      const devices = parseSmartScan(scan.stdout);
      const findings: Finding[] = [];
      const warnings: Warning[] = [];

      for (const device of devices) {
        const outcome = await environment.tools.run("smartctl", ["-H", "-A", "-j", device.name]);
        // smartctl exits non-zero and writes nothing to stderr when it cannot
        // open a device, putting the reason in its JSON instead, so a denial
        // has to be read from the document rather than from the exit status.
        const reported = parseSmartMessages(outcome.stdout);
        if (outcome.capability.status === "permission-denied" || reported.denied) {
          warnings.push({
            code: "smart-denied",
            message: `${device.name} did not report its health: ${reported.message ?? outcome.capability.explanation}`,
          });
          continue;
        }
        const health = parseSmartHealth(outcome.stdout);
        if (health === undefined) {
          warnings.push({
            code: "smart-unreadable",
            message: `${device.name} answered in a form Disktop could not read a health status from.`,
          });
          continue;
        }
        findings.push(healthFinding(device.name, health));
      }

      return { findings, warnings, complete: warnings.length === 0 };
    },
  };
}

function healthFinding(name: string, health: SmartHealth): Finding {
  const evidence: string[] = [
    health.passed === undefined
      ? "smartctl reported no overall health status for this device."
      : `smartctl reports overall health ${health.passed ? "PASSED" : "FAILED"}.`,
  ];
  if (health.model !== undefined) {
    evidence.push(`Model: ${health.model}.`);
  }
  if (health.reallocatedSectors !== undefined) {
    evidence.push(
      health.reallocatedSectors === 0n
        ? "No sectors have been reallocated."
        : `${health.reallocatedSectors} sectors have been reallocated, which is how a disk starts to fail.`,
    );
  }
  if (health.percentageUsed !== undefined) {
    evidence.push(`${health.percentageUsed}% of the drive's rated endurance has been used.`);
  }
  if (health.powerOnHours !== undefined) {
    evidence.push(`${health.powerOnHours} hours powered on.`);
  }

  return buildFinding({
    providerId: ID,
    providerVersion: VERSION,
    category: "diagnostic",
    slug: `device-${name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "")}`,
    title:
      health.passed === false
        ? `${name} reports FAILED: back it up before freeing space on it`
        : `${name} reports ${health.passed === true ? "PASSED" : "no health status"}`,
    evidence,
    size: findingSize(undefined, "unknown", "A health reading occupies no space."),
    confidence: "observed",
    actions: [],
  });
}
