// Cards CR-7 (「一篇」/ the article) and CR-8 (its in-article timeline).
//
// 🔴 WALKS THE REAL CHAIN, for the reason chat_segment_settlement_test.dart
// already writes down: everything interesting here sits BETWEEN layers. The
// scribe opens on the session, the clock advances in the settle path, and the
// head is written by the store — a test that called the model directly would
// measure what this file believes it passes, not what the chain passes.
//
// What is asserted, in the order the defects would appear:
//   ① every segment of one recording carries ONE article id, with offsets that
//      are the running sum of the segments before it (C2/C5, the live half);
//   ② the head is derived, lazily, and from the recording's own start;
//   ③ an ordinary push-to-talk utterance is untouched (C7, and the reverse
//      control for ①: a stamp that fell out of the scribe would land here);
//   ④ the offline seam — a stretch recorded with the link down is accounted for
//      in BYTES the moment it ends, so the live rows after it are not early by
//      the length of the outage (C5, the half no row can prove on its own).

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/audio/ring_buffer.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/article.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      // Record-only: continuous recording only exists where nothing is
      // delivered (ruling ⑨), so this is the destination it really runs under.
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

  Future<void> pushFinal({
    required String text,
    required int idx,
    required bool isSegment,
    required int durationMs,
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

  /// Start a continuous recording the way the entry does: open the scribe and
  /// arm the ceiling FIRST, then press.
  Future<String> startContinuous() async {
    final String id = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    );
    await controller.pttDown();
    return id;
  }

  List<TimelineEntry> membersOf(String articleId) =>
      articleMembersOf(store, articleId);

  TimelineEntry? headOf(String articleId) {
    for (final TimelineEntry e in articleHeadsOf(store)) {
      if (e.articleId == articleId) return e;
    }
    return null;
  }

  Future<void> dispose() async {
    await controller.dispose();
    store.dispose();
    await session.dispose();
  }
}

void main() {
  // ── ① and ② ───────────────────────────────────────────────────────────────

  test('one recording, one article: ids match and offsets are the running sum',
      () async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);

    final String articleId = await r.startContinuous();
    await r.pushFinal(text: '第一段', idx: 0, isSegment: true, durationMs: 30000);
    await r.pushFinal(text: '第二段', idx: 1, isSegment: true, durationMs: 30000);
    await r.controller.pttUp();
    await r.pushFinal(text: '第三段', idx: 2, isSegment: false, durationMs: 15000);

    final List<TimelineEntry> rows = r.membersOf(articleId);
    expect(rows, hasLength(3));
    expect(rows.map((TimelineEntry e) => e.displayText).toList(),
        <String>['第一段', '第二段', '第三段']);
    // 🔴 THE OFFSETS. Each row starts where the ones before it ended — audio
    // time, from the article's first byte. Not arrival time, which on this fake
    // transport would be three values microseconds apart.
    expect(rows.map((TimelineEntry e) => e.articleOffsetMs).toList(),
        <int>[0, 30000, 60000]);
    expect(rows.every((TimelineEntry e) => e.articleId == articleId), isTrue);
    expect(rows.every((TimelineEntry e) => e.isInArticle), isTrue);
  });

  test('the head is derived from the members, and starts when the button did',
      () async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);

    final DateTime before = DateTime.now().toUtc();
    final String articleId = await r.startContinuous();
    // No head yet: nothing has been said, so there is nothing to be the cover of.
    expect(r.headOf(articleId), isNull,
        reason: 'a recording nobody spoke into must leave nothing behind');

    await r.pushFinal(
        text: '会议开始，我们先过一下上周的进度', idx: 0, isSegment: true, durationMs: 12000);
    await r.pushFinal(text: '第二件事', idx: 1, isSegment: true, durationMs: 8000);
    await r.controller.pttUp();
    await r.pushFinal(text: '就这样', idx: 2, isSegment: false, durationMs: 5000);

    final TimelineEntry head = r.headOf(articleId)!;
    expect(head.isArticle, isTrue);
    expect(head.isInArticle, isFalse, reason: 'a cover is not one of its own pages');
    expect(head.segmentsCount, 3);
    // Σ of the members, not (ended − started): a recording that spent time
    // backgrounded produced no audio for it.
    expect(head.durationMs, 12000 + 8000 + 5000);
    expect(head.outputText, ArticleSummary.titleFrom('会议开始，我们先过一下上周的进度'));
    // 🔴 The recording's own start. The head is minted on the FIRST SEGMENT,
    // which is seconds later; stamping `now` would file it under the moment its
    // first sentence finished.
    expect(head.createdAt.isBefore(before.add(const Duration(seconds: 2))), isTrue);
    // It is a light record like its members, or it would vanish from the list
    // it exists to appear in.
    expect(head.origin, 'cloud');
    expect(head.status, EntryStatus.noted);
    // No words of its own — nothing may re-deliver or re-type a cover.
    expect(head.sourceText, isNull);
  });

  // ── ③ the reverse control ─────────────────────────────────────────────────

  test('reverse control: an ordinary utterance is stamped with nothing', () async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);

    // No startContinuous — this is push-to-talk, the way it has always worked.
    await r.controller.pttDown();
    await r.controller.pttUp();
    await r.pushFinal(text: '随口一句', idx: 0, isSegment: false, durationMs: 4000);

    final TimelineEntry row = r.store.entries.single;
    expect(row.displayText, '随口一句');
    // 🔴 If the scribe ever leaked past its recording, THIS is where it shows:
    // an ordinary sentence, spoken later, appearing inside somebody's meeting.
    expect(row.articleId, isNull);
    expect(row.articleOffsetMs, isNull);
    expect(articleHeadsOf(r.store), isEmpty);
  });

  test('the scribe closes with the recording, so the next sentence is free',
      () async {
    final _Rig r = _Rig();
    addTearDown(r.dispose);

    final String articleId = await r.startContinuous();
    await r.controller.pttUp();
    await r.pushFinal(text: '录音里的一句', idx: 0, isSegment: false, durationMs: 3000);
    expect(r.membersOf(articleId), hasLength(1));

    // …hours later, an ordinary press.
    await r.controller.pttDown();
    await r.controller.pttUp();
    await r.pushFinal(text: '后来随口说的', idx: 0, isSegment: false, durationMs: 2000);

    expect(r.membersOf(articleId), hasLength(1),
        reason: 'the later sentence must not have joined the finished recording');
    final TimelineEntry later = r.store.entries.first;
    expect(later.displayText, '后来随口说的');
    expect(later.articleId, isNull);
  });

  _identityGroup();

  // ── ④ the offline seam (C5) ───────────────────────────────────────────────

  group('CR-8 the two sources meet at the seam', () {
    test('bytes ÷ 32,000 is a measurement, and it lines up with durations', () {
      final ArticleClock c =
          ArticleClock(articleId: 'a0-1', startedAt: DateTime.utc(2026, 8, 30));
      expect(c.claim(30000), 0);
      expect(c.accountedMs, 30000);

      // The link died here. 45 seconds of PCM16/16k/mono were retained.
      const int fortyFiveSeconds = 45 * kPcmBytesPerSecond;
      expect(c.accountOfflineBytes(fortyFiveSeconds), 30000,
          reason: 'the outage starts where the last live segment ended');
      expect(c.accountedMs, 30000 + 45000);

      // 🔴 THE SEAM. The first live segment after the link returns must start
      // AFTER the outage, not on top of it. Without accountOfflineBytes this
      // would be 30000 — every row for the rest of the recording early by the
      // whole outage, and nothing on any row able to show it.
      expect(c.claim(10000), 75000);

      // And a backfilled row lands inside the stretch that was already paid for.
      expect(
        ArticleClock.offsetWithinStretch(stretchStartMs: 30000, withinMs: 20000),
        50000,
      );
    });

    test('a row whose engine reported no length claims a place and moves nothing',
        () {
      final ArticleClock c =
          ArticleClock(articleId: 'a0-1', startedAt: DateTime.utc(2026, 8, 30));
      expect(c.claim(5000), 0);
      // Null duration: it happened, and it happened HERE — but we do not know
      // how long it was, so advancing by a guess would push everything after it
      // wrong by the guess, compounding.
      expect(c.claim(null), 5000);
      expect(c.claim(0), 5000);
      expect(c.claim(3000), 5000);
      expect(c.accountedMs, 8000);
    });

    test('the byte arithmetic truncates and never runs ahead of its audio', () {
      expect(pcmBytesToMs(kPcmBytesPerSecond), 1000);
      expect(pcmBytesToMs(kPcmBytesPerSecond ~/ 2), 500);
      expect(pcmBytesToMs(0), 0);
      expect(pcmBytesToMs(-5), 0);
      // 31,999 bytes is 999.96 ms of audio. Rounding up would put the next
      // segment's timestamp ahead of the audio it points at.
      expect(pcmBytesToMs(kPcmBytesPerSecond - 1), 999);
    });
  });
}

// ── the identity seam: one string names the rows AND the bytes (CR-4 × CR-7) ──

void _identityGroup() {
  test('a continuous recording files its retained audio under its article id',
      () async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-article-id-');
    addTearDown(() {
      if (tmp.existsSync()) tmp.deleteSync(recursive: true);
    });
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final RetainedAudioSpill spill = RetainedAudioSpill(store: store);
    addTearDown(store.dispose);

    final FakeSocketTransport t = FakeSocketTransport();
    final PttSession session = newTestSession(
      transport: t,
      audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    addTearDown(session.dispose);

    final String runKey = spill.sessionKey;
    final String articleId = session.beginContinuous(
      cap: const Duration(minutes: 30),
      onWarning: () {},
    );

    // 🔴 THE SEAM. One string is the article the rows go into AND the key the
    // bytes go under, so the re-transcription channel can answer "which
    // recording do these belong to" without a second table — which is exactly
    // what §11-d concluded was missing (identity, not state).
    expect(spill.sessionKey, articleId);
    expect(spill.sessionKey, isNot(runKey),
        reason: 'positive control: it really moved off the per-run default');

    // Audio captured during the recording lands under that key.
    spill.noteUplinkDown();
    spill.onEvicted(BufferedChunk(seq: 0, tsMs: 0, payload: Uint8List(640)));
    await spill.flush();
    expect(await store.pendingSessions(), <String>[articleId]);
    expect(await store.bytesForSession(articleId), 640);

    // And the key rolls off it when the recording ends, so a later ordinary
    // press cannot append into this recording's audio.
    session.endContinuous();
    expect(spill.sessionKey, isNot(articleId));
  });
}
