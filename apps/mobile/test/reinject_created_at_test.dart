// owner measured 2026-07-31:「在手机重发后，这个重发的消息是与上次的时间一样，反而没放在
// 最前面，这是不对的，应保持最前面，重发的要按重发的时间来记录」.
//
// TWO EVENTS SHARE ONE FIELD (`inject:request.created_at`), and this file exists
// to keep them apart:
//   ① active re-delivery (ManualDelivery.reInject) records THIS RE-DELIVERY ⇒ now. RV-72 made
//      a re-inject a NEW PC row (`row_id` = `req:{request_id}`, row_transit.rs), and
//      the desktop sorts `created_at` desc with `created_at` in FROZEN_ROW_FIELDS —
//      so a new row stamped with the OLD instant lands back under rows it postdates
//      and nothing downstream can repair it. That is exactly what owner saw.
//   ② first delivery records the SPEAKING ⇒ the row's own birth time. That is the entire
//      reason this field exists (owner:「不管时间多久，全部都要投递」— a three-day-old
//      utterance must not claim to be new), and it gets its own test here: a future
//      "casual unification" that made every path stamp `now` would pass ① and MUST fail ②.
//
// The rows are seeded OLD through persistence on purpose. A row built in-test is
// milliseconds old, so "is it reading the row or the clock" would be undecidable — the two answers
// have to be far apart for either assertion to mean anything.
//
// SPEC-REF: packages/protocol/src/protocol-schemas-inject.ts (created_at);
//   apps/desktop/src-tauri/src/socket/row_transit.rs (row_id / build_row);
//   apps/desktop/src/lib/timeline-store.ts (FROZEN_ROW_FIELDS, entries() sort).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Three days before the test runs — far enough that 「the row's time」 and 「now」
/// can never be confused for one another by a tolerance.
final DateTime kSpokenAt = DateTime.now().toUtc().subtract(
  const Duration(days: 3),
);
const String kOldClientId = 'old-utterance-1';
const String kOldRowId = 'loc_mobile_old-utterance-1';

/// A translate-mode row that was spoken three days ago and never landed — owner's exact
/// scenario (translate/organize two columns, hence `processMode` + a diverged face so the frame
/// also carries `source_text`).
TimelineEntry _oldRow() => TimelineEntry(
  id: kOldRowId,
  clientId: kOldClientId,
  mode: FlowMode.translate,
  delivery: Delivery.inject,
  sourceText: '三天前说的原文',
  outputText: 'what was said three days ago',
  processMode: 'translate',
  status: EntryStatus.failed,
  createdAt: kSpokenAt,
  updatedAt: kSpokenAt,
);

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    // 窗口B3-2c — identity, not the handshake. A queued delivery is addressed to a MACHINE,
    // so a fixture with a live socket but no pairing has no destination and every
    // send is correctly refused `noPcTarget` (owner:「未配对的…不可能自动发向PC
    // 的」). This stamps the identities through the PRODUCTION method; it dials
    // nothing and emits nothing, so no assertion about emitted frames moves.
    giveSessionAPairedIdentity(session);
    persistence = InMemoryTimelinePersistence();
    store = newTestStore(persistence: persistence);
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final InMemoryTimelinePersistence persistence;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  /// Seed the three-day-old row through STORAGE and read it back, so the row
  /// under test carries a genuinely old `created_at` (no test-only setter).
  Future<TimelineEntry> loadOldRow() async {
    await persistence.saveAll(<TimelineEntry>[_oldRow()]);
    await store.load();
    transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();
    final TimelineEntry? e = store.findById(kOldRowId);
    expect(e, isNotNull, reason: 'setup: the seeded row must load');
    expect(
      e!.createdAt.isAtSameMomentAs(kSpokenAt),
      isTrue,
      reason: 'setup: the seeded row must keep its spoken instant',
    );
    return e;
  }

  Map<String, Object?> soleInjectFrame() {
    final List<EventEnvelope> frames = transport.emittedWhere(
      FlowMicEvents.injectRequest,
    );
    expect(frames, hasLength(1));
    return Map<String, Object?>.from(frames.single.data! as Map);
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('① active re-delivery stamps THIS re-delivery: created_at is the moment of the '
      'resend, not the moment the words were spoken', () async {
    final _Harness h = _Harness();
    final TimelineEntry old = await h.loadOldRow();

    final DateTime before = DateTime.now().toUtc();
    h.controller.reInject(old);
    await pumpEventQueue();
    final DateTime after = DateTime.now().toUtc();

    final Map<String, Object?> frame = h.soleInjectFrame();
    expect(frame['source'], 'history', reason: 'this is the re-delivery path');
    final DateTime stamped = DateTime.parse(frame['created_at']! as String);
    // Bracketed by the call, not compared against a tolerance: the frame's
    // instant must lie inside the window the resend actually happened in.
    expect(stamped.isBefore(before), isFalse);
    expect(stamped.isAfter(after), isFalse);
    // And said the other way round, because THIS is the defect owner reported:
    // three days of distance between the two answers, and the frame must not
    // carry the old one.
    expect(
      stamped.isAtSameMomentAs(kSpokenAt),
      isFalse,
      reason: 'the resend must not inherit the utterance\'s birth time',
    );
    expect(stamped.difference(kSpokenAt) > const Duration(days: 2), isTrue);

    // NOTHING IS LOST — the phone's own row still carries the spoken instant, so
    // the fact only moves onto a SECOND (PC) row, it is never overwritten.
    expect(
      h.store.findById(kOldRowId)!.createdAt.isAtSameMomentAs(kSpokenAt),
      isTrue,
    );
    await h.dispose();
  });

  test('② first delivery keeps the SPOKEN time — the guard rail against a future '
      '"casual unification" that would make every path stamp now', () async {
    final _Harness h = _Harness();
    final TimelineEntry old = await h.loadOldRow();

    final DateTime before = DateTime.now().toUtc();
    // ➤ over a row that is still awaiting its FIRST delivery (manual policy: an
    // utterance sits in the buffer until the user presses Send, and nothing
    // obliges the user to press it the same day).
    final ComposeSendFailure? failure = await h.controller.delivery.deliverText(
      old.displayText,
      covered: <String>[old.id],
    );
    expect(failure, isNull, reason: 'setup: the send must reach the wire');

    final Map<String, Object?> frame = h.soleInjectFrame();
    expect(frame['source'], 'manual', reason: 'this is the ➤ path');
    final DateTime stamped = DateTime.parse(frame['created_at']! as String);
    expect(
      stamped.isAtSameMomentAs(kSpokenAt),
      isTrue,
      reason: 'a first delivery records the SPEAKING, however long it queued',
    );
    // Stated as an ordering too: the stamp is from BEFORE the send began, which
    // no clock reading at this call site could ever produce.
    expect(stamped.isBefore(before), isTrue);
    await h.dispose();
  });
}
