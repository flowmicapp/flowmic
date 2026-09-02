// Card B2-H (finding P1-3, session/chat_utterance.dart _deliverDirect) —
// A direct-send `inject:request` that never leaves the device must NOT settle
// the row as X `EntryStatus.failed` while the SAME request is still sitting
// `queued` in the outbox (it was persisted a few lines above the emit,
// BEFORE the emit is attempted -- design draft section 3.1 / RV-60). Owner
// ruling 10 (docs/rebuild/15 section 2.0.1-c, "I choose undelivered") makes
// `EntryStatus.failed` render as undelivered and says the row's own status
// IS its own verdict -- this test does not touch that rendering rule. It
// proves the SOURCE bug: before this card, a wire failure fail-settled the
// row through `ManualDelivery.failSettled` even though the outbox kept the
// very same request `queued` for its own next drain -- two doors settling
// one delivery, and the outbox's later success silently flipped the row from
// failed to injected with no user action in between (the "flips to injected
// later" symptom the finding names).
//
// SPEC-REF: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md
//   section 2.0.1-c; session/chat_utterance.dart _deliverDirect;
//   session/chat_outbox_host.dart outboxSend (the SAME emit-failure shape,
//   which never fail-settles either).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart' show ComposeSendFailure;
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// A transport that refuses ONE named event -- same shape as
/// typed_send_row_test.dart's `_FlakyTransport` -- so only the direct-send
/// `inject:request` fails while `audio:start`/`audio:stop` (also on this
/// transport) go through untouched.
class _FlakyTransport extends FakeSocketTransport {
  String? refuse;

  @override
  void emit(String event, Object? payload) {
    if (event == refuse) throw StateError('socket closed');
    super.emit(event, payload);
  }
}

class _Harness {
  late final _FlakyTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  _Harness() {
    transport = _FlakyTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // Real pairing (not just "connected") so the outbox item this test cares
    // about has a REDEEMABLE destination -- `_admit` only refuses at the
    // door for NO_DESTINATION, and this fixture must land on the "queue
    // holds it" branch, not the "outbox refused it too" one.
    giveSessionAPairedIdentity(session);
    store = newTestStore();
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
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  Future<void> speak(String text) async {
    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();
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
  test(
    'B2-H: a direct-send wire failure leaves a row the outbox still holds '
    'at cached (delivering) -- never failed -- and diags the wire miss '
    'instead of raising a fail-settle',
    () async {
      final _Harness h = _Harness();
      h.connect();
      DiagLog.instance.clear();

      // The utterance's OWN inject:request is the one frame this fixture
      // refuses; audio:start / audio:stop go through untouched.
      h.transport.refuse = FlowMicEvents.injectRequest;
      await h.speak('this sentence cannot leave the device but is still queued');

      expect(h.store.entries, hasLength(1));
      final TimelineEntry row = h.store.entries.single;

      // POSITIVE CONTROL -- the outbox really did keep the request: this is
      // what makes the "queue still owes it" branch the one under test.
      expect(
        h.controller.outbox.queuedEntryIds.contains(row.id),
        isTrue,
        reason: 'positive control: the outbox must actually hold this row, '
            'or the assertion below proves nothing about the queued branch',
      );

      // THE FIX: the row must NOT have been fail-settled. Its status stays
      // whatever the direct-send path born it as (cached, awaiting a
      // verdict) rather than a status the outbox's own later retry would
      // then have to silently reverse.
      expect(
        row.status,
        isNot(EntryStatus.failed),
        reason: 'a wire failure the outbox is about to retry must not '
            'fail-settle the row -- that duplicates the outbox\'s own '
            'verdict through a second door',
      );
      expect(row.status, EntryStatus.cached);

      // The failure is still on the record -- diag'd, not silent.
      final List<String> trail = DiagLog.instance.snapshot();
      expect(
        trail.any(
          (String l) => l.contains('utterance.direct_send_wire_failed_queued'),
        ),
        isTrue,
        reason: 'no silent failure: the wire miss must be diag\'d even when '
            'the row itself is left alone',
      );

      await h.dispose();
    },
  );

  test(
    'B2-H reverse control: fail-settling the same row the way the old '
    '_deliverDirect did (unconditionally, on any wire miss) DOES paint it '
    'failed -- proving the assertions above are not vacuously true',
    () async {
      final _Harness h = _Harness();
      h.connect();

      h.transport.refuse = FlowMicEvents.injectRequest;
      await h.speak('this sentence cannot leave the device but is still queued');
      final TimelineEntry row = h.store.entries.single;

      // Re-run the PRE-FIX behaviour directly against the same row+outbox
      // state this test just produced (this is the old _deliverDirect's own
      // unconditional call, exercised without hand-editing production
      // source, per the common contract's reverse-control note).
      h.controller.delivery.failSettled(
        <String>[row.id],
        ComposeSendFailure.wireFailed,
      );

      expect(
        h.store.entries.single.status,
        EntryStatus.failed,
        reason: 'seen red: this is exactly the shape the old _deliverDirect '
            'produced by calling failSettled unconditionally on a queued '
            'wire miss',
      );

      await h.dispose();
    },
  );
}
