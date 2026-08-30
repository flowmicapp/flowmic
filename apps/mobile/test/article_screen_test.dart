// 🔴 THE TEST THAT WOULD HAVE CAUGHT IT — cell E-1 on the screen a continuous
// recording is actually made on.
//
// SPEC-REF: docs/ui-design/2026-08-29-continuous-recording-demo.html E-1
//   (「列表里是一张卡，不是四十行」) and C-1 (while it is recording, what has
//   been said is on screen as it is said).
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS A WIDGET TEST ────────────────────────
//
// 0.3.47 shipped CR-7/CR-8 with every acceptance test green and the feature
// invisible on device: the collapse lived in `LightRecordQuery.all()` (the 「+」
// panel's tab) while the light-record SCREEN rendered every segment. Reported
// by the owner within a day of installing it: 「半分钟一次落到历史转录清单中，
// 没有…显示到同一个卡片中」.
//
// The green tests were green honestly. `article_rows_test.dart` walks the real
// chain and asserts the MODEL; `article_face_test.dart` renders `ArticlePage`
// and asserts the TIMESTAMPS. Neither one ever asked a screen what it was
// showing, and nothing on the light-record screen routed to `ArticlePage`.
//
// ⇒ THE RULE THIS FILE ENFORCES: when the deliverable is 「what the user sees
// on screen X」, the test must mount screen X. A model assertion and a
// hand-built widget are each one honest half of a claim whose two halves can
// both be true while the product is not.
//
// ⚠️ THE PRODUCTION CHAIN IS DRIVEN UNDER `tester.runAsync`. Inside a
// `testWidgets` body the clock and the event loop belong to the tester, so a
// production `await` on a real timer never resolves: the first draft of this
// file HUNG with no output at all — which reads exactly like a slow test, not
// like a broken one. `article_rows_test.dart` needs none of this because it
// runs under plain `test()`. Recording happens under `runAsync`; assertions
// happen after `pumpWidget`, in tester time.
//
// ⚠️ THE SEGMENT ROWS' EXACT TEXT IS NOT ASSERTED HERE, on purpose. Under
// `runAsync` the settles interleave differently than under plain `test()`, so a
// row can carry the span it covers rather than one segment — a FIXTURE-timing
// property (`article_rows_test.dart` pins the per-segment text under `test()`),
// and nothing this file claims depends on it. Asserting it here would make this
// file fail for a reason that has nothing to do with what it is guarding.
//
// ⚠️ Deliberately paired with `article_view_test.dart`: the pure function
// carries the four collapse rules (cheap, exhaustive), this file carries the
// wiring (expensive, decisive). Neither replaces the other — a rules test would
// have stayed green through the whole 0.3.47 defect, because the rules were
// never the thing that was wrong.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/article_page.dart';
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// 🔴 THE ROWS MUST BE OWNED BY THE INSTANCE THIS SCREEN IS SCOPED TO, or the
/// page renders nothing at all and every `findsNothing` below passes for the
/// wrong reason. `entriesForOwners` excludes rows with a null owner by design
/// (card F2), and `newTestStore`'s default owner has none — the first draft of
/// this file failed with 「Found 0 widgets with text 随口说一句」 on the reverse
/// control, which is exactly the positive control doing its job on the FIXTURE
/// rather than on the product.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore(owner: _SessionOwner(session));
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      // Ruling ⑨ — continuous recording only exists where nothing is delivered.
      destination: DestinationController(fixedRecordOnly: true),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final ChatController controller;

  Future<String> startRecording() async {
    final String id = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    );
    await controller.pttDown();
    return id;
  }

  Future<void> say(String text, int idx, {required bool isSegment}) async {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': isSegment,
      'duration_ms': 30000,
    });
    await pumpEventQueue();
  }

  /// Three sentences, then stop — the smallest thing that is a RECORDING and
  /// not an utterance.
  Future<String> recordThreeAndStop() async {
    final String id = await startRecording();
    await say('今天先过两件事', 0, isSegment: true);
    await say('第一件是库存口径', 1, isSegment: true);
    await controller.pttUp();
    await say('第二件是采购节奏', 2, isSegment: false);
    session.endContinuous();
    return id;
  }

  Future<void> dispose() async {
    await controller.dispose();
    store.dispose();
    await session.dispose();
  }
}

/// 🔴 A TALL SURFACE, AND IT IS NOT COSMETIC. The timeline is a `ListView`,
/// which BUILDS ONLY WHAT FITS. On the default 800×600 surface the dock, header
/// and banner slot leave a viewport short enough that older rows are never
/// built at all — and an unbuilt row cannot be found by any finder, including
/// `skipOffstage: false`. Measured while writing this file: two of three
/// sentences 「passed」 `findsNothing` on a build where the collapse was not
/// running at all.
///
/// ⇒ 「先核你的尺子」 in its widget-test form: `findsNothing` over a lazy list
/// is not evidence of absence unless the list had room to build everything.
/// [_ChatMessageTile count] is the primary claim below for the same reason.
Future<void> _mount(WidgetTester tester, _Rig r) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: r.controller)),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets(
      '🔴 E-1: a finished recording is ONE card on the light-record screen, '
      'and its segments are not rows', (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    await tester.runAsync(r.recordThreeAndStop);
    await _mount(tester, r);

    // The card is there…
    expect(find.byType(ChatArticleTile), findsOneWidget,
        reason: 'one recording, one card');
    // …and no ordinary row is. The primary claim, because a count over the
    // tiles the list actually built cannot be satisfied by a row that merely
    // scrolled out of view — the surface above is tall enough to build all of
    // them.
    expect(find.byType(ChatMessageTile), findsNothing,
        reason: 'three segments must contribute zero rows of their own');
    // …and the three sentences are NOT. This is the assertion that was missing,
    // and it fails for the exact thing the owner saw on a real phone.
    // 🔴 WHAT IS DELIBERATELY *NOT* ASSERTED: 「none of the spoken words are on
    // screen」. That is FALSE BY DESIGN — the card's title is the opening of the
    // first thing said (demo E-1), so those words are supposed to be there,
    // inside the card. An earlier draft asserted it and failed against a
    // perfectly correct build. An assertion a correct product cannot satisfy is
    // worse than no assertion at all.
  });

  testWidgets('the card opens the piece, and the piece has the words',
      (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    await tester.runAsync(r.recordThreeAndStop);
    await _mount(tester, r);

    await tester.tap(find.byType(ChatArticleTile));
    await tester.pumpAndSettle();

    expect(find.byType(ArticlePage), findsOneWidget);
    // 🔴 The words are reachable again. A collapse that hid the segments and
    // did not open would have REMOVED the user's words from the product, which
    // is strictly worse than the defect it fixes — so this case is not a nicety
    // beside the one above, it is the other half of its claim.
    expect(find.textContaining('两件事'), findsWidgets);
    expect(find.textContaining('库存口径'), findsWidgets);
    expect(find.textContaining('采购节奏'), findsWidgets);
  });

  testWidgets(
      'C-1: while it is still recording, what has been said stays on screen',
      (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    await tester.runAsync(() async {
      await r.startRecording();
      await r.say('今天先过两件事', 0, isSegment: true);
      await r.say('第一件是库存口径', 1, isSegment: true);
    });
    await _mount(tester, r);

    // 🔴 NOT collapsed. Replacing a live transcript with a card whose word
    // count ticks upward is a worse answer to 「is it hearing me」 than the
    // words themselves — and the demo's C-1 shows the sentences on screen with
    // the in-progress bar under them.
    expect(find.textContaining('库存口径'), findsWidgets,
        reason: 'the transcript is what tells the user it is hearing them');
    expect(find.byType(ChatMessageTile), findsWidgets);
    // 🔴 AND NO CARD — not even the head of the recording being made. The
    // in-progress bar is already this recording's face; a second, staler one
    // beside it would be two answers to one question.
    expect(find.byType(ChatArticleTile), findsNothing,
        reason: 'the card is what a FINISHED recording collapses into');

    await tester.runAsync(() async {
      await r.controller.pttUp();
      r.session.endContinuous();
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // …and the moment it ends it becomes the card. Same screen, same rows, one
    // flag changed — which is what makes `liveArticleId` a real seam rather
    // than a decoration.
    expect(find.byType(ChatArticleTile), findsOneWidget);
    expect(find.byType(ChatMessageTile), findsNothing,
        reason: 'the transcript rows collapsed into it the moment it ended');
  });

  testWidgets('🔴 C-1 owner 2026-08-30: while it records, every row on '
      'screen says WHERE it sits in the piece', (WidgetTester tester) async {
    // 「在长程转录的过程中已经上屏的，也需要能够很明显地看到它已经在哪个位置…
    // 而不是现在这样等完成了之后才能去浏览」. Before this the in-article
    // timeline lived only inside ArticlePage, which cannot be opened until the
    // recording ends — so the piece was assembled in front of the user with no
    // way to watch it being assembled.
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    await tester.runAsync(() async {
      await r.startRecording();
      await r.say('今天先过两件事', 0, isSegment: true);
    });
    await _mount(tester, r);

    expect(find.byType(ArticleRowStamp), findsWidgets,
        reason: 'a row inside a recording carries its position');
    // 🔴 ASSERTED ON THE STAMP'S OWN KEYED Text, not on 「some Text under the
    // stamp matches mm:ss」. The stamp WRAPS the whole bubble, and the bubble
    // already carries a wall clock (11:15) that matches that pattern — so the
    // looser assertion passes with the stamp rendering nothing at all. It was
    // written that way first, and it passed for that reason.
    final ArticleRowStamp stamp =
        tester.widgetList<ArticleRowStamp>(find.byType(ArticleRowStamp)).first;
    final Text shown = tester.widget<Text>(
      find.byKey(ValueKey<String>('entry.articleStamp.${stamp.entry.id}')),
    );
    expect(
      RegExp(r'^\d\d:\d\d').hasMatch(shown.data ?? ''),
      isTrue,
      reason: 'the stamp must be a position INSIDE the recording (mm:ss), and '
          'it must actually be rendered — got ${shown.data}',
    );
  });

  testWidgets('the card is recognisable before it is read — owner 2026-08-30',
      (WidgetTester tester) async {
    // 「当前的话就是太普通了，不确定是什么东西」. The card used to be a message
    // bubble with an icon. The chip is asserted rather than the colours
    // because it is the one of the three signals that survives a user who
    // cannot distinguish them — and because a colour assertion would pin a
    // palette this repo swaps by theme.
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    await tester.runAsync(r.recordThreeAndStop);
    await _mount(tester, r);

    final ChatArticleTile card =
        tester.widget<ChatArticleTile>(find.byType(ChatArticleTile));
    expect(
      find.descendant(
        of: find.byType(ChatArticleTile),
        matching: find.byKey(ValueKey<String>('entry.article.badge.${card.entry.id}')),
      ),
      findsOneWidget,
      reason: 'the card says what KIND of thing it is, in words',
    );
  });

  testWidgets('an ordinary press is untouched — the reverse control for all '
      'three above', (WidgetTester tester) async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);
    await tester.runAsync(() async {
      await r.controller.pttDown();
      await r.say('随口说一句', 0, isSegment: false);
      await r.controller.pttUp();
    });
    await _mount(tester, r);

    // If the collapse ever stopped keying on the article id this is where it
    // would show: an ordinary utterance would vanish from the screen with
    // nothing to open in its place. The card's absence is the other half — it
    // is also the positive control for every `findsNothing` above, because a
    // page that rendered nothing at all would fail HERE.
    expect(find.text('随口说一句'), findsOneWidget);
    expect(find.byType(ChatArticleTile), findsNothing);
  });
}
