// NR-107 follow-up — no `DEV:` placeholder ships.
//
// The Linux launcher's message and README-LINUX.txt are user-visible, and until
// the final copy lands (D-47: the sentences are written by the copy job, not by
// the implementer) every one of them starts with `DEV:`. Nothing else would stop
// that text from reaching a user: `verify:i18n-dev-placeholders` only reads the
// i18n catalogues, and these sentences are not i18n keys. So the Linux artifact
// path refuses them itself, at every place a Linux portable zip is made or
// carried toward a user:
//   - package-linux-local.mjs, on the launcher bytes and rendered README, before
//     the output directory is claimed (this is also publish-linux.mjs's path);
//   - adopt-artifact.mjs, on a linux-x64 portable zip arriving from WSL;
//   - publish.mjs and publish-github-release.mjs, on every linux-x64 portable
//     zip in publish/ before anything is uploaded.
// The .deb carries neither the launcher nor the README, so it has nothing to scan.
//
// The launcher is a compiled binary: its sentences are NUL-terminated C strings
// in .rodata, so the scan looks for the marker anywhere in the bytes and reports
// the printable string around each hit.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePortableZipName } from './pack-portable.mjs';
import { extractZipEntry, listZipEntries } from './release-portable-cjk-scan.mjs';

export const DEV_MARKER = 'DEV:';

/** Files in the Linux portable bundle whose text a user reads. */
export const LINUX_USER_TEXT_FILES = Object.freeze(['flowmic-desktop', 'README-LINUX.txt']);

/** Every printable run of bytes that contains the marker, trimmed for a report. */
export function findDevPlaceholders(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const needle = Buffer.from(DEV_MARKER, 'latin1');
  const hits = [];
  for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + needle.length)) {
    let start = at;
    while (start > 0 && buf[start - 1] >= 0x20 && buf[start - 1] !== 0x7f) start -= 1;
    let end = at;
    while (end < buf.length && buf[end] >= 0x20 && buf[end] !== 0x7f) end += 1;
    hits.push(buf.subarray(start, end).toString('utf8').slice(0, 120));
  }
  return hits;
}

function refusal(where, found) {
  const lines = found.map(({ file, text }) => `    ${file}: ${text}`).join('\n');
  return new Error(
    `${where} still carries ${found.length} \`${DEV_MARKER}\` placeholder sentence(s) — refusing to ship them:\n${lines}\n` +
      '  These are user-visible (NR-107 launcher / README-LINUX.txt). The final copy lands through the copy job\n' +
      '  (D-47); rebuild after it has, do not edit the sentences here.',
  );
}

/** Throws when any named buffer still carries the marker. `files` = [{ file, bytes }]. */
export function assertNoDevCopy(where, files) {
  const found = [];
  for (const { file, bytes } of files) {
    for (const text of findDevPlaceholders(bytes)) found.push({ file, text });
  }
  if (found.length > 0) throw refusal(where, found);
}

/**
 * The same check on a Linux portable zip. The launcher and the README must be
 * present (a linux-x64 zip without them predates NR-107 and fails silently on a
 * stock Ubuntu desktop), readable, and free of the marker.
 */
export function assertLinuxZipHasNoDevCopy(zipBuf, zipName) {
  const { entries, reason } = listZipEntries(zipBuf);
  if (reason) throw new Error(`${zipName}: cannot read the archive to check for \`${DEV_MARKER}\` placeholders (${reason})`);
  const files = [];
  for (const wanted of LINUX_USER_TEXT_FILES) {
    const entry = entries.find((e) => !e.isDir && e.name.split('/').length === 2 && e.name.endsWith(`/${wanted}`));
    if (!entry) {
      throw new Error(`${zipName}: no top-level ${wanted} — not an NR-107 Linux bundle (the launcher and README are required)`);
    }
    const bytes = extractZipEntry(zipBuf, entry);
    if (!bytes) throw new Error(`${zipName}: cannot extract ${entry.name} to check for \`${DEV_MARKER}\` placeholders`);
    files.push({ file: entry.name, bytes });
  }
  assertNoDevCopy(zipName, files);
  return files.map((f) => f.file);
}

/** Check every linux-x64 portable zip among `names` in `dir`; other names are ignored.
 *  Returns the zips checked. Used by publish.mjs and publish-github-release.mjs. */
export function verifyLinuxZipsHaveNoDevCopy(dir, names) {
  const checked = [];
  for (const name of names) {
    if (parsePortableZipName(name)?.platform !== 'linux-x64') continue;
    assertLinuxZipHasNoDevCopy(readFileSync(join(dir, name)), name);
    checked.push(name);
  }
  return checked;
}
