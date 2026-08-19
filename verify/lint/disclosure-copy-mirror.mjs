// verify/lint/disclosure-copy-mirror.mjs
// The 「where do my words go」 disclosure exists TWICE — once on the phone, once
// on the desktop — and this pins the pair.
//
// SPEC-REF: docs/legal/privacy-policy.md is the source both screens summarise.
//           apps/mobile/lib/src/settings/strings/disclosure_strings.dart (header)
//           apps/desktop/src/lib/strings/disclosure.ts (header)
//
// ── WHAT THE PROBLEM ACTUALLY IS ───────────────────────────────────────────
// Both catalogues describe ONE mechanism: which engine hears you, whether the
// LAN leg is encrypted, when a language model sees your words. A user reads
// whichever screen they are standing in front of, and most phone users never
// open the desktop's page. So the failure is not 「the two files disagree」 —
// it is 「the phone is told less than the truth, or something else」, and the
// reader has no way to know a fuller sentence exists one device over.
//
// Both files' headers used to claim the two catalogues were word-for-word, and
// they called that byte-parity 「itself a guard」. It was — a cheap PROXY for
// 「two catalogues cannot describe one mechanism two ways」. Then the two screens
// were shortened by different amounts and the proxy quietly stopped existing.
// Nothing replaced it. The 2026-08-19 audit MEASURED the result: four English
// pairs had drifted apart with every gate green, and two of the four were real
// content the phone was simply missing (「While it is off, Realtime sends
// nothing; provisional words are never sent」 and 「The relay is TLS」). Those two
// were added to the phone in the same batch as this lint; the rest are declared
// below.
//
// ── WHY THIS IS NOT A BYTE-PARITY LINT ─────────────────────────────────────
// Restoring byte-parity would be WRONG, and the fastest way to make the copy
// worse. Two of the surviving differences are correct:
//   · point of view — the phone says 「this phone / your PC」, the desktop says
//     「your phone / this PC」. Copying either direction puts the reader on the
//     wrong device.
//   · what each screen can point AT — the AI-polish switch lives on the desktop,
//     so the desktop can say 「that row shows its current value」 and the phone
//     must instead say where the switch is. A phone sentence claiming a row
//     shows a value would be a sentence about a screen the reader is not on.
// So the lint pins the DECLARED SET of differences instead: every pair is either
// byte-identical, or listed below with a reason and a fingerprint of BOTH sides.
// Edit either side of a declared pair and this goes red — not because the edit
// is wrong, but because the twin now needs a decision.
//
// ── 🔴 WHAT THIS LINT DOES *NOT* PROVE — READ THIS BEFORE TRUSTING A GREEN ─
//   · IT COMPARES ENGLISH ONLY. English is the project's first language (owner
//     2026-08-15) and every claim below originates there. The other eight
//     locales were translated per app, independently, so they byte-differ for
//     reasons that say nothing about truth — measured 2026-08-19 on this box:
//     de differs in 19 of the 22 pairs, es in 15, ru in 14, fr in 13 — against 5 in English. Pinning
//     those would pin translation style, and a lint that fires on style gets
//     ignored, which is worse than no lint. ⇒ A claim added to one side in
//     English is caught HERE; a claim that exists in English on both sides but
//     was dropped by ONE translator is NOT caught by anything. Said out loud
//     because that hole is real.
//   · IT COMPARES STRINGS, NOT FACTS. Both sides can be edited together into
//     the same lie. The facts are held by the per-claim code coordinates in the
//     two file headers and by data-flow-disclosure.test.ts on each end.
//   · IT DOES NOT KNOW WHAT THE PRIVACY POLICY SAYS. Both catalogues summarise
//     docs/legal/privacy-policy.md; a summary drifting from its source is a
//     third failure this cannot see.
//
// ── REVERSE CONTROL — IT HAS BEEN SEEN RED ─────────────────────────────────
// Run on 2026-08-19 on the maintainer dev machine (which one is recorded in the
// private window log — this file is exported publicly), four shapes, each
// restored afterwards
// (`git diff` on i18n/mobile/en.json returned only the intended two lines):
//   A. an UNDECLARED pair edited on one side ⇒ 「differ and nothing says why」
//   B. a DECLARED pair edited on one side    ⇒ names the side and both fingerprints
//   C. a NEW disclosure key on one screen    ⇒ 「never been told about」
//   D. a declared pair made IDENTICAL        ⇒ 「delete the entry from DIVERGENCES」
// D matters as much as B: a stale declaration is how the previous guard rotted —
// it went on describing a parity that had stopped existing.
//
// ── WHERE THE STRINGS COME FROM ────────────────────────────────────────────
// Both catalogues are data now (i18n/mobile/*.json, i18n/desktop/*.json), so
// this reads the SAME files the generators read. It does not parse Dart or TS:
// the generated `*.g.dart` / `catalogue.g.ts` are gitignored build output, and a
// lint that reads build output answers 「what did the last generator run see」
// rather than 「what is committed」.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/disclosure-copy-mirror.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOBILE_EN = 'i18n/mobile/en.json';
const DESKTOP_EN = 'i18n/desktop/en.json';

// mobile key → desktop key. Every pair here is a sentence about the SAME
// mechanism, so the two must be identical unless declared in DIVERGENCES.
const PAIRS = {
  discEntry: 'disc_entry',
  discEntrySub: 'disc_entry_sub',
  discLead: 'disc_lead',
  discStep1Title: 'disc_s1_title',
  discStep1Body: 'disc_s1_body',
  discStep2Title: 'disc_s2_title',
  discStep2Body: 'disc_s2_body',
  discStep2Cloud: 'disc_s2_cloud',
  discStep2Byok: 'disc_s2_byok',
  discStep2Local: 'disc_s2_local',
  discStep3Title: 'disc_s3_title',
  discStep3Body: 'disc_s3_body',
  discStep4Title: 'disc_s4_title',
  discStep4Body: 'disc_s4_body',
  discStep4LanPlain: 'disc_s4_lan_plain',
  discStep5Title: 'disc_s5_title',
  discStep5Body: 'disc_s5_body',
  discLegalTitle: 'disc_legal_title',
  discLegalPrivacy: 'disc_legal_privacy',
  discLegalTerms: 'disc_legal_terms',
  discDetailsOnSite: 'disc_more_on_site',
  discScopeNote: 'disc_scope_note',
};

// Declared differences: the reason, plus a fingerprint of each side AS IT IS
// TODAY. The fingerprints are a tripwire, not a copy of the copy — a third
// verbatim copy of a user-facing paragraph is exactly the drift this file
// exists to stop. When one fires, open both files and read them.
const DIVERGENCES = {
  discLead: {
    mobile: '32df736ddb5c',
    desktop: '9fd2dda7a7bf',
    why: 'point of view — 「this phone / your PC」 vs 「your phone / this PC」. Correct on each device; swapping either would address the reader on the wrong one.',
  },
  discStep1Title: {
    mobile: '2bdccff24bec',
    desktop: 'b874b1a6d5e3',
    why: 'point of view — 「1. This phone records audio」 vs 「1. Your phone records audio」. Same as discLead.',
  },
  discStep3Body: {
    mobile: 'd737f61f6fcb',
    desktop: '8faeec1a377f',
    why: 'the AI-polish switch lives on the desktop. The desktop points AT the row (「that row shows its current value」); the phone says where the switch is (「on your computer (this phone does not have it)」). The two SUBSTANTIVE sentences the phone was missing — 「While it is off, Realtime sends nothing; provisional words are never sent」 — were added 2026-08-19 and are now on both sides.',
  },
  discStep4LanPlain: {
    mobile: 'f28e87f91808',
    desktop: '9b4965b952ff',
    why: 'the encryption reading lives on the phone. The phone says 「This connection’s state is under …」; the desktop must add 「on the phone」 because its own screen has no such indicator. 「The relay is TLS」 is on both sides since 2026-08-19.',
  },
  discDetailsOnSite: {
    mobile: '07045993e8d1',
    desktop: '703545ab8834',
    why: 'the phone sends the reader to the privacy policy it links directly below; the desktop sends them to the website, which is where its own legal texts live. Different destinations, each true of its own screen.',
  },
};

// Keys that exist on ONE side only, with why. Anything not here and not in
// PAIRS is an unregistered key — the lint fails rather than ignoring it,
// because a new disclosure sentence on one screen is precisely the event this
// is watching for.
const ONE_SIDE_ONLY = {
  mobile: {
    discOpenInBrowser: 'button label — the phone opens legal links in an external browser',
    discOpenFailed: 'failure copy for that button',
    discCopyLink: 'fallback when no browser handles the link',
    discLinkCopied: 'confirmation for that fallback',
  },
  desktop: {
    disc_nav: 'sidebar entry — the desktop reaches the page through its own nav, the phone through a settings row (discEntry)',
    disc_title: 'page heading — the phone reuses discEntry as its title (disclosure_strings.dart: `discTitle => discEntry`)',
  },
};

const fp = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

async function readStrings(rel) {
  const raw = await fs.readFile(path.join(ROOT, rel), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.strings !== 'object') {
    throw new Error(`${rel} has no 'strings' object`);
  }
  return parsed.strings;
}

export default async function run() {
  let mobile;
  let desktop;
  try {
    [mobile, desktop] = await Promise.all([readStrings(MOBILE_EN), readStrings(DESKTOP_EN)]);
  } catch (err) {
    return { status: 'FAIL', detail: `cannot read the English catalogues: ${err.message}` };
  }

  const problems = [];

  // ── every disclosure key on either side must be registered ───────────────
  const mobileKeys = Object.keys(mobile).filter((k) => /^disc[A-Z]/.test(k));
  const desktopKeys = Object.keys(desktop).filter((k) => k.startsWith('disc_'));
  for (const k of mobileKeys) {
    if (!(k in PAIRS) && !(k in ONE_SIDE_ONLY.mobile)) {
      problems.push(
        `mobile '${k}' is a disclosure string this lint has never been told about. ` +
          'Pair it with its desktop twin in PAIRS, or say in ONE_SIDE_ONLY why the other screen does not need it.',
      );
    }
  }
  const pairedDesktop = new Set(Object.values(PAIRS));
  for (const k of desktopKeys) {
    if (!pairedDesktop.has(k) && !(k in ONE_SIDE_ONLY.desktop)) {
      problems.push(
        `desktop '${k}' is a disclosure string this lint has never been told about. ` +
          'Pair it with its mobile twin in PAIRS, or say in ONE_SIDE_ONLY why the other screen does not need it.',
      );
    }
  }

  // ── the pairs themselves ─────────────────────────────────────────────────
  let identical = 0;
  for (const [mk, dk] of Object.entries(PAIRS)) {
    const mv = mobile[mk];
    const dv = desktop[dk];
    if (typeof mv !== 'string') {
      problems.push(`mobile '${mk}' is gone — the pair with desktop '${dk}' can no longer be compared`);
      continue;
    }
    if (typeof dv !== 'string') {
      problems.push(`desktop '${dk}' is gone — the pair with mobile '${mk}' can no longer be compared`);
      continue;
    }
    const declared = DIVERGENCES[mk];
    if (mv === dv) {
      identical++;
      if (declared) {
        problems.push(
          `'${mk}' / '${dk}' are now identical, but they are still declared as a divergence. ` +
            'Delete the entry from DIVERGENCES — a declaration nobody re-reads is how the last guard rotted.',
        );
      }
      continue;
    }
    if (!declared) {
      problems.push(
        `'${mk}' and desktop '${dk}' differ and nothing says why. ` +
          'Either make them say the same thing, or add an entry to DIVERGENCES stating which screen each wording is true of.',
      );
      continue;
    }
    const nowM = fp(mv);
    const nowD = fp(dv);
    if (nowM !== declared.mobile || nowD !== declared.desktop) {
      const side =
        nowM !== declared.mobile && nowD !== declared.desktop
          ? 'both sides'
          : nowM !== declared.mobile
            ? 'the mobile side'
            : 'the desktop side';
      problems.push(
        `'${mk}' / '${dk}' is a declared divergence and ${side} changed ` +
          `(mobile ${declared.mobile}→${nowM}, desktop ${declared.desktop}→${nowD}). ` +
          'Read BOTH and decide whether the twin needs the same edit, then update the fingerprints. ' +
          `Declared reason: ${declared.why}`,
      );
    }
  }

  if (problems.length) {
    return { status: 'FAIL', detail: problems.join(' | ') };
  }
  const pairCount = Object.keys(PAIRS).length;
  return {
    status: 'PASS',
    detail: `${identical}/${pairCount} disclosure pairs identical in en, ${Object.keys(DIVERGENCES).length} declared (other locales not compared — see header)`,
  };
}
