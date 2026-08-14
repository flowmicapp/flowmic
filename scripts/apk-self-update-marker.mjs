// Card UP-7 — does the APK we are about to publish actually CONTAIN the phone's
// self-update feature?
//
// ── the hole this closes ────────────────────────────────────────────────────
//
// UP-2 landed the phone's self-update behind a build-time define whose default
// is OFF, and that default is deliberate and must not be flipped: a forgotten
// define has to cost us the FEATURE, never ship a Play-policy-violating build
// (apps/mobile/lib/src/update/self_update_flag.dart states the failure-direction
// argument in full). The cost of that correct choice is a silent one:
//
//     flutter build apk --release          ← the bare command
//
// produces an APK without the feature, exits 0, and every gate in the repo stays
// green. Nothing anywhere says the capability is missing. 0.2.59 was published
// exactly that way [measured 2026-08-08, dev-pc-a — see §measurement].
//
// CLAUDE.md: 「要靠人记住的纪律，已经被漏掉两次，就该自动化」. This one did not
// get to wait for a second miss, because its failure mode is not "we shipped
// something wrong" but "the capability does not exist and nobody knows".
//
// ── why a CONTENT marker and not an attestation ─────────────────────────────
//
// The alternative was to route the build through a script that always passes the
// define and writes an attestation beside the APK. That proves the build went
// THROUGH OUR SCRIPT. It does not prove the bytes contain the feature — those are
// different claims, and the weaker one must not be dressed as the stronger.
// publish.mjs already refuses artifacts on content markers rather than on trust
// (`exe embeds the current frontend (main-*.js)`, `sidecar carries stt:refined`),
// because a publish step that trusts an earlier step is how a stale binary
// reaches the owner. This is that same pattern applied to the APK: it
// interrogates the bytes that will ship.
//
// ── §measurement — this was measured, in BOTH directions, not assumed ───────
//
// The whole approach rests on one question that could NOT be answered from first
// principles: when the define is off, does Dart's AOT compiler tree-shake the
// update module hard enough that its strings are ABSENT from the APK? (It was
// not obvious that it would: UpdateController is constructed unconditionally in
// main.dart and its `_checker` default references checkForUpdate.) So two real
// release APKs were built and grepped.
//
//   Machine dev-pc-a, 2026-08-08, Flutter 3.41.8, 3 ABIs, all [measured]:
//
//   marker                    bare build      --dart-define=FLOWMIC_SELF_UPDATE=1
//   ------------------------  --------------  -----------------------------------
//   '/api/updates/latest'     0 hits          3 hits @ 2141467, 27706396, 45559085
//   'mobile:reconnect'        3 hits          3 hits          ← control
//
//   apk sizes: 72,232,275 B (off) vs 72,609,027 B (on); sha256 06f2e89b… / 01e53ad4…
//
// 3 hits = one per ABI (lib/arm64-v8a, lib/armeabi-v7a, lib/x86_64), each with its
// own libapp.so. The marker is therefore a real discriminator: it goes to zero
// when the define is forgotten. This check CAN fail, and the demonstration that
// it does is in scripts/up7-apk-self-update-marker.test.mjs §5.
//
// Cross-check on already-shipped bytes: publish/FlowMic-0.2.59-release.apk scores
// control=3, feature=0 [measured, same machine] — the published 0.2.59 really
// does lack the feature. That is corroboration from the artifact, not from
// anyone's recollection of what they typed.
//
// ── why a raw byte scan is legitimate here, and why the CONTROL marker exists ─
//
// An APK is a zip, so a raw grep only works if the payload is stored
// uncompressed. It is: `unzip -v` reports lib/<abi>/libapp.so as **Stored**, 0%
// [measured, same machine] — Flutter sets android:extractNativeLibs=false, which
// requires it. But "requires it today" is an assumption about a toolchain we do
// not control, and an assumption is exactly what this file exists to remove.
//
// So the scan carries a CONTROL marker: a string present in EVERY build of this
// app regardless of any define. That converts the compression assumption into a
// measurement taken at publish time. CLAUDE.md's G13 rule ②:「负向断言必须自带
// 正向对照，否则『零』可能是探针瞎了而不是实现对了」. Without it, the day AGP
// starts deflating libapp.so this check would report "you forgot the define" —
// confidently, and about the wrong thing, sending someone to rebuild an APK that
// was already correct.
//
// Three outcomes, three different diagnoses, three different actions:
//   verdict 'ok'              feature present  → publish
//   verdict 'missing-feature' control present, feature absent → the UP-7 defect:
//                             the build really was made without the define
//   verdict 'blind'           control absent   → the SCAN is broken (compression
//                             changed, or this is not a FlowMic APK). Says
//                             nothing about the define either way.
//
// ── no bypass flag, deliberately ────────────────────────────────────────────
//
// Matching publish.mjs's Gate 0 precedent verbatim: no env override, no --force.
// If this gate ever has to be skipped, the honest way is to delete these lines
// in a commit where someone can see it.
//
// 🔴 The day a Google Play build legitimately exists, this gate WILL go red on
// it — and that is correct, not a bug to be softened. A Play APK must not carry
// the self-update path at all, and must not be staged into ./publish (the
// sideload distribution directory) in the first place. On that day the fix is to
// split the gate BY CHANNEL — a Play artifact asserting the marker is ABSENT —
// never to weaken it into "present or absent, both fine", which is a check that
// cannot fail. See self_update_flag.dart's header: no store build may be
// produced at all until the runtime install-source guard (design §6 ②) exists
// and has been proven on a real Play track.

import { refuseDirectRun } from './module-entrypoint-guard.mjs';

// Same trap as its sibling: running this file directly exits 0 having scanned
// nothing, which is indistinguishable from a pass. See the guard's header.
refuseDirectRun(
  import.meta.url,
  'node scripts/publish-apk-gates.mjs (or import scanApkForSelfUpdate)',
);

/** Present in EVERY build of the mobile app, whatever the defines. Its job is to
 *  prove the byte scan can see Dart string constants at all — see the header. It
 *  is a protocol event name (lib/generated/flowmic_events.g.dart), so it is
 *  generated from the protocol package and cannot quietly drift out of the app. */
export const APK_CONTROL_MARKER = 'mobile:reconnect';

/** Present ONLY when --dart-define=FLOWMIC_SELF_UPDATE is on. It is
 *  `kUpdateManifestPath` in apps/mobile/lib/src/update/update_check.dart — the
 *  path the update check actually requests, i.e. the thing the feature DOES,
 *  not a label describing it. */
export const APK_SELF_UPDATE_MARKER = '/api/updates/latest';

/** The command that produces a publishable APK. Kept here beside the marker so
 *  the refusal message and the docs quote one source rather than two. */
export const APK_BUILD_COMMAND =
  'flutter build apk --release --dart-define=FLOWMIC_SELF_UPDATE=1';

/** Occurrences of `marker` in `buf`. Counted rather than tested for presence
 *  because the count is the operator's evidence: one hit per ABI is the expected
 *  shape, and a count lands in the log where a boolean would not. */
export function countMarker(buf, marker) {
  const needle = Buffer.from(marker, 'utf8');
  let n = 0;
  let at = buf.indexOf(needle, 0);
  while (at !== -1) {
    n += 1;
    at = buf.indexOf(needle, at + 1);
  }
  return n;
}

/**
 * Scan APK bytes for the self-update feature.
 * @returns {{control:number, feature:number, verdict:'ok'|'missing-feature'|'blind'}}
 *
 * Order matters: 'blind' is decided FIRST. A run where the scan cannot see
 * anything must never be reported as "the define was forgotten" — that is a
 * confident answer to a question this scan did not manage to ask.
 */
export function scanApkForSelfUpdate(buf) {
  const control = countMarker(buf, APK_CONTROL_MARKER);
  const feature = countMarker(buf, APK_SELF_UPDATE_MARKER);
  if (control === 0) return { control, feature, verdict: 'blind' };
  if (feature === 0) return { control, feature, verdict: 'missing-feature' };
  return { control, feature, verdict: 'ok' };
}

/** The refusal text for each non-ok verdict. Separated from publish.mjs so the
 *  test can assert on the exact words an operator will read at 2am — the whole
 *  value of a red gate is that its message names the action. */
export function selfUpdateRefusalMessage(label, scan) {
  if (scan.verdict === 'blind') {
    return (
      `${label}: the feature scan is BLIND — the control marker ` +
      `'${APK_CONTROL_MARKER}' is absent too (control=${scan.control}, ` +
      `feature=${scan.feature}). This says NOTHING about the self-update define. ` +
      `Either this is not a FlowMic APK, or lib/<abi>/libapp.so is no longer ` +
      `stored uncompressed in the archive and a raw byte scan can no longer read ` +
      `it. Re-measure before touching the build: unzip -v the APK and check ` +
      `libapp.so still says "Stored".`
    );
  }
  return (
    `${label}: built WITHOUT the phone's self-update feature — marker ` +
    `'${APK_SELF_UPDATE_MARKER}' absent (control marker present: ${scan.control} ` +
    `hits, so the scan can see this APK's Dart strings). This is what a bare ` +
    `\`flutter build apk --release\` produces: the define defaults to off and the ` +
    `AOT compiler tree-shakes the whole update module away, silently, exit 0. ` +
    `Rebuild with:  ${APK_BUILD_COMMAND}`
  );
}
