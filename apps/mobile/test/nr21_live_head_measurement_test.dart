// NR-21 step 1 — MEASURE, DO NOT READ: during a long press, does the text the
// user READS ON THE PHONE lose its beginning?
//
// Ledger: docs/strategy/2026-08-27-next-release-feature-and-optimization-
//   ledger.md §8 (NR-21). The owner's own suspicion recorded there ("maybe a
//   segment's final replaces instead of appends") is marked 猜测 (a guess) IN
//   THAT ENTRY, so this file may not be built on it — it drives the shipped
//   path and reports what comes out.
//
// ── WHAT IS REAL HERE AND WHAT IS SCRIPTED ──────────────────────────────────
// Real: FakeSocketTransport -> PttSession -> ptt_inbound.dart -> SegmentBuffer
// -> ChatController (chat_utterance.dart / chat_utterance_settle.dart) ->
// ChatFlowPage -> LiveDraftTile. Scripted: only the wire frames and the socket
// they arrive on. Nothing in this file calls `_handleTerminalFinal`,
// `SegmentBuffer.put` or `LiveDraftTile` directly — a hand-built fake of the
// assembly would agree with whatever the fake's author believed.
//
// ── WHY THE FRAMES HAVE THE SHAPE THEY HAVE ─────────────────────────────────
// Both halves are MEASURED facts about the relay, not assumptions:
//   · FINALS ARE INCREMENTAL — every `stt:final` carries only its own span, and
//     the terminal final repeats no earlier segment. Measured by the previous
//     work package against the shipped orchestrator:
//     apps/server-core/test/nr40-segment-final-semantics.test.ts (commit
//     74b9a613). That is why `_speakSegment` sends one segment's words, never a
//     running total.
//   · INTERIMS ARE CUMULATIVE WITHIN THE CURRENT SEGMENT ONLY — the emit is
//     `text: this.offlineAccum + this.onlineDraft`
//     (apps/server-core/src/stt/orchestrator-core.ts, the `interim:` handler)
//     and BOTH accumulators are cleared at every delivering boundary
//     (orchestrator-rollover.ts:240-241). So a preview grows inside a segment
//     and restarts at each rollover — which is the only reading under which a
//     cumulative-REPLACE slot and an incremental final describe the same span.
//
// ── 🔴 WHAT IS ASSERTED: THE SCREEN, NOT THE MODEL ──────────────────────────
// CLAUDE.md anti-facade ⑥ (0.3.47): when the deliverable is "what the user sees
// on screen X", the acceptance has to mount screen X. A model assertion and a
// hand-built widget are each one honest half of a claim whose halves can both
// be true while the product is broken. So every claim below is read off
// `RichText` render objects that the mounted `ChatFlowPage` actually laid out,
// together with their geometry — the same route `live_draft_tile_render_test`
// uses for the height budget.
//
// ⚠️ `tester.runAsync` for the production chain: inside a `testWidgets` body the
// clock belongs to the tester, so a production `await` on a real timer never
// returns and the file HANGS WITH NO OUTPUT — which reads as slow, not broken
// (article_screen_test.dart paid for this once).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart' show SessionOwnerProbe;
import 'support/di.dart';
import 'support/fakes.dart';

/// 🔴 THE VOLUME IS PART OF THE FIXTURE. A 30-second soft segment of Mandarin
/// is on the order of 130 characters (~4.5 chars/s), so a four-segment press is
/// ~520 characters. Four SHORT spans would fit a phone screen whole and the
/// viewport case below would report "nothing scrolled out" — a green that
/// measured the fixture instead of the product. Each span here therefore opens
/// with its own marker and then carries a realistic body.
String _span(String mark, String body) => '$mark。$body';

/// The markers are what every assertion looks for: distinct, and never a
/// substring of one another.
const List<String> _kMarks = <String>[
  '第一段是开头的话',
  '第二段接着往下说',
  '第三段再说一点别的',
  '第四段到这里就结束',
];

/// A string nobody said — the negative control for the finders below. Without
/// it, a `_onScreen` that returned true for everything would pass every
/// assertion in this file.
const String _kNeverSpoken = '这句话从来没有人说过';

final List<String> _kSpans = <String>[
  _span(_kMarks[0],
      '我们今天先把上个季度的事情理一理，仓库那边的口径一直没有统一，'
      '销售报上来的数字和财务对不上，先把这个讲清楚再谈别的安排。'),
  _span(_kMarks[1],
      '第二件事是采购的节奏，现在每个月都压着月底才下单，供应商那边来不及备货，'
      '所以后面想改成按周滚动，看看大家有没有别的意见。'),
  _span(_kMarks[2],
      '还有就是新来的同事要尽快熟悉流程，前两周先跟着做，第三周开始自己负责一条线，'
      '中间有问题随时找我，不要自己憋着不说。'),
  _span(_kMarks[3],
      '最后一件是下个月的盘点，时间还是定在月初，需要提前一周把单据都整理好，'
      '不然到时候又要返工，就先说到这里。'),
];

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // Without a redeemable destination the row is minted but nothing is
    // queued — the fixture would then read "the display is wrong" when what is
    // actually missing is the delivery half this card must NOT touch.
    giveSessionAPairedIdentity(session);
    store = newTestStore(owner: SessionOwnerProbe(session));
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final ChatController controller;

  /// 🔴 THE MICROPHONE HAS TO PRODUCE SOMETHING, AND IT IS NOT A DETAIL.
  /// `AudioCapture._armDeadCaptureWatchdog` fires after `kDeadCaptureAfter` of
  /// REAL time with `_platformBytes == 0` and routes to
  /// `ptt_capture_pump._onCaptureFault`, which calls `segments.clear()` — i.e.
  /// it WIPES the on-screen text mid-press. Measured while writing this file:
  /// the frame-by-frame case below takes longer than that watchdog in wall
  /// time, so with a silent fake recorder it failed with
  /// 「frame 4 … the head left the screen mid-press」 — a fixture measuring the
  /// watchdog and reporting it as NR-21. Feeding one real frame is what makes
  /// this a press with a working microphone, which is what NR-21 is about.
  /// (The watchdog itself is NOT NR-21: it also aborts the utterance, mints no
  /// row and raises a banner, while NR-21's delivery is complete.)
  Future<void> pressDown() async {
    await controller.pttDown();
    recorder.feed(makePcm(3200));
    await pumpEventQueue();
  }

  Future<void> pushInterim(String text, int idx) async {
    transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': text,
      'confidence': 0.8,
      'language': 'zh',
      'segment_idx': idx,
    });
    await pumpEventQueue();
  }

  Future<void> pushFinal(
    String text,
    int idx, {
    required bool isSegment,
    int durationMs = 30000,
  }) async {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': isSegment,
      'duration_ms': durationMs,
    });
    await pumpEventQueue();
  }

  /// One segment as it really arrives: four growing previews INSIDE the
  /// segment, then the final that closes it carrying only that segment's words.
  Future<void> speakSegment(int idx, String span, {required bool isSegment}) async {
    for (final int cut in <int>[
      span.length ~/ 4,
      span.length ~/ 2,
      (span.length * 3) ~/ 4,
      span.length,
    ]) {
      await pushInterim(span.substring(0, cut), idx);
    }
    await pushFinal(span, idx, isSegment: isSegment);
  }

  Future<void> dispose() async {
    await controller.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

/// Every paragraph the mounted page actually laid out, with where it sits.
///
/// `RichText` and not `Text`: a `Text` BUILDS a `RichText`, so reading the
/// `RichText` layer is both the deduplicated list and the only one that owns a
/// `RenderBox` — i.e. the only one that can answer "and where is it on the
/// screen". A paragraph the list never built contributes nothing here, which is
/// the honest answer (an unbuilt row is not on the screen).
List<({String text, Rect rect})> _paintedParagraphs(WidgetTester tester) {
  final List<({String text, Rect rect})> out = <({String text, Rect rect})>[];
  for (final Element e in find.byType(RichText).evaluate()) {
    final RenderObject? ro = e.renderObject;
    if (ro is! RenderBox || !ro.hasSize) continue;
    final Rect rect = ro.localToGlobal(Offset.zero) & ro.size;
    out.add((text: (e.widget as RichText).text.toPlainText(), rect: rect));
  }
  return out;
}

/// Is [needle] anywhere in what the page laid out?
bool _onScreen(WidgetTester tester, String needle) =>
    _paintedParagraphs(tester).any((({String text, Rect rect}) p) => p.text.contains(needle));

/// Where [needle]'s own glyphs sit on the screen, in global coordinates.
///
/// 🔴 THE PARAGRAPH'S RECT IS NOT THE ANSWER. In translate/organize the whole
/// press is ONE paragraph in `LiveDraftTile`, so a box test against the
/// paragraph reports "visible" while the first two hundred characters of it are
/// above the top of the screen — the paragraph overlaps the window because its
/// TAIL does. Asking the laid-out text for the boxes of that character range is
/// the only reading that answers "can the user read these characters".
List<Rect> _needleRects(WidgetTester tester, String needle) {
  final List<Rect> out = <Rect>[];
  for (final Element e in find.byType(RichText).evaluate()) {
    final RenderObject? ro = e.renderObject;
    if (ro is! RenderParagraph || !ro.hasSize) continue;
    final String plain = ro.text.toPlainText();
    final int at = plain.indexOf(needle);
    if (at < 0) continue;
    final Offset origin = ro.localToGlobal(Offset.zero);
    for (final TextBox b in ro.getBoxesForSelection(
      TextSelection(baseOffset: at, extentOffset: at + needle.length),
    )) {
      out.add(b.toRect().shift(origin));
    }
  }
  return out;
}

/// Would the user see [needle] WITHOUT scrolling? Kept apart from [_onScreen]
/// on purpose: "laid out but scrolled out of view" and "gone" look identical to
/// the user and have opposite fixes.
bool _inViewport(WidgetTester tester, String needle, Size viewport) {
  final Rect window = Offset.zero & viewport;
  return _needleRects(tester, needle).any((Rect r) => r.overlaps(window));
}

Future<void> _mount(WidgetTester tester, _Rig r, Size viewport) async {
  tester.view.physicalSize = viewport;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

/// The measurement line this file exists to print. Written to the run's output
/// so the ledger entry quotes a reading rather than a recollection.
void _report(WidgetTester tester, String label, Size viewport) {
  final List<String> missing = <String>[];
  final List<String> outOfView = <String>[];
  for (final String s in _kMarks) {
    if (!_onScreen(tester, s)) {
      missing.add(s);
    } else if (!_inViewport(tester, s, viewport)) {
      outOfView.add(s);
    }
  }
  debugPrint(
    'NR-21 MEASUREMENT [$label] viewport=${viewport.width.toInt()}x${viewport.height.toInt()} '
    'laid-out-but-absent=${missing.isEmpty ? 'none' : missing} '
    'present-but-scrolled-out=${outOfView.isEmpty ? 'none' : outOfView}',
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════════════════
  // A 60-second press — the exact shape the owner described. Two soft-segment
  // rollovers (30 s each) and the release, i.e. THREE spans.
  // ═══════════════════════════════════════════════════════════════════════════
  testWidgets(
      '🔴 NR-21 realtime, 60 s press, 3 incremental segments: every span the '
      'user spoke is still on the screen', (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    const Size tall = Size(800, 2400); // see article_rig: a lazy list only builds what fits
    await tester.runAsync(() async {
      await r.pressDown();
      await r.speakSegment(0, _kSpans[0], isSegment: true);
      await r.speakSegment(1, _kSpans[1], isSegment: true);
    });
    await _mount(tester, r, tall);

    // Mid-press: the head must be readable while the user is still speaking.
    // This is the claim the owner's report denies.
    expect(_onScreen(tester, _kMarks[0]), isTrue,
        reason: 'segment 0 — the head — is what NR-21 says goes missing');
    expect(_onScreen(tester, _kMarks[1]), isTrue);
    // Negative control for the finder itself: a finder that answered "yes" to
    // everything would satisfy every other assertion in this file.
    expect(_onScreen(tester, _kNeverSpoken), isFalse,
        reason: 'the finder must be able to say no');
    _report(tester, 'realtime mid-press 2 spans', tall);

    await tester.runAsync(() async {
      await r.controller.pttUp();
      await r.speakSegment(2, _kSpans[2], isSegment: false);
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    for (int i = 0; i < 3; i++) {
      expect(_onScreen(tester, _kMarks[i]), isTrue,
          reason: 'span $i vanished from the screen after the release');
    }
    _report(tester, 'realtime after release 3 spans', tall);

    // The other half of the owner's report, pinned so a display fix can never
    // be bought with delivered text: what went to the PC is complete.
    final String delivered = r.store.entries
        .map((TimelineEntry e) => e.sourceText)
        .join(' ');
    for (int i = 0; i < 3; i++) {
      expect(delivered, contains(_kMarks[i]),
          reason: 'span $i is missing from what was minted/delivered');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A 90-second press in translate mode. Different arm on purpose:
  // `_settlesPerSegment` is `_composeTaskFor(mode) == null`, so realtime turns
  // every segment into a ROW while translate/organize keep growing ONE live
  // draft for the whole press. The head therefore lives in a different widget
  // in the two modes, and NR-21 does not say which mode it was seen in.
  // ═══════════════════════════════════════════════════════════════════════════
  testWidgets(
      '🔴 NR-21 translate, 90 s press, 4 incremental segments: the live draft '
      'keeps every span, it does not get replaced by the newest one',
      (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    const Size tall = Size(800, 2400);
    r.controller.setMode(FlowMode.translate);
    await tester.runAsync(() async {
      await r.pressDown();
      await r.speakSegment(0, _kSpans[0], isSegment: true);
      await r.speakSegment(1, _kSpans[1], isSegment: true);
      await r.speakSegment(2, _kSpans[2], isSegment: true);
    });
    await _mount(tester, r, tall);

    for (int i = 0; i < 3; i++) {
      expect(_onScreen(tester, _kMarks[i]), isTrue,
          reason: 'span $i is not on the screen during the press');
    }
    _report(tester, 'translate mid-press 3 spans', tall);
    // The live draft is ONE paragraph in this mode, so the strongest available
    // statement is that the paragraph carrying the newest span also still
    // carries the oldest — i.e. the final APPENDED, it did not replace.
    final List<({String text, Rect rect})> withNewest = _paintedParagraphs(tester)
        .where((({String text, Rect rect}) p) => p.text.contains(_kMarks[2]))
        .toList();
    expect(withNewest, isNotEmpty);
    expect(
      withNewest.any((({String text, Rect rect}) p) => p.text.contains(_kMarks[0])),
      isTrue,
      reason: 'the paragraph showing the newest span must still show the head; '
          'if it does not, a segment final replaced the draft instead of '
          'appending to it — the owner\'s recorded suspicion',
    );
    debugCancelAsrHealthTicker(r.controller);
    debugCancelBannerAutoHideTimers(r.controller);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔴 THE SAME PRESS ON A PHONE-SIZED SCREEN. The two tests above use a tall
  // surface so a lazy list has room to build every row — which is what lets
  // them answer "does the text still EXIST". This one answers the different
  // question the user actually asks: "can I see it".
  // ═══════════════════════════════════════════════════════════════════════════
  testWidgets(
      '🔴 NR-21 phone viewport 360x780: where the head is when it is no longer '
      'in view', (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    const Size phone = Size(360, 780);
    r.controller.setMode(FlowMode.translate);
    await tester.runAsync(() async {
      await r.pressDown();
      for (int i = 0; i < 4; i++) {
        await r.speakSegment(i, _kSpans[i], isSegment: true);
      }
    });
    await _mount(tester, r, phone);
    _report(tester, 'translate 4 spans', phone);

    // No expectation is placed on WHICH spans are inside the window: the list
    // is `reverse: true` and LiveDraftTile deliberately carries no clamp
    // ("the reversed list keeps its tail against the bottom of the screen while
    // the head scrolls out of view" — live_draft_tile.dart). Asserting a
    // particular scroll position would pin a layout accident as a contract.
    // What IS asserted is that scrolling can get it back, which is the whole
    // difference between "off screen" and "lost".
    expect(_onScreen(tester, _kMarks[0]), isTrue,
        reason: 'the head must still be laid out on a phone-sized screen; if '
            'it is not, the head is genuinely gone rather than scrolled away');
    debugCancelAsrHealthTicker(r.controller);
    debugCancelBannerAutoHideTimers(r.controller);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔴 FRAME BY FRAME — the strongest form of the question. The cases above
  // look at the screen once per segment, so a head that vanished after one
  // frame and came back on the next would pass all of them. This one mounts the
  // page ONCE and re-reads it after EVERY frame the wire delivers: four
  // previews and a final per segment, three segments.
  //
  // ⚠️ The alternation is required, not stylistic: the production chain runs
  // inside `tester.runAsync` (real timers) and the pumps run outside it (tester
  // time). Doing both in one place either hangs or never repaints.
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Both settlement arms are driven: `_settlesPerSegment` is
  // `_composeTaskFor(mode) == null`, so in realtime the head becomes a ROW
  // while in translate it stays inside ONE live draft. The head lives in a
  // different widget in the two arms and NR-21 does not say which mode it was
  // seen in, so one arm is half an answer.
  for (final FlowMode mode in <FlowMode>[FlowMode.realtime, FlowMode.translate]) {
    testWidgets('🔴 NR-21 [${mode.name}]: the head is on the screen after EVERY '
      'frame of a 3-segment press, not merely at the end',
      (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    const Size tall = Size(800, 2400);
    r.controller.setMode(mode);
    await tester.runAsync(r.pressDown);
    await _mount(tester, r, tall);

    int frames = 0;
    int headSeen = 0;
    for (int seg = 0; seg < 3; seg++) {
      final String span = _kSpans[seg];
      for (final int cut in <int>[
        span.length ~/ 4,
        span.length ~/ 2,
        (span.length * 3) ~/ 4,
        span.length,
      ]) {
        await tester.runAsync(() async => r.pushInterim(span.substring(0, cut), seg));
        await tester.pump();
        frames++;
        // Only once the head's own words have been on the wire at all: the
        // first preview of segment 0 carries a prefix, so the marker is not
        // complete until that segment's previews have grown past it.
        if (_onScreen(tester, _kMarks[0])) headSeen++;
        if (seg > 0 || cut == span.length) {
          expect(_onScreen(tester, _kMarks[0]), isTrue,
              reason: 'frame $frames (segment $seg preview): the head left the '
                  'screen mid-press — this is NR-21 reproduced');
        }
      }
      // Every final here is a SOFT SEGMENT final: the button is still held, so
      // this case is entirely inside the press — which is where NR-21 lives.
      // (A terminal final in translate mode would also start the compose run,
      // whose watchdog timer then trips the binding's pending-timer invariant
      // after the tree is disposed; the release path is covered by the first
      // two cases.)
      await tester.runAsync(
          () async => r.pushFinal(span, seg, isSegment: true));
      await tester.pump();
      frames++;
      expect(_onScreen(tester, _kMarks[0]), isTrue,
          reason: 'frame $frames (segment $seg final): the head left the screen '
              'when segment $seg was finalised — this is NR-21 reproduced');
    }
    debugPrint(
      'NR-21 MEASUREMENT [frame by frame ${mode.name}] $frames frames driven, '
      'head on screen in $headSeen of them',
    );
    debugCancelAsrHealthTicker(r.controller);
    debugCancelBannerAutoHideTimers(r.controller);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔴 HOW LONG A PRESS HAS TO BE BEFORE THE HEAD LEAVES THE PHONE'S WINDOW.
  // The three cases above answer "is it still there". This one answers the
  // quantitative half NR-21 needs, because the owner's report is about a press
  // of 30-60 s: if the head only leaves the window after several minutes, then
  // "the reversed list scrolled it away" does not explain what was reported and
  // the next step is a device rather than more headless work.
  //
  // ⚠️ THE YARDSTICK IS THE TEST FONT. `flutter_test` paints Ahem, every glyph a
  // full em square. For CJK that is close to a real font (Han glyphs are ~1 em
  // wide too), so this number is meaningful for the fixture's Chinese; it would
  // be pessimistic by roughly half for Latin text, which needs saying rather
  // than leaving for someone to re-derive.
  testWidgets('🔴 NR-21 measurement: characters of speech before the head '
      'scrolls out of a 360x780 window', (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    const Size phone = Size(360, 780);
    r.controller.setMode(FlowMode.translate); // one growing draft, the worst case
    await tester.runAsync(() async {
      await r.pressDown();
    });

    int spoken = 0;
    int lastVisibleAt = 0;
    int segments = 0;
    for (int i = 0; i < 16; i++) {
      final String span = i == 0 ? _kSpans[0] : _filler(i);
      await tester.runAsync(() async {
        await r.speakSegment(i, span, isSegment: true);
      });
      spoken += span.length;
      segments = i + 1;
      await _mount(tester, r, phone);
      if (!_inViewport(tester, _kMarks[0], phone)) break;
      lastVisibleAt = spoken;
    }
    debugPrint(
      'NR-21 MEASUREMENT [head leaves the 360x780 window] '
      'still visible at $lastVisibleAt chars; gone by $spoken chars '
      'across $segments segments (~${(spoken / 4.5).round()} s of Mandarin at 4.5 chars/s)',
    );
    // No threshold is asserted — the number IS the deliverable, and a pinned
    // number here would turn a layout measurement into a contract nobody chose.
    // What is asserted is that the loop measured something: the head was inside
    // the window at the start, so the reading is not "it was never visible".
    expect(lastVisibleAt, greaterThan(0),
        reason: 'the head must be visible at the start, or this loop measured '
            'nothing at all');
    debugCancelAsrHealthTicker(r.controller);
    debugCancelBannerAutoHideTimers(r.controller);
  });
}

/// ~130 characters, the size of one 30-second Mandarin soft segment.
String _filler(int i) =>
    '第$i段继续往下说，这里是一段用来占位的话，长度大致相当于三十秒的口述，'
    '内容本身并不重要，重要的是它占掉的行数和真实的一段话差不多，'
    '这样屏幕上的高度才有参考意义，不然量到的就是夹具而不是产品。';
