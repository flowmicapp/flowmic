// Minimal little-endian ELF64 reading for the Linux release tooling: one named
// section's bytes, and the DT_NEEDED list of a dynamic executable or library.
// Pure JavaScript on purpose: the release gates must read the same bytes on any
// host, and a missing `readelf` must not turn into a silent pass.
// Format reference: System V ABI, "Sections" and "Dynamic Section"
// (https://refspecs.linuxfoundation.org/elf/gabi4+/contents.html).

import { readFileSync } from 'node:fs';

function readElf64(pathOrBytes, label) {
  const elf = Buffer.isBuffer(pathOrBytes) ? pathOrBytes : readFileSync(pathOrBytes);
  if (
    elf.length < 64 ||
    elf[0] !== 0x7f ||
    elf.subarray(1, 4).toString('ascii') !== 'ELF' ||
    elf[4] !== 2 ||
    elf[5] !== 1
  ) {
    throw new Error(`${label} is not a little-endian ELF64 binary`);
  }
  return elf;
}

function sections(elf, label) {
  const sectionOffset = Number(elf.readBigUInt64LE(0x28));
  const sectionEntrySize = elf.readUInt16LE(0x3a);
  const sectionCount = elf.readUInt16LE(0x3c);
  const namesIndex = elf.readUInt16LE(0x3e);
  if (sectionEntrySize < 64 || namesIndex >= sectionCount) throw new Error(`${label} has an invalid ELF64 header`);
  const range = (index) => {
    const header = sectionOffset + index * sectionEntrySize;
    if (header < 0 || header + 64 > elf.length) throw new Error(`${label} has an invalid ELF section table`);
    const offset = Number(elf.readBigUInt64LE(header + 24));
    const size = Number(elf.readBigUInt64LE(header + 32));
    return {
      nameOffset: elf.readUInt32LE(header),
      type: elf.readUInt32LE(header + 4),
      offset,
      size,
      link: elf.readUInt32LE(header + 40),
    };
  };
  const names = range(namesIndex);
  const namesEnd = names.offset + names.size;
  if (names.offset < 0 || namesEnd > elf.length) throw new Error(`${label} has an invalid ELF section-name table`);
  const list = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const section = range(index);
    const nameStart = names.offset + section.nameOffset;
    let nameEnd = nameStart;
    while (nameEnd < namesEnd && elf[nameEnd] !== 0) nameEnd += 1;
    const end = section.offset + section.size;
    list.push({ ...section, index, name: elf.subarray(nameStart, nameEnd).toString('ascii'), end });
  }
  return list;
}

function bytesOf(elf, section, label) {
  if (section.offset < 0 || section.end > elf.length) throw new Error(`${label} has an invalid ${section.name} section`);
  return elf.subarray(section.offset, section.end);
}

/** The bytes of the section called `wantedName`; throws when it is absent. */
export function readElf64Section(path, wantedName) {
  const elf = readElf64(path, path);
  const section = sections(elf, path).find((s) => s.name === wantedName);
  if (!section) throw new Error(`${path} has no ${wantedName} ELF section`);
  return bytesOf(elf, section, path);
}

const SHT_DYNAMIC = 6;
const DT_NULL = 0n;
const DT_NEEDED = 1n;

/** DT_NEEDED sonames, in file order. A static binary (no SHT_DYNAMIC) has none.
 *  The string table is the one the dynamic section links to (sh_link), which is
 *  what the loader uses — not whichever section happens to be named .dynstr. */
export function readElfNeeded(pathOrBytes, label = String(pathOrBytes)) {
  const elf = readElf64(pathOrBytes, label);
  const all = sections(elf, label);
  const dynamic = all.find((s) => s.type === SHT_DYNAMIC);
  if (!dynamic) return [];
  const strtab = all[dynamic.link];
  if (!strtab) throw new Error(`${label} dynamic section links to a missing string table`);
  const entries = bytesOf(elf, dynamic, label);
  const strings = bytesOf(elf, strtab, label);
  const needed = [];
  for (let p = 0; p + 16 <= entries.length; p += 16) {
    const tag = entries.readBigInt64LE(p);
    if (tag === DT_NULL) break;
    if (tag !== DT_NEEDED) continue;
    const start = Number(entries.readBigUInt64LE(p + 8));
    if (start >= strings.length) throw new Error(`${label} has a DT_NEEDED entry outside its string table`);
    let end = start;
    while (end < strings.length && strings[end] !== 0) end += 1;
    needed.push(strings.subarray(start, end).toString('utf8'));
  }
  return needed;
}
