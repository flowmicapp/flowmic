// verify-export-license.mjs — the LICENSE state machine used by
// scripts/verify-export.mjs (split out at the 800-line gate; the orchestration,
// sandbox asserts and logging stay with the runner — what lives here is the
// pure judgement logic plus the constants it judges against).
//
// Two states are legitimate for a LICENSE file and each has a distinct proof:
//   unsigned  the template's placeholders are intact (a fork, a re-template)
//   signed    the placeholders are gone AND the owner's copyright witness line
//             is present — absence of placeholders alone is never accepted,
//             because that is also exactly what template drift looks like
// Everything else (half the placeholders, duplicated placeholders, neither
// placeholders nor witness) is a broken state the caller must fail loudly on.

// 🔴 The header above says this module is "pure judgement logic". That stopped
// being the whole truth on 2026-08-14, when the license-stub STAGE moved here
// (see its own comment at the foot of this file): the stage reads and writes
// files and commits inside the sandbox, so these three imports are its, not the
// classifier's. The classifier above is still pure and still tested as such.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STUB_MARKER = 'FLOWMIC_VERIFY_EXPORT_SANDBOX_STUB';
export const STUB_TEXT = `${STUB_MARKER} — not a real copyright holder; injected only inside a throwaway ` +
  'sandbox by scripts/verify-export.mjs, never in the real repository';

// One spec per LICENSE file, because the placeholders in a file answer ONE
// question ("is this file signed?") and must be judged together.
//   placeholders  the template's literals (stubbed on an unsigned tree)
//   witness       the SIGNED line that must exist when the placeholders are gone
//   unsigned()    the exact template line, used by --skip-license-stub to
//                 un-sign a signed sandbox copy so the owner gate can fire
export const LICENSE_SPECS = [
  {
    file: 'LICENSE',
    placeholders: [
      { find: '<name of author>', replace: STUB_TEXT },
      { find: '<year>', replace: '0000' },
    ],
    // The AGPL how-to-apply appendix line the owner filled on 2026-08-06.
    // The FSF's own «Copyright (C) 2007 Free Software Foundation» line at the
    // top of the license text must NOT count as a witness — hence the lookahead.
    witness: /^(\s*)Copyright \(C\) \d{4}\s+(?!Free Software Foundation)\S.*$/m,
    unsigned: (indent) => `${indent}Copyright (C) <year>  <name of author>`,
  },
  {
    file: 'packages/protocol/LICENSE',
    placeholders: [
      { find: '[name of copyright owner]', replace: STUB_TEXT },
      { find: '[yyyy]', replace: '0000' },
    ],
    // The Apache-2.0 appendix boilerplate line, filled by the owner. Nothing
    // else in the Apache text matches `Copyright <4 digits>` — measured
    // (grep -n "Copyright" packages/protocol/LICENSE) before relying on it.
    witness: /^(\s*)Copyright \d{4} \S.*$/m,
    unsigned: (indent) => `${indent}Copyright [yyyy] [name of copyright owner]`,
  },
];

/** Classify one LICENSE file's text against its spec. Pure — no IO, no throw:
 *  the caller owns the failure wording because it owns the file path and log. */
export function classifyLicense(text, spec) {
  const counts = spec.placeholders.map((ph) => text.split(ph.find).length - 1);
  const over = counts.findIndex((n) => n > 1);
  if (over >= 0) return { state: 'over', which: spec.placeholders[over].find, count: counts[over] };
  const present = counts.filter((n) => n === 1).length;
  if (present === spec.placeholders.length) return { state: 'unsigned' };
  if (present !== 0) return { state: 'half', present, total: spec.placeholders.length };
  const m = text.match(spec.witness);
  if (!m) return { state: 'drift' };
  return { state: 'signed', witness: m[0], indent: m[1] };
}

/** The owner gate's own error token. The reverse control asserts the export
 *  died NAMING THIS — "it failed" on its own is not evidence, because a
 *  missing tar binary fails too. */
export const LICENSE_GATE_TOKEN = 'LICENSE_UNSIGNED';

/**
 * 🔴 --skip-license-stub INVERTS the export stage's verdict. Without this
 * function the flag asserted NOTHING.
 *
 * As shipped in IT-46 it printed «the export stage below MUST now fail with
 * LICENSE_UNSIGNED, for real» — and nothing checked that it did. The stage that
 * skipped the work reported PASS, and a successful export reported PASS too, so
 * the run ended `OVERALL: PASS`, exit 0, two lines beneath a banner saying the
 * opposite. That is not a hypothetical: on the day the owner actually signs the
 * LICENSE — the exact state this gate exists to wait for — the placeholders are
 * gone, the gate does not fire, the export succeeds, and the "reverse control"
 * reports success for the outcome it was written to forbid. (Since OSS-3 the
 * arming half answers that day: a signed sandbox copy is un-signed back to the
 * template before the export runs, so the gate always has something to refuse.)
 *
 * This repo already legislated the shape (0.2.52 §3): a reverse control pointing
 * the wrong way is WORSE than no reverse control, because it does not merely
 * miss a defect — it writes the defect into the acceptance criteria, and it goes
 * red on the day the fix arrives. The first question to ask of a negative
 * assertion is not "is this right?" but "if I am wrong, who tells me?" For the
 * shipped version the answer was nobody. It is now this function.
 *
 * Three outcomes, all named:
 *   - export SUCCEEDED  -> FAIL. Under this flag, success IS the failure.
 *   - export failed but its log never names the gate -> FAIL. It died of
 *     something else, so the run proves nothing about the owner gate.
 *   - export failed naming the gate -> PASS, and `halt` stops the downstream
 *     stages: nothing was exported, so there is nothing for them to run against,
 *     and letting them fail on a missing directory would report a second,
 *     invented defect.
 */
export function judgeSkippedStubExport(res) {
  if (res.status !== 'FAIL') {
    return {
      ...res,
      status: 'FAIL',
      detail:
        `REVERSE CONTROL DID NOT FIRE — the export SUCCEEDED (${res.detail}) with the LICENSE copyright ` +
        `placeholders left unfilled. Either the ${LICENSE_GATE_TOKEN} owner gate no longer refuses an ` +
        'unsigned tree, or the placeholders it looks for have changed. Under --skip-license-stub a ' +
        'successful export IS the failure of this run.',
    };
  }
  let named = false;
  try {
    named = res.log ? readFileSync(res.log, 'utf8').includes(LICENSE_GATE_TOKEN) : false;
  } catch {
    named = false; // unreadable log cannot be evidence of anything
  }
  if (!named) {
    return {
      ...res,
      status: 'FAIL',
      detail:
        `the export failed (${res.detail}) but its log never names ${LICENSE_GATE_TOKEN} — it died for some ` +
        'OTHER reason, so this run proves nothing about the owner gate. Read the log before concluding anything.',
    };
  }
  return {
    ...res,
    status: 'PASS',
    detail: `reverse control fired: export refused (${res.detail}) and its log names ${LICENSE_GATE_TOKEN}`,
    halt: 'nothing was exported (reverse control) — downstream stages have no tree to run against',
  };
}

// ── The license-stub STAGE (moved here 2026-08-14) ──────────────────────────
// A structural split, not a rewrite: verify-export.mjs crossed the 800-line
// gate when the gen-mobile stage was added, and this block is the one coherent
// family that already had a home — this module is the LICENSE state machine it
// drives. Moved VERBATIM; only the signature changed, taking its four
// collaborators as parameters instead of reading them from the driver's scope,
// which is what keeps this module pure and testable the way the rest of it is.
export function runLicenseStubStage({ HARNESS_DIR, SKIP_LICENSE_STUB, makeNativeLog, assertSandbox, banner }) {
  const log = makeNativeLog('license-stub');
  assertSandbox(HARNESS_DIR);
  const stubbed = [];      // unsigned files whose placeholders we filled (normal mode)
  const signed = [];       // files verified as owner-signed, left untouched (normal mode)
  const leftUnsigned = []; // unsigned files left intact for the gate (--skip-license-stub)
  const armed = [];        // signed files un-signed back to template (--skip-license-stub)
  for (const spec of LICENSE_SPECS) {
    const p = path.join(HARNESS_DIR, spec.file);
    assertSandbox(path.dirname(p));
    let text = readFileSync(p, 'utf8');
    const c = classifyLicense(text, spec);
    if (c.state === 'over') {
      throw new Error(`expected at most 1 occurrence of ${JSON.stringify(c.which)} in ${spec.file}, ` +
        `found ${c.count} — the template drifted; opensource-export.mjs's checkLicenseSignoff() would need the same update.`);
    }
    if (c.state === 'half') {
      throw new Error(`${spec.file} is HALF-signed: ${c.present}/${c.total} placeholders still present — ` +
        'neither the signed state nor the template. A hand edit went wrong; fix the file, do not teach this stage to accept it.');
    }
    if (c.state === 'drift') {
      // "No placeholders" alone is also what template drift looks like, and
      // checkLicenseSignoff() is blind to that state by design (its job is
      // refusing placeholders, not proving a sign-off) — so it fails HERE.
      throw new Error(`${spec.file}: no placeholders AND no signed copyright line matching ${spec.witness} — ` +
        'template drift, not a sign-off. Restore the owner\'s signed line or the template; nothing downstream can be trusted from this state.');
    }
    if (c.state === 'unsigned') {
      if (SKIP_LICENSE_STUB) {
        leftUnsigned.push(spec.file);
        log.write(`${spec.file}: placeholders present, LEFT UNTOUCHED (--skip-license-stub) — the owner gate must refuse them`);
      } else {
        for (const ph of spec.placeholders) text = text.split(ph.find).join(ph.replace);
        writeFileSync(p, text);
        stubbed.push(spec.file);
        log.write(`stubbed ${spec.file}: ${spec.placeholders.map((ph) => JSON.stringify(ph.find)).join(' + ')} -> ${STUB_MARKER}`);
      }
      continue;
    }
    // c.state === 'signed'
    if (SKIP_LICENSE_STUB) {
      // Reverse-control arming on a signed tree: put the template BACK
      // (sandbox only) so LICENSE_UNSIGNED has something to refuse. Without
      // this, the flag stopped testing anything on the day the owner signed —
      // see the header note and judgeSkippedStubExport().
      text = text.replace(spec.witness, spec.unsigned(c.indent));
      writeFileSync(p, text);
      armed.push(spec.file);
      log.write(`${spec.file}: SIGNED — un-signed back to template placeholders (sandbox only) so the owner gate can fire`);
    } else {
      signed.push(spec.file);
      log.write(`${spec.file}: already signed by the owner (witness «${c.witness.trim()}») — nothing to stub`);
    }
  }
  const touchedMsg = SKIP_LICENSE_STUB
    ? 'un-sign LICENSE back to template placeholders (sandbox-only reverse-control arming)'
    : 'stub LICENSE owner-gate placeholders (sandbox only, obviously fake)';
  if (stubbed.length + armed.length > 0) {
    execFileSync('git', ['add', '-A'], { cwd: HARNESS_DIR });
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', touchedMsg], { cwd: HARNESS_DIR });
  }
  if (SKIP_LICENSE_STUB) {
    banner([
      'OWNER-GATE REVERSE CONTROL ARMED (--skip-license-stub)',
      leftUnsigned.length ? `${leftUnsigned.length} file(s) left with their real template placeholders.` : null,
      armed.length ? `${armed.length} signed file(s) un-signed back to placeholders — SANDBOX ONLY, the real files were never opened for writing.` : null,
      'The owner gate is expected to refuse this export for real, on its own code path.',
      'This is a self-test of verify-export.mjs\'s own failure reporting — not a normal run.',
      'If the export SUCCEEDS anyway, this run FAILS: see the export stage verdict below.',
    ].filter(Boolean));
    // PASS is honest here since OSS-3: in this mode the stage's job is to
    // ARRANGE (and verify) the unsigned sandbox state, and it did that work.
    // The inverted export verdict is still asserted by judgeSkippedStubExport().
    return {
      status: 'PASS',
      detail: `gate reverse-control armed (${leftUnsigned.length} template file(s) untouched, ${armed.length} signed file(s) ` +
        `un-signed in sandbox) — the export stage below must die naming ${LICENSE_GATE_TOKEN}`,
      log: log.path,
    };
  }
  banner(stubbed.length
    ? [
      'OWNER GATE STUBBED — SANDBOX ONLY, NOT THE REAL LICENSE',
      `${stubbed.length} unsigned file(s) had their placeholders filled with the greppable marker ${STUB_MARKER}`,
      `inside the throwaway sandbox at ${HARNESS_DIR}.`,
      'The real repo\'s LICENSE and packages/protocol/LICENSE were never opened for writing by this run.',
      'THIS RUN THEREFORE PROVES NOTHING ABOUT WHETHER THE REAL LICENSE IS SIGNED.',
      'It only proves the rest of the export/gate pipeline works once that owner gate is (fakely) satisfied.',
    ]
    : [
      'OWNER GATE SATISFIED BY THE REAL SIGN-OFF — NOTHING STUBBED',
      `${signed.length}/${LICENSE_SPECS.length} LICENSE file(s) carry the owner's signed copyright line (verified, not assumed).`,
      'The export below runs in the exact license state the real export will run in.',
    ]);
  const parts = [];
  if (stubbed.length) parts.push(`${stubbed.length} file(s) stubbed with ${STUB_MARKER}; committed`);
  if (signed.length) parts.push(`${signed.length} file(s) owner-signed (witness verified) — nothing to stub`);
  return { status: 'PASS', detail: parts.join('; '), log: log.path };
}
