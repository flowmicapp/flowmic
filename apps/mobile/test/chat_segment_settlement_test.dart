// N1-B2 / REG-D1 / J5 — the segment as the settlement unit, and row duration
// back to the correct meaning.
//
// Contract: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-c
//   (one segment (segment_idx) ＝ one row; trigger edge ＝ every final; one
//   failure loses only that segment)
// Design: docs/strategy/2026-08-08-design-n1-long-recording.md §2.1 / §3 J4·J5·J7
//
// ── 🔴 Why this file walks the real chain the whole way (FakeSocketTransport →
//     PttSession → ptt_inbound → SegmentBuffer → ChatController) instead of
//     calling `_handleTerminalFinal` directly ──────────────────────────────
// The entire cause of REG-D1 sits **between layers**: the server changed the
// meaning of `duration_ms` from "the whole session" to "this segment", and the
// row-minting layer copied it as-is. A test that feeds `SttFinal` directly
// would stub out the `ptt_inbound` hop entirely (the only place duration is
// stored into SegmentBuffer), so it would measure "what we believe we passed"
// rather than "what the wire actually passed".
// Same-family lesson: M3's 15 adapter-layer unit tests "all green and
// impossible not to be green".
//
// ⚠️ Corpus-shape note: the soft-segment window ＝ 30 s
// (AUDIO_DEFAULTS.soft_segment_ms), so 「30000 + 30000 + 15000」 is the real
// three-frame shape of a 75-second recording on the wire; the last segment's
// 15000 is exactly the number REG-D1 would make the whole row report.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/portable/asset_inventory.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/portable_fakes.dart';

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    outboxStore = newTestOutboxStore();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // The queue can accept a delivery item only if there is a real destination
    // (`_hasRedeemableDestination`) — without it, enqueue returns null while
    // the row is still minted, and the test would read "row is right, queue is 0".
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    controller = ChatController(
      outboxStore: outboxStore,
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
  late final OutboxStore outboxStore;
  late final PttSession session;
  late final TimelineStore store;
  late final ChatController controller;

  Future<void> down() async {
    await controller.pttDown();
  }

  Future<void> up() async {
    await controller.pttUp();
  }

  /// One `stt:final` exactly as the orchestrator emits it: every final — soft
  /// segment AND terminal — carries `duration_ms` = "how long this segment is" since
  /// `24b75cc` (N1-B1).
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

  Future<void> pushInterim({required String text, required int idx}) async {
    transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': text,
      'confidence': 0.8,
      'language': 'zh',
      'segment_idx': idx,
    });
    await pumpEventQueue();
  }

  /// A 75-second recording: two soft-segment rollovers, then release.
  Future<void> speakThreeSegments() async {
    await down();
    await pushFinal(
        text: '第一段内容', idx: 0, isSegment: true, durationMs: 30000);
    await pushFinal(
        text: '第二段内容', idx: 1, isSegment: true, durationMs: 30000);
    await up();
    await pushFinal(
        text: '第三段内容', idx: 2, isSegment: false, durationMs: 15000);
  }

  Future<void> dispose() async {
    await controller.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

int _sumRowDurations(TimelineStore s) => s.entries
    .map((TimelineEntry e) => e.durationMs ?? 0)
    .fold(0, (int a, int b) => a + b);

void main() {
  // ══════════════════════════════════════════════════════════════════════════
  // Card B — REG-D1: row-level duration_ms back to the correct meaning
  // ══════════════════════════════════════════════════════════════════════════
  group('REG-D1 row duration', () {
    test(
      '🔴 whole-utterance settlement (translate): the row records Σ of each segment = the full 75000, not the last segment 15000',
      () async {
        final _Rig r = _Rig();
        r.controller.setMode(FlowMode.translate);
        await r.speakThreeSegments();

        // translate keeps whole-utterance settlement ⇒ exactly one row.
        expect(r.store.entries, hasLength(1));
        expect(
          r.store.entries.single.durationMs,
          75000,
          reason: 'this row covers three segments of audio, so its duration must '
              'be the sum of the three; 15000 is "the last segment" — exactly '
              'the number that was copied up after 24b75cc',
        );
        // Positive control: the text really is the three segments joined (not
        // only the last).
        expect(r.store.entries.single.sourceText, contains('第一段内容'));
        expect(r.store.entries.single.sourceText, contains('第三段内容'));
        await r.dispose();
      },
    );

    test('🔴 per-segment settlement (realtime): each row records only its own segment duration', () async {
      final _Rig r = _Rig();
      await r.speakThreeSegments();

      expect(r.store.entries, hasLength(3));
      // Whether store.entries is newest-first or oldest-first is not this case's
      // criterion, so assert on the duration set.
      expect(
        r.store.entries.map((TimelineEntry e) => e.durationMs).toList()..sort(),
        <int>[15000, 30000, 30000],
        reason: 'the three rows are 30s / 30s / 15s; any row reporting another '
            'row\'s duration is REG-D1',
      );
      await r.dispose();
    });

    test(
      '🔴 aggregate = sum of rows: the stats layer must not compute a second time (asset_inventory\'s real implementation)',
      () async {
        final _Rig r = _Rig();
        await r.speakThreeSegments();

        final AssetTally tally = await newTestInventory(
          rows: r.store.entries,
          images: newTestOutboxBlobs(),
        ).tally();
        expect(
          tally.durationMs,
          _sumRowDurations(r.store),
          reason: 'the only legitimate aggregate yardstick is "sum the rows" — computing '
              'it a second time is one question, two answers',
        );
        expect(
          tally.durationMs,
          75000,
          reason: 'a 75-second recording, however many rows it is minted into, '
              'must still total 75 seconds',
        );
        await r.dispose();
      },
    );

    test('each segment row\'s segments_count says "how many segments this row covers", not "how many segments this utterance had"',
        () async {
      final _Rig r = _Rig();
      await r.speakThreeSegments();
      expect(
        r.store.entries.map((TimelineEntry e) => e.segmentsCount).toSet(),
        <int>{1},
        reason: 'each of the three rows covers one segment; writing 3 would let '
            'the third row claim three segments of audio behind it',
      );
      await r.dispose();
    });

    test('zero-sample guard: a final with no duration_ms ⇒ the row writes NULL, not 0', () async {
      final _Rig r = _Rig();
      await r.down();
      await r.up();
      await r.pushFinal(
          text: '没有时长的一句', idx: 0, isSegment: false, durationMs: 0);
      expect(r.store.entries.single.durationMs, isNull);
      await r.dispose();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Card A — N1-B2: settlement trigger edge from "terminal-segment final" to
  // "every final" (realtime)
  // ══════════════════════════════════════════════════════════════════════════
  group('N1-B2 segment ＝ settlement unit', () {
    test('🔴 realtime: a segment final mints a row + enqueues on the spot, without waiting for release', () async {
      final _Rig r = _Rig();
      await r.down();
      await r.pushFinal(
          text: '第一段内容', idx: 0, isSegment: true, durationMs: 30000);

      expect(
        r.store.entries,
        hasLength(1),
        reason: 'this is the entire 15 册 §2.0-c card: the segment is the '
            'settlement unit, not the display unit',
      );
      expect(
        (await r.outboxStore.loadPending()).length,
        1,
        reason: 'minting a row without enqueueing = a record that can never be delivered',
      );
      // FSM is still RECORDING — a segment final does not close this utterance.
      expect(r.session.fsm.session, SessionState.recording);
      await r.dispose();
    });

    test('🔴 J4: one 75-second recording ⇒ 3 rows, 3 delivery items (the premise that one failure loses only one segment)',
        () async {
      final _Rig r = _Rig();
      await r.speakThreeSegments();
      expect(r.store.entries, hasLength(3));
      expect((await r.outboxStore.loadPending()).length, 3);
      // Each of the three rows has its own clientId — without it, the PC's
      // receipt cannot land back on the correct row.
      expect(
        r.store.entries.map((TimelineEntry e) => e.clientId).toSet(),
        hasLength(3),
      );
      await r.dispose();
    });

    test(
      '🔴 translate/organize keep whole-utterance settlement — a segment final must not mint even one row'
      ' (owner 2026-08-11 already ruled this terminal; UtteranceComposeController.start is strictly single-flight)',
      () async {
        for (final FlowMode m in <FlowMode>[
          FlowMode.translate,
          FlowMode.organize,
        ]) {
          final _Rig r = _Rig();
          r.controller.setMode(m);
          await r.down();
          await r.pushFinal(
              text: '第一段内容', idx: 0, isSegment: true, durationMs: 30000);
          expect(
            r.store.entries,
            isEmpty,
            reason: '$m: per-segment settlement would make every segment from '
                'the second onward take busy and fail ⇒ must not expand there',
          );
          await r.pushFinal(
              text: '第二段内容', idx: 1, isSegment: true, durationMs: 30000);
          expect(r.store.entries, isEmpty, reason: '$m: the second segment likewise does not settle');
          await r.up();
          await r.pushFinal(
              text: '第三段内容', idx: 2, isSegment: false, durationMs: 15000);
          expect(r.store.entries, hasLength(1), reason: '$m: only the terminal-segment final settles');
          await r.dispose();
        }
      },
    );

    test('🔴 a settled segment must not reappear in the 「转录中」 draft (the same words must not display twice)',
        () async {
      final _Rig r = _Rig();
      await r.down();
      await r.pushInterim(text: '第一段内容', idx: 0);
      expect(r.controller.liveText, '第一段内容');
      await r.pushFinal(
          text: '第一段内容', idx: 0, isSegment: true, durationMs: 30000);
      expect(
        r.controller.liveText,
        isEmpty,
        reason: 'it is already a row; showing it again in the draft is the '
            'same sentence appearing twice on screen',
      );
      await r.pushInterim(text: '第二段开头', idx: 1);
      expect(
        r.controller.liveText,
        '第二段开头',
        reason: 'the draft only answers "what has not settled yet" — including '
            'the first segment means joined read the wrong layer',
      );
      await r.dispose();
    });

    test(
      'an empty segment final does not mint a row and does not advance the watermark — its duration rides with the next row, not one second lost',
      () async {
        final _Rig r = _Rig();
        await r.down();
        // A silent segment: the server still sends a final, just with no words.
        await r.pushFinal(text: '', idx: 0, isSegment: true, durationMs: 30000);
        expect(r.store.entries, isEmpty);
        await r.up();
        await r.pushFinal(
            text: '真正说的那句', idx: 1, isSegment: false, durationMs: 5000);
        expect(r.store.entries, hasLength(1));
        expect(
          r.store.entries.single.durationMs,
          35000,
          reason: 'those 30 seconds of silence really were recorded; dropping '
              'them is the stats layer lying',
        );
        await r.dispose();
      },
    );

    test(
      '🔴 「没有听到语音」 is a sentence about the whole utterance: '
      'when a row has already been minted, an empty terminal-segment final must not report it again',
      () async {
        final _Rig r = _Rig();
        await r.down();
        await r.pushFinal(
            text: '真的说了话', idx: 0, isSegment: true, durationMs: 30000);
        expect(r.store.entries, hasLength(1));
        await r.up();
        await r.pushFinal(text: '', idx: 1, isSegment: false, durationMs: 800);
        expect(
          r.controller.sttStalled,
          isNull,
          reason: 'after 30 seconds of speech, releasing in a pause and telling '
              'the user 「没有听到语音」 is a lie',
        );
        await r.dispose();
      },
    );

    test('positive control: when not a single word was spoken, an empty terminal-segment final still reports loudly (the red line was not weakened)',
        () async {
      final _Rig r = _Rig();
      await r.down();
      await r.up();
      await r.pushFinal(text: '', idx: 0, isSegment: false, durationMs: 2000);
      expect(r.controller.sttStalled, const SttStall(SttStallReason.emptyTranscript));
      expect(r.store.entries, isEmpty);
      await r.dispose();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Card C — J5 segment idempotency
  // ══════════════════════════════════════════════════════════════════════════
  group('J5 segment idempotency', () {
    test('🔴 the same terminal-segment final arriving twice ⇒ only one row (P2 window measured this as 2)', () async {
      final _Rig r = _Rig();
      await r.down();
      await r.up();
      await r.pushFinal(
          text: '说过一次的话', idx: 0, isSegment: false, durationMs: 1200);
      expect(r.store.entries, hasLength(1));
      await r.pushFinal(
          text: '说过一次的话', idx: 0, isSegment: false, durationMs: 1200);
      expect(
        r.store.entries,
        hasLength(1),
        reason: 'a replayed final would mint a second row with the same words — '
            'SegmentBuffer.put guards "text", not "settlement"',
      );
      expect(
        (await r.outboxStore.loadPending()).length,
        1,
        reason: 'the second row does not exist ⇒ a second delivery item must not exist either',
      );
      await r.dispose();
    });

    test(
      '🔴 what is held down is "settlement", not "that frame": a duplicate terminal-segment final still drives the FSM out of PROCESSING',
      () async {
        final _Rig r = _Rig();
        await r.down();
        await r.up();
        expect(r.session.fsm.session, SessionState.processing);
        await r.pushFinal(
            text: '说过一次的话', idx: 0, isSegment: false, durationMs: 1200);
        expect(r.session.fsm.session, isNot(SessionState.processing));
        // Second pass: the guard is at the settlement layer; the `ptt_inbound`
        // hop was not changed by a single word.
        await r.pushFinal(
            text: '说过一次的话', idx: 0, isSegment: false, durationMs: 1200);
        expect(
          r.session.fsm.session,
          isNot(SessionState.processing),
          reason: 'the first-edition guard dropped the whole frame ⇒ FSM stuck '
              'in PROCESSING, PTT dead until GA-03\'s 15-second fallback ⇒ '
              'worse than minting one extra row',
        );
        await r.dispose();
      },
    );

    test('🔴 replaying an already-settled segment final ⇒ no second row', () async {
      final _Rig r = _Rig();
      await r.down();
      await r.pushFinal(
          text: '第一段内容', idx: 0, isSegment: true, durationMs: 30000);
      await r.pushFinal(
          text: '第二段内容', idx: 1, isSegment: true, durationMs: 30000);
      expect(r.store.entries, hasLength(2));
      // The reconnect ladder replays an old segment.
      await r.pushFinal(
          text: '第一段内容', idx: 0, isSegment: true, durationMs: 30000);
      expect(r.store.entries, hasLength(2));
      // And must not pull the watermark back (monotonic) — otherwise the next
      // segment would be judged a replay and swallowed.
      await r.up();
      await r.pushFinal(
          text: '第三段内容', idx: 2, isSegment: false, durationMs: 15000);
      expect(
        r.store.entries,
        hasLength(3),
        reason: 'if the watermark is pulled back by a replay, a genuine new '
            'segment is silently swallowed as a replay — content loss',
      );
      await r.dispose();
    });

    test(
      'FB-6 shape: release lands inside a rollover flush ⇒ the segment final and the terminal-segment final share one segment number, '
      'must not swallow a row because of that, and must not mint an extra row because of that',
      () async {
        final _Rig r = _Rig();
        await r.down();
        await r.pushFinal(
            text: '这一段的内容', idx: 0, isSegment: true, durationMs: 30000);
        expect(r.store.entries, hasLength(1));
        await r.up();
        // Terminal-segment final on the same segment number: this segment has
        // already settled.
        await r.pushFinal(
            text: '这一段的内容', idx: 0, isSegment: false, durationMs: 30000);
        expect(
          r.store.entries,
          hasLength(1),
          reason: 'SegmentBuffer has already locked this slot, the words it '
              'carries cannot come in; minting another row is saying the same '
              'segment twice',
        );
        expect(r.session.fsm.session, isNot(SessionState.processing));
        await r.dispose();
      },
    );

    test('every utterance restarts from watermark −1 (clear is the only reset point)', () async {
      final _Rig r = _Rig();
      await r.down();
      await r.up();
      await r.pushFinal(
          text: '第一句', idx: 0, isSegment: false, durationMs: 1000);
      r.session.fsm.onJustDoneTimeout();
      // Second utterance: the server rebuilds the orchestrator ⇒ segment
      // numbers reset to zero.
      await r.down();
      await r.up();
      await r.pushFinal(
          text: '第二句', idx: 0, isSegment: false, durationMs: 1000);
      expect(
        r.store.entries,
        hasLength(2),
        reason: 'if the watermark did not reset with audio:start, the second '
            'utterance would be swallowed whole',
      );
      await r.dispose();
    });
  });
}
