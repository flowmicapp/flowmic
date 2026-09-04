// 🔴 Card D-2 → D7 ③ (2026-09-03) — WHICH ROW A LATE `stt:refined` IS ALLOWED TO REWRITE.
//
// Source: owner ruling Q2 b (docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md)
// and design D7 (docs/strategy/2026-09-03-phone-owned-settings-design-and-task-book.md):
// `stt:final` and `stt:refined` both carry a server-minted `utterance_id`; the
// phone stores it on the row the terminal final builds and matches a refine on
// THAT KEY ALONE. The temporal guess card D-2 had to keep (「the newest row must
// be the row my last utterance built」) is gone, and so is its blast radius: a
// refine for an utterance that is no longer on top now lands on the right row
// instead of being dropped, and a refine that names no utterance is dropped at
// the wire (ptt_inbound.dart) instead of being aimed at whatever is on top.
//
// WHAT THIS FILE PINS. `TimelineStore.buildFromUtterance` has five callers and
// only ONE of them is speech; the other four (a picture, a light-record picture,
// a typed note, a saved-phrase tap) never carry an utterance id, so no refine can
// name them — but every case still seeds a SPOKEN row first and puts the
// non-speech row ON TOP, because the defect this file guards against is 「the
// newest row absorbed it」, and a suite where nothing was ever said cannot
// reach that defect.
//
// The assertions are `refinedAt` AND the text. `refinedAt` is the sharper one:
// `TimelineStore.applyRefined` stamps it unconditionally, so a null stamp proves
// the write never ran.
//
// Plain `test()`, not testWidgets: the PTT chain is genuinely async and awaiting
// it inside a FakeAsync zone deadlocks (a scar this repo already wears).
//
// ── reverse controls measured red 2026-09-03 (restored; grep in lib/ = 0) ───
// A. In `_applyRefined`, replace the id filter with 「the newest row」
//    (`c.store.entries.first`, D-2's old shape, all other guards kept) ⇒
//    「a refine for an utterance that is no longer on top still lands on ITS
//    row」 goes red (the picture on top absorbed it: Expected '这是我说的那一句，
//    第二遍更准的版本' Actual '🖼 PNG · 77 B' on the spoken row, and the picture's
//    caption was overwritten) — the exact defect D-2 was written against.
// B. In `ptt_inbound.dart`, forward a frame WITHOUT `utterance_id` using the
//    spoken row's id as a stand-in ⇒ 「a frame without an id is DROPPED」 goes
//    red (the spoken row was refined).
// The three speech-with-id cases stayed green through both runs — the half of
// the control that separates 「the fix selects the right row」 from 「the fix
// turned GA-14 off」.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/image_payload.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading, ServerChannel;
import 'package:flowmic/src/session/session_instance_owner.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The same real 2×2 RGBA PNG the rest of the image suite uses.
final Uint8List kPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
  'SUkJeJw9PL4AAAAASUVORK5CYII=',
);

const String kSpoken = '这是我说的那一句';
const String kRefined = '这是我说的那一句，第二遍更准的版本';
const String kUtt = 'utt-d7-0001';

class _FakePicker implements ImagePickerPort {
  _FakePicker(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

/// A REAL, connected, PAIRED session — `pcId` comes from a genuine `pair()` ack,
/// the production path (ManualDelivery refuses an unpaired fixture). The pairing
/// also seeds `session.scope.ownerIds`, the owner set `_applyRefined` checks a
/// row against — no test-only setter anywhere.
Future<PttSession> _pairedSession(FakeSocketTransport t) async {
  final PttSession session = newTestSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
  );
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  t.defaultAck = <String, Object?>{
    'token': 'tok-card-d7-abcdefghijklmnopqrstuvwxyz1',
    'pairing_id': 'pair-card-d7-1',
    'pc_id': 'pc-card-d7-0001',
    'pc_name': 'Card D7 Test PC',
  };
  final PairResult r = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://127.0.0.1:41883',
  );
  expect(r.ok, isTrue, reason: 'setup: pairing must succeed');
  t.defaultAck = <String, Object?>{'ok': true};
  await pumpEventQueue();
  return session;
}

class _Rig {
  _Rig._(this.transport, this.session, {bool recordOnly = false}) {
    // The REAL owner probe, as main.dart wires it: rows are born with the
    // instance they were spoken to, which is what the owner guard reads.
    store = newTestStore(owner: SessionInstanceOwner(session));
    destination = DestinationController(fixedRecordOnly: recordOnly);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
      imagePicker: _FakePicker(kPng),
    );
    session.serverChannel.value = ServerChannel.lan;
    transport.pushStatus(SocketStatus.connected);
  }

  static Future<_Rig> paired({bool recordOnly = false}) async {
    final FakeSocketTransport t = FakeSocketTransport()..connectSucceeds = true;
    return _Rig._(t, await _pairedSession(t), recordOnly: recordOnly);
  }

  final FakeSocketTransport transport;
  final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  /// Path ①: a real utterance — PTT down/up and a TERMINAL final carrying the
  /// server's utterance id (null = an old relay that strips it).
  Future<TimelineEntry> speak(String text, {String? utteranceId = kUtt}) async {
    expect(await controller.pttDown(), isTrue, reason: 'setup: PTT must arm');
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.92,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
      'utterance_id': ?utteranceId,
    });
    await pumpEventQueue();
    return store.entries.first;
  }

  /// The late second-pass transcript, through the production inbound arm
  /// (`ptt_inbound.dart` → `PttSession.refinedTexts` → `_onRefined`). No seam is
  /// poked: a test that called `_applyRefined` directly could not prove the
  /// stream is still wired.
  Future<void> refine(String text, {String? utteranceId = kUtt}) async {
    transport.pushIncoming(FlowMicEvents.sttRefined, <String, Object?>{
      'text': text,
      'utterance_id': ?utteranceId,
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

void expectUntouched(TimelineEntry? row, String text, {required String reason}) {
  expect(row, isNotNull, reason: '$reason (the row itself disappeared)');
  expect(row!.outputText, text, reason: reason);
  expect(row.refinedAt, isNull,
      reason: '$reason — `applyRefined` stamps refinedAt unconditionally, so a '
          'null stamp is proof the write never ran');
}

void main() {
  // ── the row carries the id it was settled from ────────────────────────────
  test('the terminal final\'s utterance_id is stored on the row it builds', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(spoken.utteranceId, kUtt);
    expect(rig.store.findById(spoken.id)!.utteranceId, kUtt,
        reason: 'and it survives the store (payload key, codec round-trip)');
    await rig.dispose();
  });

  // ── ① speech row named by id ⇒ replaced ───────────────────────────────────
  test('speech row named by the refine\'s utterance_id ⇒ replaced (GA-14 still does its job)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);

    await rig.refine(kRefined);

    final TimelineEntry? after = rig.store.findById(spoken.id);
    expect(after!.outputText, kRefined);
    expect(after.refinedAt, isNotNull);
    expect(after.edited, isFalse,
        reason: 'a second pass is a machine, not a person — the human-edited bit stays clear');
    await rig.dispose();
  });

  test('🔴 a refine for an utterance that is no longer on top still lands on ITS row '
      '(the improvement over card D-2), and the picture on top is untouched', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(await rig.controller.sendImage(), isNull, reason: 'setup: the picture really was sent');
    final TimelineEntry picture = rig.store.entries.first;
    expect(picture.isImage, isTrue, reason: 'setup: the picture is on top');
    final String label = picture.outputText;

    await rig.refine(kRefined);

    expect(rig.store.findById(spoken.id)!.outputText, kRefined,
        reason: 'the id names the spoken row wherever it is in the list');
    expectUntouched(rig.store.findById(picture.id), label,
        reason: 'the picture caption is a descriptor, and it carries no utterance id');
    await rig.dispose();
  });

  test('speech row the user has edited ⇒ must not overwrite (the pre-existing guard is not lost)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    rig.controller.editEntry(spoken, '我自己改过的话');

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(spoken.id), '我自己改过的话',
        reason: 'a machine opinion must not overwrite a person edit');
    await rig.dispose();
  });

  // ── the four non-speech rows: no id, never touched ────────────────────────
  test('record-only picture row on top ⇒ never touched; the spoken row underneath IS refined', () async {
    final _Rig rig = await _Rig.paired(recordOnly: true);
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(await rig.controller.sendImage(), isNull);
    final TimelineEntry picture = rig.store.entries.first;
    expect(picture.delivery, Delivery.none, reason: 'setup: light-record');
    final String label = picture.outputText;

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(picture.id), label, reason: 'no utterance id on a picture');
    expect(rig.store.findById(spoken.id)!.outputText, kRefined);
    await rig.dispose();
  });

  test('typed-note row on top ⇒ never touched (the user typed these words)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    rig.controller.setBuffer('我自己打的字');
    expect(await rig.controller.sendBuffer(), isNull, reason: 'setup: the typed send really went out');
    final TimelineEntry typed = rig.store.entries.first;
    expect(typed.outputText, '我自己打的字');
    expect(typed.utteranceId, isNull, reason: 'a typed note has no utterance behind it');

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(typed.id), '我自己打的字',
        reason: '🔴 these are words the user typed themselves — overwriting it is content loss');
    expect(rig.store.findById(spoken.id)!.outputText, kRefined);
    await rig.dispose();
  });

  test('saved-phrase row on top ⇒ never touched', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(await rig.controller.sendFavorite('稍等一下'), isNull);
    final TimelineEntry phrase = rig.store.entries.first;
    expect(phrase.utteranceId, isNull);

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(phrase.id), '稍等一下',
        reason: 'a 「transcript」 nobody transcribed carries no id and cannot be named');
    expect(rig.store.findById(spoken.id)!.outputText, kRefined);
    await rig.dispose();
  });

  // ── the id is the ONLY key ────────────────────────────────────────────────
  test('🔴 a frame without an utterance_id is DROPPED at the wire — even with a spoken '
      'row on top, nothing is guessed by recency', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(rig.store.entries.first.id, spoken.id, reason: 'setup: the spoken row IS the newest');

    await rig.refine(kRefined, utteranceId: null);

    expectUntouched(rig.store.findById(spoken.id), kSpoken,
        reason: 'no id ⇒ no refine; recency is not a correlation');
    await rig.dispose();
  });

  test('an id that names no row ⇒ nothing is touched', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);

    await rig.refine(kRefined, utteranceId: 'utt-somebody-else');

    expectUntouched(rig.store.findById(spoken.id), kSpoken, reason: 'wrong id');
    await rig.dispose();
  });

  test('an old relay that strips utterance_id from stt:final leaves a row with no id, '
      'and a later refine cannot reach it (the safe direction in design §2)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken, utteranceId: null);
    expect(spoken.utteranceId, isNull);

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(spoken.id), kSpoken, reason: 'no id on the row');
    await rig.dispose();
  });

  test('two segment rows sharing one utterance_id (a long realtime utterance) ⇒ '
      'the whole-utterance refine is dropped rather than written onto one segment', () async {
    final _Rig rig = await _Rig.paired();
    expect(await rig.controller.pttDown(), isTrue);
    await rig.controller.pttUp();
    rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '第一段', 'confidence': 0.9, 'language': 'zh',
      'segment_idx': 0, 'is_segment': true, 'duration_ms': 16000, 'utterance_id': kUtt,
    });
    await pumpEventQueue();
    rig.transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': '第二段', 'confidence': 0.9, 'language': 'zh',
      'segment_idx': 1, 'is_segment': false, 'duration_ms': 4000, 'utterance_id': kUtt,
    });
    await pumpEventQueue();
    final List<TimelineEntry> rows =
        rig.store.entries.where((TimelineEntry e) => e.utteranceId == kUtt).toList();
    expect(rows, hasLength(2), reason: 'setup: realtime settles per segment');

    await rig.refine('第一段 第二段 更准');

    for (final TimelineEntry r in rows) {
      expectUntouched(rig.store.findById(r.id), r.outputText,
          reason: 'a whole-utterance transcript has no segment boundary to split on');
    }
    await rig.dispose();
  });
}
