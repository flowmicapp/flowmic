// 🔴 Card D-2 (2026-08-07) — WHICH ROW A LATE `stt:refined` IS ALLOWED TO REWRITE.
//
// Source: packages/protocol/src/protocol-schemas-compose.ts, the 2026-08-07
// correction block on `SttRefinedSchema` (「the phone's consumer applies this
// frame to the newest ROW in `store.entries`, unfiltered by entry type or owner
// … a late frame can overwrite a picture's label or text the user typed,
// persisted, unrecoverably」), and owner 2026-08-07 ruling ②「异步替换一定要切换」
// (docs/decisions/2026-08-07-owner-segment-polish-2s-budget-and-no-legacy-fleet.md)
// — this selection is the gate that ruling has to pass through.
//
// WHAT THIS FILE PINS THAT NOTHING ELSE DOES. `TimelineStore.buildFromUtterance`
// has five callers and only ONE of them is speech. The other four produce rows
// that are, field for field, indistinguishable from a spoken one: `entry_type`
// is 'transcript' for a typed note and a saved-phrase tap, `edited` is false (no human
// has touched them yet) and `processed_text` is null (no LLM ran). Both of the
// guards `_applyRefined` used to have are therefore OPEN on all four. So every
// case below SEEDS A SPOKEN ROW FIRST and then puts the non-speech row on top:
// without that seed the fix would pass for the wrong reason (nothing had ever
// been said, so there was no refine to place), and the defect it is about would
// not even be reachable.
//
// The assertions are `refinedAt` AND the text. `refinedAt` is the sharper one:
// `TimelineStore.applyRefined` stamps it unconditionally, so a null stamp proves
// the write never ran rather than that it ran and happened to produce the same
// string.
//
// Plain `test()`, not testWidgets: the PTT chain is genuinely async and awaiting
// it inside a FakeAsync zone deadlocks (a scar this repo already wears).
//
// ── reverse control measured red (marker REVERSE-CONTROL-D2, restored; grep in lib/ = 0) ───
// The two new guards in `_applyRefined` were commented out — i.e. the selection
// was put back to 「the newest row, edited/processedText only」 — and this file
// went 2 green / 5 RED, the reds being exactly the five rows nobody dictated:
//
//   发给 PC 的图片行  Expected: '🖼 PNG · 77 B'    Actual: '这是我说的那一句，第二遍更准的版本'
//   仅记录图片行      Expected: '🖼 PNG · 77 B'    Actual: '这是我说的那一句，第二遍更准的版本'
//   手打笔记行        Expected: '我自己打的字'      Actual: '这是我说的那一句，第二遍更准的版本'
//   常用语行          Expected: '稍等一下'          Actual: '这是我说的那一句，第二遍更准的版本'
//   一句话都没说过    Expected: '开场先打一行字'    Actual: '这是我说的那一句，第二遍更准的版本'
//
// The two SPEECH cases stayed green through the whole reverse run, and that is
// the half of the control that is easy to skip: it is what separates 「the fix
// selects the right row」 from 「the fix turned GA-14 off」, which would also have
// made all five reds go away.

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

class _FakePicker implements ImagePickerPort {
  _FakePicker(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

/// A REAL, connected, PAIRED session — `pcId` comes from a genuine `pair()` ack,
/// the production path. Not decoration: `ManualDelivery.deliverText` enqueues
/// before it emits, and the queue refuses an item it cannot address, so an
/// unpaired fixture turns every typed send into `noPcTarget` (manual_delivery
/// says so in the 17-reds note at its enqueue site). No test-only setter is
/// used — a backdoor would let this file pass on a value nothing populates.
Future<PttSession> _pairedSession(FakeSocketTransport t) async {
  final PttSession session = newTestSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
  );
  // RV-89: pin the channel probe, or the fixture reads whatever is listening on
  // the dev machine's port.
  session.healthReader = (Uri url, Duration timeout) async => HealthReading.offline;
  t.defaultAck = <String, Object?>{
    'token': 'tok-card-d2-abcdefghijklmnopqrstuvwxyz1',
    'pairing_id': 'pair-card-d2-1',
    'pc_id': 'pc-card-d2-0001',
    'pc_name': 'Card D-2 Test PC',
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
    store = newTestStore();
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
    // owner 2026-08-01 cloud image policy: the channel is read from `/api/health`,
    // which no test session answers, and `imagePickSpecFor` fails CLOSED to the
    // cloud tier on "unknown". Declared through the same notifier production
    // reads so the picture cases exercise the LAN path.
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

  /// Path ①: a real utterance — PTT down/up and a TERMINAL final, i.e. the one
  /// `buildFromUtterance` caller that speech reaches.
  Future<TimelineEntry> speak(String text) async {
    expect(await controller.pttDown(), isTrue, reason: 'setup: PTT must arm');
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.92,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 900,
    });
    await pumpEventQueue();
    return store.entries.first;
  }

  /// The late second-pass transcript, through the production inbound arm
  /// (`ptt_inbound.dart` → `PttSession.refinedTexts` → `_onRefined`). No seam is
  /// poked: a test that called `_applyRefined` directly could not prove the
  /// stream is still wired.
  Future<void> refine(String text) async {
    transport.pushIncoming(FlowMicEvents.sttRefined, <String, Object?>{
      'text': text,
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

/// 「this row was not touched」 — the text is byte-identical AND the adoption
/// stamp never landed.
void expectUntouched(TimelineEntry? row, String text, {required String reason}) {
  expect(row, isNotNull, reason: '$reason (the row itself disappeared)');
  expect(row!.outputText, text, reason: reason);
  expect(row.refinedAt, isNull,
      reason: '$reason — `applyRefined` stamps refinedAt unconditionally, so a '
          'null stamp is proof the write never ran');
}

void main() {
  // ── ① speech transcript row: the ONE row a refine is for ───────────────────
  test('speech transcript row ⇒ may be replaced (GA-14 still does its job)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(spoken.outputText, kSpoken, reason: 'setup: the utterance built a row');

    await rig.refine(kRefined);

    final TimelineEntry? after = rig.store.findById(spoken.id);
    expect(after!.outputText, kRefined,
        reason: 'the better transcript replaces the row it belongs to');
    expect(after.refinedAt, isNotNull);
    expect(after.edited, isFalse,
        reason: 'a second pass is a machine, not a person — the human-edited bit stays clear');
    await rig.dispose();
  });

  test('speech row the user has edited ⇒ must not overwrite (the pre-existing guard is not lost)',
      () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    rig.controller.editEntry(spoken, '我自己改过的话');

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(spoken.id), '我自己改过的话',
        reason: 'a machine opinion must not overwrite a person edit');
    await rig.dispose();
  });

  // ── ② picture row sent to the PC ───────────────────────────────────────────
  test('picture row sent to the PC ⇒ never touched', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(await rig.controller.sendImage(), isNull,
        reason: 'setup: the picture really was sent');
    final TimelineEntry picture = rig.store.entries.first;
    expect(picture.isImage, isTrue, reason: 'setup: the picture is on top');
    final String label = picture.outputText;

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(picture.id), label,
        reason: 'the picture caption is a descriptor not a dictation — refining it would edit a label');
    expectUntouched(rig.store.findById(spoken.id), kSpoken,
        reason: 'and the utterance underneath is no longer the newest row, so '
            'the refine is DROPPED rather than re-aimed (card D-2 keeps the '
            'temporal guard verbatim — there is no id to re-aim WITH)');
    await rig.dispose();
  });

  // ── ③ record-only picture row ─────────────────────────────────────────────
  test('record-only picture row ⇒ never touched', () async {
    final _Rig rig = await _Rig.paired(recordOnly: true);
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(await rig.controller.sendImage(), isNull);
    final TimelineEntry picture = rig.store.entries.first;
    expect(picture.isImage, isTrue);
    expect(picture.delivery, Delivery.none,
        reason: 'setup: light-record — this row never leaves the phone');
    final String label = picture.outputText;

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(picture.id), label,
        reason: 'a light-record picture is a descriptor too, and it has no PC to '
            'disagree with — the damage would be purely local and permanent');
    expectUntouched(rig.store.findById(spoken.id), kSpoken, reason: 'not newest');
    await rig.dispose();
  });

  // ── ④ typed-note row ───────────────────────────────────────────────────────
  test('typed-note row ⇒ never touched (the user typed these words)', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    rig.controller.setBuffer('我自己打的字');
    expect(await rig.controller.sendBuffer(), isNull,
        reason: 'setup: the typed send really went out');
    final TimelineEntry typed = rig.store.entries.first;
    expect(typed.outputText, '我自己打的字', reason: 'setup: D10 built its own row');

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(typed.id), '我自己打的字',
        reason: '🔴 these are words the user typed themselves — overwriting it is content loss, on disk, '
            'with no `edited` bit to show a human it happened');
    expectUntouched(rig.store.findById(spoken.id), kSpoken, reason: 'not newest');
    await rig.dispose();
  });

  // ── ⑤ saved-phrase row ─────────────────────────────────────────────────────
  test('saved-phrase row ⇒ never touched', () async {
    final _Rig rig = await _Rig.paired();
    final TimelineEntry spoken = await rig.speak(kSpoken);
    expect(await rig.controller.sendFavorite('稍等一下'), isNull,
        reason: 'setup: F-5 tap-to-send really delivered');
    final TimelineEntry phrase = rig.store.entries.first;
    expect(phrase.outputText, '稍等一下');

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(phrase.id), '稍等一下',
        reason: 'a saved phrase is the user\'s own words — same class as ④, and '
            'the reason `entry_type` could never have been the filter: this row '
            'is a 「transcript」 that nobody transcribed');
    expectUntouched(rig.store.findById(spoken.id), kSpoken, reason: 'not newest');
    await rig.dispose();
  });

  // ── the 「nothing was ever said」 leg ───────────────────────────────────────
  test('this session never spoke a word ⇒ refine has nowhere to land, must not pick a row', () async {
    final _Rig rig = await _Rig.paired();
    rig.controller.setBuffer('开场先打一行字');
    expect(await rig.controller.sendBuffer(), isNull);
    final TimelineEntry typed = rig.store.entries.single;

    await rig.refine(kRefined);

    expectUntouched(rig.store.findById(typed.id), '开场先打一行字',
        reason: 'a refine with no utterance behind it is about nothing; '
            'dropping beats guessing');
    await rig.dispose();
  });
}
