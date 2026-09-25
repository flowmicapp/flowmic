// Linux portable ZIP permissions must describe the installed product, not the
// staging filesystem. DrvFS can report 0777 after a successful chmod(0755).
// Only the central-directory creator and external attributes are rewritten;
// payload, local records, CRCs, lengths and offsets remain byte-for-byte intact.
// Format reference: PKWARE APPNOTE 6.3.10 sections 4.3 / 4.4:
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// This is deliberately a classic, single-disk ZIP profile, not a ZIP64 parser.

const fail = (reason) => { throw new Error(`Linux portable ZIP: ${reason}`); };
const utf8 = new TextDecoder('utf-8', { fatal: true });

function extras(buf, start, length) {
  const end = start + length;
  for (let p = start; p < end;) {
    if (p + 4 > end) fail('truncated extra field');
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (p + 4 + size > end) fail('extra field exceeds its record');
    if (id === 1) fail('ZIP64 extra field is unsupported');
    // An alternate pathname could make an extractor disagree with the name
    // whose mode we classified. bsdtar's UTF-8 profile needs no alias.
    if (id === 0x7075) fail('alternate Unicode path extra field is unsupported');
    p += 4 + size;
  }
}

function checkedName(raw, flags, dirName) {
  if (!raw.length || (raw.some((b) => b >= 128) && !(flags & 0x800))) {
    fail('empty or ambiguously encoded entry path');
  }
  let name;
  try { name = utf8.decode(raw); } catch { fail('invalid UTF-8 entry path'); }
  if (/[\\:\x00-\x1f\x7f]/.test(name)) fail('unsafe entry path');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts[0] !== dirName || parts.some((p) => !p || p === '.' || p === '..')) {
    fail('entry path is outside the portable directory or contains traversal');
  }
  if (parts.length === 1 && !name.endsWith('/')) fail('top-level entry must be a directory');
  return name;
}

/** Return a new Buffer after complete validation; refusal never mutates input.
 * The caller applies this only for platform === 'linux-x64', before hashing. */
export function normalizeLinuxPortableModes(buf, dirName) {
  if (!Buffer.isBuffer(buf)) fail('expected a Buffer');
  if (typeof dirName !== 'string' || !dirName || /[\\/:\x00-\x1f\x7f]/.test(dirName)
      || dirName === '.' || dirName === '..') fail('invalid top-level directory name');
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) fail('not a classic ZIP');
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 0xffff); p--) {
    if (buf.readUInt32LE(p) === 0x06054b50 && p + 22 + buf.readUInt16LE(p + 20) === buf.length) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) fail('missing or truncated end-of-central-directory record');
  if (buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6)) fail('multi-disk ZIP is unsupported');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) fail('ZIP64 is unsupported');
  if (!count || count !== buf.readUInt16LE(eocd + 8) || cdStart + cdSize !== eocd) {
    fail('central-directory count or boundary mismatch');
  }
  const entries = [];
  const names = new Map();
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) fail('bad central-directory record');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const end = p + 46 + nameLen + extraLen + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if ([compressed, size, local].includes(0xffffffff)) fail('ZIP64 entry is unsupported');
    if (end > eocd || buf.readUInt16LE(p + 34)) fail('entry boundary or disk mismatch');
    if ((flags & ~0x80e) || ![0, 8].includes(method)) fail('unsupported flags or compression');
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    const name = checkedName(rawName, flags, dirName);
    const isDir = name.endsWith('/');
    const key = name.replace(/\/$/, '');
    if (names.has(key)) fail('duplicate or conflicting entry path');
    names.set(key, isDir);
    const attrs = buf.readUInt32LE(p + 38);
    const type = (attrs >>> 16) & 0o170000;
    if (type && type !== (isDir ? 0o040000 : 0o100000)) fail('special file or conflicting entry type');
    if ((attrs & 0x10) && !isDir) fail('DOS directory bit conflicts with file path');
    if (isDir && size !== 0) fail('directory has a nonempty payload');
    extras(buf, p + 46 + nameLen, extraLen);
    if (local + 30 > cdStart || buf.readUInt32LE(local) !== 0x04034b50) fail('invalid local header offset');
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtraLen = buf.readUInt16LE(local + 28);
    const data = local + 30 + localNameLen + localExtraLen;
    if (data > cdStart || data + compressed > cdStart) fail('local record or payload exceeds directory boundary');
    if (buf.readUInt16LE(local + 6) !== flags || buf.readUInt16LE(local + 8) !== method
        || !buf.subarray(local + 30, local + 30 + localNameLen).equals(rawName)) fail('local/central header mismatch');
    if (buf.readUInt32LE(local + 18) === 0xffffffff || buf.readUInt32LE(local + 22) === 0xffffffff) {
      fail('ZIP64 local entry is unsupported');
    }
    extras(buf, local + 30 + localNameLen, localExtraLen);
    let localEnd = data + compressed;
    if (flags & 8) {
      for (const [offset, value] of [[14, crc], [18, compressed], [22, size]]) {
        const localValue = buf.readUInt32LE(local + offset);
        if (localValue !== 0 && localValue !== value) fail('streamed local CRC or size mismatch');
      }
      if (localEnd + 12 > cdStart) fail('truncated data descriptor');
      const descriptor = buf.readUInt32LE(localEnd) === 0x08074b50 ? localEnd + 4 : localEnd;
      if (descriptor + 12 > cdStart || buf.readUInt32LE(descriptor) !== crc
          || buf.readUInt32LE(descriptor + 4) !== compressed || buf.readUInt32LE(descriptor + 8) !== size) {
        fail('data descriptor mismatch');
      }
      localEnd = descriptor + 12;
    } else if (buf.readUInt32LE(local + 14) !== crc || buf.readUInt32LE(local + 18) !== compressed
        || buf.readUInt32LE(local + 22) !== size) fail('local CRC or size mismatch');
    entries.push({ p, name, isDir, attrs, local, localEnd });
    p = end;
  }
  if (p !== eocd) fail('central-directory size/count mismatch');
  let nextLocal = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
    if (entry.local !== nextLocal) fail('overlapping or unindexed local records');
    nextLocal = entry.localEnd;
    const segments = entry.name.replace(/\/$/, '').split('/');
    for (let n = 1; n < segments.length; n++) {
      if (names.get(segments.slice(0, n).join('/')) === false) fail('file used as parent directory');
    }
  }
  if (nextLocal !== cdStart) fail('local records do not end at central directory');
  const result = Buffer.from(buf);
  for (const entry of entries) {
    const executable = entry.name === `${dirName}/flowmic-desktop` || entry.name === `${dirName}/node`;
    const mode = entry.isDir ? 0o040755 : executable ? 0o100755 : 0o100644;
    result[entry.p + 5] = 3; // UNIX creator; preserve the version byte.
    result.writeUInt32LE(((mode << 16) | (entry.attrs & 0xffff)) >>> 0, entry.p + 38);
  }
  return result;
}
