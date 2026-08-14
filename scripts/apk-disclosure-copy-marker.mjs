// Card W8-6 — does the APK we are about to publish carry the CURRENT
// LAN-TLS disclosure copy, or the rewrite-before version that told users
// encryption was still unfinished?
//
// ── the hole this closes ────────────────────────────────────────────────────
//
// 0.2.60 shipped with LAN TLS encryption delivered, while the APK's disclosure
// strings were still the pre-rewrite copy («目前没有加密» / «加密还在做»).
// Cause: the copy rewrite (`3035c61`, 08-09 22:30) landed AFTER the release pin
// (`08c42b3`, 08-09 11:25). Every unit test green, every gate green, build
// exit 0 — and the bytes that left the building said the opposite of the
// product. Same shape as UP-7 and N1-B4: only a content scan of the shipped
// artifact can see it. CLAUDE.md: once a remember-it discipline has been
// missed twice, automate it.
//
// ── encoding — the trap that makes a UTF-8-only scan look identical to
//    "copy absent" ───────────────────────────────────────────────────────────
//
// The strings live in `lib/<abi>/libapp.so` (Dart AOT snapshot). Measured on
// dev-pc-a, 2026-08-10:
//
//   Chinese disclosure literals are stored as **UTF-16LE**, not UTF-8.
//   Searching them as UTF-8 yields 0 hits on a correct build — the same
//   number a stale-copy APK yields for the NEW strings. That is not a near
//   miss; it is indistinguishable from the defect this gate exists to catch.
//
//   ASCII markers (`mobile:reconnect`, `/api/updates/latest`) remain
//   UTF-8 / ASCII in the same file.
//
// ⇒ two encodings, two scanners. Mixing them up is how the next person
//   spends half an hour concluding the copy "isn't in the APK".
//
// ── §measurement — both directions, real release APKs ───────────────────────
//
//   Machine dev-pc-a, 2026-08-10, Flutter AOT libapp.so (Stored, 0%):
//
//   marker (encoding)                         0.2.61-B (new)   0.2.59 (stale)
//   ----------------------------------------  ---------------  ---------------
//   换成另一台电脑就会被拦下 (utf16le)          3                0
//   在手机上重新配对一次 (utf16le)              3                0
//   要看这条配对是怎么建的 (utf16le)            3                0
//   加密还在做 (utf16le)                        0                3
//   目前没有加密 (utf16le)                      0                3
//   做好之前这句话不会消失 (utf16le)            0                3
//   这一页说清 (utf16le)                        3                3   ← control
//   局域网 (utf16le)                           39               39   ← control
//   mobile:reconnect (utf8)                     3                3   ← control
//   /api/updates/latest (utf8)                  3                0   ← see below
//
// 3 hits = one per ABI. The new/old markers are real discriminators.
//
// ── why `/api/updates/latest` is REPORTED but not a blind-gate control ──────
//
// The card listed it among the control strings. It cannot be a hard prerequisite for
// "the scan can see this APK", because it is UP-7's FEATURE marker — absent
// whenever the self-update define was forgotten. The measured W8-6 negative
// sample (`publish/FlowMic-0.2.59-release.apk`) is exactly that APK
// (control=3, feature=0 for UP-7). Requiring it here would mis-file the
// W8-6 defect as `scanner-blind` instead of `copy-stale` — one value
// answering two questions, the headline bug shape. It stays in the report
// object so an operator still sees the count; the blind verdict rests only
// on markers present in EVERY FlowMic mobile build:
//   UTF-16LE: 这一页说清, 局域网
//   UTF-8:    mobile:reconnect
//
// Three outcomes, three diagnoses, three actions:
//   verdict 'ok'            new copy present, old copy absent → publish
//   verdict 'copy-stale'    scan can see the APK, but new markers are
//                           missing and/or old markers remain → the W8-6
//                           defect: rebuild from a tree that has the rewrite
//   verdict 'scanner-blind' encoding-family controls absent → the SCAN is
//                           broken (compression changed, wrong encoding,
//                           or not a FlowMic APK). Says nothing about the
//                           disclosure copy either way.
//
// ── no bypass flag, deliberately ────────────────────────────────────────────
//
// Matching publish.mjs Gate 0 / UP-7: no env override, no --force. Skip means
// delete these lines in a commit where someone can see it.

import { refuseDirectRun } from './module-entrypoint-guard.mjs';

// `node scripts/apk-disclosure-copy-marker.mjs some.apk` used to evaluate this
// file's exports and exit 0 without opening the APK — which reads as "the APK
// passed". It did that to the coordinator on 2026-08-10. See the guard's header.
refuseDirectRun(
  import.meta.url,
  'node scripts/publish-apk-gates.mjs (or import scanApkForDisclosureCopy)',
);

/** New disclosure phrases that must ALL be present (UTF-16LE in libapp.so). */
// 🔴 RE-POINTED 2026-08-14, and the reason matters more than the new strings.
// The 0.2.67 disclosure rewrite (owner: 「PC/MOBILE 两端不要写大片的文字」)
// compressed the five data-flow steps, and two of the three canaries below went
// with the prose: 「换成另一台电脑就会被拦下」 and 「在手机上重新配对一次」.
//
// Before repointing, the question that had to be answered was NOT 「which
// sentences exist now」 but 「did the CLAIM survive」 — repointing a gate at
// whatever the code happens to say today is how a gate stops measuring anything.
// Measured in i18n/mobile/zh-CN.json: it did. `discStep4LanPlain` still carries
// 「此前建的配对仍然是明文——重新配对才会升级」 (the re-pair instruction) and
// 「每一次连接都核对」 (the identity check); the 「被拦下」 wording moved to
// `diagEncryptionTofuNote`. Same three claims, fewer words.
//
// So all three canaries are now drawn from `discStep4LanPlain` itself — the one
// string whose truth is state-dependent and which therefore must never quietly
// revert to the pre-W8-6 copy that claimed encryption was 「还在做」.
export const APK_DISCLOSURE_NEW_MARKERS = Object.freeze([
  '要看这条配对是怎么建的',
  '此前建的配对仍然是明文',
  '每一次连接都核对',
]);

/** Pre-rewrite phrases that must ALL be absent (UTF-16LE in libapp.so). */
export const APK_DISCLOSURE_OLD_MARKERS = Object.freeze([
  '加密还在做',
  '目前没有加密',
  '做好之前这句话不会消失',
]);

/** UTF-16LE controls — prove the Chinese-string scan can see Dart constants. */
export const APK_DISCLOSURE_CONTROL_UTF16LE = Object.freeze([
  '这一页说清',
  '局域网',
]);

/** UTF-8 control — prove the ASCII scan can see Dart constants at all. */
export const APK_DISCLOSURE_CONTROL_UTF8 = Object.freeze([
  'mobile:reconnect',
]);

/** Reported for operator evidence; NOT used for the blind verdict — see header. */
export const APK_DISCLOSURE_REPORTED_UTF8 = Object.freeze([
  '/api/updates/latest',
]);

/** Count occurrences of `marker` encoded as `encoding` inside `buf`. */
export function countMarkerEncoded(buf, marker, encoding) {
  const needle = Buffer.from(marker, encoding);
  let n = 0;
  let at = buf.indexOf(needle, 0);
  while (at !== -1) {
    n += 1;
    at = buf.indexOf(needle, at + 1);
  }
  return n;
}

function countAll(buf, markers, encoding) {
  /** @type {Record<string, number>} */
  const hits = {};
  for (const m of markers) hits[m] = countMarkerEncoded(buf, m, encoding);
  return hits;
}

function allPositive(hits) {
  return Object.values(hits).every((n) => n > 0);
}

function anyPositive(hits) {
  return Object.values(hits).some((n) => n > 0);
}

/**
 * Scan APK bytes for current vs stale LAN-TLS disclosure copy.
 * @returns {{
 *   newHits: Record<string, number>,
 *   oldHits: Record<string, number>,
 *   controlUtf16le: Record<string, number>,
 *   controlUtf8: Record<string, number>,
 *   reportedUtf8: Record<string, number>,
 *   verdict: 'ok'|'copy-stale'|'scanner-blind'
 * }}
 *
 * Order matters: 'scanner-blind' is decided FIRST. A run where the scan cannot
 * see the APK's Dart strings must never be reported as "the copy is stale".
 */
export function scanApkForDisclosureCopy(buf) {
  const newHits = countAll(buf, APK_DISCLOSURE_NEW_MARKERS, 'utf16le');
  const oldHits = countAll(buf, APK_DISCLOSURE_OLD_MARKERS, 'utf16le');
  const controlUtf16le = countAll(buf, APK_DISCLOSURE_CONTROL_UTF16LE, 'utf16le');
  const controlUtf8 = countAll(buf, APK_DISCLOSURE_CONTROL_UTF8, 'utf8');
  const reportedUtf8 = countAll(buf, APK_DISCLOSURE_REPORTED_UTF8, 'utf8');

  const canSeeChinese = allPositive(controlUtf16le);
  const canSeeAscii = allPositive(controlUtf8);
  if (!canSeeChinese || !canSeeAscii) {
    return {
      newHits,
      oldHits,
      controlUtf16le,
      controlUtf8,
      reportedUtf8,
      verdict: 'scanner-blind',
    };
  }

  const newComplete = allPositive(newHits);
  const oldAbsent = !anyPositive(oldHits);
  if (!newComplete || !oldAbsent) {
    return {
      newHits,
      oldHits,
      controlUtf16le,
      controlUtf8,
      reportedUtf8,
      verdict: 'copy-stale',
    };
  }

  return {
    newHits,
    oldHits,
    controlUtf16le,
    controlUtf8,
    reportedUtf8,
    verdict: 'ok',
  };
}

function formatHits(hits) {
  return Object.entries(hits)
    .map(([k, n]) => `${JSON.stringify(k)}×${n}`)
    .join(', ');
}

/** Refusal text per non-ok verdict — names the action, not just the fact. */
export function disclosureCopyRefusalMessage(label, scan) {
  if (scan.verdict === 'scanner-blind') {
    return (
      `${label}: the disclosure-copy scan is BLIND (scanner-blind) — an encoding-family ` +
      `control is absent too (utf16le controls: ${formatHits(scan.controlUtf16le)}; ` +
      `utf8 controls: ${formatHits(scan.controlUtf8)}; reported utf8: ` +
      `${formatHits(scan.reportedUtf8)}). This says NOTHING about whether the ` +
      `disclosure copy is current. Either this is not a FlowMic APK, lib/<abi>/libapp.so ` +
      `is no longer stored uncompressed, or the Chinese scan is using the wrong ` +
      `encoding (Chinese Dart strings in libapp.so are UTF-16LE, not UTF-8). ` +
      `Re-measure before touching the build: unzip -v the APK and check libapp.so ` +
      `still says "Stored"; grep the same markers as utf16le AND utf8 separately.`
    );
  }
  return (
    `${label}: APK carries STALE LAN-TLS disclosure copy (copy-stale) — new markers ` +
    `missing and/or old markers still present (new: ${formatHits(scan.newHits)}; ` +
    `old: ${formatHits(scan.oldHits)}; utf16le controls present: ` +
    `${formatHits(scan.controlUtf16le)}, so the Chinese scan can see this APK's ` +
    `Dart strings). This is the W8-6 defect: the product shipped encryption while ` +
    `the disclosure still said encryption was unfinished. Rebuild the APK from a ` +
    `tree whose i18n/mobile/zh-CN.json already has the rewrite (0.2.67 moved the ` +
    `copy out of apps/mobile/.../strings/disclosure_strings.dart into the ` +
    `catalogue data files), then re-run publish.`
  );
}
