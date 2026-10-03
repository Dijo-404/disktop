/**
 * Just enough of an ELF reader to prove a release binary is what its name says.
 *
 * A checksum proves a file is the one that was packed; it cannot prove the
 * file packed as `disktop-fs-linux-arm64-musl` is an ARM64 static binary rather
 * than, say, the x86-64 glibc one copied under the wrong name. This reads the
 * machine, the program interpreter, whether a symbol table survived stripping,
 * and the newest glibc symbol version the binary asks for.
 */

const PT_INTERP = 3;
const SHT_SYMTAB = 2;

export function inspectElf(bytes) {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error("not an ELF file");
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new Error("not a 64-bit little-endian ELF file");
  }

  const type = bytes.readUInt16LE(16);
  const machine = bytes.readUInt16LE(18);
  const programHeaders = Number(bytes.readBigUInt64LE(32));
  const sectionHeaders = Number(bytes.readBigUInt64LE(40));
  const programHeaderSize = bytes.readUInt16LE(54);
  const programHeaderCount = bytes.readUInt16LE(56);
  const sectionHeaderSize = bytes.readUInt16LE(58);
  const sectionHeaderCount = bytes.readUInt16LE(60);
  const sectionNameIndex = bytes.readUInt16LE(62);

  let interpreter = null;
  for (let index = 0; index < programHeaderCount; index += 1) {
    const header = programHeaders + index * programHeaderSize;
    if (bytes.readUInt32LE(header) === PT_INTERP) {
      const offset = Number(bytes.readBigUInt64LE(header + 8));
      const size = Number(bytes.readBigUInt64LE(header + 32));
      interpreter = bytes.subarray(offset, offset + size).toString("latin1").replace(/\0+$/, "");
    }
  }

  const sections = [];
  for (let index = 0; index < sectionHeaderCount; index += 1) {
    const header = sectionHeaders + index * sectionHeaderSize;
    sections.push({
      nameOffset: bytes.readUInt32LE(header),
      type: bytes.readUInt32LE(header + 4),
      offset: Number(bytes.readBigUInt64LE(header + 24)),
      size: Number(bytes.readBigUInt64LE(header + 32)),
    });
  }
  const names = sections[sectionNameIndex];
  const nameOf = (section) => {
    if (names === undefined) {
      return "";
    }
    const start = names.offset + section.nameOffset;
    return bytes.subarray(start, bytes.indexOf(0, start)).toString("latin1");
  };

  const dynamicStrings = sections.find((section) => nameOf(section) === ".dynstr");
  let glibc = null;
  if (dynamicStrings !== undefined) {
    const text = bytes.subarray(dynamicStrings.offset, dynamicStrings.offset + dynamicStrings.size).toString("latin1");
    for (const match of text.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?\0/g)) {
      const version = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
      if (glibc === null || compareVersions(version, glibc) > 0) {
        glibc = version;
      }
    }
  }

  return {
    machine,
    positionIndependent: type === 3,
    interpreter,
    stripped: !sections.some((section) => section.type === SHT_SYMTAB),
    glibc: glibc === null ? null : glibc.slice(0, glibc[2] === 0 ? 2 : 3).join("."),
  };
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? left.split(".").map(Number) : left;
  const b = typeof right === "string" ? right.split(".").map(Number) : right;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

/**
 * Every way a binary can disagree with the target it is named for. An empty
 * list means it matches; `glibcFloor` is checked only when given, because a
 * host-only build links against whatever glibc the host has.
 */
export function targetMismatches(facts, target, { glibcFloor } = {}) {
  const problems = [];
  if (facts.machine !== target.elfMachine) {
    problems.push(`ELF machine ${facts.machine}, expected ${target.elfMachine}`);
  }
  if (facts.interpreter !== target.interpreter) {
    problems.push(`program interpreter ${facts.interpreter ?? "none"}, expected ${target.interpreter ?? "none (static)"}`);
  }
  if (!facts.stripped) {
    problems.push("a symbol table survived; the release profile strips symbols");
  }
  if (target.libc === "musl" && facts.glibc !== null) {
    problems.push(`a musl build asks for GLIBC_${facts.glibc}`);
  }
  if (glibcFloor !== undefined && facts.glibc !== null && compareVersions(facts.glibc, glibcFloor) > 0) {
    problems.push(`needs GLIBC_${facts.glibc}, newer than the ${glibcFloor} floor`);
  }
  return problems;
}
