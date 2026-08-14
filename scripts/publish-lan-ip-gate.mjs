// The LAN-IP content gate of scripts/publish.mjs (card OSS-DEFAULTS, face 5 —
// the wiring half).
//
// ── the open account this closes ────────────────────────────────────────────
//
// scripts/scan-artifact-lan-ip.mjs was written, tested, and never called. Its
// own header said so in as many words — "NOT WIRED INTO scripts/publish.mjs …
// the wiring is an OPEN ACCOUNT handed to the release window … an unrun scanner
// is worth exactly as much as an unrun test" — because the window that built it
// was forbidden to touch the publisher (W4A §1-bis-1: "part built, not installed").
//
// The release window that inherited the account ran the scanner by hand and then
// deliberately did NOT wire it (W6R §1-3), for a reason that is still correct and
// that this file has to answer rather than ignore: on the tree as it stands the
// scan exits 1, and it exits 1 on artifacts that are RIGHT. CLAUDE.md:
// 「门加上去的那一刻必须是绿的……一开始就红的门第二天就会被所有人无视，等于没加」.
// W6R wrote down the question that had to be answered before wiring:
//
//     「预设目录里的私网段算不算 ship」
//
// ── the answer, and why it is not a waiver of the question ──────────────────
//
// It ships, and it is ALREADY a declared, argued, owner-visible debt: the six LAN
// endpoints in packages/protocol/src/engine-presets.ts are a preset CATALOGUE
// (CLAUDE.md 「预设走 presets 包」), and verify/lint/no-lan-ip.mjs carries them as
// a WAIVERS entry with an exact count and a written reason. So this gate does not
// re-litigate them and does not silently bless them either. It asks the narrower
// question a publish boundary can actually answer:
//
//     is every private-range occurrence in the bytes we are about to hand out
//     one of the occurrences somebody already declared, in the file that was
//     already declared to carry them — and NOTHING else?
//
// Anything else refuses the publish. The declared budget is READ FROM the lint's
// WAIVERS table rather than copied here, so 「how many LAN endpoints do we ship」
// has one answer asked twice (of the source, and of the bytes) instead of two
// answers that drift. Add a seventh preset and this gate goes red until the
// waiver moves with it — which is the point: the account stays a census, not a
// blanket exemption.
//
// ⚠️ WHAT A GREEN RUN HERE DOES NOT MEAN. It does not mean a stranger's install
// cannot reach the owner's office. It means no NEW leak got in beside the
// catalogue. Closing the catalogue itself is a product decision (owner ruling #13,
// W4A-9), not something a publish gate may decide by staying quiet.
//
// ── coverage, stated so nobody reads more into it ───────────────────────────
//
// Scans the two TEXT artifacts publish.mjs is about to ship from:
//   · the sidecar bundle (esbuild output: server-core + protocol + zod + socket.io
//     in one file — the bundler is exactly how a clean-looking source ends up
//     carrying a dependency's addresses), staged into publish/FlowMic-portable/;
//   · the built desktop frontend, which the exe embeds (publish.mjs already
//     asserts that embedding one block above, so scanning dist covers the exe's
//     web layer without re-reading a 20 MB binary as text).
// NOT the .exe/.msi/.apk themselves: the scanner skips known-binary extensions
// on purpose (mojibake noise), and the Rust and Dart sources that compile into
// them are covered by verify/lint/no-lan-ip.mjs at source level. An APK byte
// scan is a separate question with its own waiver arithmetic — an open account,
// not something quietly folded in here.
//
// NOT `publish/` either, deliberately, even though the scanner's own
// DEFAULT_TARGETS include it. At the moment this gate runs, publish/ still holds
// LAST round's artifacts (publish.mjs clears it further down). W6R hit this
// exactly: 「上面那三个命中里 … 是上一轮的陈旧产物 … 否则我量的是别人」. A gate that
// refuses this round's publish over last round's bytes measures the wrong thing.
//
// ── no bypass flag, deliberately ────────────────────────────────────────────
//
// Matching Gate 0 and the UP-7 APK gate verbatim: no env override, no --force.
// If this ever has to be skipped, the honest way is to delete these lines in a
// commit somebody can see.

import { refuseDirectRun } from './module-entrypoint-guard.mjs';
import { RANGES, scanTargets } from './scan-artifact-lan-ip.mjs';
import { WAIVERS } from '../verify/lint/no-lan-ip.mjs';

// Same trap as its siblings: running a pure-function module directly evaluates
// definitions and exits 0, which is indistinguishable from "the check ran and
// passed". See the guard's header for the two times that cost this repo.
refuseDirectRun(
  import.meta.url,
  'node scripts/publish.mjs (or import verifyArtifactsCarryNoLanIp)',
);

/**
 * The artifacts this gate reads, repo-relative. See the coverage note above for
 * what is deliberately absent (publish/, and every binary product).
 */
export const LAN_IP_SCAN_TARGETS = [
  'apps/desktop/src-tauri/resources/server.js',
  'apps/desktop/dist',
];

/**
 * The office LAN range, taken from the scanner's own RANGES rather than spelled
 * again here.
 *
 * 🔴 NOT A CONVENIENCE. Both this repo's LAN-IP rules keep their ranges as plain
 * string literals because the open-source export applies a tree-wide literal
 * substitution (scripts/opensource-manifest.mjs REDACTIONS) that rewrites the
 * ranges everywhere — a second copy written here would be rewritten too, but a
 * copy written as an escaped REGEX would not, and would then hunt an address the
 * exported tree no longer contains. no-lan-ip.mjs measured that: 13 of 16 entries
 * came out wrong. Importing the literal means this file moves with the same pass
 * that moves everything else, and there is no second copy to drift.
 */
const [OFFICE_LAN_RANGE] = RANGES;

/** The lint entry that already declares the preset catalogue's debt. */
const PRESET_CATALOGUE_SOURCE = 'packages/protocol/src/engine-presets.ts';

/**
 * How many private-range occurrences the preset catalogue legitimately puts into
 * a bundle: the CODE count from the lint's waiver — comments are not in an
 * esbuild bundle (esbuild drops them), so the comment count is deliberately not
 * added in.
 *
 * Read, not copied. If the catalogue grows and the waiver is updated, this gate
 * follows; if the catalogue grows and the waiver is NOT updated, the lint goes
 * red first. Either way there is no number here for anyone to forget.
 */
export function presetCatalogueBudget(waivers = WAIVERS) {
  const entry = waivers.find((w) => w.file === PRESET_CATALOGUE_SOURCE);
  // A missing entry is not "budget 0, carry on": it means the thing this gate's
  // accounting rests on has moved, and the honest outcome is that every hit
  // becomes undeclared and the publish refuses until someone looks.
  return entry ? entry.code : 0;
}

/**
 * The artifacts allowed to carry the catalogue, and only the catalogue.
 *
 * Patterns, not literal paths, because the frontend bundle's name carries a
 * content hash that changes on every build — pinning the hash would make this
 * table stale on the next `vite build` and stale-then-red is how a table stops
 * being read. The hash is not the identity; "the desktop frontend's main chunk"
 * is.
 */
export const DECLARED_CARRIERS = [
  {
    id: 'sidecar bundle',
    pattern: /^apps\/desktop\/src-tauri\/resources\/server\.js$/,
    why: 'esbuild bundles @flowmic/protocol into it, catalogue included',
  },
  {
    id: 'desktop frontend main chunk',
    pattern: /^apps\/desktop\/dist\/assets\/main-[A-Za-z0-9_-]+\.js$/,
    why: 'the settings UI imports the same catalogue to render the preset menu',
  },
];

/**
 * Split the scanner's findings into the declared account and everything else.
 *
 * A finding is DECLARED only when all three hold: the file is a declared
 * carrier, the range is the office LAN range (the VPN range is in no account —
 * any occurrence of it is new debt), and the count is EXACTLY the catalogue's
 * budget.
 *
 * 🔴 EXACTLY, checked in BOTH directions, copying no-lan-ip.mjs's discipline
 * verbatim: more than the budget is new debt riding in beside the catalogue;
 * FEWER is a stale account, which reads as evidence that somebody checked. Both
 * refuse. `<=` would have been the natural thing to write and it is precisely
 * the hole — one leaked address into a bundle whose catalogue shrank by one
 * lands back on the budget and passes.
 */
export function classifyFindings(findings, budget = presetCatalogueBudget()) {
  const declared = [];
  const undeclared = [];
  for (const f of findings) {
    const carrier = DECLARED_CARRIERS.find((c) => c.pattern.test(f.file));
    if (carrier && f.range === OFFICE_LAN_RANGE && f.count === budget) {
      declared.push({ ...f, carrier: carrier.id });
    } else {
      undeclared.push({ ...f, carrier: carrier ? carrier.id : null });
    }
  }
  return { declared, undeclared };
}

/**
 * Scan the artifacts and reach one of four verdicts.
 * @returns {{scanned:number, controlSeen:number, findings:Array, declared:Array,
 *            undeclared:Array, budget:number, targets:string[],
 *            verdict:'ok'|'leak'|'blind'|'nothing-to-scan'}}
 *
 * Precedence mirrors the scanner's own main(): nothing-to-scan, then blind, then
 * hits. A run that could not read anything must never be reported as a verdict
 * about the artifact — that is a confident answer to a question the scan never
 * managed to ask.
 */
export function scanPublishArtifactsForLanIp(targets = LAN_IP_SCAN_TARGETS, root = undefined) {
  const budget = presetCatalogueBudget();
  const { scanned, controlSeen, findings } = root === undefined
    ? scanTargets(targets)
    : scanTargets(targets, root);
  const base = { scanned, controlSeen, findings, budget, targets };
  if (scanned === 0) return { ...base, declared: [], undeclared: [], verdict: 'nothing-to-scan' };
  if (controlSeen === 0) return { ...base, declared: [], undeclared: [], verdict: 'blind' };
  const { declared, undeclared } = classifyFindings(findings, budget);
  return { ...base, declared, undeclared, verdict: undeclared.length > 0 ? 'leak' : 'ok' };
}

/** One finding, formatted exactly as the scanner's own CLI prints it
 *  (`  <file>: <count> × <range>`) so the words an operator reads at the publish
 *  boundary and the words they get re-running the scanner by hand are the same
 *  words. Two spellings of one finding is one spelling too many. */
function findingLine(f) {
  return `    ${f.file}: ${f.count} × ${f.range}`;
}

/**
 * The refusal text for each non-ok verdict.
 *
 * Separated from publish.mjs so the drill can assert on the exact sentence an
 * operator will read — the whole value of a red gate is that its message names
 * the action, and the three actions here are genuinely different:
 *   leak            → find out what put that address in the bundle
 *   blind           → fix the scanner/targets; say NOTHING about the artifact
 *   nothing-to-scan → build first; the gate has not run
 */
export function lanIpRefusalMessage(scan) {
  if (scan.verdict === 'nothing-to-scan') {
    return (
      `LAN-IP artifact scan: NOTHING TO SCAN — none of [${scan.targets.join(', ')}] exist, so ` +
      `0 file(s) were read. Refusing to publish: "no files found" and "the files are clean" are ` +
      `different facts and this gate has established neither. Build first ` +
      `(\`pnpm --filter @flowmic/desktop build:sidecar\` and \`build\`), then re-run.`
    );
  }
  if (scan.verdict === 'blind') {
    return (
      `LAN-IP artifact scan: THE SCAN IS BLIND — read ${scan.scanned} file(s) and not one ` +
      `contained the control string, so a zero-hit result would be evidence about the ` +
      `SCANNER, not about the artifact. This says NOTHING about whether the bytes are ` +
      `clean. Do not read it as a pass and do not go looking for a leak: check the target ` +
      `paths and the encoding first (targets: ${scan.targets.join(', ')}).`
    );
  }
  const total = scan.undeclared.reduce((n, f) => n + f.count, 0);
  const lines = scan.undeclared.map(findingLine).join('\n');
  const carrierNote = scan.undeclared.some((f) => f.carrier)
    ? `\n    (a file marked as a declared carrier above is here because its COUNT is not the ` +
      `declared ${scan.budget} — more means something rode in beside the catalogue, fewer means ` +
      `the account in verify/lint/no-lan-ip.mjs is stale and reads as evidence somebody checked)`
    : '';
  return (
    `LAN-IP artifact scan: ${total} UNDECLARED occurrence(s) of an owner private range in the ` +
    `bytes about to be published (${scan.scanned} file(s) scanned) — refusing to stage anything:\n` +
    `${lines}${carrierNote}\n` +
    `    These bytes ship. A stranger who installs this build gets them, and on a public ` +
    `range they route somewhere real.\n` +
    `    The only DECLARED source is the preset catalogue in ${PRESET_CATALOGUE_SOURCE} ` +
    `(${scan.budget} occurrence(s) per bundle, per the WAIVERS entry in ` +
    `verify/lint/no-lan-ip.mjs). Anything above is new debt: find what put it there. ` +
    `If the catalogue itself changed, move the waiver first — this gate reads that table, ` +
    `it does not keep its own copy.`
  );
}

/**
 * The gate publish.mjs calls. Returns true when the artifacts may be staged.
 *
 * Takes `fail`/`ok` rather than throwing, matching publish-apk-gates.mjs: the
 * publisher collects every refusal in a run so an operator facing two problems
 * hears about both instead of one at a time.
 */
export function verifyArtifactsCarryNoLanIp(fail, ok, targets = LAN_IP_SCAN_TARGETS, root = undefined) {
  const scan = scanPublishArtifactsForLanIp(targets, root);
  if (scan.verdict !== 'ok') {
    fail(lanIpRefusalMessage(scan));
    return false;
  }
  const declaredTotal = scan.declared.reduce((n, f) => n + f.count, 0);
  ok(
    `artifacts carry no undeclared LAN address (${scan.scanned} file(s) read, control seen in ` +
      `${scan.controlSeen}; ${declaredTotal} declared preset-catalogue occurrence(s) across ` +
      `${scan.declared.length} carrier(s), budget ${scan.budget}/bundle)`,
  );
  return true;
}
