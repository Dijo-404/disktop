/**
 * What Disktop is willing to say about a file nobody seems to use.
 *
 * The question people ask is "what have I not opened in six months?" and on a
 * normal Linux system that question has no answer. Mounts are `relatime` by
 * default, which updates the access time at most once a day and only when it
 * is already older than the modification time; many are `noatime`, which never
 * updates it at all. A listing built on that and labelled "not opened since"
 * would be confidently wrong about files somebody uses daily.
 *
 * So Disktop measures the modification time and says that is what it measured.
 * The mount's options do not change the measurement — no column in the scan
 * index holds an access time to measure instead — they change the sentence, so
 * somebody reading a list of stale candidates knows what the number is and is
 * not evidence of.
 */

/** What a mount's options say about whether its access times mean anything. */
export type AccessTimeConfidence = "maintained" | "coarse" | "absent" | "unknown";

export interface StalenessBasis {
  /**
   * Always `modified` in this release. The confidence below changes what is
   * said about that, never what was measured.
   */
  readonly field: "modified";
  readonly confidence: AccessTimeConfidence;
  /** The sentence shown to a person. It never claims a file was not opened. */
  readonly label: string;
}

/**
 * Read a mount's options.
 *
 * `noatime` beats `relatime` when both are present: a mount that maintains no
 * access time maintains none, whatever else it also says. `nodiratime` is not
 * considered, because it concerns directories and this is about files.
 */
export function accessTimeConfidence(options: readonly string[]): AccessTimeConfidence {
  const names = new Set(options.map((option) => option.split("=")[0]));
  if (names.has("noatime")) {
    return "absent";
  }
  if (names.has("relatime")) {
    return "coarse";
  }
  return "maintained";
}

const LABELS: Readonly<Record<AccessTimeConfidence, string>> = {
  maintained:
    "not modified since this date. This mount does keep access times, but Disktop's index records only modification times, so this is about when the contents last changed.",
  coarse:
    "not modified since this date. This mount is relatime, so its access times are updated at most once a day and are not evidence of when a file was last used.",
  absent:
    "not modified since this date. This mount is noatime, so the kernel records no access time at all for these files.",
  unknown:
    "not modified since this date. Disktop could not read this mount's options, so it cannot say anything about access times either way.",
};

/**
 * The basis a stale listing carries, from the options of the mount holding it.
 *
 * Options that could not be read produce `unknown` rather than `maintained`:
 * a reading that did not happen is not a reading that found nothing.
 */
export function stalenessBasis(options: readonly string[] | undefined): StalenessBasis {
  const confidence = options === undefined ? "unknown" : accessTimeConfidence(options);
  return { field: "modified", confidence, label: LABELS[confidence] };
}

/**
 * The cutoff a stale search filters on: nanoseconds since the epoch.
 *
 * Nanoseconds because that is what the index stores and what the helper's
 * filter compares against; a `bigint` because a nanosecond clock passed 2^53
 * in 1970 and a `number` would round it.
 */
export function staleBeforeNanoseconds(now: Date, days: number): bigint {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError("A staleness threshold is a whole number of days above zero");
  }
  const cutoffMilliseconds = BigInt(now.getTime()) - BigInt(days) * 86_400_000n;
  // A cutoff before the epoch is one nothing can be older than. Clamping says
  // so, where a negative number would be one the helper cannot hold.
  return cutoffMilliseconds <= 0n ? 0n : cutoffMilliseconds * 1_000_000n;
}
