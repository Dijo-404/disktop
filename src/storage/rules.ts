import { createHash } from "node:crypto";
import { canonicalRule, type CleanupRule } from "../domain/rules.js";

/**
 * A rule's identity, as a plan carries it.
 *
 * The canonical form is the domain's: it decides what counts as the same rule.
 * All this adds is the digest, which lives here because taking one needs
 * `node:crypto` and `src/domain` imports nothing outside itself.
 *
 * A plan built from a rule stores this. At apply time the rule is read again
 * and hashed again, and a plan whose hash no longer matches is refused — the
 * rule somebody reviewed is not the rule in the file any more, and applying
 * the second one on the strength of a confirmation given for the first is
 * exactly the thing a reviewed plan exists to prevent.
 */
export function ruleHash(rule: CleanupRule): string {
  return createHash("sha256").update(canonicalRule(rule), "utf8").digest("hex");
}
