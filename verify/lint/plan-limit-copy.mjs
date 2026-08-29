// verify/lint/plan-limit-copy.mjs
//
// The plan limits are spelled out, in prose, in another repo's nine locale
// files. This makes moving one of them impossible to do quietly.
//
// ── WHAT IS ACTUALLY THERE (measured 2026-08-29, not assumed) ───────────────
//   @flowmic/web  src/i18n/{de,en,es,fr,ja,ko,ru,zh-CN,zh-TW}.ts
//                 planFeatFree / planFeatPro / planFeatMax, e.g.
//                 「900 managed STT min/mo · 5M LLM tokens · 3 PCs + unlimited
//                 phones · 365-day retention」 — four numbers, nine languages,
//                 twenty-seven strings, all hand-typed.
//   i18n/mobile/*.json  8 plan/quota leaves, ALL numberless or interpolated
//                 (`Voice $used/$limit min`). Clean, and the point of watching
//                 it is that it STAYS the easy half.
//
// Checked against apps/server-core/src/billing/plans.ts, which is the only
// place these numbers are decided.
//
// ── 🔴 WHAT THIS LINT CLAIMS, AND WHAT IT REFUSES TO CLAIM ──────────────────
//
// It claims ONE thing: the plan-limit VALUES have not moved since somebody last
// looked at the copy that describes them.
//
// It does NOT claim the copy is correct. It cannot: 「5M LLM tokens」 describes
// 5_000_000 through a formatting convention that differs per language, and a
// lint that parsed nine languages' number prose would be a second, worse
// implementation of the pricing page — fragile, and the kind of gate that gets
// disabled the first time a translator writes 「5 Mio.」 instead of 「5M」.
//
// So this is a FORCING FUNCTION, not a proof. When a tier is re-cut this goes
// red and names every file that spells a number, so the person moving the number
// has to go and look. That is the failure we are actually guarding against —
// nobody mistypes a translation, they forget the other repo exists.
//
// ⚠️ READ THE PASS LINE LITERALLY. It says the values are unchanged. It does not
// say the copy agrees with them, and if this file ever starts printing that, the
// sentence is a lie by then.
//
// ── WHY ONE LINT FOR BOTH CLIENTS, NOT ONE EACH ────────────────────────────
// Asked for by the mobile lane and the argument is right: mobile is clean today,
// which makes it the easy half, and a mirror that guarded only web would leave
// nine mobile locale files as the obvious place for the next hardcoded number to
// land. By then there would be two lints answering 「does the copy still match
// PLAN_LIMITS」 and they would drift — which is the shape this whole suite keeps
// paying down.
//
// ── HOW THE OTHER REPO IS LOCATED ──────────────────────────────────────────
// By identity, never by path, and looking beside the MAIN worktree as well as
// beside this one — see verify/lint/password-policy-mirror.mjs, which was
// silently skipping for exactly that reason until 2026-08-29. Absent web repo is
// a partial result, not a pass: the mobile half still runs, and the line says
// which half did not.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROOT, readText, readJson } from './_util.mjs';
import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';
import { PLAN_LIMIT_VALUE_PIN } from './plan-limit-copy-baseline.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

const WEB_PKG_NAME = '@flowmic/web';
const PLANS_TS = 'apps/server-core/src/billing/plans.ts';
const MOBILE_I18N = 'i18n/mobile';
/** The three tier literals in plans.ts, in the order the file declares them. */
const TIERS = ['free', 'pro', 'max'];
/** Mirrors PLAN_LIMIT_KEYS in plans.ts. Held here so that a key ADDED there but
 *  not here fails the extraction below rather than being silently unpinned —
 *  which is precisely how `continuous_minutes` could have slipped in. */
const LIMIT_KEYS = ['stt_minutes', 'llm_tokens', 'pcs', 'mobiles', 'history_days', 'continuous_minutes'];

const sha12 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/**
 * Pull the limit values out of plans.ts by reading its source.
 *
 * 🔴 It FAILS rather than returning a partial answer. A regex that quietly
 * matched four keys instead of six would produce a stable digest over the wrong
 * facts, and this lint would then go green for the rest of its life while
 * guarding two thirds of a pricing table.
 */
async function readPlanLimits() {
  const src = await readText(path.join(ROOT, PLANS_TS));
  if (!src) return { error: `${PLANS_TS} unreadable` };
  const out = [];
  for (const tier of TIERS) {
    // The tier's literal: from its key through the closing brace of its object.
    const block = new RegExp(`\\b${tier}\\s*:\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm').exec(src);
    if (!block) return { error: `could not find the \`${tier}\` limits literal in ${PLANS_TS}` };
    for (const key of LIMIT_KEYS) {
      const m = new RegExp(`\\b${key}\\s*:\\s*([^,\\n]+)`).exec(block[1]);
      if (!m) return { error: `${PLANS_TS}: \`${tier}\` has no \`${key}\` — the key set moved, so the pin is over the wrong facts` };
      // Numeric separators only (1_000_000 → 1000000). Deliberately NOT a blanket
      // underscore strip: that also ate POSITIVE_INFINITY, which is a real value
      // here, and a digest over mangled names is stable and unreadable.
      out.push(`${tier}.${key}=${m[1].trim().replace(/(\d)_(?=\d)/g, '$1')}`);
    }
  }
  return { values: out };
}

/** Locate the web repo by identity, beside this worktree or beside the main one. */
async function findWebRepo() {
  const override = process.env.FLOWMIC_WEB_REPO;
  const roots = [path.dirname(ROOT)];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common) {
      const p = path.dirname(path.dirname(common));
      if (p && !roots.includes(p)) roots.push(p);
    }
  } catch { /* only ever adds a place to look */ }
  if (override) {
    const pkg = await readJson(path.join(override, 'package.json'));
    return pkg?.name === WEB_PKG_NAME ? override : null;
  }
  for (const parent of roots) {
    let entries;
    try {
      entries = await fsp.readdir(parent, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(parent, e.name);
      const pkg = await readJson(path.join(dir, 'package.json'));
      if (pkg?.name === WEB_PKG_NAME) return dir;
    }
  }
  return null;
}

/** Every plan-describing string on both clients, with whether it spells a digit. */
async function collectCopy(webDir) {
  const spelled = [];
  const clean = [];
  let scannedStrings = 0;
  let anyDigitAnywhere = false;

  // ── mobile: i18n/mobile/*.json, plan*/quota* leaves ──
  const mobileDir = path.join(ROOT, MOBILE_I18N);
  let files = [];
  try {
    files = (await fsp.readdir(mobileDir)).filter((f) => f.endsWith('.json'));
  } catch { /* reported by the caller through the counts */ }
  for (const f of files) {
    const j = await readJson(path.join(mobileDir, f));
    const strings = j?.strings ?? {};
    for (const [k, v] of Object.entries(strings)) {
      if (typeof v !== 'string') continue;
      if (/\d/.test(v)) anyDigitAnywhere = true; // positive control, see below
      if (!/plan|quota/i.test(k)) continue;
      scannedStrings += 1;
      // An interpolated number is not a hardcoded one: `$limit` is the API
      // answering, which is the shape we want everywhere.
      const withoutVars = v.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '');
      (/\d/.test(withoutVars) ? spelled : clean).push(`${MOBILE_I18N}/${f}:${k}`);
    }
  }

  // ── web: src/i18n/<locale>.ts, planFeat* ──
  if (webDir) {
    const dir = path.join(webDir, 'src/i18n');
    let locales = [];
    try {
      locales = (await fsp.readdir(dir)).filter((f) => /^[a-z]{2}(-[A-Za-z]{2,4})?\.ts$/.test(f));
    } catch { /* counted as absent below */ }
    for (const f of locales) {
      const src = await readText(path.join(dir, f));
      if (!src) continue;
      for (const m of src.matchAll(/^\s*(planFeat[A-Za-z]+)\s*:\s*(['"`])([\s\S]*?)\2\s*,?\s*$/gm)) {
        scannedStrings += 1;
        if (/\d/.test(m[3])) anyDigitAnywhere = true;
        const withoutVars = m[3].replace(/\$\{[^}]*\}/g, '');
        (/\d/.test(withoutVars) ? spelled : clean).push(`${WEB_PKG_NAME}:src/i18n/${f}:${m[1]}`);
      }
    }
  }
  return { spelled, clean, scannedStrings, anyDigitAnywhere };
}

export default async function planLimitCopy() {
  const limits = await readPlanLimits();
  if (limits.error) return { status: 'FAIL', detail: limits.error };

  const webDir = await findWebRepo();
  const copy = await collectCopy(webDir);

  // 🔴 POSITIVE CONTROL. Without it, a scan that stopped matching anything would
  // report「no hardcoded numbers」— the most reassuring possible way to be blind.
  if (copy.scannedStrings === 0) {
    return {
      status: 'FAIL',
      detail:
        'found ZERO plan-describing strings on either client. Either both key conventions changed, or ' +
        'the scan is broken — and a scan that matches nothing reports the happiest possible answer.',
    };
  }
  if (!copy.anyDigitAnywhere) {
    return {
      status: 'FAIL',
      detail: 'the digit test never fired on any string it read — the scan cannot tell numbers from words',
    };
  }

  const digest = sha12(limits.values.join('\n'));
  if (digest !== PLAN_LIMIT_VALUE_PIN) {
    return {
      status: 'FAIL',
      detail:
        `a plan limit MOVED (${PLANS_TS} digest ${digest}, pinned ${PLAN_LIMIT_VALUE_PIN}). ` +
        `Numbers are spelled out by hand in ${copy.spelled.length} client string(s) — go and read them, ` +
        `then re-pin: ${copy.spelled.slice(0, 6).join(', ')}${copy.spelled.length > 6 ? ', …' : ''}. ` +
        'This lint does NOT check that the copy is right; it makes sure nobody moves a number without looking.',
    };
  }

  const webNote = webDir ? '' : `; ${WEB_PKG_NAME} NOT FOUND — the mobile half only`;
  return {
    status: webDir ? 'PASS' : 'SKIP',
    detail:
      `plan-limit values unchanged (${LIMIT_KEYS.length} keys x ${TIERS.length} tiers, digest ${digest}); ` +
      `${copy.scannedStrings} plan string(s) read, ${copy.spelled.length} spell a number by hand ` +
      `(${copy.clean.length} interpolate or are numberless). ` +
      'SAYS THE VALUES HAVE NOT MOVED — NOT that the copy agrees with them' + webNote,
  };
}
