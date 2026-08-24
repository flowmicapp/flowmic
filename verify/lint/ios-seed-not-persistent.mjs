// verify/lint/ios-seed-not-persistent.mjs
// The iOS device seed must not outlive the app's own container.
//
// ── THE RULING ───────────────────────────────────────────────────────────────
// owner 2026-08-24, on the 0.3.28 identity surface: 「改成卸载即清」 ("change it
// so uninstalling clears it"). 0.3.28 minted a UUID into the Keychain
// specifically BECAUSE Keychain items survive app deletion; that property is
// now ruled out of the product, so the mechanism goes with it. The seed lives
// in UserDefaults, which the OS destroys with the container.
//
// ── WHY A LINT AND NOT A TEST ────────────────────────────────────────────────
// There is no Swift test target in this repo, and the Flutter suite cannot
// reach a platform channel — `MethodChannelDeviceInfo` is faked in every test
// that touches identity, which is correct and also means the Swift half is
// invisible to all 2,800 of them. The only mechanisms that can see this file at
// all are the compiler (which is happy either way), package-id-family (which
// asks whether it is COMPILED, not what it does), and this.
//
// ⚠️ So state the limit plainly: this reads source text. It proves the write
// path is not in the file and the reaper is called from `register`. It does NOT
// prove anything about a running handset, and nothing here should be quoted as
// if it did. The honest end-to-end judge is a device: delete the app, reinstall,
// and see a different name.
//
// ── WHY IT ASSERTS A PRESENCE AS WELL AS AN ABSENCE ──────────────────────────
// 🔴 STOPPING IS NOT CLEARING. Deleting the Keychain code would leave every
// device that already minted an item holding it forever — that is what "survives
// deletion" means, and it is why the item has to be taken back out by hand
// (`reapLegacyKeychainSeed`). A scanner that only asked "is SecItemAdd gone?"
// would report a clean sheet on the day the reaper was deleted too, i.e. on the
// day the ruling silently stopped being carried out for exactly the devices it
// was about. Absence is not cleanliness — the same lesson
// verify/lint/android-install-permission.mjs carries in its own header.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// Three drills, run 2026-08-24 on dev-pc-a, each edit reverted by hand with an
// empty `git diff` afterwards:
//
// A — the write path comes back. `SecItemAdd(add as CFDictionary, nil)` was
//     pasted into `stableSeed`:
//       FAIL apps/mobile/ios/Runner/DeviceInfo.swift:… writes to the Keychain
//       (SecItemAdd) …
// B — the reaper is defined but nobody calls it. The `reapLegacyKeychainSeed()`
//     line was removed from `register`:
//       FAIL reapLegacyKeychainSeed() is defined but never called …
// C — the reaper is deleted outright:
//       FAIL apps/mobile/ios/Runner/DeviceInfo.swift never calls SecItemDelete …
//
// B is the drill that matters: it is the state an "is the forbidden call gone?"
// scanner calls clean, and it is a façade of exactly the kind this repo names.

import path from 'node:path';

import { ROOT, readText, rel } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'ios-seed-not-persistent';

const SWIFT = path.join(ROOT, 'apps', 'mobile', 'ios', 'Runner', 'DeviceInfo.swift');

/** Calls that WRITE a Keychain item, i.e. the thing the ruling removes. */
const FORBIDDEN = ['SecItemAdd', 'SecItemUpdate', 'kSecAttrAccessible'];

/** The one Keychain call that must stay, and the call site that must reach it. */
const REAPER = 'reapLegacyKeychainSeed';
const REAP_CALL = 'SecItemDelete';

/** The replacement store. Its absence means the seed moved somewhere unread. */
const SEED_STORE = 'UserDefaults.standard';

/**
 * Blank out Swift comments line by line, preserving line numbers.
 *
 * ⚠️ Deliberately crude, and imprecise in ONE direction only: a `//` inside a
 * string literal truncates the rest of that line, so the scanner sees LESS than
 * the file says. That can hide a hit, never invent one — which is why the
 * presence assertions below exist. A scanner that has gone blind must fail, not
 * pass, and those are what make it fail.
 *
 * This file's comments DISCUSS the Keychain at length — they are the record of
 * why the mechanism was chosen and then removed, and they name every forbidden
 * symbol. A scanner that could not tell an explanation from a call would be one
 * that gets silenced by deleting the explanation.
 */
function stripSwiftComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      inBlock = false;
      out.push(cut(line.slice(end + 2)));
      continue;
    }
    out.push(cut(line));
  }
  function cut(text) {
    const slash = text.indexOf('//');
    const block = text.indexOf('/*');
    if (slash === -1 && block === -1) return text;
    if (block !== -1 && (slash === -1 || block < slash)) {
      const end = text.indexOf('*/', block + 2);
      if (end === -1) {
        inBlock = true;
        return text.slice(0, block);
      }
      return text.slice(0, block) + cut(text.slice(end + 2));
    }
    return text.slice(0, slash);
  }
  return out.join('\n');
}

/** 1-based line numbers of every line of `text` containing `needle`. */
function linesOf(text, needle) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes(needle)) hits.push(i + 1);
  });
  return hits;
}

export default async function run() {
  const src = await readText(SWIFT);
  if (src == null) {
    return {
      status: 'FAIL',
      detail:
        `cannot read ${rel(SWIFT)} — the scan is blind, which is not the same as clean. ` +
        `That file is the iOS half of the device-identity channel and is checked in; ` +
        `if it genuinely went away, package-id-family fails too and iPhones are back to ` +
        `an anonymous name on every re-pair`,
    };
  }

  const code = stripSwiftComments(src);
  const failures = [];

  for (const symbol of FORBIDDEN) {
    for (const line of linesOf(code, symbol)) {
      failures.push(
        `${rel(SWIFT)}:${line} writes to the Keychain (${symbol}) — owner 2026-08-24 ` +
          `ruled the device seed must not outlive a deletion, and a Keychain item is ` +
          `chosen precisely because it does. The seed belongs in ${SEED_STORE}, which ` +
          `the OS destroys with the app container`
      );
    }
  }

  // The reaper: defined, and actually reached. Two separate facts.
  const reapCalls = linesOf(code, REAP_CALL);
  if (reapCalls.length === 0) {
    failures.push(
      `${rel(SWIFT)} never calls ${REAP_CALL} — removing the write path only stops NEW ` +
        `items; every device that already minted one keeps it, because surviving deletion ` +
        `is the whole property that made the Keychain the wrong home. Stopping is not ` +
        `clearing`
    );
  }
  const reaperMentions = linesOf(code, REAPER);
  // One line defines it (`private static func reapLegacyKeychainSeed()`), at
  // least one more must invoke it. A definition with no caller is the shape
  // this repo's anti-façade rule ④ is named after, and it would leave the
  // ruling carried out in the source and nowhere else.
  if (reaperMentions.length === 1) {
    failures.push(
      `${REAPER}() is defined but never called (${rel(SWIFT)}:${reaperMentions[0]} is its ` +
        `only occurrence in code) — a reaper nobody runs clears nothing, and the absence ` +
        `of SecItemAdd would still make this scanner read clean`
    );
  } else if (reaperMentions.length === 0) {
    failures.push(`${REAPER}() is gone from ${rel(SWIFT)} — see the ${REAP_CALL} failure above`);
  }

  // Positive control. If the seed is not in UserDefaults it is somewhere this
  // scanner has no opinion about, and every assertion above becomes vacuous.
  if (!code.includes(SEED_STORE)) {
    failures.push(
      `${rel(SWIFT)} does not mention ${SEED_STORE} — the seed has moved to a store this ` +
        `check knows nothing about, so its silence about the Keychain proves nothing`
    );
  }

  if (failures.length > 0) return { status: 'FAIL', detail: failures.join(' | ') };

  // Prose count: the witness that the comment stripper actually ran. This file
  // explains the Keychain history at length; if that number ever reads 0 the
  // stripper has blanked the file and the PASS above means nothing.
  let prose = 0;
  for (const symbol of [...FORBIDDEN, 'Keychain']) {
    prose += linesOf(src, symbol).length - linesOf(code, symbol).length;
  }
  if (prose === 0) {
    return {
      status: 'FAIL',
      detail:
        `${rel(SWIFT)} has 0 comment mentions of the Keychain — either the stripper ` +
        `blanked the file (so every assertion just passed vacuously) or the record of ` +
        `why this mechanism was removed has been deleted. Both are failures`,
    };
  }

  return {
    status: 'PASS',
    detail:
      `${rel(SWIFT)}: no Keychain write path in code, ${REAPER}() reaped via ` +
      `${REAP_CALL} at line ${reapCalls.join(',')} and called from ${reaperMentions.length - 1} ` +
      `site(s), seed stored in ${SEED_STORE}; ${prose} prose mention(s) in comments (allowed)`,
  };
}
