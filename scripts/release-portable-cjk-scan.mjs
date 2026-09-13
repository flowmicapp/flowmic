// Owner ruling 2026-09-09 (docs/decisions/2026-09-09-owner-portable-release-english-only.md)
// — the Release body has been English-only since 2026-08-15, but the ruling's
// own Situation notes that rule never covered the text FILES bundled INSIDE a
// portable zip (the README a user actually unpacks and reads). This module is
// the gate for that half: every human-readable text entry inside a
// `*-portable-*.zip` release asset must contain no CJK before that asset is
// uploaded to a public GitHub Release.
//
// ── why this reads the zip itself instead of trusting what publish.mjs wrote ──
//
// The producing side (scripts/publish.mjs) already writes the bundled
// README.txt in English. This gate exists anyway, on the SHIPPED BYTES, for
// the same reason the release-body CJK check runs on the bytes about to be
// published rather than on "whoever wrote the CHANGELOG section remembered
// the rule": a rule that lives only in a script's good behavior today has no
// defense against a future edit, a hand-patched archive, or a third text file
// someone adds later without re-reading this file's header.
//
// ── archive-reading approach, and why it is not a new dependency ─────────────
//
// The central-directory walk and local-header extraction below are the same
// mechanism scripts/portable-self-update-marker.mjs's extractPortableExe()
// already uses and has measured on real shipped bytes (0.2.59: the portable
// zip stores its payload DEFLATEd — method 8 — so a raw byte scan of the
// archive is structurally blind; see that file's header for the measurement).
// That function looks for exactly one named entry; this one generalizes the
// same walk to enumerate every entry, so a second, independent zip reader is
// not being invented — `node:zlib`'s inflateRawSync is already a dependency
// this repo pins, and no new package is added by this file.
//
// ── why the CJK pattern is DUPLICATED here rather than imported ──────────────
//
// The obvious move is to import `CJK_RE` / `scanText` from verify/lint/no-cjk.mjs
// so this file and the rest of the repo's CJK lints share one definition of
// "is this Chinese" — importing was the first version of this file. It broke
// scripts/m3-latest-apk-asset.test.mjs's isolation fixture: that drill copies
// scripts/publish-github-release.mjs and its import closure into a bare temp
// directory by walking ONLY same-directory sibling imports (copyClosure(), by
// design — see that file's header; its own regex literally quotes the import
// shape it follows, which is deliberately not repeated verbatim here so this
// comment cannot itself be mistaken for one of those import statements), so a
// `../verify/...` reference anywhere in this module's chain resolves to a
// path that was never copied and the isolated run crashes with
// ERR_MODULE_NOT_FOUND before a
// single assertion runs. This module is reachable from that closure (it is
// imported by publish-github-release.mjs), so it has to stay inside the
// `scripts/` namespace with only `./` imports, the same constraint every
// other file already in that closure quietly satisfies.
//
// So the pattern is copied, not shared, and §0 of the drill
// (scripts/release-portable-cjk-scan.test.mjs) asserts this copy's source
// text is byte-identical to verify/lint/no-cjk.mjs's CJK_RE — a test file is
// NOT walked by copyClosure (it is never part of SUBJECT's own import graph),
// so that comparison is free to import across the boundary this module
// cannot. If the two patterns ever drift, that assertion is what catches it,
// not a shared import.

import { inflateRawSync } from 'node:zlib';

/** Han + CJK Ext-A + CJK punctuation + fullwidth forms — MUST stay
 *  byte-identical to `CJK_RE` in verify/lint/no-cjk.mjs (see the header above
 *  for why this is a copy, not an import, and what keeps the two in sync). */
export const CJK_RE = /[一-鿿㐀-䶿　-〿＀-￯]/u;
const CJK_RE_G = /[一-鿿㐀-䶿　-〿＀-￯]/gu;

/** Copied from verify/lint/no-cjk.mjs's `scanText` (same reason as CJK_RE
 *  above). Scans one file's text; returns null if it has no CJK, else
 *  {count, firstLine}. */
function scanText(text) {
  const textLines = text.split('\n');
  let count = 0;
  let firstLine = -1;
  for (let n = 0; n < textLines.length; n++) {
    const m = textLines[n].match(CJK_RE_G);
    if (m) {
      count += m.length;
      if (firstLine === -1) firstLine = n + 1;
    }
  }
  return count === 0 ? null : { count, firstLine };
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
/** Max EOCD scan-back: the 22-byte record plus the format's own maximum
 *  65,535-byte trailing comment — bounded so a corrupt multi-hundred-MB file
 *  cannot turn into a full reverse scan of itself. Same bound
 *  portable-self-update-marker.mjs uses, for the same reason. */
const EOCD_MAX_BACK = 22 + 0xffff;

/** Extensions this gate treats as human-readable text worth scanning. An
 *  allowlist, not a denylist of binaries: a denylist silently admits whatever
 *  extension nobody thought to exclude yet (an icon, the exe itself, a font).
 *  `.htm`/`.html` both match via the `l?`. */
export const TEXT_ENTRY_RE = /\.(txt|md|json|html?)$/i;

/**
 * Walk a zip's central directory and return every entry, with enough fields
 * to extract each one (`method`, `csize`, `lho`). Never throws on malformed
 * input — a release gate that crashes produces a stack trace where it owes a
 * verdict, not a diagnosis.
 *
 * @param {Buffer} zipBuf
 * @returns {{entries: Array<{name:string, isDir:boolean, method:number, csize:number, usize:number, lho:number}>, reason: string|null}}
 *   `reason` is non-null only when the central directory itself could not be
 *   read at all (too small, no EOCD record, zip64, truncated) — that is a
 *   different failure than "read fine, nothing matched" and callers must not
 *   conflate the two.
 */
export function listZipEntries(zipBuf) {
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22) return { entries: [], reason: 'too-small-to-be-a-zip' };

  let eocd = -1;
  const floor = Math.max(0, zipBuf.length - EOCD_MAX_BACK);
  for (let i = zipBuf.length - 22; i >= floor; i--) {
    if (zipBuf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) return { entries: [], reason: 'no-end-of-central-directory' };

  const count = zipBuf.readUInt16LE(eocd + 10);
  const cdOff = zipBuf.readUInt32LE(eocd + 16);
  // zip64 sentinels — reading these 32-bit fields as real values on a zip64
  // archive would walk into garbage and produce a confident WRONG verdict, so
  // this refuses by name instead of guessing (same reasoning as
  // extractPortableExe() and readZipEntries() in pack-portable.mjs).
  if (count === 0xffff || cdOff === 0xffffffff) return { entries: [], reason: 'zip64-not-supported' };
  if (cdOff >= zipBuf.length) return { entries: [], reason: 'central-directory-offset-out-of-range' };

  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zipBuf.length || zipBuf.readUInt32LE(p) !== CD_SIG) {
      return { entries, reason: 'central-directory-truncated' };
    }
    const method = zipBuf.readUInt16LE(p + 10);
    const csize = zipBuf.readUInt32LE(p + 20);
    const usize = zipBuf.readUInt32LE(p + 24);
    const nlen = zipBuf.readUInt16LE(p + 28);
    const elen = zipBuf.readUInt16LE(p + 30);
    const clen = zipBuf.readUInt16LE(p + 32);
    const lho = zipBuf.readUInt32LE(p + 42);
    const name = zipBuf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    entries.push({ name, isDir: name.endsWith('/'), method, csize, usize, lho });
    p += 46 + nlen + elen + clen;
  }
  return { entries, reason: null };
}

/**
 * Extract one entry's decompressed bytes, given the record `listZipEntries()`
 * returned for it. The payload start is computed from the LOCAL header's own
 * name/extra lengths (which may differ from the central directory's) — the
 * same off-by-a-few-bytes trap `extractPortableExe()` guards against.
 *
 * @returns {Buffer|null} null on any structural failure — never throws.
 */
export function extractZipEntry(zipBuf, entry) {
  if (entry.lho + 30 > zipBuf.length) return null;
  const lnlen = zipBuf.readUInt16LE(entry.lho + 26);
  const lelen = zipBuf.readUInt16LE(entry.lho + 28);
  const start = entry.lho + 30 + lnlen + lelen;
  if (start + entry.csize > zipBuf.length) return null;
  const raw = zipBuf.subarray(start, start + entry.csize);
  if (entry.method === 0) return raw; // STORED
  if (entry.method !== 8) return null; // not DEFLATE — refuse rather than mis-decode
  try {
    return inflateRawSync(raw);
  } catch {
    return null;
  }
}

/**
 * Scan every human-readable text entry of a zip for CJK, using the repo's
 * one existing CJK detector (`scanText`, from verify/lint/no-cjk.mjs) so this
 * gate and the source-tree lint can never disagree about what counts.
 *
 * @param {Buffer} zipBuf
 * @returns {{findings: Array<{entry:string, count:number, firstLine:number}>, scanned: number, reason: string|null}}
 *   `reason` non-null means the archive itself could not be opened at all —
 *   a different verdict from "opened fine, found nothing", mirroring
 *   portable-self-update-marker.mjs's no-exe-entry/blind split: "could not
 *   look" must never be reported as "looked and it's clean".
 */
export function scanZipForCjk(zipBuf) {
  const { entries, reason } = listZipEntries(zipBuf);
  if (reason) return { findings: [], scanned: 0, reason };

  const findings = [];
  let scanned = 0;
  for (const entry of entries) {
    if (entry.isDir || !TEXT_ENTRY_RE.test(entry.name)) continue;
    const bytes = extractZipEntry(zipBuf, entry);
    if (!bytes) continue; // an unreadable individual entry is not this gate's corruption to diagnose
    scanned += 1;
    const hit = scanText(bytes.toString('utf8'));
    if (hit) findings.push({ entry: entry.name, count: hit.count, firstLine: hit.firstLine });
  }
  return { findings, scanned, reason: null };
}

/** Refusal text, shaped like publish-github-release.mjs's release-body CJK
 *  refusal on purpose: name the file, name the first offending line, point at
 *  the ruling, name the fix. */
export function zipCjkRefusalMessage(assetName, findings) {
  const lines = findings
    .map((f) => `    ${f.entry} — ${f.count} CJK run(s) found, first at line ${f.firstLine}`)
    .join('\n');
  return (
    `✗ ${assetName}: a text file inside this portable archive contains CJK text. ` +
    'Portable release assets are English-only ' +
    '(owner iron rule 2026-09-09 — docs/decisions/2026-09-09-owner-portable-release-english-only.md).\n' +
    `${lines}\n` +
    '  Rewrite the offending file in English (the bundled README.txt is generated by ' +
    'scripts/publish.mjs), rebuild the portable archive with scripts/pack-portable.mjs, then re-run.'
  );
}

/** Refusal text for the case the archive itself could not be read. Kept
 *  separate from `zipCjkRefusalMessage` because "could not look" must not be
 *  worded like "looked and found something" — same split as
 *  portable-self-update-marker.mjs's `portableRefusalMessage`. */
export function zipUnreadableRefusalMessage(assetName, reason) {
  return (
    `✗ ${assetName}: could not read this as a zip archive (${reason}) — refusing to ` +
    'release a portable asset this gate cannot verify is English-only.'
  );
}
