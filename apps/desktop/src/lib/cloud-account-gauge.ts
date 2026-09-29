// SPEC-REF:
//   apps/desktop/src/lib/cloud-account.ts (the card this gauge is one row of; that
//     file re-exports every symbol here, so callers and tests keep one import)
//   docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md
//
// ④ The bidirectional quota gauge, moved out of cloud-account.ts VERBATIM when
// that file reached the 800-line cap (card NR-109 needed room for one more
// account phase). Nothing below was edited in the move except ONE token:
// `quotaGauge` takes `A extends GaugeAccount` instead of `LiveAccount`, because importing
// `LiveAccount` back from cloud-account.ts is a cycle (`verify:lint circular`).
// `GaugeAccount` is exactly the six fields the gauge reads, and `LiveAccount`
// satisfies it structurally; the generic keeps a caller that passes a full
// `LiveAccount` literal free of excess-property errors, so every caller is unchanged.

import { S } from './strings';
import { resetLine } from './cloud-account-reset';
/** The slice of `LiveAccount` (cloud-account.ts) the gauge reads — see the header. */
export interface GaugeAccount {
  quota_exempt: boolean;
  used_min: number | null;
  limit_min: number | null;
  used_tokens: number | null;
  limit_tokens: number | null;
  resets_at: number | null;
}

// ── ④ the bidirectional quota gauge ─────────────────────────────────────────
//
// owner 2026-08-27 (docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md):
// ONE track with a centre tick. Speech minutes grow from the LEFT edge toward the
// centre, LLM context tokens grow from the RIGHT edge toward the centre, and each
// side's 100% IS the centre — so two independent meters share one track and can
// never collide or be read as one bar. Same shape on all three surfaces (phone /
// PC / web console); this file owns the PC's half of the arithmetic.
//
// 🔴 WHICH SENTENCE the minutes side prints still comes from `quota_exempt` and
// nothing else, and it is still the same two strings as before the gauge — the
// 2026-08-07 reasoning is unchanged and worth restating because it is what keeps
// this honest:
//
//   Until then an exempt account had no limit at all, so the exempt line printed
//   "unlimited" and needed no `{limit}`. owner then capped `permanent_free` at the
//   monthly MAX tier (docs/decisions/2026-08-07-owner-permanent-free-becomes-max-
//   and-test-accounts-reset-to-free.md ①) ⇒ the server enforces 3,000 minutes on
//   that account, and "unlimited" became a LABEL CONTRADICTING A LIVE GATE — R11 /
//   D1's red line exactly.
//
// ⇒ both branches render a real `{used}/{limit}`; the exempt branch adds the one
// thing that is still uniquely true of it (nothing is billed). Every number is the
// SERVER's — 3,000 and 1M/10M/50M live in billing/plans.ts, and typing any of them
// here would make this the second answer.

/** Half the track. Each side's full bar ends at the centre tick, so "100% of this
 *  meter" is 50% of the width — the reason the two fills can never overlap. */
const HALF_TRACK_PCT = 50;

/** One end of the track. */
export interface GaugeSide {
  /** Width **as a percentage of the WHOLE track** (0–50). Already clamped. */
  pct: number;
  /** The small line under this end, already formatted in the current locale. */
  label: string;
  /** used ≥ limit — the fill has reached the centre and must switch to the warning
   *  colour. 🔴 It does NOT change the numbers: the label keeps saying what was
   *  really used, including when that is more than the limit. */
  over: boolean;
}

/** ④ what the card draws. A side is `null` when its meter could not be read —
 *  which is a missing end of the gauge, never a zero-length bar (a zero bar reads
 *  as "you have used none of it", an answer we do not have). */
export interface QuotaGauge {
  minutes: GaugeSide | null;
  context: GaugeSide | null;
  /** ④-ter "and it starts over on…" — one short sentence under the rail (owner
   *  2026-09-07). `null` when there is nothing true to say: the server sent no
   *  cycle, or the one it sent has already passed. See [resetLine]. */
  reset: string | null;
}

/** `min(used/limit, 1) × 50`, rounded to 2 decimals. Exported so the width the
 *  browser is handed is the width a test measured — the component only pastes it
 *  into a `style`. */
export function gaugePct(used: number, limit: number): number {
  // A non-positive limit cannot be divided by. "Zero allowance and something used"
  // is a full bar, not NaN%; "zero allowance and nothing used" is an empty one.
  if (!(limit > 0)) return used > 0 ? HALF_TRACK_PCT : 0;
  return Math.round(Math.min(used / limit, 1) * HALF_TRACK_PCT * 100) / 100;
}

/** Tokens → millions, at most one decimal ("0" / "0.4" / "10" / "50").
 *
 *  Why M and not the raw count: the tiers are 1M / 10M / 50M and the used figure
 *  runs to seven or eight digits, so `12345678 / 50000000` on a 12px line is a wall of
 *  digits nobody reads. The unit is spelled in the string (`cloud_usage_context`),
 *  so this returns the bare number and no locale has to agree about the letter. */
export function formatTokensM(n: number): string {
  const m = Math.round((n / 1_000_000) * 10) / 10;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}

/** ④. The whole gauge, from one live answer.
 *
 *  🔴 A `null` LIMIT DOES NOT RENDER "UNLIMITED", and this is a deliberate
 *  narrowing of the ruling's own wording. The ruling says 「`limit` 为 null（豁免/∞）
 *  ⇒ 该侧文字「不限」」 — its parenthesis names the premise: ∞ crossing the wire as
 *  `null`. **The server retired that premise on 2026-08-07** and says so verbatim
 *  in the field's own contract (apps/server-core/src/billing/billing-service.ts,
 *  `QuotaView`: 「nothing here reaches the wire as `null` any more, and a `null`
 *  that does show up means we failed to compute it」) — an exempt account gets the
 *  MAX tier's finite number like everyone else. There is therefore no exempt-∞ left
 *  to label, and the only thing a `null` can still be is a read we did not manage
 *  ⇒ printing "unlimited" for it would put a boundless claim under a live gate,
 *  which is the exact R11 defect the 2026-08-07 ruling was issued to remove.
 *  ⇒ that end of the gauge is ABSENT instead (same choice the minutes row has made
 *  since 0.2.5x). If a meter is ever genuinely unbounded again it will need a
 *  positive signal on the wire — never an empty field, which cannot tell the two
 *  apart. */
export function quotaGauge<A extends GaugeAccount>(a: A | null, nowMs: number): QuotaGauge | null {
  if (a === null) return null;
  const minutes: GaugeSide | null =
    a.used_min === null || a.limit_min === null
      ? null
      : {
          pct: gaugePct(a.used_min, a.limit_min),
          label: (a.quota_exempt ? S.cloud_usage_minutes_exempt : S.cloud_usage_minutes)
            .replace('{used}', String(Math.round(a.used_min)))
            .replace('{limit}', String(Math.round(a.limit_min))),
          over: a.used_min >= a.limit_min,
        };
  const context: GaugeSide | null =
    a.used_tokens === null || a.limit_tokens === null
      ? null
      : {
          pct: gaugePct(a.used_tokens, a.limit_tokens),
          label: S.cloud_usage_context
            .replace('{used}', formatTokensM(a.used_tokens))
            .replace('{limit}', formatTokensM(a.limit_tokens)),
          over: a.used_tokens >= a.limit_tokens,
        };
  // Neither end readable ⇒ no track at all. An empty rail under "This cycle" would
  // be a control that answers nothing. ⚠️ A reset instant on its own is NOT a
  // reason to draw one: "your allowance starts over on Thursday" under no numbers
  // at all is a sentence about a quota we could not read.
  return minutes === null && context === null
    ? null
    : { minutes, context, reset: resetLine(a.resets_at, nowMs) };
}
