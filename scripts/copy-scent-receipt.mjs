#!/usr/bin/env node
// scripts/copy-scent-receipt.mjs
// PUBLISH-TIME half of the AI-scent copy rule: has the outward copy about to
// ship actually been through the audit, or does somebody merely remember
// running it once?
//
// WHY A RECEIPT AND NOT A GATE THAT CALLS THE MODEL. Calling the audit endpoint
// from `publish.mjs` would make every release depend on one LAN host being up.
// The day that host is down, the release is blocked by something that has
// nothing to do with the release, and the flag to skip it gets added within the
// hour -- which is how a gate dies. So the model is called at ACCEPTANCE time,
// when there is a person to talk to, and it leaves a receipt naming exactly
// which bytes it read. Publish only compares hashes: no network, no model, no
// new failure mode.
//
// WHAT THE RECEIPT PROVES, and the boundary is the point:
//   . these exact strings were shown to a model that was demonstrably awake
//     (its planted positive controls came back flagged), on that date;
//   . NOT that the findings were fixed -- a run with findings still writes a
//     receipt, because the audit's job is to see, and the decision to fix or to
//     pin is a person's;
//   . NOT that copy outside the audited surfaces is clean. `surfaces` in the
//     receipt says what was looked at, and this check refuses on anything it
//     was asked about but cannot find there.
//
// WHY THIS IS A WARNING TODAY AND A REFUSAL LATER, declared rather than
// discovered. The stock sweep (docs/strategy/2026-09-01-copy-scent-stock-audit
// -work-package.md) has not run yet: 13,349 units across nine locales have
// never been read by the auditor. A hard gate landing before that sweep would
// be red on its first day for a reason nobody could fix in one sitting, and
// this repository has written down twice what happens next -- 「一开始就红的门，
// 第二天就会被所有人无视」. So the ARMING SWITCH is the sweep's own completion:
// verify/copy-scent/baseline.json carries `$stockSweep`, and the window that
// finishes the sweep flips it to "complete". Until then this prints a WARN that
// names the work package; after that it refuses. Nothing else changes.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { collectUnits, ROOT } from './copy-scent-corpus.mjs';

const RECEIPT = path.join(ROOT, '.local', 'copy-audit', 'receipt.json');
const BASELINE = path.join(ROOT, 'verify', 'copy-scent', 'baseline.json');

/** Surfaces a release actually puts in front of a stranger. */
export const RELEASE_SURFACES = ['app', 'readme'];

/** Days after which a receipt stops meaning "recently". */
export const MAX_AGE_DAYS = 45;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Armed only once the stock sweep says it is done. See the header. */
export function isArmed(baseline = readJson(BASELINE)) {
  return baseline?.$stockSweep === 'complete';
}

/**
 * Compare the copy on disk against the receipt.
 * @returns {{armed: boolean, problems: string[], notes: string[]}}
 */
export async function inspectCopyReceipt({ surfaces = RELEASE_SURFACES, now = Date.now() } = {}) {
  const problems = [];
  const notes = [];
  const receipt = existsSync(RECEIPT) ? readJson(RECEIPT) : null;

  if (!receipt) {
    problems.push(`no copy-scent receipt at .local/copy-audit/receipt.json (the AI-scent audit is internal tooling that does not ship in this tree; this check never blocks a build here).`);
    return { armed: isArmed(), problems, notes };
  }

  const ageDays = (now - Date.parse(receipt.ranAt)) / 86_400_000;
  if (!Number.isFinite(ageDays)) problems.push(`receipt has no readable ranAt (${receipt.ranAt})`);
  else if (ageDays > MAX_AGE_DAYS) problems.push(`the receipt is ${Math.round(ageDays)} days old (limit ${MAX_AGE_DAYS}); audit again.`);
  else notes.push(`receipt from ${receipt.ranAt} (${Math.round(ageDays)}d old), model ${receipt.model} via ${receipt.endpointHost}`);

  if (receipt.blind) problems.push('the receipt records a BLIND run; it proves nothing.');
  if (receipt.lowTrust) notes.push('the recorded run was LOW TRUST (over-eager model) — its findings were advisory.');

  const { units } = await collectUnits({ surfaces });
  for (const s of surfaces) {
    const texts = units
      .filter((u) => u.surface === s)
      .map((u) => `${u.id} ${u.text}`)
      .sort();
    if (texts.length === 0) {
      notes.push(`surface ${s}: nothing on disk to check`);
      continue;
    }
    const current = sha(texts.join(''));
    const recorded = receipt.surfaces?.[s];
    if (!recorded) {
      problems.push(`surface ${s} was never audited in the recorded run (it covered: ${Object.keys(receipt.surfaces ?? {}).join(', ') || 'nothing'}).`);
      continue;
    }
    if (recorded.sha !== current) {
      problems.push(`surface ${s} has changed since it was audited (${recorded.units} units then, ${texts.length} now) — audit again.`);
      continue;
    }
    notes.push(`surface ${s}: ${texts.length} unit(s), unchanged since the audit`);
  }

  return { armed: isArmed(), problems, notes };
}

/**
 * publish.mjs shape: returns true to continue. Prints through the caller's own
 * fail/ok so the refusal reads like every other gate in that script.
 */
export async function verifyCopyAudited(fail, ok, opts = {}) {
  const { armed, problems, notes } = await inspectCopyReceipt(opts);
  for (const n of notes) ok(`copy-scent: ${n}`);
  if (problems.length === 0) {
    ok('copy-scent: the outward copy in this build has been through the AI-scent audit');
    return true;
  }
  if (!armed) {
    // Not a silent pass: it names the reason and the work package, every time.
    console.log(
      `⚠ copy-scent NOT ENFORCED YET — the stock sweep has not run.\n` +
        problems.map((p) => `    · ${p}`).join('\n') +
        `\n    This becomes a refusal when docs/strategy/2026-09-01-copy-scent-stock-audit-work-package.md\n` +
        `    finishes and flips \`$stockSweep\` to "complete" in verify/copy-scent/baseline.json.`,
    );
    return true;
  }
  for (const p of problems) fail(`copy-scent: ${p}`);
  return false;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const fail = (m) => console.error(`✗ ${m}`);
  const ok = (m) => console.log(`✓ ${m}`);
  verifyCopyAudited(fail, ok)
    .then((good) => process.exit(good ? 0 : 1))
    .catch((err) => {
      console.error(`✗ copy-scent receipt check: ${err.message}`);
      process.exit(1);
    });
}
