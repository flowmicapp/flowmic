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
//      still saying unlimited is exactly the R11 red line (criterion in [quotaGauge]).
//
//   🔴 Unknown ≠ error ≠ stale value ≠ currently asking — four states that may not be merged ([AccountPhase]).

import { isRestrictionReason, RESTRICTION_REASONS } from '@flowmic/protocol';
import { S } from './strings';
import { getLocale } from './strings/locale';
import type { CloudStatus } from './channel';
import { formatExpiry } from './channel';
import { maskAccountEmail } from './account-mask';

/** What the Rust `cloud_account_fetch` command reports. Mirrors `CloudAccountDto`
 *  in src-tauri/src/shell/cloud.rs — see the long note there for why these are
 *  distinct values and not a bool. `no_bridge` is the ONE value Rust never produces: it is
 *  what the frontend records when the command could not be invoked at all (running
 *  outside Tauri), which is a different fact from "the server didn't answer".
 *
 *  🔴 `restricted` was split out of `unauthorized` by owner ruling 2026-08-27
 *  §R1 追加. The relay refuses a restricted account with `403 ACCOUNT_RESTRICTED`,
 *  and folding that into `unauthorized` made this card say "session expired —
 *  please sign in again": the credential is fine, signing in again succeeds, and
 *  nothing changes. Two verdicts, two outcomes. */
export type AccountOutcome =
  | 'ok'
  | 'no_key'
  | 'no_endpoint'
  | 'unauthorized'
  | 'restricted'
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
   *  we print — see [quotaGauge]. */
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
  /** QuotaView.llm.used — the ENFORCED token meter (output tokens only). ⚠️ NOT
   *  `used_in`: the server split those two on 2026-08-14 precisely because one
   *  number was answering both "how much quota is left" and "how much was
   *  processed" (billing-service.ts QuotaView). The gauge shows what is charged. */
  used_tokens: number | null;
  /** QuotaView.llm.limit. Same single meaning as [limit_min]: `null` can only mean
   *  "couldn't be read" — see [quotaGauge] for why that is NOT rendered as
   *  "unlimited". */
  limit_tokens: number | null;
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
  // owner 2026-08-27 (docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md):
  // the card now draws BOTH meters, so this is the round where `quota.llm` stops
  // being parsed away. It has been on the wire since the summary route existed —
  // the desktop simply never read it, which is why the card could only ever answer
  // half of "how much of my plan have I used".
  const llm = obj(obj(summary?.quota)?.llm);
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
    used_tokens: num(llm?.used),
    limit_tokens: num(llm?.limit),
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
 *  - `restricted` — the server said 403 ACCOUNT_RESTRICTED. LOUD and NOT
 *                   actionable: the key is valid, so there is no button that
 *                   helps. Kept apart from `expired` for exactly that reason —
 *                   the two differ in what the user should do, which is the only
 *                   thing a state is for (owner ruling 2026-08-27 §R1 追加).
 */
export type AccountPhase = 'signed_out' | 'loading' | 'live' | 'stale' | 'unknown' | 'expired' | 'restricted';

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
  /** ④ "this month's usage" — the two-ended gauge (owner 2026-08-27). It replaced a
   *  single `usageText` string that could only speak about minutes; the token meter
   *  was on the wire the whole time and had nowhere to go. */
  gauge: QuotaGauge | null;
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
  /** ms-since-epoch; defaults to `Date.now()`. Injectable so [keyExpiryLine]'s
   *  「is this date so far out that it is not a date any more」 branch can be
   *  asserted without waiting a year. */
  nowMs?: number;
}

/**
 * A Cloud Key expiry further out than this is not reported as a DATE.
 *
 * 🔴 WHY A THRESHOLD AND NOT `ttl === LONG_LIVED`. This side never sees the
 * server's TTL constant — it only ever holds one number, the `exp` in the key it
 * was handed. So the question it can honestly answer is not「which policy minted
 * this」but「is the answer to *valid until?* still a useful date」. One year is
 * where those two stop differing in practice: every credential minted under the
 * old policy is ≤7 days out, and every one minted since owner ruling 2026-08-27
 * §R1 (docs/decisions/2026-08-27-owner-persistent-login-and-routing-order.md) is
 * ~100 years out. Nothing the server can mint lands in between.
 *
 * ⚠️ Legacy keys therefore keep TODAY'S rendering, unchanged — a 7-day key
 * really does lapse on a date, and showing 「long-lived」 for it would be the
 * same lie in the other direction.
 */
export const LONG_LIVED_KEY_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The ⑥ Cloud Key row's VALUE.
 *
 * Three answers, not two: no key (`null` — the row does not exist), a date, or
 * the sentence that says the key does not lapse on a date at all. The third is
 * not decoration: since §R1 the honest answer to 「valid until?」 is 「until you
 * sign out on this PC」, and printing a date in the year 2126 would be a true
 * number that answers a question nobody asked.
 */
export function keyExpiryLine(expiresAt: number | null, nowMs: number): string | null {
  if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt > 0
      && expiresAt * 1000 - nowMs > LONG_LIVED_KEY_THRESHOLD_MS) {
    return S.cloud_key_expires_long_lived;
  }
  return formatExpiry(expiresAt);
}

export function deriveAccountCard(input: AccountCardInput): AccountCard {
  const { cloud, raw, lastLive, loading } = input;
  const keyExpiresText = keyExpiryLine(cloud.expires_at, input.nowMs ?? Date.now());
  const empty: AccountCard = {
    phase: 'signed_out',
    account: null,
    identityText: null,
    planBadge: null,
    sourceBadge: null,
    gauge: null,
    subExpiresText: null,
    subStateText: null,
    keyExpiresText: null,
    statusText: null,
    canRetry: false,
    loud: null,
  };
  if (!cloud.key_set) return empty;

  const phase: AccountPhase = ((): AccountPhase => {
    if (raw !== null && raw.outcome === 'restricted') return 'restricted';
    if (raw !== null && raw.outcome === 'unauthorized') return 'expired';
    if (loading) return 'loading';
    if (raw === null) return lastLive === null ? 'unknown' : 'stale';
    if (raw.outcome === 'ok') return 'live';
    return lastLive === null ? 'unknown' : 'stale';
  })();

  // The values on screen: the fresh answer when there is one, otherwise the last
  // one we had. `expired` and `unknown` deliberately show NOTHING.
  const live = raw !== null && raw.outcome === 'ok' ? parseLiveAccount(raw) : null;
  const account = phase === 'expired' || phase === 'restricted' || phase === 'unknown'
    ? null
    : (live ?? lastLive?.account ?? null);
  const asOf = phase === 'live' ? (raw?.fetched_at ?? null) : (lastLive?.at ?? null);

  return {
    phase,
    account,
    identityText: identityLine(account),
    planBadge: planTierBadge(account),
    sourceBadge: sourceChip(account),
    gauge: quotaGauge(account),
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
    loud: loudLine(phase, raw?.detail ?? null),
  };
}

/**
 * The red line. Two phases produce one, and they say opposite things about what
 * to do next (owner ruling 2026-08-27 §R1 追加).
 *
 * 🔴 `restricted` DELIBERATELY CARRIES NO IMPERATIVE. There is nothing on this
 * screen the user can press: the Cloud Key is valid, so "sign in again" would
 * succeed and change nothing — the dead-end button the paired-list rework and
 * `INJECT_PC_MISMATCH` both ruled against. The phone's `ACCOUNT_RESTRICTED` copy
 * made the same call for the same reason (`pairing_strings.dart`).
 *
 * The enumerated `reason` is APPENDED WHEN THE SERVER SENT ONE, never invented:
 * `RESTRICTION_REASONS` is the single registry both ends read (the phone renders
 * it too), so the two faces cannot drift into two answers about one person. A
 * reason key this build does not recognise is kept and labelled rather than
 * dropped — it is the one artefact the user could quote to us.
 *
 * ⚠️ That registry carries zh_CN/en/ja/ko only, while this surface has nine UI
 * locales. A locale it does not cover falls back to `en`, which is this
 * pipeline's declared rule for an untranslated leaf (gen-desktop-ts.mjs header),
 * not a special case invented here. The HEAD sentence is translated in all nine.
 */
function loudLine(phase: AccountPhase, detail: string | null): string | null {
  if (phase === 'expired') return S.cloud_err_expired;
  if (phase !== 'restricted') return null;
  const head = S.cloud_err_restricted;
  if (detail === null || detail === '') return head;
  const why = restrictionReasonSentence(detail);
  return why === null ? `${head}（${detail}）` : `${head}\n${why}`;
}

/** The enumerated sentence for a restriction reason key, or `null` when this
 *  build does not recognise the key. Reads the protocol registry rather than a
 *  copy — a second table here is how one person gets told two things. */
function restrictionReasonSentence(reasonKey: string): string | null {
  if (!isRestrictionReason(reasonKey)) return null;
  // 🔴 DERIVED, NOT LISTED. The registry's row keys are the locale codes with the
  // hyphen swapped for an underscore (`zh-CN` → `zh_CN`), so the current UI
  // locale addresses its own row — no list of language names lives here, and
  // adding a tenth UI language does not mean editing this file
  // (verify:lint i18n-add-locale-cost; 2026-08-14 locale architecture §2).
  // `en` is the declared base fallback for a leaf a language has not translated
  // (gen-desktop-ts.mjs header), which is what this registry's four rows are.
  const row = RESTRICTION_REASONS[reasonKey] as unknown as Record<string, string | undefined>;
  return row[getLocale().replace('-', '_')] ?? row.en ?? null;
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
 *  (`apps/server-core/src/auth/jwt.ts:38-43,139`), and the `subject` field of
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
  // owner 2026-08-27:「所有显示账号的地方都要用星号遮盖」. Masked HERE, in the one
  // place that decides what the identity line says, rather than in the component
  // that paints it — and that placement is the whole point. `AccountCard` is
  // what leaves this module; if the mask lived in the template, a second render
  // site (a tooltip, a sign-out dialog, the next page someone adds) would get
  // the raw address and nothing would say so. There is one identity string in
  // this app and it is already masked by the time anyone can render it.
  //
  // ⚠️ `a.email` ITSELF IS NOT TOUCHED. `LiveAccount` keeps the real address,
  // because 「every place that PAINTS it」 is the rule and 「every value that
  // holds it」 is not — see account-mask.ts's header for the two mobile call
  // sites that are KDF input and must never be masked. The desktop has no such
  // caller today (`account-mask.test.ts` pins that), and the honest way to keep
  // it that way is a narrow mask at the render decision, not a poisoned field.
  return a.email === null ? S.cloud_acct_no_email : maskAccountEmail(a.email);
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
// SERVER's — 3,000 and 1M/5M/15M live in billing/plans.ts, and typing any of them
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

/** Tokens → millions, at most one decimal ("0" / "0.4" / "5" / "15").
 *
 *  Why M and not the raw count: the tiers are 1M / 5M / 15M and the used figure
 *  runs to seven digits, so `12345678 / 15000000` on a 12px line is a wall of
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
export function quotaGauge(a: LiveAccount | null): QuotaGauge | null {
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
  // Neither end readable ⇒ no track at all. An empty rail under "This month" would
  // be a control that answers nothing.
  return minutes === null && context === null ? null : { minutes, context };
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
