// W2.5 / FB-6 — the server's processed final is authoritative FOR ITS SLOT.
//
// 裁定: docs/decisions/2026-08-06-server-final-is-authoritative-over-phone-joined.md
// (read the 原地更正 block: the authority relationship holds per `segment_idx`,
// NOT over the whole terminal transcript).
//
// ── WHY THIS FILE EXISTS AND WHY IT IS DRIVEN FROM THE WIRE ──────────────────
// `SttFinal.text` was effectively DEAD CODE and all 1459 mobile tests were
// green. A buffer-level unit test cannot see that: the defect lived in the
// relationship between three collaborators (`ptt_inbound` writes the final into
// `SegmentBuffer`, `SegmentBuffer` merged it against the raw interims, and
// `chat_utterance` then read `joined` rather than the final). So every test in
// this file pushes REAL frames through `FakeSocketTransport` and asserts on the
// TIMELINE ROW the user actually sees.
//
// ── THE TWO RELATIONSHIP CLASSES ARE PINNED SEPARATELY, ON PURPOSE ───────────
// 第一负责人 2026-08-06:「判据不是修辞」. The defect on both ends of this product
// was ONE arbiter answering TWO different questions, so a test suite that only
// asserts "no words were dropped" would go green on a wrong-but-lossless implementation and
// prove nothing about which question is being answered.
//
//   REVISION  (same segment_idx): raw interim vs. processed final describe the
//             SAME span. The authoritative version REPLACES. A concatenation
//             here is a DEFECT (duplication), so the assertions in that group
//             are exact-equality and go red on a 「lossless concatenate」 build.
//   DISJOINT  (different segment_idx): different spans. BOTH survive; neither
//             may ever be dropped or replaced. Those assertions go red on the
//             naive 「prefer f.text」 build, which keeps only the last segment.
//
// A single 「the row contains the words」 assertion would pass under both a
// correct implementation and a wrong one, so there is no such assertion here.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// Same shape as `chat_controller_test.dart`'s `_SessionOwner` — rows are
/// stamped with the instance they were spoken to, and the chat view narrows on
/// that, so a harness without it would be testing the empty state.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Harness {
  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  _Harness() {
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
    );
    store = newTestStore(owner: _SessionOwner(session));
    destination = DestinationController();
    prefs = InMemoryLocalPrefs();
    gate = TimelineSyncGate(transport: transport);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: prefs,
      clock: () => DateTime.utc(2026, 8, 6, 9),
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  /// One `stt:interim` frame, exactly as the orchestrator emits it
  /// (`orchestrator-core.ts` `spawnEngine`'s `interim` handler stamps every
  /// frame with the CURRENT `currentSegmentIdx`).
  Future<void> interim(String text, {int idx = 0}) async {
    transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': text,
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': idx,
    });
    await pumpEventQueue();
  }

  /// One `stt:final` frame. `isSegment: true` is the soft-segment rollover
  /// final (`rolloverSegment` — segment N is closed and idx moves on);
  /// `isSegment: false` is the terminal final that closes the utterance.
  ///
  /// [emptyReason] is the additive `empty_reason` of card EMPTY-1, stamped by
  /// `apps/server-core/src/stt/empty-final-cause.ts`. Null is the pre-card
  /// shape AND the flush-cap fallback shape, so leaving it off is what the
  /// FALLBACK group below means by 「an empty final」.
  Future<void> finalFrame(
    String text, {
    int idx = 0,
    bool isSegment = false,
    String? emptyReason,
  }) async {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': idx,
      'is_segment': isSegment,
      'duration_ms': 1200,
      'empty_reason': ?emptyReason,
    });
    await pumpEventQueue();
  }

  /// Every `inject:request` this device put on the wire. The row is what the
  /// user sees on the phone; THIS is what lands in the PC's focused window,
  /// and drill B-7 is a defect about the second one.
  List<EventEnvelope> get injectFrames =>
      transport.emittedWhere(FlowMicEvents.injectRequest);

  String get rowText => store.entries.first.displayText;

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  // ──────────────────────────────────────────────────────────────────────────
  group('REVISION class — same segment_idx: the processed final REPLACES the '
      'raw interim accumulation', () {
    // 🔴 THE HEADLINE CASE. FB-6 requires the server to remove filler (口水话),
    // so a CORRECTLY processed final is SHORTER than the raw interims by
    // construction. Under the old `_mergeOverlap` the raw accumulation won every
    // time — which is why the whole server-side processing chain was invisible.
    //
    // Exact equality is the point: `contains` would also pass on a
    // concatenation, and a concatenation here is duplication, not safety.
    test('filler removed by the server survives to the row (overlap branch)',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('呃');
      await h.interim('呃 那个');
      await h.interim('呃 那个 我们明天上午开会');
      await h.controller.pttUp();
      // The server's terminal final for the SAME span, normalised.
      await h.finalFrame('我们明天上午开会');
      expect(h.store.entries.length, 1);
      expect(h.rowText, '我们明天上午开会');
      await h.dispose();
    });

    // The same defect through the OTHER branch. Here the processed text shares
    // no suffix/prefix with the raw accumulation at all, so the old code fell
    // through to `next.length > accum.length ? next : accum` — the 「取更长」
    // rule the 裁定 rejected as option 丙 — and discarded the shorter processed
    // final WHOLESALE. Note the dictionary correction 可以 → 可行 is also lost
    // under the old rule: the user reads their own filler back.
    test('a processed final that shares nothing with the interims still wins '
        '(the k=0 longest-wins branch)', () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('嗯 我 我觉得这个方案可以');
      await h.controller.pttUp();
      await h.finalFrame('我觉得这个方案可行');
      expect(h.rowText, '我觉得这个方案可行');
      await h.dispose();
    });

    // A processed final that is LONGER (punctuation added) must also land
    // verbatim — 「replace」 is not 「prefer the shorter one」, which would be
    // option 丙 with the sign flipped.
    test('punctuation the server added lands verbatim', () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('明天下午三点开会');
      await h.controller.pttUp();
      await h.finalFrame('明天下午三点开会。');
      expect(h.rowText, '明天下午三点开会。');
      await h.dispose();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  group('DISJOINT class — different segment_idx: every segment survives', () {
    // 🔴 THE TRAP THE 裁定'S 原地更正 BLOCK EXISTS FOR. `rolloverSegment()`
    // resets `offlineAccum`/`onlineDraft` and increments the segment index after
    // emitting segment N's soft final, so the TERMINAL final carries ONLY the
    // LAST segment. Implementing 「prefer f.text」 at the utterance level would
    // therefore delete every earlier segment of any recording longer than the
    // soft-segment window (30 s).
    //
    // 🔴 N1-B2 原地更正 (2026-08-08) —— these two cases in the group originally
    // asserted `entries.length == 1` and concatenated both segments into the
    // same row. **That cardinality has already been overturned by 15 册
    // §2.0-c** (one segment = one row), and it had never been written in any
    // contract, so the day it was overturned no document would go red — only
    // these two tests would. ⚠️ The **property this group guards did not
    // change a word**:
    // "different segment_idx are different spans; both segments must survive;
    // neither may be dropped or replaced".
    // What changed is only how many rows they land on; both keep
    // exact-equality assertions (this file's header expressly forbids a
    // "the row contains these words" style: it would go green on both a
    // correct implementation and a wrong one).
    //
    // This test goes RED on that naive build: it would produce only 第二部分…
    test('a soft-segment final and a later terminal final BOTH reach a row',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('第一部分', idx: 0);
      // Rollover: segment 0 is closed by its own processed final…
      await h.finalFrame('第一部分已经完成了', idx: 0, isSegment: true);
      // …and the engine restarts on segment 1.
      await h.interim('第二部分', idx: 1);
      await h.controller.pttUp();
      await h.finalFrame('第二部分正在进行', idx: 1);
      expect(h.store.entries.length, 2);
      expect(
        h.store.entries.map((TimelineEntry e) => e.displayText).toSet(),
        <String>{'第一部分已经完成了', '第二部分正在进行'},
        reason: 'each segment is its own row, each exact; naive 「prefer f.text」 would make the first segment '
            'not exist at all',
      );
      await h.dispose();
    });

    // The disjoint rule must hold when the processed finals are SHORTER than
    // the raw interims in both slots — i.e. the two classes composing. Neither
    // segment may be dropped, and neither may keep its filler.
    test('processing shortens BOTH segments and neither is dropped', () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('那个 预算是三百万', idx: 0);
      await h.finalFrame('预算是三百万。', idx: 0, isSegment: true);
      await h.interim('呃 工期是六个月', idx: 1);
      await h.controller.pttUp();
      await h.finalFrame('工期是六个月。', idx: 1);
      expect(
        h.store.entries.map((TimelineEntry e) => e.displayText).toSet(),
        <String>{'预算是三百万。', '工期是六个月。'},
        reason: 'both segments were processed (filler gone), and both segments are still there',
      );
      await h.dispose();
    });

    // 🔴 The cross-segment assembly trap **is still alive; it just moved
    // house**. After realtime makes each segment its own row, the wrong
    // implementation "prefer f.text at the whole-utterance level" is almost
    // invisible on realtime (each row's span is already only one segment).
    // The only place it still causes a **whole segment to vanish** is the
    // two modes that **settle the whole session**. Without this case, the
    // file-header claim "a naive build would keep only the last segment"
    // would from today on have no test that can falsify it.
    test('translate still settles the whole session ⇒ the cross-segment assembly trap holds there as-is', () async {
      final _Harness h = _Harness();
      h.connect();
      h.controller.setMode(FlowMode.translate);
      await h.controller.pttDown();
      await h.interim('第一部分', idx: 0);
      await h.finalFrame('第一部分已经完成了', idx: 0, isSegment: true);
      await h.interim('第二部分', idx: 1);
      await h.controller.pttUp();
      await h.finalFrame('第二部分正在进行', idx: 1);
      expect(h.store.entries.length, 1);
      expect(
        h.store.entries.single.sourceText,
        '第一部分已经完成了第二部分正在进行',
        reason: 'naive 「prefer f.text」 on this path would make the first segment vanish entirely',
      );
      await h.dispose();
    });
  });

  // ⚠️ The 「。 → newline joiner」 assertion was removed from the second case
  // above this round, because under realtime the two segments no longer land
  // on the same row and the seam is not produced at this layer at all. **The
  // seam rule itself did not lose coverage**: it is pinned directly on
  // `joined` by the W2.5-H group of `segment_buffer_test.dart`, and that
  // layer is independent of row-minting cardinality; the translate case
  // still walks the same assembly.

  // ──────────────────────────────────────────────────────────────────────────
  group('FALLBACK — the server final is absent or empty', () {
    // 裁定 §边界与验收:「服务端终稿为空/超时的兜底路径要有显式测试，证明它仍然工作」.
    //
    // This is a REAL path, not a defensive branch: the orchestrator's flush-cap
    // fallback emits `stt:final{text:''}` (see `flush-final.ts` `raceFlushFinal`
    // resolving with the empty `FinalResult`, and `orchestrator-core.ts`
    // `handleHardLimit`'s no-engine branch). The phone must keep what it heard.
    test('an empty terminal final keeps the accumulated interim text', () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('累积的在线文本');
      await h.controller.pttUp();
      await h.finalFrame('');
      expect(h.store.entries.length, 1);
      expect(h.rowText, '累积的在线文本');
      await h.dispose();
    });

    // Fallback must not resurrect an utterance that genuinely had no speech: with
    // nothing accumulated, an empty final is still the fail-loud empty
    // transcript (chat_controller_test pins the banner itself).
    test('an empty final with nothing accumulated still builds NO row',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.controller.pttUp();
      await h.finalFrame('');
      expect(h.store.entries, isEmpty);
      await h.dispose();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 🔴 SD-1 — A SILENT PRESS MUST NOT PUT A FULL STOP INTO THE PC.
  //
  // Frames taken VERBATIM from the device drill, not invented:
  // `.local/session-2026-09-06-durability-drill/pc-events.jsonl` lines 10/14/18
  // (tablet TB335ZC, 3 s press in a quiet room, standalone relay, 0.3.73):
  //   stt:interim   {"text":".","segment_idx":0}
  //   stt:final     {"text":"","segment_idx":0,"is_segment":false,
  //                  "empty_reason":"heard_no_words"}
  //   inject:request{"text":"."}          ← THE DEFECT
  //
  // ── 🔴 REVERSE CONTROLS, BOTH MEASURED RED (2026-09-06, this worktree) ──────
  // The two halves of the fix are pinned SEPARATELY because they are separately
  // load-bearing — with only (b) in place the drill sequence is already clean,
  // so a suite that measured them together would let (a) rot unnoticed.
  //   (a) delete `if (!sttTextHasContent(text)) return false;` from
  //       `SegmentBuffer.put` ⇒ 3 red, including
  //       「a punctuation-only interim is refused even with no empty_reason」
  //       `Expected: empty / Actual: [Instance of 'TimelineEntry']`.
  //   (b) delete `&& !emptyIsVerdict` from the same method ⇒ 2 red, including
  //       「an empty terminal final carrying empty_reason clears its own slot」
  //       `Expected: empty / Actual: [Instance of 'TimelineEntry']`.
  // Both restored; `grep -rn REVERSE-CONTROL-A|-B apps/mobile/lib` = 0 and the
  // full pair of files is green again.
  //
  // ⚠️ THE ASSERTION IS ON `inject:request`, NOT ONLY ON THE ROW. The row is
  // the phone's own record; the frame is what reaches somebody else's keyboard,
  // and only the frame can distinguish 「we kept it to ourselves」 from 「we typed
  // it into their editor」.
  group('SD-1 — a punctuation-only interim is not a transcript', () {
    test('the drill B-7 frame sequence mints no row and injects nothing',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('.');
      await h.controller.pttUp();
      await h.finalFrame('', emptyReason: 'heard_no_words');
      expect(h.store.entries, isEmpty);
      expect(h.injectFrames, isEmpty);
      await h.dispose();
    });

    // The same refusal, without leaning on `empty_reason`: fix (a) alone must
    // hold, because an older relay strips additive fields and the punctuation
    // would then be all the phone has.
    test('a punctuation-only interim is refused even with no empty_reason',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('。');
      await h.controller.pttUp();
      await h.finalFrame('');
      expect(h.store.entries, isEmpty);
      expect(h.injectFrames, isEmpty);
      await h.dispose();
    });

    // Fix (b) on its own: real words on screen, and then the server says the
    // recording had none. Its verdict wins FOR ITS OWN SLOT.
    test('an empty terminal final carrying empty_reason clears its own slot',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('嗯');
      await h.controller.pttUp();
      await h.finalFrame('', emptyReason: 'heard_no_words');
      expect(h.store.entries, isEmpty);
      expect(h.injectFrames, isEmpty);
      await h.dispose();
    });

    // 🔴 POSITIVE CONTROL — THE FB-6 CROSS-SEGMENT RULE IS UNTOUCHED. Segment 0
    // was closed with real words that exist NOWHERE BUT THIS DEVICE (the
    // terminal final carries the last segment only). A verdict about segment 1
    // may not reach back and delete them.
    test('an empty terminal final on a LATER segment keeps the earlier words',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('我们明天开会', idx: 0);
      await h.finalFrame('我们明天开会', idx: 0, isSegment: true);
      await h.interim('.', idx: 1);
      await h.controller.pttUp();
      await h.finalFrame('', idx: 1, emptyReason: 'heard_no_words');
      expect(h.store.entries.length, 1);
      expect(h.rowText, '我们明天开会');
      await h.dispose();
    });

    // A real word that HAPPENS to end in punctuation is content and must not be
    // caught by the content predicate — the reverse direction of fix (a).
    test('a one-character utterance with a full stop still reaches a row',
        () async {
      final _Harness h = _Harness();
      h.connect();
      await h.controller.pttDown();
      await h.interim('好。');
      await h.controller.pttUp();
      await h.finalFrame('好。');
      expect(h.store.entries.length, 1);
      expect(h.rowText, '好。');
      await h.dispose();
    });
  });
}
