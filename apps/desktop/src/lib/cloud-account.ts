// SPEC-REF:
//   docs/strategy/2026-08-02-l3-account-card-design.md (this module IS that design's §2 + §3, 本模块就是那份稿的 §2 + §3)
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §6.1 / §6.1-bis
//     (PlanView's three fields plan / source / quota_exempt —— the sole source of truth, 唯一真相点)
//   apps/server-core/src/billing/billing-service.ts (the definitions of PlanView / QuotaView, PlanView / QuotaView 的定义)
//   CLAUDE.md red line: one value answers only one question; no silent failure (unknown ≠ error ≠ stale value)
//
// The pure, Tauri-free, DOM-free decision core for the CLOUD ACCOUNT CARD.
//
// The reason it exists, in one sentence: the two lines on the card (tier /
// valid-until) used to come from **the Cloud Key's own claims** — a snapshot
// from the moment it was issued. So "tier" answered "which tier were you on
// when you issued this key", and "valid-until" answered "when does this key
// expire" — yet it sat under "tier" and got read as the subscription's expiry
// date. This module parses out the server's answer as of right now, and
// parses it **only once**:
//
//   🔴 The desktop never computes its own copy of the tier. The three fields
//      `plan` / `source` / `quota_exempt` are taken verbatim from the
//      server's PlanView (D1 §6.1's sole source of truth); this file
//      performs no "deriving the tier" action of its own. In particular a
//      permanent_free account's `plan` stays `'free'` — owner bought
//      nothing, and writing pro/max would be a lie; the exemption may only
//      ever be spoken by `quota_exempt`.
//
//   🔴 2026-08-07 correction (owner ruling ①, permanent_free changed to be
//      capped at the monthly MAX tier): this section used to also have a
//      line saying "'unlimited' must never be inferred from `limit_min ===
//      null`, because an exempt account's limit is Infinity and
//      `JSON.stringify` turns it into null." **That premise no longer
//      holds** — an exempt account now gets a finite number like 3,000, and
//      `limit_min` is no longer ever empty because of exemption. ⇒ The
//      conclusion is actually stronger now: `null` can **only** mean "we
//      couldn't compute it", so both branches skip rendering this line when
//      there's no limit to get. Meanwhile the sentence "unlimited" has
//      itself been deleted — the server really is capping it, and the UI
//      still saying unlimited is exactly the R11 red line (criterion in [usageLine]).
//
//   🔴 Unknown ≠ error ≠ stale value ≠ currently asking — four states that may not be merged ([AccountPhase]).

import { S } from './strings';
import type { CloudStatus } from './channel';
import { formatExpiry } from './channel';

/** What the Rust `cloud_account_fetch` command reports. Mirrors `CloudAccountDto`
 *  in src-tauri/src/shell/cloud.rs — see the long note there for why these are six
 *  values and not a bool. `no_bridge` is the ONE value Rust never produces: it is
 *  what the frontend records when the command could not be invoked at all (running
 *  outside Tauri), which is a different fact from "the server didn't answer". */
export type AccountOutcome =
  | 'ok'
  | 'no_key'
  | 'no_endpoint'
  | 'unauthorized'
  | 'unreachable'
  | 'bad_response'
  | 'no_bridge';

export interface CloudAccountRaw {
  outcome: AccountOutcome;
  /** unix seconds; only ever non-null on `ok` (a failed read has no as-of time). */
  fetched_at: number | null;
  detail: string | null;
  /** `GET /api/me` body, unparsed. */
  me: unknown;
  /** `GET /api/cloud/summary` body, unparsed. */
  summary: unknown;
}

/** PlanView.source (server SSOT). Four values, four different sentences. */
export type PlanSource = 'permanent_free' | 'paddle' | 'mock' | 'none';
/** PlanView.state. `past_due` / `paused` are Paddle-only and deliberately not
 *  collapsed into `canceled` on the server side; we keep them apart here too. */
export type SubState = 'none' | 'pending' | 'active' | 'canceled' | 'expired' | 'past_due' | 'paused';

/** One live answer from the server. Every field is "what the server is saying right now" —— nothing in
 *  here is ever derived from the Cloud Key's claims. */
export interface LiveAccount {
  /** From `/api/me`. `null` when the account genuinely has none — `users.email` is
   *  NULLable (the users DDL in apps/server-core/src/db/schema.ts, `user.repo.ts:12`), so an
   *  empty email is a real live answer, not a read failure. The two are told apart
   *  by [identityLine], never merged.
   *
   *  🔴 There is deliberately NO `account_id` next to it any more. `/api/me` does
   *  return `user.id`, and this file used to parse it as "the fallback identity" —
   *  which is how a bare `3f9c1a2e-…-b7d4` ended up under the label "account" (M3-8).
   *  Not parsing it at all is what makes the regression structural rather than a
   *  rule someone has to remember. */
  email: string | null;
  /** PlanView.plan, verbatim and lowercase ('free' | 'pro' | 'max'). */
  plan: string | null;
  /** PlanView.source — "what justifies being this tier". */
  source: PlanSource;
  /** PlanView.quota_exempt — "what justifies these numbers being these numbers". ⚠️ 2026-08-07: it no
   *  longer means "unlimited" (the server caps an exempt account at the MAX tier);
   *  it means "the quota doesn't come from the `plan` table". It still selects which usage sentence
   *  we print — see [usageLine]. */
  quota_exempt: boolean;
  /** PlanView.state. */
  sub_state: SubState;
  /** PlanView.expires_at (ISO string) — when the "subscription" expires, NOT the key's life. */
  sub_expires_at: string | null;
  /** QuotaView.stt.used_min. */
  used_min: number | null;
  /** QuotaView.stt.limit_min. ⚠️ 2026-08-07: this used to mean EITHER exempt
   *  (Infinity, which crosses the wire as null) OR not readable. The exemption is
   *  a finite number now, so `null` has exactly ONE meaning left — "couldn't be read" —
   *  and [usageLine] drops the row rather than inventing a figure. It still must
   *  not decide "whether it's exempt": that is `quota_exempt`'s job, and merging them is
   *  how one value ends up answering two questions. */
  limit_min: number | null;
}

// ── narrowing helpers ────────────────────────────────────────────────────────
//
// 🔴 RV-新A's lesson: a hand-written type predicate (`(x): x is T =>`) is an
// assertion the compiler does not check, and this repo has been burned by it
// twice (an array that stays empty on every machine). So there is not a
// single `is T` here — it is all explicit reads of "take a field, and if you
// can't, use null"; the consequence of failing to get one is a missing line
// on screen, not a fake value.

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function planSource(v: unknown): PlanSource {
  return v === 'permanent_free' || v === 'paddle' || v === 'mock' ? v : 'none';
}

function subState(v: unknown): SubState {
  switch (v) {
    case 'pending':
    case 'active':
    case 'canceled':
    case 'expired':
    case 'past_due':
    case 'paused':
      return v;
    default:
      return 'none';
  }
}

/** Normalize an unknown IPC payload into a CloudAccountRaw. An unreadable payload
 *  becomes `bad_response` — never a half-populated `ok`. */
export function asCloudAccountRaw(raw: unknown): CloudAccountRaw {
  const o = obj(raw);
  if (o === null) return { outcome: 'bad_response', fetched_at: null, detail: null, me: null, summary: null };
  const outcome = o.outcome;
  const known: AccountOutcome[] = ['ok', 'no_key', 'no_endpoint', 'unauthorized', 'unreachable', 'bad_response'];
  const named = known.find((k) => k === outcome) ?? 'bad_response';
  return {
    outcome: named,
    fetched_at: num(o.fetched_at),
    detail: str(o.detail),
    me: o.me ?? null,
    summary: o.summary ?? null,
  };
}

/** Parse the two bodies into ONE live answer, or `null` when the payload does not
 *  carry a plan at all (which is a `bad_response`, not an empty card of zeroes). */
export function parseLiveAccount(raw: CloudAccountRaw): LiveAccount | null {
  if (raw.outcome !== 'ok') return null;
  const summary = obj(raw.summary);
  const plan = obj(summary?.plan);
  if (plan === null) return null;
  const user = obj(obj(raw.me)?.user);
  const quota = obj(obj(summary?.quota)?.stt);
  return {
    email: str(user?.email),
    plan: str(plan.plan),
    source: planSource(plan.source),
    // 🔴 strict `=== true`: a missing field must read as "no exemption", never as truthy.
    quota_exempt: plan.quota_exempt === true,
    sub_state: subState(plan.state),
    sub_expires_at: str(plan.expires_at),
    used_min: num(quota?.used_min),
    limit_min: num(quota?.limit_min),
  };
}

// ── the card ─────────────────────────────────────────────────────────────────

/** 🔴 Unknown ≠ error ≠ stale value ≠ currently asking (未知 ≠ 错误 ≠ 旧值 ≠ 正在问). Four states, four different things to do:
 *
 *  - `signed_out` — no Cloud Key on this PC. Nothing to ask.
 *  - `loading`    — a read is in flight. Any previous answer stays on screen
 *                   (blanking on every refresh would flash "couldn't reach it" each time).
 *  - `live`       — this is what the server said just now.
 *  - `stale`      — we asked before and got an answer, we asked again and could
 *                   not. The old values stay, **and the card says how old**.
 *  - `unknown`    — we have never had an answer. NOTHING is rendered: not a zero,
 *                   not a dash, and above all not the Cloud Key's own claims.
 *  - `expired`    — the server said 401. LOUD and actionable (sign in again),
 *                   which is why it is not folded into `unknown`.
 */
export type AccountPhase = 'signed_out' | 'loading' | 'live' | 'stale' | 'unknown' | 'expired';

export interface AccountCard {
  phase: AccountPhase;
  /** The values to render. `null` for every phase that has no answer to show. */
  account: LiveAccount | null;
  /** ②"who am I". 🔴 `null` means THE ROW DOES NOT EXIST — same language as
   *  [subExpiresText]. See [identityLine]. */
  identityText: string | null;
  /** ③ tier badge, e.g. 'FREE' — `null` when there is no live answer. */
  planBadge: string | null;
  /** ③ "what justifies being this tier" chip — `null` when `source === 'none'` (nothing to say). */
  sourceBadge: string | null;
  /** ④ "this month's usage" value, already formatted. */
  usageText: string | null;
  /** ⑤ subscription validity period. 🔴 `null` means THE ROW DOES NOT EXIST — free tiers have no
   *  subscription expiry, and rendering "—" would be answering a question that
   *  does not apply. */
  subExpiresText: string | null;
  /** ⑤-bis a non-active subscription states its state (canceled / past_due / paused). */
  subStateText: string | null;
  /** ⑥ Cloud Key expiry — from the KEY, always available while signed in, and
   *  labelled as the key's own life so it can never stand in for ⑤ again. */
  keyExpiresText: string | null;
  /** ⑦ the as-of line. */
  statusText: string | null;
  /** ⑦ whether to offer "re-query". */
  canRetry: boolean;
  /** A LOUD (red) line — only `expired` produces one. */
  loud: string | null;
}

export interface AccountCardInput {
  /** `CloudStatus.key_set` — is there a Cloud Key on this PC at all. */
  cloud: CloudStatus;
  /** The last response, or `null` if we have not asked yet. */
  raw: CloudAccountRaw | null;
  /** The last SUCCESSFUL answer + the unix seconds at which it was obtained.
   *  Session-only (see the design doc §2.4): persisting it would put a stale tier
   *  on screen at cold start looking exactly like a live one. */
  lastLive: { account: LiveAccount; at: number } | null;
  /** A read is in flight. */
  loading: boolean;
}

export function deriveAccountCard(input: AccountCardInput): AccountCard {
  const { cloud, raw, lastLive, loading } = input;
  const keyExpiresText = formatExpiry(cloud.expires_at);
  const empty: AccountCard = {
    phase: 'signed_out',
    account: null,
    identityText: null,
    planBadge: null,
    sourceBadge: null,
    usageText: null,
    subExpiresText: null,
    subStateText: null,
    keyExpiresText: null,
    statusText: null,
    canRetry: false,
    loud: null,
  };
  if (!cloud.key_set) return empty;

  const phase: AccountPhase = ((): AccountPhase => {
    if (raw !== null && raw.outcome === 'unauthorized') return 'expired';
    if (loading) return 'loading';
    if (raw === null) return lastLive === null ? 'unknown' : 'stale';
    if (raw.outcome === 'ok') return 'live';
    return lastLive === null ? 'unknown' : 'stale';
  })();

  // The values on screen: the fresh answer when there is one, otherwise the last
  // one we had. `expired` and `unknown` deliberately show NOTHING.
  const live = raw !== null && raw.outcome === 'ok' ? parseLiveAccount(raw) : null;
  const account = phase === 'expired' || phase === 'unknown' ? null : (live ?? lastLive?.account ?? null);
  const asOf = phase === 'live' ? (raw?.fetched_at ?? null) : (lastLive?.at ?? null);

  return {
    phase,
    account,
    identityText: identityLine(account),
    planBadge: planTierBadge(account),
    sourceBadge: sourceChip(account),
    usageText: usageLine(account),
    subExpiresText: subscriptionExpiry(account),
    subStateText: subscriptionState(account),
    keyExpiresText,
    statusText: statusLine(phase, asOf),
    // A live answer still offers "re-query": upgrading a plan happens in the web
    // console, and the user coming back to this card wants to SEE it move without
    // restarting the desktop (that is A2's real-device step for this lane).
    // Nothing to retry while we are already asking. `expired` gets no retry either:
    // re-asking with the same dead key produces the same 401 — the action is to
    // sign in again, and offering a button that cannot work is the "button that
    // must fail" (必然失败的按钮)
    // the paired-list rework already ruled against.
    canRetry: phase === 'live' || phase === 'stale' || phase === 'unknown',
    loud: phase === 'expired' ? S.cloud_err_expired : null,
  };
}

/** ②"who am I" —— the ONE producer of the account (账号) row's value (M3-8).
 *
 *  Three different facts, three different answers, never one string for two of them:
 *
 *   - the server answered and named an email  → that email. "⑦ account info updated at HH:mm"
 *     (or "⑦ temporarily unreachable, below is what was learned at HH:mm" in `stale`) says when it was said, so
 *     the row can always answer "what justifies saying so" —— book 15 §4 R11.
 *   - the server answered and the account has NO email → `S.cloud_acct_no_email`.
 *     `users.email` is NULLable (the users DDL in server-core db/schema.ts) ⇒ this is a live answer, and it
 *     must not read as "couldn't reach it".
 *   - we have no answer (`unknown` / `expired` / a first-ever `loading`) → **`null`,
 *     i.e. the row does not exist.**
 *
 *  🔴 Why `null` and not "the account id we do have locally" (what 0.2.48 shipped):
 *  the row is labelled "account" and the question a human reads off it is "who am I".
 *  A `3f9c1a2e-…-b7d4` is not an answer to that question — it is the answer to
 *  "which internal primary key is this key bound to", and printing it under that label is the same shape
 *  owner 2026-08-02 rejected on the "grouped by source phone" grouping (a UUID
 *  running naked ⇒ rework, 裸奔 UUID ⇒ 返工;
 *  `docs/strategy/2026-08-02-ui-batch1-rework-design.md` §1.3 "a UUID never appears on screen", UUID 永不上屏).
 *  Its old defence ("the id is an immutable property of this key, it won't
 *  change just because we can't reach the server",
 *  L3 design doc §7-2) answers a DIFFERENT objection — staleness — and staleness was
 *  never what was wrong with it.
 *
 *  🔴 Why not "fall back to the email in the JWT" (the handoff report's leaning):
 *  **there is no email in the JWT.** `JwtClaims` is exactly `{ sub, plan, iat, exp }`
 *  (`apps/server-core/src/auth/jwt.ts:34-39,107`), and the `subject` field of
 *  `shell/cloud.rs:125-128` says so verbatim: "the email only exists".
 *
 *  🔴 Why no replacement sentence in this row: every phase that returns `null` here
 *  ALREADY carries its own sentence elsewhere on the card —— `unknown` ⇒ ⑦
 *  "temporarily unable to reach account info" + "re-query", `expired` ⇒ the red [loud] block,
 *  `loading` ⇒ ⑦ "querying account info…", signed-out ⇒ the card is not rendered at all
 *  (`SettingsPage.vue:301` / `DevicesPage.vue:610` both gate on `key_set`).
 *  A second sentence here would be a second answer to a question already answered. */
function identityLine(a: LiveAccount | null): string | null {
  if (a === null) return null;
  return a.email ?? S.cloud_acct_no_email;
}

/** 'free' → 'FREE'. 🔴 Uppercasing the SERVER's word — never a tier this file
 *  decided. A permanent_free account stays FREE here on purpose (D1 §6.1-bis). */
function planTierBadge(a: LiveAccount | null): string | null {
  if (a === null || a.plan === null) return null;
  return a.plan.toUpperCase();
}

function sourceChip(a: LiveAccount | null): string | null {
  if (a === null) return null;
  switch (a.source) {
    case 'permanent_free':
      return S.cloud_src_permanent_free;
    case 'paddle':
      return S.cloud_src_paddle;
    case 'mock':
      return S.cloud_src_mock;
    default:
      return null;
  }
}

/** ④. 🔴 WHICH SENTENCE we print still comes from `quota_exempt` and nothing
 *  else. What changed on 2026-08-07 is WHAT that sentence says.
 *
 *  Until then an exempt account had no limit at all, so the exempt line printed
 *  "unlimited" and needed no `{limit}`. owner then capped `permanent_free` at the
 *  monthly MAX tier (docs/decisions/2026-08-07-owner-permanent-free-becomes-max-
 *  and-test-accounts-reset-to-free.md ①) ⇒ the server enforces 3,000 minutes on
 *  that account, and "unlimited" became a LABEL CONTRADICTING A LIVE GATE — R11 /
 *  D1's red line exactly, and the very split that ruling claims to have fixed.
 *
 *  ⇒ both branches now render a real `{used}/{limit}`; the exempt branch adds the
 *  one thing that is still uniquely true of it (nothing is billed). The `limit`
 *  is the SERVER's number, never a constant typed here — 3,000 lives in
 *  billing/plans.ts and copying it would make this the second answer. */
function usageLine(a: LiveAccount | null): string | null {
  if (a === null || a.used_min === null) return null;
  // Moved ABOVE the exempt branch, deliberately: an exempt account now needs a
  // limit like everyone else, so a missing one means "we couldn't compute it" for BOTH
  // kinds of account, and printing a half-line would be inventing an answer.
  if (a.limit_min === null) return null;
  const used = String(Math.round(a.used_min));
  const limit = String(Math.round(a.limit_min));
  const template = a.quota_exempt ? S.cloud_usage_minutes_exempt : S.cloud_usage_minutes;
  return template.replace('{used}', used).replace('{limit}', limit);
}

/** ⑤. 🔴 The row EXISTS only for an account that actually bought a subscription.
 *  `source === 'none'` (plain free) and `source === 'permanent_free'` (owner) both
 *  get `null` — "free tiers simply don't show subscription expiry" (免费档干脆不显示订阅到期), owner 2026-08-02. */
function subscriptionExpiry(a: LiveAccount | null): string | null {
  if (a === null) return null;
  if (a.source !== 'paddle' && a.source !== 'mock') return null;
  return formatIsoLocal(a.sub_expires_at);
}

function subscriptionState(a: LiveAccount | null): string | null {
  if (a === null) return null;
  if (a.source !== 'paddle' && a.source !== 'mock') return null;
  switch (a.sub_state) {
    case 'canceled':
      return S.cloud_sub_canceled;
    case 'past_due':
      return S.cloud_sub_past_due;
    case 'paused':
      return S.cloud_sub_paused;
    default:
      return null;
  }
}

function statusLine(phase: AccountPhase, asOf: number | null): string | null {
  const at = asOf === null ? null : formatClock(asOf);
  switch (phase) {
    case 'loading':
      return S.cloud_acct_loading;
    case 'live':
      return at === null ? null : S.cloud_acct_live.replace('{t}', at);
    case 'stale':
      // 🔴 The whole point: a value that is on screen but old must SAY it is old,
      // and say WHEN. Falling back to the bare "couldn't reach it" would hide that the numbers
      // above it are from an earlier read.
      return at === null ? S.cloud_acct_unknown : S.cloud_acct_stale.replace('{t}', at);
    case 'unknown':
      return S.cloud_acct_unknown;
    default:
      return null;
  }
}

/** `HH:mm` local — hand-built, same reason as formatExpiry (UI does not follow OS locale, UI 不跟随 OS locale). */
function formatClock(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm` local from an ISO-8601 string (PlanView.expires_at is a
 *  string, the Cloud Key's exp is unix seconds — two sources, two parsers, one
 *  output format). */
function formatIsoLocal(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return formatExpiry(Math.floor(ms / 1000));
}
