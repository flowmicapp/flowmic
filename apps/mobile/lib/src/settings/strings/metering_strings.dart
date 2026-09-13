// AppStrings copy-catalogue shard: card G-2c (2026-09-11) / card WB-5a
// (2026-09-12) — the sentences that answer 「WHOSE transcription allowance is
// this spending」.
//
// 🔴 THE CHAT-PAGE BANNER THIS SHARD OPENED WITH IS GONE (owner
// 2026-09-12, the 09-12 batch ruling, item 5). `bannerFarEndPaysQuota` and
// `BannerIds.farEndPaysQuota` were deleted with their trigger and their nine
// translations, and the fact they stated moved to the guide below — reachable
// from the connections list, true on every screen, and able to name the
// third-party case the frame-keyed banner structurally could not. The `payer`
// parsing and `applyBudget`'s refusal are untouched.
//
// Its own shard rather than more lines in `recording_strings.dart` for the
// file-size cap's sake (that file is at 764/800 and both members below carry
// the reasoning this repo requires), and because the two really are one family:
// each exists because a sentence the phone already had names THE WRONG ACCOUNT
// when somebody else is paying.
//
// ── 🔴 THE RULE BOTH OF THESE SERVE (owner 2026-09-11, 22 册 §2/§5/§7) ───────
//
// 「只要有对端，就扣对端」 — whenever a far end exists, the far end pays, signed in
// or not. So on a paired handset the minutes moving are NOT the speaker's, and
// every sentence on this phone that says 「your quota」 while paired is false.
// The relay says which case it is (`BudgetViewSchema.payer`, card MP-10); until
// this card nothing on the phone read that word.
part of '../app_strings.dart';

mixin MeteringStrings on AppStringsLeaves {
  /// Card WB-5a — the connections-list guide 「who pays for transcription」, and
  /// the eight sentences under it. It REPLACES the standing chat-page banner
  /// this shard opened with (`bannerFarEndPaysQuota`, `BannerIds.farEndPaysQuota`),
  /// which owner removed on 2026-09-12
  /// (`docs/decisions/2026-09-12-owner-web-client-batch-image-upload-qr-only-and-hints.md`
  /// item 5). Read as a swap of PLACE and SCOPE, not as a deletion of the fact.
  ///
  /// 🔴 WHY A GUIDE AND NOT A BANNER, in the terms this repo already uses.
  /// The banner was a STATE-type entry keyed on one frame (`payer:'far_end'`),
  /// so it answered 「who is paying for THIS recording」 while a recording was
  /// on screen — and it could only answer it for the one case the frame named.
  /// The question a user actually has is 「how does this work at all」, which
  /// has no live trigger, is the same on every screen, and is the same on the
  /// web client. A standing bar over the transcript answered a smaller question
  /// more often than anybody needed it answered.
  ///
  /// 🔴 IT IS ALSO THE ONE PLACE THE THIRD-PARTY CASE CAN BE HONEST. The
  /// banner's own doc recorded the gap: `payer:'far_end'` also reaches a
  /// speaker paired into somebody else's page, and 「the computer you are
  /// connected to」 is not what that reader is looking at — the frame carries no
  /// room kind the phone can read, so a live sentence had to pick one case and
  /// be wrong in the other. A guide is not keyed on a frame at all: it can
  /// state every case, because it is not claiming which one is happening now.
  ///
  /// ⚠️ THE COMPANION REFUSAL IS UNCHANGED AND STILL SHIPS:
  /// `CloudSummaryController.applyBudget` still refuses to fold a `'far_end'`
  /// or `'trial'` remainder into this account's meter. What changed is where
  /// the reader is told why — a page they can open, instead of a bar that only
  /// appears while somebody else's minutes are moving.
  ///
  /// ⚠️ NO FIGURE EXCEPT THE ONE THE RULE ITSELF CONTAINS. The demo grant's
  /// 120 seconds is in [quotaRulesLine3] because the rule IS that number
  /// (22 册 §0.2); no line prints a far end's remainder, which is a stranger's
  /// commercial fact — the same restraint `sttStallIntegratorQuotaExceeded`
  /// states at length.
  ///
  /// ⚠️ THE WEB CLIENT SHOWS THE SAME EIGHT SENTENCES after connecting
  /// (owner, same ruling). They are in `i18n/web/subset.json` for that reason;
  /// one wording for one rule, on both screens, as `sttStallIntegratorQuotaExceeded`
  /// already is.
  String get quotaRulesTitle => _lfQuotaRulesTitle;

  /// Card WB-5a — the one-line answer under [quotaRulesTitle] on the
  /// connections list. A reader who never taps still learns the shape of the
  /// rule, the same reason `discEntrySub` carries the disclosure's summary.
  String get quotaRulesSub => _lfQuotaRulesSub;

  /// Card WB-5a — 「you are talking to a computer」: the account signed in on
  /// THAT computer pays (22 册 §0.2, owner 2026-09-11 「只要有对端，就扣对端」).
  String get quotaRulesLine1 => _lfQuotaRulesLine1;

  /// Card WB-5a — 「you are talking through somebody else's website」: the
  /// site's owner pays. The case the retired banner could not name.
  String get quotaRulesLine2 => _lfQuotaRulesLine2;

  /// Card WB-5a — the demo page on our own site: the demo allowance pays, and
  /// it is capped per browser. The figure is the rule, not decoration.
  String get quotaRulesLine3 => _lfQuotaRulesLine3;

  /// Card WB-5a — the ONLY case that spends the reader's own allowance:
  /// recording on this phone with nothing connected.
  String get quotaRulesLine4 => _lfQuotaRulesLine4;

  /// Card WB-5a — nothing is transcribed when we cannot tell what is on the
  /// other end. Stated because the alternative is guessing whose allowance to
  /// spend, and a silent guess about somebody's bill is the worst of the three.
  String get quotaRulesLine5 => _lfQuotaRulesLine5;

  /// Card WB-5a — the closing line: being signed in here does not change any of
  /// it. 🔴 IT MUST NOT BECOME A CALL TO ACTION. Signing in does not move
  /// this ceiling, and an invitation to act would be a control that changes
  /// nothing — the same sentence the retired banner carried and the reason
  /// card G-2a renamed the web client's key away from `goUnsigned*`.
  String get quotaRulesClosing => _lfQuotaRulesClosing;

  /// Card WB-5a — the label on the link row to the account's own billing page.
  /// ⚠️ IT POINTS AT THE READER'S OWN PLAN, which is the one number this
  /// screen may show them; `/console/billing` is a path a real device opened
  /// and rendered (`help_link.dart` records the measurement).
  String get quotaRulesConsoleLink => _lfQuotaRulesConsoleLink;


  /// Card G-2c — `QUOTA_EXCEEDED` when the ceiling that refused is the SITE
  /// DEMO's per-device grant (`audio.handler.ts` gate `'trial_cap'`), not a
  /// monthly plan.
  ///
  /// 🔴 IT MUST NOT FALL THROUGH TO [sttStallQuotaExceeded]. That sentence ends
  /// 「It resets when the current cycle ends」 — a promise of a monthly cycle
  /// this reader does not have. The demo grant is a lifetime allowance per
  /// device (`trial_ledger`); telling somebody to wait for a reset that will
  /// never come is a worse failure than saying nothing, because they will wait.
  /// This is the WP-9 defect with the wrong half of the sentence: there the
  /// SUBJECT was wrong, here the REMEDY is.
  ///
  /// ⚠️ HOW THE PHONE KNOWS, AND WHY IT IS AN INFERENCE. The refusal frame
  /// cannot say so: `SttErrorSchema.judged_account` is a closed two-value enum
  /// (`'self' | 'pc_owner'`) and the trial gate reports `'self'`, which is true
  /// — the grant really is this device's. The fact lives on the last
  /// `billing:budget` frame instead (`mode == 'trial'`, which `budget-push.ts`
  /// emits only in the demo room), carried onto the stall by
  /// `ptt_inbound.dart`. Stated as an inference rather than hidden: with no
  /// such frame the phone keeps [sttStallQuotaExceeded] byte for byte, which is
  /// every non-demo pairing and every relay that predates the field.
  ///
  /// ⚠️ IT NAMES SIGNING IN AND NOTHING ELSE. That is the one action that
  /// really lifts this ceiling (owner's W4-05 ruling: the demo allowance stops
  /// applying the moment the visitor signs in), and it is an affordance this
  /// app already has. No figure and no upgrade prompt — same restraint as both
  /// of its neighbours.
  String get sttStallTrialQuotaExceeded => _lfSttStallTrialQuotaExceeded;
}
