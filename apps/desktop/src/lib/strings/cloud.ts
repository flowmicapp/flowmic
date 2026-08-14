// S string catalogue shard: cloud relay (Cloud Key form / account card /
// fail-loud errors).
// Merged and exported by ../strings.ts — that remains the only external entry point.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en).
import { shardCatalogue } from './shard';

export const CLOUD_KEYS = [
  // cloud key form
  'cloud_key_label',
  'cloud_key_ph',
  'cloud_endpoint_label',
  'cloud_endpoint_hint',
  'cloud_key_save',
  'cloud_key_clear',
  // owner 2026-07-27 confirmation: this deletes the stored Cloud Key, so the
  // copy names that consequence instead of asking a bare 「确定吗？」("are you sure?").
  //
  // 🔴 REQ-12-01 (owner 2026-08-12 requirement ①) added the three entries
  // below, and not for looks: this one entry **only answers "what will I
  // lose"**, while neither of the two questions a user actually asks first
  // when reading "log out" on the PC gets answered — "is my history still
  // there" (this computer has been the timeline's **owner**, not a cache,
  // since 0.2.26) and "has my account been deleted." The phone side's
  // confirmation copy has carried both of those sentences for four versions
  // (`logoutConfirmBody`); the PC side didn't ⇒ the same action, two ends
  // answering different questions.
  // ⚠️ These three entries **fill in the two missing questions**; they must
  // not be read the other way around as decoration that can be deleted.
  'cloud_key_clear_q',
  'cloud_key_clear_confirm',
  'cloud_key_clear_unaffected',
  'cloud_key_clear_keeps_records',
  'cloud_key_clear_keeps_account',
  'cloud_key_clear_do',
  'cloud_key_set',
  'cloud_plan',
  'cloud_account',
  // ── L3 account card (0.2.48): live from the server ─────────────────────
  // 🔴 `cloud_expires` (「有效期至」, "valid until") has been deleted. It
  // rendered the Cloud Key's exp, but sat under 「套餐」("plan"), so it got
  // read as "your subscription expires tomorrow" — the user-visible face of
  // this repo's #1 bug shape (owner 2026-08-02 screenshot). It's replaced
  // by **two labels that each clearly state who they are**.
  // 🔴 `cloud_account_gap` (「桌面端未接入 /api/me…」, "the desktop hasn't
  // wired up /api/me…") has also been deleted: it was an honest disclosure
  // that "this card isn't live," and now that it's wired up live, keeping
  // it would be lying.
  'cloud_sub_expires',
  'cloud_key_expires',
  'cloud_key_expires_tip',
  'cloud_usage',
  // {used}/{limit} are both in minutes. Exempt accounts take the entry
  // below; the criterion is still only the server's quota_exempt, never
  // inferred from an empty limit (empty can only mean "we failed to compute it").
  //
  // 🔴 Rewritten 2026-08-07: this entry originally read 「{used} 分钟 ·
  // 不限额」("{used} minutes · unlimited"), and owner ruled that same day
  // that permanent_free is capped at the monthly MAX tier
  // (docs/decisions/2026-08-07-owner-permanent-free-becomes-max-and-test-
  // accounts-reset-to-free.md ①) ⇒ the server is right now genuinely
  // stopping people at 3,000 minutes, while this line still said
  // "unlimited." **The label says unlimited, the gate limits** — that is
  // exactly the red line behind R11 and D1; one of that ruling's stated
  // benefits was "fix one place where the name and the enforced value had
  // diverged," and keeping this sentence would just move the inconsistency
  // from the server to the UI while claiming it was fixed.
  //
  // Why this isn't simply merged into the entry above (letting exempt
  // accounts also read "128 / 3000 minutes"): that would make it read
  // identically to a user who actually paid for max, and the natural
  // reading is "I bought a 3,000-minute plan." The suffix supplies exactly
  // this sentence — this particular allotment isn't paid for.
  // ⚠️ It does overlap with the badge `cloud_src_permanent_free`
  // (「长期免费」, "permanently free"), but they answer different
  // questions: the badge answers "why is this tier free," the suffix
  // answers "is this 3,000 line something you pay for." Without it, the
  // card has nowhere that explains why this number isn't the free tier's 20.
  'cloud_usage_minutes',
  'cloud_usage_minutes_exempt',
  'cloud_src_permanent_free',
  'cloud_src_paddle',
  'cloud_src_mock',
  'cloud_sub_canceled',
  'cloud_sub_past_due',
  'cloud_sub_paused',
  // 🔴 M3-8: the server answered, and this account genuinely has no email
  // (`users.email` is nullable). That is a different thing from "couldn't
  // ask," so it gets a different sentence — never merge the two, and never
  // fall back to printing the internal id.
  'cloud_acct_no_email',
  'cloud_acct_loading',
  'cloud_acct_live',
  // 🔴 If a stale value stays on screen, it must say it's stale and state
  // when it was last fetched (unknown ≠ error ≠ stale value).
  'cloud_acct_stale',
  'cloud_acct_unknown',
  'cloud_acct_retry',
  'cloud_pair_hint',
  'cloud_pair_offline',
  // fail-loud reasons (T-2 ⑤ — never silently fall back to the local channel)
  // 🔴 F5 / owner ruling ⑤ 2026-08-04: owner's exact words were
  // 「登录已过期，请重新登录。」("your login has expired, please log in
  // again.") — the copy in all four languages is a faithful translation of
  // that sentence, not a paraphrase. Don't layer any extra explanation onto
  // it; "how to log in again" is already answered by the existing
  // 「退出云端登录」("log out of cloud login") → paste-the-form flow
  // (cloud_key_clear / cloud_key_save) next to it. This string only answers
  // two things — "what happened" + "what to do" — and owner's exact words
  // already covered both.
  'cloud_err_expired',
  'cloud_err_malformed',
  'cloud_err_refused',
  // 🔴 The other half of M4-5's "half a chain": the words the user reads on
  // **this** computer the moment they hit the wall. The billing page has
  // long had two tier-specific sentences (visible before buying), while
  // anyone who actually hits the wall has always seen the generic string
  // above — it says neither that it's a quota limit nor what to do about
  // it, only "see the diagnostic log for details."
  //
  // 🔴 This sentence deliberately **doesn't split by tier and doesn't state
  // the device count**, for two independently sufficient reasons:
  //   ① This layer has no trustworthy tier to work with. `CloudStatus.plan`
  //      comes from the Cloud Key's claims, which answer "which tier were
  //      you on when this key was issued" — the header of
  //      `lib/cloud-account.ts` states outright that the entire L3 account
  //      card exists precisely to fix this confusion (shipped once in
  //      0.2.48, then reverted). Branching on it here would just recreate
  //      the same defect on the surface next door. 15 册 §4 R11: when the
  //      fact a criterion needs isn't available, switch to a phrasing you
  //      can actually back up.
  //   ② The SSOT for device counts (2/3/10) is the server's
  //      `billing/plans.ts`. Copying it into desktop copy would be a third
  //      copy (the web billing page is already a second one), and the day
  //      the tiers change it quietly turns into a lie.
  // ⇒ Both remedies are stated outright, and the wording is true for
  // **any** tier, so no branching is needed and it can't be wrong.
  'cloud_err_pc_limit',
  'cloud_err_no_endpoint',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] 2026-08-07: was 「{used} min · unlimited」. See the long note on the zh-CN
// [en] entry — the server now enforces the MAX tier's ceiling on exempt accounts,
// [en] so 「unlimited」 became a label contradicting a live gate.

export const CLOUD_STRINGS = shardCatalogue(CLOUD_KEYS);
