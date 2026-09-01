// Work package 2, card 4, case A-3 — after catch-up transcription lands, the
// card updates.
//
// ── WHY THIS RIG DOES NOT REPLAY THROUGH REAL RETAINED-AUDIO FILES ──────────
//
// The full re-transcription channel — `RetainedAudioStore` on real disk,
// `RetainedAudioSpill`, `BackfillRunner`'s `audio:start`/`audio:chunk`/
// `audio:stop` wire framing — is already proven end to end, including this
// exact "the outage's words land inside the same piece" claim, by
// `backfill_channel_test.dart`'s C3/C4. This file is not re-proving that; it
// is proving a DIFFERENT thing, that the ARTICLE CARD on screen updates once
// a catch-up sentence lands — and it can reach that seam directly.
//
// 🔴 A first version of this file DID drive the full disk-backed channel
// under `testWidgets`, and it hung — measured, with debug prints bisecting
// it to inside `RetainedAudioStore.append`'s real directory listing
// (`Directory.list()`), even though every production call was wrapped in
// `tester.runAsync`. The SAME sequence, byte for byte, passes instantly under
// plain `test()` (`backfill_channel_test.dart` itself). That is a real,
// narrower hang than the general "wrap it in runAsync" rule covers, and
// chasing it further would have meant debugging `dart:io` under
// `AutomatedTestWidgetsFlutterBinding` rather than writing card 4 — so this
// file steps to one side of it instead: it drives the SAME production seam
// `BackfillRunner._replayOne` drives (`ArticleScribe.beginReplay` + the
// ordinary `stt:final` settle path, `chat_utterance_settle.dart`), without
// the disk store or the wire framing underneath it. That is real production
// code, not a test-only shortcut — `beginReplay`/`ArticleReplayTarget` are
// `ArticleScribe`'s own public seam, the same one `BackfillRunner` calls.
//
// 🔴 EVERY CASE MOUNTS THE REAL SCREEN (`ChatFlowPage` → `entriesForOwners`),
// never `ArticlePage` and never the model directly — see
// article_screen_test.dart's header for why that distinction is card 4
// itself.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/article_replay.dart' show ArticleReplayTarget;
// For the `pttUp()` extension (`ChatPttLifecycle`, a `part of` this library) —
// article_rig.dart already uses it internally, but a Dart extension needs its
// OWN import at the call site, not just at the library that defines the type.
import 'package:flowmic/src/session/chat_controller.dart';
// For `beginBackfill`/`endBackfill` (`PttSessionBackfill`, a `part of` this
// library — same reason as the `chat_controller.dart` import above).
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/ui/chat_article_tile.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/article_rig.dart';

Future<void> _mount(WidgetTester tester, ArticleRig r) =>
    mountLightRecordScreen(tester, r);

void main() {
  testWidgets(
      '🔴 A-3: after catch-up transcription lands, the SAME card updates — '
      'it does not stay stale and it does not explode into rows',
      (WidgetTester tester) async {
    final ArticleRig r = ArticleRig();
    addTearDown(r.dispose);

    late final String articleId;
    await tester.runAsync(() async {
      articleId = await r.startRecording();
      // 🔴 The SHAPE here — one mid-stream segment, `pttUp()`, then the
      // terminal segment — is not arbitrary: it is `ArticleRig
      // .recordThreeAndStop`'s own proven shape, trimmed to two real
      // segments. It matters because `is_segment:false` is what closes the
      // FSM's own utterance buffer back to rest; skipping it (a first draft
      // of this file pushed exactly one `is_segment:true` final and stopped)
      // left the session in `SessionState.processing` forever, and
      // `beginBackfill` below — the same gate a live press is judged by —
      // refuses to open on anything but rest.
      await r.say('先说第一件事', 0, isSegment: true); // ArticleRig.say: 30000ms.
      // 🔴 `pttUp()` ends the CONTINUOUS flag (so the card collapses — the
      // same edge C-1 in article_screen_test.dart pins) but deliberately
      // does NOT close the scribe (article_scribe.dart's own doc: "closed by
      // whatever is about to mint rows that must NOT be in the recording —
      // pttDown on an ordinary press, beginContinuous on the next recording,
      // and dispose"). So `session.articles.articleId` is STILL this
      // recording after this line — which is exactly what lets a catch-up
      // sentence land in it later, the same way a real backfill sweep does.
      await r.controller.pttUp();
      await r.say('这句收了尾', 1, isSegment: false);
    });

    // ── mount BEFORE the catch-up lands: the card already exists, and it
    // has not caught up yet. ──────────────────────────────────────────────
    await _mount(tester, r);

    expect(find.byType(ChatArticleTile), findsOneWidget,
        reason: 'the recording already ended; it must already be one card');
    expect(find.byType(ChatMessageTile), findsNothing);
    final ChatArticleTile cardBefore =
        tester.widget<ChatArticleTile>(find.byType(ChatArticleTile));
    final Finder metaFinder = find.byKey(
      ValueKey<String>('entry.article.meta.${cardBefore.entry.id}'),
    );
    final String metaBefore = tester.widget<Text>(metaFinder).data!;
    expect(cardBefore.entry.segmentsCount, 2,
        reason: 'setup error: nothing has caught up yet, so the head should '
            'carry only the two live segments');
    expect(r.session.articles.accountedMs, 60000, reason: 'setup error');

    // ── catch-up lands: the SAME seam `BackfillRunner._replayOne` drives —
    // open a replay cursor on this (still-open) article, then let an
    // ordinary `stt:final` settle through it. See the file header for why
    // this does not go through the disk-backed retention store. ───────────
    await tester.runAsync(() async {
      r.session.articles.beginReplay(
        ArticleReplayTarget(articleId: articleId, stretchStartMs: 60000),
      );
      // 🔴 `beginReplay` alone only tells the SCRIBE where a recovered row
      // belongs — it does not open anything at the FSM/wire layer, so an
      // `stt:final` pushed without this step is not "in flight" from the
      // session's point of view and is dropped before it ever reaches the
      // settle path (measured: without this call, `segmentsCount` stayed at
      // 2). `beginBackfill` is the SAME call `BackfillRunner._replayOne`
      // makes for this exact reason, and it is judged by the SAME
      // "is the session at rest" gate a live press is (measured: refused
      // outright while `fsm.session == SessionState.processing`, which is
      // exactly the state a missing terminal `is_segment:false` above would
      // leave it in — see that line's comment).
      final bool opened = r.session.beginBackfill(
        mode: FlowMode.realtime,
        sourceLang: 'zh',
      );
      expect(opened, isTrue, reason: 'setup error: beginBackfill refused');
      r.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        'text': '断网时补回来的一句',
        'confidence': 0.95,
        'language': 'zh',
        'segment_idx': 0,
        'is_segment': false,
        'duration_ms': 5000,
      });
      await pumpEventQueue();
      r.session.endBackfill();
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // 🔴 THE CLAIM. Still exactly one card — the recovered sentence must
    // collapse into the SAME card, not explode the finished recording back
    // into loose rows (the C-1/`liveArticleId` reverse control's failure
    // shape landing here instead — `liveArticleId` is null throughout this
    // case, since `continuous.isActive` is already false).
    expect(find.byType(ChatArticleTile), findsOneWidget,
        reason: '🔴 after catch-up, this must still be ONE card, not rows');
    expect(find.byType(ChatMessageTile), findsNothing,
        reason: '🔴 the recovered segment must not surface as a stray row '
            'beside the card it belongs to');
    final ChatArticleTile cardAfter =
        tester.widget<ChatArticleTile>(find.byType(ChatArticleTile));
    expect(cardAfter.entry.id, cardBefore.entry.id,
        reason: 'this must be an UPDATE of the same card, not a new one');
    expect(cardAfter.entry.segmentsCount, 3,
        reason: '🔴 the recovered sentence must be counted — the whole '
            'point of catch-up landing');
    expect(cardAfter.entry.durationMs, 60000 + 5000,
        reason: '🔴 duration must include the recovered segment\'s audio');
    // 🔴 THE RENDERED FACE. What must be proven is that the SAME KEYED
    // WIDGET shows a DIFFERENT string once catch-up lands, i.e. the card
    // actually repainted rather than the underlying entry silently changing
    // under a stale build.
    final String metaAfter = tester.widget<Text>(metaFinder).data!;
    expect(metaAfter, isNot(equals(metaBefore)),
        reason: '🔴 the card\'s own meta line must change on screen once '
            'catch-up lands — a card that keeps showing the pre-catch-up '
            'numbers has not "updated", whatever the model underneath says');
  });
}
