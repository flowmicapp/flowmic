// verify/lint/design-token-literals.mjs
// Lint 10/10 — no colour literals outside the two design-token SSOTs.
//
// Invariant (already stated in both token file headers):
//   desktop tokens.css  — "components never carry their own dark rules, they
//                          read these vars"
//   mobile tokens.dart  — "widgets must not invent colours"
//
// Scan surfaces:
//   desktop: apps/desktop/src/**/*.{vue,ts}  (#hex / rgb() / rgba() / hsl() /
//            hsla()). SSOT tokens.css is outside this globs (css), still
//            path-excluded for defence in depth.
//   mobile:  apps/mobile/lib/**/*.dart  (Color(0x…) / Colors.<name>).
//            SSOT tokens.dart excluded. FlowMicColors.x is NOT a hit
//            (negative lookbehind so the Material Colors. prefix is required).
//
// Tests are EXCLUDED and the count is printed every run (never silently
// truncated): **/test/**, **/tests/**, *.test.ts / *.test.vue, *_test.dart.
// Asserting palette values in tests legitimately needs literals.
//
// G7 first-pass found 56 non-test hits; 10 of them were `Colors.transparent`
// (not a colour choice — see MOBILE_RE below), leaving **46 real debts**. That
// is far past the 15 the card set as the rewrite threshold, so this lint does
// NOT rewrite production code. It pins the current multiset as BASELINE / ALLOWLIST and
// FAILs only on *new* hits (file|literal multiplicity). Cleared hits are fine
// — the gate only prevents getting worse. Detail always prints the pinned
// count (no silent allow).

import path from 'node:path';
import { ROOT, walk, readText, rel, DEFAULT_SKIP_DIRS } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/design-token-literals.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'design-token-literals';

const DESKTOP_ROOT = path.join(ROOT, 'apps', 'desktop', 'src');
const MOBILE_ROOT = path.join(ROOT, 'apps', 'mobile', 'lib');
const DESKTOP_SSOT = 'apps/desktop/src/styles/tokens.css';
const MOBILE_SSOT = 'apps/mobile/lib/src/ui/tokens.dart';

// Full colour literals (desktop CSS/TS/Vue).
const DESKTOP_RE =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|(?:rgba?|hsla?)\(\s*[^)]*\)/g;
// Material Colors.x / Color(0x…) — not FlowMicColors.x.
//
// `Colors.transparent` is deliberately NOT a hit: it names the ABSENCE of a
// colour (Material ink wells, sheet backgrounds, hit-test-only surfaces), so no
// palette decision is being made and there is nothing that could drift from the
// tokens file. Counting it padded the pinned baseline by 10 of 56 entries and
// made the number read as「56 places invent colours」when 10 of them invent
// nothing. A baseline is only useful if every entry is a real debt.
const MOBILE_RE =
  /Color\s*\(\s*0x[0-9a-fA-F]+\s*\)|(?<![A-Za-z0-9_])Colors\.(?!transparent\b)\w+/g;

// Baseline pinned 2026-07-30 (G7 scan). Key = `${rel}|${literal}` (no line —
// line drift must not false-FAIL). Duplicates encode multiplicity in one file.
// Why each family stays: gradients / alpha overlays / Material white|black /
// QR-code white plate / pre-mount error-boundary CSS strings — none map 1:1 onto
// an existing named token without inventing new tokens.
//
// NOT an endorsement: `error-boundary.ts` hard-codes LIGHT-theme colours because
// it paints before Vue and tokens.css load, which means the crash screen is
// wrong in dark mode. Registered as a zero-work item, not fixed here — this lint
// exists to stop the list GROWING, and pinning a debt is not the same as
// blessing it.
const ALLOWLIST = [
  // desktop — error-boundary injects inline CSS before Vue/tokens load
  'apps/desktop/src/lib/error-boundary.ts|#fdeaea',
  'apps/desktop/src/lib/error-boundary.ts|#8a1f1f',
  'apps/desktop/src/lib/error-boundary.ts|#f3c2c2',
  // desktop — modal scrim alpha + QR white plate (no matching token)
  'apps/desktop/src/main-window/components/PairingModal.vue|rgba(11, 16, 32, .42)',
  'apps/desktop/src/main-window/components/PairingModal.vue|#fff',
  // mobile — Material transparent / white / black + alpha overlays + gradients
  'apps/mobile/lib/src/ui/add_pairing_sheet.dart|Color(0x4DF87171)',
  'apps/mobile/lib/src/ui/add_pairing_sheet.dart|Color(0xFFFCA5A5)',
  'apps/mobile/lib/src/ui/add_pairing_sheet.dart|Color(0xFFFCA5A5)',
  'apps/mobile/lib/src/ui/add_pairing_sheet.dart|Color(0xFF5B54E8)',
  'apps/mobile/lib/src/ui/add_pairing_sheet.dart|Color(0xFF7C74F2)',
  'apps/mobile/lib/src/ui/add_pairing_sheet.dart|Colors.white',
  // ai_action_row.dart's Color(0x66818CF8) entry was pruned 2026-08-14 (WP8):
  // the pill restyle replaced the on/busy border with FlowMicDockColors tokens,
  // so the literal no longer exists. Pruned rather than banked — a stale slot
  // is budget somebody can silently re-spend.
  'apps/mobile/lib/src/ui/banner_slot.dart|Color(0x59F87171)',
  'apps/mobile/lib/src/ui/banner_slot.dart|Color(0xB3F87171)',
  'apps/mobile/lib/src/ui/banner_slot.dart|Color(0xFFFFF1F2)',
  'apps/mobile/lib/src/ui/banner_slot.dart|Color(0x4DFBBF24)',
  'apps/mobile/lib/src/ui/banner_slot.dart|Color(0x4D818CF8)',
  // Was `chat_message_tile.dart` until the 800-line-cap split (FB-7): the
  // literal travelled VERBATIM with LiveDraftTile into its own part file. Same
  // colour, same one use, new home — the allowlist is keyed by file, so a pure
  // move has to be re-keyed here or the move reads as a new hard-coded colour.
  'apps/mobile/lib/src/ui/live_draft_tile.dart|Color(0x73818CF8)',
  'apps/mobile/lib/src/ui/compose_band.dart|Color(0xFFFFFFFF)',
  'apps/mobile/lib/src/ui/compose_band.dart|Color(0xB3FFFFFF)',
  'apps/mobile/lib/src/ui/connections_page.dart|Colors.white',
  'apps/mobile/lib/src/ui/connections_page.dart|Colors.white',
  'apps/mobile/lib/src/ui/image_preview_page.dart|Color(0xE60B1020)',
  'apps/mobile/lib/src/ui/image_transfer_bar.dart|Color(0x4D818CF8)',
  'apps/mobile/lib/src/ui/image_transfer_bar.dart|Color(0x33818CF8)',
  'apps/mobile/lib/src/ui/login_sheet.dart|Colors.white',
  'apps/mobile/lib/src/ui/login_sheet.dart|Color(0x4DF87171)',
  'apps/mobile/lib/src/ui/login_sheet.dart|Color(0xFFFCA5A5)',
  'apps/mobile/lib/src/ui/login_sheet.dart|Color(0xFFFCA5A5)',
  'apps/mobile/lib/src/ui/login_sheet.dart|Color(0xFF5B54E8)',
  'apps/mobile/lib/src/ui/login_sheet.dart|Color(0xFF7C74F2)',
  'apps/mobile/lib/src/ui/login_sheet.dart|Colors.white',
  'apps/mobile/lib/src/ui/plus_panel.dart|Color(0x66818CF8)',
  'apps/mobile/lib/src/ui/plus_panel.dart|Color(0x66818CF8)',
  // ptt_bar.dart's four entries (Colors.black in _glow, 3× white face/pulse
  // inks) were pruned 2026-08-14 (WP8): the Plan A′ solid faces deleted the
  // glow and routed every ink through tokens (onPri / onBrandInk). Same
  // pruned-not-banked reasoning as ai_action_row above.
  'apps/mobile/lib/src/ui/scan_sheet.dart|Color(0x4DF87171)',
  'apps/mobile/lib/src/ui/scan_sheet.dart|Color(0xFFFCA5A5)',
  'apps/mobile/lib/src/ui/scan_sheet.dart|Color(0xFFFCA5A5)',
  'apps/mobile/lib/src/ui/settings_page.dart|Color(0xFF4A4F63)',
  'apps/mobile/lib/src/ui/settings_widgets.dart|Color(0xFF2A2F42)',
  'apps/mobile/lib/src/ui/settings_widgets.dart|Colors.white',
  'apps/mobile/lib/src/ui/settings_widgets.dart|Colors.white',
  'apps/mobile/lib/src/ui/status_badge.dart|Color(0x4DFBBF24)',
];

function skipDir(basename) {
  return DEFAULT_SKIP_DIRS.has(basename);
}

function isTestFile(relPath) {
  return (
    /(^|\/)(test|tests|__tests__)\//.test(relPath) ||
    /\.test\.(ts|vue|js|mjs)$/.test(relPath) ||
    /_test\.dart$/.test(relPath)
  );
}

/** @returns {{ key: string, file: string, line: number, lit: string }[]} */
function collectHits(text, relPath, re) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i]))) {
      out.push({
        key: `${relPath}|${m[0]}`,
        file: relPath,
        line: i + 1,
        lit: m[0],
      });
    }
  }
  return out;
}

function multiset(keys) {
  const m = new Map();
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

/** Hits whose (file|literal) multiplicity exceeds the baseline. */
function findNew(hits, baselineKeys) {
  const base = multiset(baselineKeys);
  const used = new Map();
  const neu = [];
  for (const h of hits) {
    const n = (used.get(h.key) || 0) + 1;
    used.set(h.key, n);
    const allowed = base.get(h.key) || 0;
    if (n > allowed) neu.push(h);
  }
  return neu;
}

export default async function run() {
  /** @type {{ key: string, file: string, line: number, lit: string }[]} */
  const hits = [];
  let testExcluded = 0;

  for (const abs of await walk(DESKTOP_ROOT, { skipDir })) {
    const r = rel(abs);
    if (r === DESKTOP_SSOT) continue;
    if (!/\.(vue|ts)$/.test(r)) continue;
    const text = await readText(abs);
    if (text == null) continue;
    const fileHits = collectHits(text, r, DESKTOP_RE);
    if (isTestFile(r)) {
      testExcluded += fileHits.length;
      continue;
    }
    hits.push(...fileHits);
  }

  for (const abs of await walk(MOBILE_ROOT, { skipDir })) {
    const r = rel(abs);
    if (r === MOBILE_SSOT) continue;
    if (!r.endsWith('.dart')) continue;
    const text = await readText(abs);
    if (text == null) continue;
    const fileHits = collectHits(text, r, MOBILE_RE);
    if (isTestFile(r)) {
      testExcluded += fileHits.length;
      continue;
    }
    hits.push(...fileHits);
  }

  const baseline = ALLOWLIST.length;
  const neu = findNew(hits, ALLOWLIST);
  // Always print pinned / excluded counts — silent allowlists are forbidden.
  const excludeNote = `test-excluded ${testExcluded}`;

  if (neu.length > 0) {
    const sample = neu
      .slice(0, 8)
      .map((h) => `${h.file}:${h.line} ${h.lit}`)
      .join('; ');
    return {
      status: 'FAIL',
      detail:
        `${neu.length} new (baseline ${baseline} pinned, current ${hits.length}, ` +
        `${excludeNote}; see ALLOWLIST): ${sample}`,
    };
  }

  return {
    status: 'PASS',
    detail:
      `0 new (baseline ${baseline} pinned, current ${hits.length}, ` +
      `${excludeNote}; see ALLOWLIST)`,
  };
}
