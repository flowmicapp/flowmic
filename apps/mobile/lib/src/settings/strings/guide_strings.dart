// AppStrings copy-catalogue shard: two 「tap to view」 in-page guides (P-7 §3
// instance list / §4 pairing).
//
// SPEC-REF:
//   docs/ui-design/2026-08-06-p7-mobile-onboarding-design.md §3 / §4 / §5（W-4/W-5）
//   docs/decisions/2026-08-06-p-wave-choices-by-first-responsible.md P-7 7-4 (entry point takes A)
//
// The one external entry point is still ../app_strings.dart. From 0.2.67 on,
// the copy leaves `_lf…` are implemented by generated classes under l10n/.
//
// 🔴 Deliberately split into two files from onboarding_strings.dart: the
// first-launch onboarding (one-shot, skippable) and the in-page guide (the
// persistent 「?」, tap to view) are two different surfaces, each owned by its
// own parallel lane. Merging them into one file would collide the two lanes on
// the same file.
//
// 🔴 Same-source string discipline (design doc §6-1): any button name / tab
// name / status word that appears in a guide **must always reference the getter
// the real UI is actually using** (e.g. the ones in ConnectionStrings /
// PairingStrings), never a literal copy duplicated in this shard. When the real
// UI's wording changes, the guide must automatically follow.
part of '../app_strings.dart';

mixin GuideStrings on AppStringsLeaves {

  /// The instance-list-page guide's title (design doc §5 W-4).
  String get guideInstancesTitle => _lfGuideInstancesTitle;

  // ── ② instance-list guide, design §3.2 ────────────────────────────────────
  //
  // Nothing below quotes a button name, a tab name or a status word as a
  // literal. Where the copy has to name one, the sentence takes it as a
  // PARAMETER and the widget passes the live getter (§6-1). The alternative —
  // declaring `String get cloudInstance;` here and letting the mixin chain
  // resolve it — is not available: AppStrings applies CloudStrings BEFORE
  // GuideStrings, so an abstract declaration here would shadow the concrete one
  // rather than borrow it.

  /// §3.2-1. The second line of this section is `startNoAutoConnect` itself,
  /// rendered verbatim — the design says not to write a second phrasing of a
  /// sentence the page footer is already saying.
  String get guideListTitle => _lfGuideListTitle;
  String get guideListBody => _lfGuideListBody;

  /// §3.2-2. One sentence per [InstanceLivenessFace]; the LABEL beside each of
  /// them is the real getter, never a copy. Phenomena, not mechanisms — no
  /// endpoint, no /api/health, no room.
  String get guideStatusTitle => _lfGuideStatusTitle;
  String get guideStatusOnline => _lfGuideStatusOnline;
  String get guideStatusOffline => _lfGuideStatusOffline;
  /// 🔴 2026-08-18 — and it is a THIRD sentence for the same reason the two
  /// below are two: [guideStatusOffline] says 「够不着那个地址」("that address
  /// cannot be reached"), which sends the reader to look at their network or
  /// that machine. This one says 「这一轮没问到」("we got no answer this round"),
  /// whose correct action is to do nothing and let the next tick answer. Reusing
  /// [guideStatusOffline] here would put a troubleshooting errand under a
  /// situation with nothing to troubleshoot.
  String get guideStatusReachUnanswered => _lfGuideStatusReachUnanswered;
  /// 🔴 This one and [guideStatusOffline] must stay two different sentences,
  /// for the reason pc_presence.dart gives at the `pcOffline` face: the action
  /// they call for is different (go turn the PC on / go look at the network).
  String get guideStatusPcOffline => _lfGuideStatusPcOffline;
  /// 🔴 The only status line on this page that names an action the user takes
  /// on the OTHER machine. Every other absence resolves to 「看看那台电脑/看看
  /// 网络」("check that computer / check the network"); this one is a lapsed
  /// credential on a computer that is running fine, and the sentence has to say
  /// so or the reader will go and stare at a working machine.
  String get guideStatusPcSignedOut => _lfGuideStatusPcSignedOut;

  /// 🔴 C9 — and the only status line whose action is on THIS phone. The
  /// sentence has three jobs and drops none of them: it says the machine
  /// changed accounts (the cause), it says to pair again (the fix), and it says
  /// the computer is fine (which is what stops the reader walking over to it
  /// anyway, the way the plain 「离线」 sentence made them).
  ///
  /// ⚠️ Its first clause is owner-supplied wording (card C9,
  /// 「这台电脑现在属于另一个账号，请重新配对」) and the rest was written around
  /// it; do not "tighten" it by deleting the third clause, which is the half
  /// that makes the first two believable.
  String get guideStatusPcOtherAccount => _lfGuideStatusPcOtherAccount;
  String get guideStatusRelayOnly => _lfGuideStatusRelayOnly;
  String get guideStatusChecking => _lfGuideStatusChecking;
  String get guideStatusUnmeasured => _lfGuideStatusUnmeasured;

  /// §3.2-3.
  String get guideGesturesTitle => _lfGuideGesturesTitle;
  String get guideGestureSwipe => _lfGuideGestureSwipe;
  String get guideGestureLongPress => _lfGuideGestureLongPress;

  /// §3.2-4. [name] is the live cloud-instance label — see the note at the top
  /// of this section for why it is a parameter and not a literal.
  String guideCloudTitle(String name) => _lfGuideCloudTitle(name);
  String get guideCloudBody => _lfGuideCloudBody;

  /// §3.2-5. Phenomenon only. The three grouping rules live in
  /// session/machine_group.dart and are deliberately not described here.
  String get guideSameMachineTitle => _lfGuideSameMachineTitle;
  String get guideSameMachineBody => _lfGuideSameMachineBody;

  String get guideClose => _lfGuideClose;

  // ── ③ add-device (pairing) guide, design §4.2 ─────────────────────────────
  //
  // 🔴 Two things this section deliberately does NOT contain, both from §4.2:
  //   · no error-code table — the sheet already fails loud with the real
  //     reason, and a second copy of that table here would drift away from it;
  //   · no pairing-code TTL in seconds — the number is an implementation
  //     detail of the PC side and writing it down guarantees it goes stale.
  //     [guidePairingCodeExpires] says what the user has to DO instead.

  String get guidePairingTitle => _lfGuidePairingTitle;

  /// §4.2-1 — the head question this sheet actually raises. The phone is
  /// answering for the PC here, which is why the steps name the PC surfaces.
  String get guidePairingWhereTitle => _lfGuidePairingWhereTitle;
  String get guidePairingWhereBody => _lfGuidePairingWhereBody;
  String get guidePairingCodeExpires => _lfGuidePairingCodeExpires;

  /// 🔴 §6-2: the sketch above this caption is an abstract wireframe, and the
  /// caption says so out loud. A screenshot would be a pixel snapshot of a
  /// screen that is free to change without anything going red.
  String get guidePairingSketchCaption => _lfGuidePairingSketchCaption;

  /// §4.2-2. [scanTab] is the live tab name.
  String guidePairingScanTitle(String scanTab) => _lfGuidePairingScanTitle(scanTab);
  String get guidePairingScanBody => _lfGuidePairingScanBody;

  /// §4.2-3. [manualTab] is the live tab name; [addressLabel] / [codeLabel]
  /// are the live field labels from that tab.
  String guidePairingManualTitle(String manualTab) => _lfGuidePairingManualTitle(manualTab);
  /// 0.3.1 (P2) — the manual tab is SEGMENTED now (LAN | cloud relay), so the
  /// copy walks the two segments: LAN = [addressLabel] + [codeLabel]; cloud =
  /// [pcidLabel] + [codeLabel], no address (the official relay's endpoint is
  /// fixed — owner 2026-08-15: 「不用输端点URL，因为是确定的」). The 0.2.66
  /// wording described a conditional third box on ONE pane; that UI no longer
  /// exists, and a guide describing it would send the user hunting for an
  /// address field the cloud segment deliberately does not have. owner
  /// 2026-08-14's 「本地局域网……没有 PCID」 still governs the LAN half.
  String guidePairingManualBody(String addressLabel, String codeLabel, String pcidLabel) => _lfGuidePairingManualBody(addressLabel, codeLabel, pcidLabel);

  /// §4.2-4 — two sentences, no code table.
  String get guidePairingTroubleTitle => _lfGuidePairingTroubleTitle;
  String get guidePairingSameNetwork => _lfGuidePairingSameNetwork;
  String get guidePairingNewestCode => _lfGuidePairingNewestCode;

  String get guidePairingBack => _lfGuidePairingBack;
}
