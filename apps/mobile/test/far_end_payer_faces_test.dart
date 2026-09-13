// Card G-2c — WHOSE transcription allowance is this recording spending, and
// whose account is named when it runs out.
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §2 / §5 / §7 (owner
//     2026-09-11 「只要有对端，就扣对端」 — whenever a far end exists it pays,
//     signed in or not)
//   apps/server-core/src/billing/budget-push.ts `payerHintFor` (the producer)
//   packages/protocol/src/protocol-schemas-billing.ts `BudgetViewSchema.payer`
//   apps/mobile/lib/src/settings/strings/metering_strings.dart (the two
//     sentences and their reasoning)
//   CLAUDE.md red line R11 (a status word must be able to answer 「凭什么这么
//     说」) and the 0.2.53 law (a copy assertion lands on the RENDERED result)
//
// ── WHAT WAS WRONG, STATED SO THE SHAPE OF THIS FILE FOLLOWS FROM IT ─────────
//
// The relay has been able to say `payer:'far_end'` since card MP-10, and the
// phone has parsed the word since MP-3 — into a field with no readers. So:
//
//   ① a phone paired to somebody ELSE's computer folded that computer's
//      remainder into its OWN settings gauge. Nothing failed, no exception, no
//      log line: the user watched their own minutes drain while their plan was
//      untouched, and watched them stop the moment they unpaired. A plausible
//      number about the wrong ledger — R11 exactly;
//   ② nothing on any screen said whose minutes were moving, so a meter that
//      simply STOPS moving (the fix for ①) would answer nothing either. The two
//      halves ship together or neither is honest;
//   ③ a demo-room refusal read out the MONTHLY sentence — "it resets when the
//      current cycle ends" — to a reader whose grant is a lifetime allowance
//      per device. Telling somebody to wait for a reset that never comes is
//      worse than saying nothing, because they will wait.
//
// 🔴 IN-PLACE CORRECTION (2026-09-12) — ② ABOVE DESCRIBES A SENTENCE THAT NO
// LONGER EXISTS, and it is kept unchanged because it was true when it was
// written. Owner removed the standing chat-page line on 2026-09-12 (the 09-12
// batch ruling, item 5) and replaced it with a guide under the connections
// list. Read ② as the reason the fact must be SAID SOMEWHERE — still true, and
// still met, just not here. Group ③ below is now the REVERSE assertion and says
// at length why it was reversed rather than deleted. ① and ④ are untouched: the
// meter still must not move on somebody else's remainder, and that half never
// depended on any sentence existing anywhere.
//
// 🔴 THE SUITE WAS GREEN THROUGHOUT, AND ONE TEST HELD ① IN PLACE AS A
// SPECIFICATION: `billing_budget_payer_test.dart`'s 「the meter reads the same
// whatever the payer word says」. That assertion was right when it was written
// (no producer could send `far_end` to a phone) and its own header says who
// has to change it and when. Updated there, on purpose — 0.2.52's law: a
// reverse control pointed the wrong way does not miss a defect, it writes the
// defect down as the acceptance criterion.
//
// ── WHERE THE ASSERTIONS LAND ───────────────────────────────────────────────
//
// Every visible-copy claim is made against the paragraph the framework LAID
// OUT, inside the screen that is the deliverable — `ChatFlowPage`, not a
// hand-built slot and not `Text.data` (0.2.53, and anti-façade ⑥: the two ends
// of a wire can each be green while nothing walks the middle).
//
// ── THE BREAK THAT PROVED THIS FILE COULD SEE THE THING (2026-09-11) ────────
//
// 🔴 KEPT AS A RECORD, NOT AS A CLAIM ABOUT TODAY'S FILE. It was run against the
// version that asserted the banner was PRESENT, and that version is gone (see
// the correction above). What replaces it is group ③'s own positive control,
// which runs on every pass instead of once by hand.
//
// Deleted the one production line that read the fact —
// `chat_banner_sources.dart`s `farEndPaysQuota: … == 'far_end'` — so the
// far-end arm fell through untouched (the queue entry, the copy and the parser
// all still existed; only the reader was gone, which is anti-façade ①s shape:
// the fault leaves no new symbol, only an empty value).
//
// OBSERVED `00:06 +14 -3: Some tests failed.` — exactly the three cases that
// claimed something was ON SCREEN, each with the same message:
//   Expected: exactly one matching candidate
//     Actual: _DescendantWidgetFinder:<Found 0 widgets with type "Text"
//             descending from widgets with type "BannerSlot">
// i.e. the slot was empty, which was the defect itself.
//
// CONTROL ON CONTROL: 「payer:self is byte-for-byte the pre-card page」 stayed
// GREEN, so the break was exactly as wide as the fact — a case that went red for
// both values would have been measuring the harness rather than the branch.
// Restored, re-run, 17/17.
//
// ── THE BREAK FOR TODAY'S DIRECTION (executed 2026-09-12) ───────────────────
//
// Put the removed banner back — the `farEndPaysQuota` parameter, its queue
// entry and its `chat_banner_sources.dart` reader — and re-ran this file. (The
// entry carried a DIFFERENT sentence, because the original copy is deleted in
// all nine languages; the mechanism under test is 「a payer frame reaches the
// slot」, not which words arrive there.)
// OBSERVED group ③'s first case red on the very first iteration (payer=far_end):
//   Expected: no matching candidates
//     Actual: _DescendantWidgetFinder:<Found 1 widget with type "Text" …>
// Removed again, re-run, green. A negative assertion has no other evidence to
// offer than going red when the thing it forbids is put back.
//
// ⚠️ THE FONT IS AHEM, so every glyph is a full em square and a 360 dp line
// holds ~20 characters where a real font holds far more. That direction is
// conservative for 「will it be clipped」 and does NOT run backwards: nothing
// here may be read as 「it happens to fit on a device」.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/cloud_summary_controller.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/quota_gauge.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';

const AppStrings _en = AppStringsEn();

/// 🔴 THE PAGE'S OWN LANGUAGE, and the distinction is load-bearing.
/// `ChatFlowPage` resolves its own `AppStrings` from the app settings, whose
/// default is Chinese — so a rendered-page assertion must be made against THAT
/// catalogue. Asserting `_en` there fails for a reason that has nothing to do
/// with this card (measured: 「Expected: Anything y… Actual: 你在这里说的话…」),
/// and worse, it would PASS on any build that stopped localising the page.
/// `_en` below is used only where this file hands the strings in itself.
const AppStrings _zh = AppStringsZh();

/// The frame `apps/server-core/src/billing/budget-push.ts` builds, verbatim.
/// `payer` is OMITTED unless asked for — absence is the pre-card wire and has
/// to be a distinct case from any word, never a default.
Map<String, Object?> budgetFrame({
  String? payer,
  String mode = 'plan',
  Object? remainingMs = 90000,
  Object? resetsAt = 1800000000000,
}) => <String, Object?>{
  'remaining_ms': remainingMs,
  'mode': mode,
  'resets_at': resetsAt,
  'reason': 'heartbeat',
  'payer': ?payer,
};

/// `refuseStart`'s frame (audio-start-quota.ts): the quota gate turned the
/// press away. `judged_account` is additive and only meaningful here.
Map<String, Object?> quotaRefusal({String judged = 'self'}) => <String, Object?>{
  'code': 'QUOTA_EXCEEDED',
  'message': 'audio:start refused',
  'retryable': false,
  'judged_account': judged,
};

class _Owner implements InstanceOwnerProbe {
  _Owner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

/// The real data layer + the real hub + the real banner adapter + the real
/// page. Only the socket and the recorder are doubles, so every hop between
/// the frame and the sentence is production code — that seam is the subject.
class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create() {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.store = newTestStore(owner: _Owner('inst-g2c', 'Study PC'));
    r.destination = DestinationController();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    r.transport.pushStatus(SocketStatus.connected);
    return r;
  }

  void budget({String? payer, String mode = 'plan'}) => transport.pushIncoming(
    FlowMicEvents.billingBudget,
    budgetFrame(payer: payer, mode: mode),
  );

  /// The server refuses the press. Driven through the FSM the way a real press
  /// does: the refusal arrives mid-recording, is latched, and is consumed when
  /// the press ends (see `onSttTerminalError` / `onPttUp`). Deliberately NOT
  /// `SttStall(...)` typed by hand — the fact under test is that
  /// `ptt_inbound.dart` reads the last budget frame at exactly this seam.
  void refuseQuota({String judged = 'self'}) {
    session.fsm.onPttDown();
    transport.pushIncoming(FlowMicEvents.sttError, quotaRefusal(judged: judged));
    session.fsm.onPttUp();
  }
}

_Rig _rig() {
  final _Rig r = _Rig.create();
  addTearDown(() async {
    await r.controller.dispose();
    r.destination.dispose();
    r.store.dispose();
    await r.session.dispose();
    await r.transport.close();
  });
  return r;
}

/// Deliver a frame's consequences AND repaint. Two pumps, not one: the inbound
/// arms hop a broadcast stream, so at the first `pump()` nothing has scheduled
/// a frame yet and the repaint is left for the next one. One pump passes only
/// when something ELSE happened to schedule a frame — which makes the assertion
/// about the scheduler rather than about the product
/// (`autostop_reason_wire_test.dart` measured this the hard way).
Future<void> _deliverAndPaint(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

/// `AutomatedTestWidgetsFlutterBinding` refuses a pending Timer at teardown,
/// which happens BEFORE `addTearDown` runs.
void _releaseTimers(_Rig r) {
  debugCancelBannerAutoHideTimers(r.controller);
  r.session.debugStopIdlePresencePoll();
}

final Finder _bannerText = find.descendant(
  of: find.byType(BannerSlot),
  matching: find.byType(Text),
);

/// What the banner slot LAID OUT — one step past the widget's own `data`,
/// which is the step 0.2.53 was lost on.
String _renderedBanner(WidgetTester tester) {
  expect(_bannerText, findsOneWidget,
      reason: 'the slot shows exactly one sentence; more than one means this '
          'helper is measuring an action label instead of the copy');
  return tester
      .renderObject<RenderParagraph>(_bannerText)
      .text
      .toPlainText();
}

void main() {
  // ── ① the parser, the three cases that matter ─────────────────────────────
  //
  // Absence is its own case and may never collapse into `'self'`: since this
  // card the two mean different things ("an old relay, keep the pre-card
  // behaviour" vs "we were told you are paying").
  group('the wire word', () {
    test('absent ⇒ null, and null is never read as self', () {
      final BillingBudget? b = BillingBudget.tryFromJson(budgetFrame());
      expect(b, isNotNull);
      expect(b!.payer, isNull);
      // positive control: the frame really was readable, so the null above is
      // "not told" and not "the parser gave up".
      expect(b.remainingMs, 90000);
      expect(b.mode, 'plan');
    });

    test("'self' and 'far_end' survive verbatim", () {
      expect(BillingBudget.tryFromJson(budgetFrame(payer: 'self'))?.payer, 'self');
      expect(
        BillingBudget.tryFromJson(budgetFrame(payer: 'far_end'))?.payer,
        'far_end',
      );
    });

    test('a word this build never heard of is dropped, the reading is kept', () {
      final BillingBudget? b =
          BillingBudget.tryFromJson(budgetFrame(payer: 'landlord'));
      expect(b, isNotNull);
      expect(b!.payer, isNull);
      expect(b.remainingMs, 90000, reason: 'punishing the word must not cost '
          'us a valid meter reading');
    });
  });

  // ── ② the frame reaches the fact the screen reads ─────────────────────────
  group('the session holds the latest frame', () {
    testWidgets('payer and mode are both readable off it', (WidgetTester tester) async {
      final _Rig r = _rig();
      expect(r.session.latestBudget.value, isNull,
          reason: 'null until the relay says anything — never "self"');
      r.budget(payer: 'far_end');
      await tester.pump();
      expect(r.session.latestBudget.value?.payer, 'far_end');
      r.budget(payer: 'self', mode: 'trial');
      await tester.pump();
      expect(r.session.latestBudget.value?.payer, 'self');
      expect(r.session.latestBudget.value?.mode, 'trial',
          reason: 'the whole frame is held, not one field — two readers want '
              'two different fields off the same reading');
      _releaseTimers(r);
    });
  });

  // ── ③ the chat page says NOTHING about whose quota is moving ──────────────
  //
  // 🔴 THIS GROUP WAS THE OPPOSITE ASSERTION UNTIL 2026-09-12, and the reversal
  // is owner's, not a correction of a mistake: the standing line this file was
  // written to pin (「payer:'far_end' puts the sentence on the page」, plus its
  // no-figure and no-timer companions) was removed by the 09-12 batch ruling,
  // item 5. The fact moved to a guide under the connections list, which states
  // every case instead of the one a live frame names; the sentences and the two
  // screens that carry them are pinned by `quota_rules_guide_test.dart`.
  //
  // 🔴 WHY THE REVERSED ASSERTION IS WORTH KEEPING RATHER THAN DELETING. What
  // this file can still see, and nothing else can, is that the CHAT page draws
  // nothing on a `far_end` frame. Delete the group and the next person who
  // re-reads `PttSession.latestBudget` from `chat_banner_sources.dart` — the
  // obvious place, since the field is still parsed and still held — gets no
  // warning at all. 0.2.52's law is why this is spelled out: a reverse control
  // pointed the wrong way does not miss a defect, it writes one down as the
  // acceptance criterion, and the only defence is saying out loud which
  // direction it points and why.
  group('the chat page draws nothing on a payer frame', () {
    testWidgets('no payer value puts a banner on the page', (WidgetTester tester) async {
      final _Rig r = _rig();
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
      await tester.pump();
      expect(find.byType(BannerSlot), findsOneWidget);

      // All three wire cases, including the two that used to differ.
      for (final String? payer in <String?>['far_end', 'self', null]) {
        r.budget(payer: payer);
        await _deliverAndPaint(tester);
        expect(_bannerText, findsNothing, reason: 'payer=$payer');
      }

      // 🔴 POSITIVE CONTROL, and the negative assertion above is worth nothing
      // without it. 「Zero widgets in the slot」 is exactly what a blind probe
      // reports: a finder pointed at a slot that never renders anything, a rig
      // whose frames never arrive, and a correct implementation all read the
      // same. So drive the SAME slot, through the SAME rig, with something that
      // must appear — a refused press — and require it.
      r.refuseQuota();
      await _deliverAndPaint(tester);
      expect(_bannerText, findsWidgets,
          reason: 'the slot can render; the emptiness above is the product, '
              'not the probe');
      _releaseTimers(r);
    });

    testWidgets('a far_end frame is still parsed and still held',
        (WidgetTester tester) async {
      // ⚠️ THE FRAME IS NOT WHAT WAS REMOVED. `applyBudget`'s refusal to fold a
      // stranger's remainder into this account's meter (group ④) reads exactly
      // this value, so a build that 「cleaned up」 the parse alongside the banner
      // would take the meter's honesty with it — and no case in group ④ would
      // notice, because those drive the controller directly.
      final _Rig r = _rig();
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
      await tester.pump();
      r.budget(payer: 'far_end');
      await _deliverAndPaint(tester);
      expect(r.session.latestBudget.value?.payer, 'far_end');
      _releaseTimers(r);
    });
  });

  // ── ④ the gauge that used to lie ──────────────────────────────────────────
  group("the settings gauge does not show the far end's minutes as yours", () {
    /// A signed-in account with a summary already on screen — the precondition
    /// for `applyBudget` to do anything at all.
    ///
    /// ⚠️ [settle] IS NOT OPTIONAL SUGAR. The fetcher resolves through a real
    /// `Future.delayed`, and inside `testWidgets` the clock is fake: awaiting
    /// it there never returns, and the symptom is a case that hangs with no
    /// output until the harness times out — it looks slow, not broken (the
    /// discipline note in `article_screen_test.dart`, met again here). A
    /// widget case passes `tester.runAsync`; a plain `test` passes nothing.
    Future<CloudSummaryController> loaded({
      Future<void> Function(Future<void> Function())? settle,
    }) async {
      final LoginController login = newTestLogin(
        transport: FakeSocketTransport(),
        accountStore: InMemoryAccountStore(
          const CloudAccount(jwt: 'jwt-g2c', email: 'a@example.com', plan: 'pro'),
        ),
      );
      await login.hydrate();
      final CloudSummaryController c = newTestCloudSummary(
        login: login,
        fetcher: fixedCloudSummary(testSummary(usedMin: 12, limitMin: 900)),
      );
      c.refresh();
      Future<void> flush() => Future<void>.delayed(Duration.zero);
      if (settle == null) {
        await flush();
      } else {
        await settle(flush);
      }
      expect(c.summary?.minutes?.used, 12,
          reason: 'the fixture must land, or every assertion below passes for '
              'the wrong reason');
      addTearDown(() {
        c.dispose();
        login.dispose();
      });
      return c;
    }

    testWidgets("a far_end frame leaves the RENDERED label alone",
        (WidgetTester tester) async {
      final CloudSummaryController c =
          await loaded(settle: (Future<void> Function() f) => tester.runAsync(f));
      c.applyBudget(BillingBudget.tryFromJson(budgetFrame(payer: 'far_end'))!);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: QuotaGauge(summary: c.summary!, strings: _en)),
      ));
      final RenderParagraph label = tester.renderObject<RenderParagraph>(
        find.byKey(QuotaGauge.minutesLabelKey),
      );
      expect(label.text.toPlainText(), _en.quotaVoiceUsed('12', '900'),
          reason: "the far end's 90 s remainder would read as 898.5 used — a "
              "plausible number about the wrong ledger");
    });

    test("'trial' is refused for the same sentence", () async {
      // A demo grant is two minutes; arithmetic against a 900-minute ceiling
      // would report this account as hundreds of minutes over.
      final CloudSummaryController c = await loaded();
      c.applyBudget(
        BillingBudget.tryFromJson(budgetFrame(payer: 'trial', mode: 'trial'))!,
      );
      expect(c.summary?.minutes?.used, 12);
    });

    test("'self' and an absent word still move it — positive control", () async {
      final CloudSummaryController self = await loaded();
      self.applyBudget(BillingBudget.tryFromJson(budgetFrame(payer: 'self'))!);
      expect(self.summary?.minutes?.used, closeTo(898.5, 0.001));

      final CloudSummaryController old = await loaded();
      old.applyBudget(BillingBudget.tryFromJson(budgetFrame())!);
      expect(old.summary?.minutes?.used, closeTo(898.5, 0.001),
          reason: 'a relay that never learned the word must keep the pre-card '
              'behaviour — refusing to answer a question we CAN answer is the '
              'opposite defect');
    });
  });

  // ── ⑤ exhaustion: which account is named ──────────────────────────────────
  group('when it runs out, the sentence names the right account', () {
    testWidgets("judged_account:'pc_owner' reaches the page",
        (WidgetTester tester) async {
      final _Rig r = _rig();
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
      await tester.pump();
      r.refuseQuota(judged: 'pc_owner');
      await _deliverAndPaint(tester);
      expect(_renderedBanner(tester), _zh.sttStallQuotaExceededPcOwner);
      expect(_renderedBanner(tester), isNot(_zh.sttStallQuotaExceeded),
          reason: 'the sibling sentence blames the reader\'s own plan, which '
              'nothing they buy would fix');
      _releaseTimers(r);
    });

    testWidgets("judged_account:'self' reaches the page unchanged",
        (WidgetTester tester) async {
      final _Rig r = _rig();
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
      await tester.pump();
      r.refuseQuota();
      await _deliverAndPaint(tester);
      expect(_renderedBanner(tester), _zh.sttStallQuotaExceeded);
      _releaseTimers(r);
    });

    testWidgets('a DEMO grant does not promise a monthly reset',
        (WidgetTester tester) async {
      // The demo room's ceiling is a lifetime allowance per device
      // (`trial_ledger`), and the refusal frame cannot say so — its
      // `judged_account` enum is closed and the trial gate honestly reports
      // `'self'`. The phone reads the last budget frame's `mode` instead, at
      // the one seam that holds both facts.
      final _Rig r = _rig();
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
      await tester.pump();
      r.budget(payer: 'trial', mode: 'trial');
      await _deliverAndPaint(tester);
      r.refuseQuota();
      await _deliverAndPaint(tester);

      expect(_renderedBanner(tester), _zh.sttStallTrialQuotaExceeded);
      expect(_renderedBanner(tester), isNot(_zh.sttStallQuotaExceeded),
          reason: 'the monthly sentence tells this reader to wait for a reset '
              'that will never come, and they will wait');
      _releaseTimers(r);
    });

    testWidgets('a plan-mode frame before the refusal keeps the monthly sentence',
        (WidgetTester tester) async {
      // The negative half of the case above. Without it, "the trial sentence
      // appeared" could equally mean "the trial sentence always appears".
      final _Rig r = _rig();
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
      await tester.pump();
      r.budget(payer: 'self');
      await _deliverAndPaint(tester);
      r.refuseQuota();
      await _deliverAndPaint(tester);
      expect(_renderedBanner(tester), _zh.sttStallQuotaExceeded);
      _releaseTimers(r);
    });
  });

  // ── ⑥ the copy contract, nine languages ───────────────────────────────────
  group('the two new sentences, in every language', () {
    test('the trial sentence is a DIFFERENT sentence everywhere', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.sttStallTrialQuotaExceeded, isNotEmpty, reason: '$locale');
        expect(s.sttStallTrialQuotaExceeded, isNot(s.sttStallQuotaExceeded),
            reason: '$locale');
        expect(s.sttStallTrialQuotaExceeded,
            isNot(s.sttStallQuotaExceededPcOwner), reason: '$locale');
        // No figure: the grant's size is not this sentence's business, and a
        // number here would be the one claim we would then have to keep true.
        expect(s.sttStallTrialQuotaExceeded, isNot(matches(RegExp(r'[0-9]'))),
            reason: '$locale');
      }
    });

    test('the selector picks it from the stall alone', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(
          s.sttStallBannerMessage(const SttStall(SttStallReason.engineError,
              code: 'QUOTA_EXCEEDED', trialCeiling: true)),
          s.sttStallTrialQuotaExceeded,
          reason: '$locale',
        );
        // …and the default is untouched: `trialCeiling` is false for every
        // ordinary pairing and every relay that never sent a budget frame.
        expect(
          s.sttStallBannerMessage(const SttStall(SttStallReason.engineError,
              code: 'QUOTA_EXCEEDED')),
          s.sttStallQuotaExceeded,
          reason: '$locale',
        );
      }
    });
  });
}
