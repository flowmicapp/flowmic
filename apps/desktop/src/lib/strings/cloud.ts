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
  // 🔴 The VALUE of that row when the key does not lapse on a date. Owner ruling
  // 2026-08-27 §R1 (docs/decisions/2026-08-27-owner-persistent-login-and-
  // routing-order.md) made the account JWT's default TTL 100 years, so "valid
  // until <a date in 2126>" would be a true number answering a question nobody
  // asked. The criterion lives in lib/cloud-account.ts `keyExpiryLine` and it is
  // 「is this still a useful date」, not 「which policy minted it」 — this side
  // only ever holds the `exp`, never the server's TTL constant.
  // ⚠️ 7-day keys still in the wild keep the DATE. They really do lapse.
  'cloud_key_expires_long_lived',
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
  // ── the RIGHT end of the quota gauge (owner 2026-08-27) ────────────────
  // docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md: 「从左到右
  // ＝语音分钟数，从右到左＝token（上下文）」. The token meter has been on the
  // wire since `/api/cloud/summary` existed and the desktop simply never
  // parsed it, so the card could only ever answer half of 「how much of my
  // plan have I used」.
  //
  // 🔴 It says 「context」 and not 「tokens」 on purpose. A token is our unit,
  // not the user's; what they can act on is 「how much of the text I send is
  // being read as background」. The number is in MILLIONS with at most one
  // decimal (`formatTokensM`) because the tiers are 1M/5M/15M and a raw
  // seven-digit count on a 12px line is unreadable.
  //
  // ⚠️ The M is part of the TRANSLATED string, not appended in code: a
  // language that abbreviates the unit differently has to be able to say so,
  // and a suffix concatenated in TS would be one more place a locale cannot
  // reach (the shape 0.2.53 shipped a bare identifier through).
  // ⚠️ There is deliberately NO `_exempt` twin of this entry. The exempt
  // sentence 「· not billed」 is already carried once, by the minutes label at
  // the other end of the same track; saying it twice on one gauge would be a
  // second answer to a question already answered.
  'cloud_usage_context',
  // ── when the allowance starts over (owner 2026-09-07) ─────────────────────
  //
  // 🔴 THE GAUGE ANSWERS HALF A QUESTION WITHOUT THESE. 「17 / 20 min」 says
  // somebody is nearly out and nothing about whether that matters for another
  // hour or another month — and since the cycle became account-anchored
  // (2026-09-05) they cannot derive it either: two people reading this card on
  // the same day reset on different dates.
  //
  // ⚠️ `{at}` ARRIVES ALREADY FORMATTED (`formatExpiry`, `YYYY-MM-DD HH:mm`,
  // local). The date SHAPE is one product-wide convention, not nine — the same
  // call the two number labels above make about their own digits. What each
  // language chooses is the sentence around it, including where the date goes.
  'cloud_usage_reset',
  // 🔴 THREE ENTRIES FOR THE RELATIVE HALF, AND NO TRANSLATION IS ASKED FOR A
  // PLURAL. `1` never reaches the counted one — it has its own — so no language
  // needs a second form of 「day」, and Russian's few/many split is sidestepped
  // with the invariant 「дн.」 this catalogue already uses for 「мин」 / 「ч」.
  // 「in 1 days」 is the exact failure these two exist to prevent, and it would
  // land on the day a user is most likely to be reading the card.
  'cloud_usage_reset_today',
  'cloud_usage_reset_tomorrow',
  'cloud_usage_reset_in_days',
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
  // 🔴 A RESTRICTION IS NOT AN EXPIRY, and until owner ruling 2026-08-27 §R1 追加
  // this surface had no word for one at all: the relay's `403 ACCOUNT_RESTRICTED`
  // came out as `unauthorized` and rendered as [cloud_err_expired] — "please sign
  // in again" for a user whose credential is perfectly valid. They sign in, it
  // works, nothing changes.
  // ⚠️ DELIBERATELY NO IMPERATIVE. There is nothing on this screen to press
  // (same call the phone's ACCOUNT_RESTRICTED copy made, pairing_strings.dart);
  // the enumerated reason is appended by lib/cloud-account.ts from the protocol's
  // RESTRICTION_REASONS registry, never authored here.
  'cloud_err_restricted',
  'cloud_err_malformed',
  'cloud_err_refused',
  // 2026-08-29 multi-node — the relay that answered is a read-only replica and
  // cannot register a PC. Without its own sentence this lands on
  // [cloud_err_refused] above, which is TRUE and useless: "refused, see the
  // diagnostic log" for a condition the app already knows exactly, including
  // which server could have done it.
  // 🔴 IT PROMISES ONLY WHAT THERE IS A MECHANISM FOR. The register watchdog
  // re-emits on the SAME socket, so nothing switches servers on its own; a new
  // dial does re-run node selection and an unregistered PC then prefers the
  // writer (src-tauri socket/node_select.rs). So the copy says "reconnect" and
  // does not say "FlowMic will move you" — that would be a promise with no code
  // behind it, which is the shape the status red line exists to forbid.
  'cloud_err_wrong_node',
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
  // ── card NR-2b: guided browser sign-in ────────────────────────────────
  // owner 2026-08-27 (docs/decisions/2026-08-27-owner-no-password-login-on-
  // clients.md): the PC keeps the Cloud Key paste and gains a button that
  // takes the user to the console to GET one. Explicitly NOT an in-app email
  // form.
  //
  // 🔴 CORRECTED THE SAME DAY, AND THE CORRECTION IS THE INTERESTING PART.
  // This block used to end 「and explicitly NOT a loopback callback that would
  // paste the key by itself — the ruling asks for a smooth route, not a new
  // mechanism」. The owner overturned that at UAT, looking at the thing:
  // 「浏览器里 Gmail 都登录成功了，为什么还要我去复制 Key」. The sentence was
  // true when it was written and became false a few hours later, which is this
  // repo's most-cited failure shape — so it is corrected here rather than left
  // to be read as a live prohibition by the next person.
  //
  // ⇒ The button now COMPLETES the sign-in: the PC binds a loopback listener,
  // the console redirects to it with a one-time grant, and the key is stored
  // without anybody copying anything. The paste below it stays, as the fallback
  // for a machine where that cannot work.
  'cloud_signin_browser',
  // 🔴 The hint says the WHOLE journey in one sentence, because the button on
  // its own answers 「where do I go」 and leaves 「and then what」 hanging. It was
  // rewritten with the mechanism: it used to end 「copy the Cloud Key from the
  // console home and paste it below」, and after the correction above that
  // instruction is no longer the route — it is the fallback.
  'cloud_signin_browser_hint',
  // ⚠️ Its own sentence, not a reuse of `cloud_err_malformed`: 「the OS opened
  // nothing」 and 「what you pasted is not a key」 are different problems with
  // different next actions, and this one has to leave the user a route (the
  // address in words) rather than just naming a fault.
  'cloud_signin_browser_failed',
  // Waiting, and a way out of waiting. A three-minute window with no visible
  // state and no cancel is indistinguishable from a frozen button.
  'cloud_signin_waiting',
  'cloud_signin_cancel',
  // The page the BROWSER lands on. It lives in this catalogue — and is handed
  // to Rust as an argument — so this flow adds no second locale pipeline and
  // no English literal inside the listener.
  'cloud_signin_page_ok_title',
  'cloud_signin_page_ok_body',
  'cloud_signin_page_fail_title',
  'cloud_signin_page_fail_body',
  // 🔴 SIX FAILURE SENTENCES, ONE PER `SignInFailure` VARIANT, because the
  // person's next move differs in every one of them: wait / start again /
  // check the address / use the paste below. `cloud-signin.ts` maps them
  // through an EXHAUSTIVE record, so a seventh variant added in Rust without a
  // sentence here fails `vue-tsc` instead of reaching a screen as a bare word
  // — which is precisely what 0.2.53 shipped.
  'cloud_signin_err_timeout',
  'cloud_signin_err_state',
  'cloud_signin_err_refused',
  'cloud_signin_err_unreachable',
  'cloud_signin_err_listen',
  'cloud_signin_err_endpoint',
  // WP2 Card 1 — read-only relay-node latency beside the account card.
  // Latency / check family (no "probe"): the headline is a hot round trip.
  'node_lat_title',
  'node_lat_note',
  'node_lat_check',
  'node_lat_checking',
  'node_lat_connect',
  'node_lat_latency',
  'node_lat_via_cloud',
  'node_lat_via_direct',
  'node_lat_here',
  'node_lat_unanswered',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] 2026-08-07: was 「{used} min · unlimited」. See the long note on the zh-CN
// [en] entry — the server now enforces the MAX tier's ceiling on exempt accounts,
// [en] so 「unlimited」 became a label contradicting a live gate.

export const CLOUD_STRINGS = shardCatalogue(CLOUD_KEYS);
