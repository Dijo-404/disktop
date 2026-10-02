const PREFIXES = "KMGTP";

/**
 * A size another program printed. A bare suffix is binary, the way systemd
 * prints it ("1.2G" is 1.2 GiB); "GB" is decimal and "GiB" binary.
 */
export function parsePrintedSize(text: string, bareIsBinary: boolean): bigint | undefined {
  const match = /([0-9]+(?:[.,][0-9]+)?)\s*([KMGTP]?)(i?)(B?)\b/i.exec(text);
  if (match === null) {
    return undefined;
  }
  const amount = Number((match[1] as string).replace(",", "."));
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const prefix = (match[2] as string).toUpperCase();
  const binary = (match[3] as string) !== "" || ((match[4] as string) === "" && bareIsBinary);
  const exponent = prefix === "" ? 0 : PREFIXES.indexOf(prefix) + 1;
  return BigInt(Math.round(amount * (binary ? 1024 : 1000) ** exponent));
}

/** `journalctl --disk-usage`: one sentence with a size in it. */
export function parseJournalUsage(text: string): bigint | undefined {
  return parsePrintedSize(text, true);
}
