// Card F4 — over-length text must be refused **on this device**, right there,
// not die at the protocol boundary.
//
// Source: `docs/strategy/2026-08-12-req1209-plus-panel-design.md` §9-3 item 1
// (the debt REQ-12-09's multi-select card itself reported): `ManualDelivery.deliverText`
// has only three gates (`canCompose` / non-empty / `noPcTarget`) and **no length
// check** ⇒ over-length walks all the way to `InjectRequestSchema`, gets zod-rejected,
// and **a boundary refusal is anonymous and silent**.
//
// 🔴 Why this is a red line and not a UX issue: when zod drops a frame at the
// boundary there is no code, no receipt, and no row is settled. The phone sees
// "it went out"; the PC sees nothing — of the two directions of "no silent
// failure", the one violated here is **swallowing the failure**.
//
// 🔴 Multi-select is the first entry that can pile up a hundred thousand
// characters in a few taps, so this card also pins one multi-select-specific
// fact: **a refusal must refuse the whole selection**. When the text is over
// length and the pictures are fine, sending the pictures then refusing the
// text leaves a **half delivery** — the user ticked 3 texts + 2 pictures, sees
// 2 arrive, and **cannot tell which of the five made it**. Either refuse the
// whole batch, or refuse nothing.
//
// ── What the three assertion groups in this file each prevent ──────────────
// ① Mirror guard: Dart cannot see TypeScript symbols, so `kInjectTextMaxChars`
//    is **hand-copied**. A hand-copied cap will drift — this repo already keeps
//    a whole family of lints for that (`admin-limit-mirror` /
//    `password-policy-mirror`). Here we read the .ts source and compare on the
//    spot, same technique as `inject_verdict_authorship_mirror_test.dart`.
// ② Behavior: at the line it goes out; one character over, nothing goes out;
//    multi-select over the line **sends nothing at all**.
// ③ Render: that refusal sentence is **readable** by the user in all four
//    locales.
//
// 🔴 ③'s assertions land on the **painted glyphs**, not on `Text.data`
//    (0.2.53 rule: that time 1259 tests were all green and the screen showed
//    three letters, because the test asserted the string it had just stuffed
//    in). ⚠️ But the claim here has to be exact, or a tautology masquerades as
//    a measurement: **`BannerSlot`'s message `Text` has no `maxLines` and no
//    `ellipsis`** (`banner_slot.dart:82-92`, it wraps freely inside `Expanded`)
//    ⇒ on this surface `didExceedMaxLines` is **always false**, and by itself
//    it proves nothing. So the real load-bearing check is the one below: re-lay
//    the same text at the **width the paragraph actually received**, and
//    require the laid-out height to equal the paragraph's **actually painted
//    height** — the box gave the text all the room it asked for, not one
//    character was cut. Plus a `takeException()`: a `Row` overflow (icon +
//    resend + ✕ squeezing `Expanded` to nothing) is this surface's real
//    failure shape.
//
// ⚠️ `flutter_test` uses the Ahem placeholder font; every glyph is a full-em
//    square ⇒ the width budget here is **conservative** vs a real device:
//    unclipped under Ahem ⇒ unclipped on a real device, **the converse does
//    not hold**. Do not use this file to argue "this sentence fits exactly on
//    a real device".
//
// ⚠️ Use `test()` rather than `testWidgets()` for the delivery chain: that
//    chain is truly async, and awaiting it inside the FakeAsync zone deadlocks
//    (an existing scar in this repo; see the file header of
//    `typed_send_row_test.dart`).

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_retry_targets.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The same real 2×2 RGBA PNG the rest of the image suite uses.
final Uint8List kPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
  'SUkJeJw9PL4AAAAASUVORK5CYII=',
);

/// `flutter test`'s working directory is fixed at this package's root (apps/mobile).
final File _ssot = File('../../packages/protocol/src/protocol-schemas-inject.ts');

class _FakePicker implements ImagePickerPort {
  _FakePicker(this.bytes);
  final Uint8List? bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

/// A light-record row exactly as `ImageSendController._saveLocal` writes one:
/// `clientId == request_id`, `origin: 'cloud'`.
TimelineEntry _noteRow(
  String clientId, {
  required String text,
  required DateTime at,
  String entryType = TimelineEntry.kTranscript,
}) => TimelineEntry(
  id: TimelineEntry.mintLocId('mobile', clientId),
  clientId: clientId,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: text,
  outputText: text,
  status: EntryStatus.noted,
  createdAt: at,
  updatedAt: at,
  origin: 'cloud',
  entryType: entryType,
);

/// Same shape as `plus_selection_delivery_test.dart`: real ChatController, real
/// queue, fake socket. The criterion is **how many frames actually went out**,
/// not "who was called how many times".
class _Harness {
  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final TimelineSyncGate gate;
  late final ChatController controller;
  late final OutboxBlobStore blobs;
  late final TimelinePersistence persistence;

  _Harness({Uint8List? picked}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // Identity, not a handshake — without a pairing there is no destination,
    // and every text send will (correctly) be refused by `noPcTarget`, so this
    // file would not be measuring the length gate.
    giveSessionAPairedIdentity(session);
    persistence = InMemoryTimelinePersistence();
    store = newTestStore(persistence: persistence);
    destination = DestinationController();
    gate = TimelineSyncGate(transport: transport);
    blobs = newTestOutboxBlobs();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: blobs,
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: InMemoryLocalPrefs(),
      imagePicker: _FakePicker(picked),
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  List<Map<String, Object?>> framesOfSource(String source) =>
      <Map<String, Object?>>[
        for (final EventEnvelope e
            in transport.emittedWhere(FlowMicEvents.injectRequest))
          Map<String, Object?>.from(e.data! as Map),
      ].where((Map<String, Object?> p) => p['source'] == source).toList();

  /// How long each frame's `text` is.
  ///
  /// 🔴 An assertion that "not one frame went out" must land on **this**, not
  /// on the frames themselves: this card's sample is a hundred thousand
  /// characters, and when `expect(frames, isEmpty)` goes red it dumps the
  /// entire payload into the failure message (this round's reverse-control
  /// measured: a twenty-thousand-character scroll), and the next person who
  /// hits red has to dig through it. Criterion strength is not reduced by one
  /// word — any frame that went out necessarily has a length.
  List<int> textLengthsOfSource(String source) => <int>[
    for (final Map<String, Object?> f in framesOfSource(source))
      (f['text'] as String? ?? '').length,
  ];

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

/// How wide this text wants to be **under no constraint**. Compare with the
/// actual box and you know whether it is long enough.
double _intrinsicWidth(Text t) => (TextPainter(
  text: TextSpan(text: t.data, style: t.style),
  textDirection: TextDirection.ltr,
  maxLines: 1,
)..layout()).width;

/// The banner the production mapping paints (real `buildChatBanners` + real
/// `BannerSlot`). Deliberately do not hand-roll a `BannerItem`: that would
/// measure the string I wrote myself, not the product's mapping.
Widget _banner(AppStrings s, ComposeSendFailure f) => MaterialApp(
  home: Scaffold(
    body: BannerSlot(
      queue: buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: s,
        sendFailure: f,
        // In production this is null when `sendRetryTargets` is empty
        // (chat_flow_page.dart:513) — `tooLong` is exactly that case; see
        // the last item of ②.
        onRetrySendFailure: null,
        onDismissSendFailure: () {},
      ),
      strings: s,
    ),
  ),
);

void main() {
  // ── ① Mirror guard: the hand-copied number on the Dart side must equal the
  //    protocol single source of truth, character for character ─────────────
  group('① kInjectTextMaxChars vs the protocol single source of truth', () {
    test('the parser is not blind: the .ts really yielded a number (positive control)', () {
      // 🔴 This one runs first. If the equality assertion below is built on a
      // regex that parsed out null, it would be "green and meaningless" —
      // equality / negative assertions must carry their own positive control
      // (a written rule in this repo).
      expect(
        _ssot.existsSync(),
        isTrue,
        reason: 'cannot find the protocol single source of truth ${_ssot.path} (cwd should be apps/mobile)',
      );
      final RegExpMatch? m = RegExp(
        r'export const INJECT_TEXT_MAX_CHARS\s*=\s*([0-9_]+)\s*;',
      ).firstMatch(_ssot.readAsStringSync());
      expect(m, isNotNull, reason: 'regex drifted, or the protocol side renamed / rewrote this constant');
      expect(int.parse(m!.group(1)!.replaceAll('_', '')), greaterThan(0));
    });

    test('🔴 both sides equal, character for character', () {
      final RegExpMatch m = RegExp(
        r'export const INJECT_TEXT_MAX_CHARS\s*=\s*([0-9_]+)\s*;',
      ).firstMatch(_ssot.readAsStringSync())!;
      expect(
        kInjectTextMaxChars,
        int.parse(m.group(1)!.replaceAll('_', '')),
        reason:
            'the protocol side changed INJECT_TEXT_MAX_CHARS and compose_gate.dart\'s '
            'mirror did not follow (or the other way around). Change '
            'packages/protocol/src/protocol-schemas-inject.ts first, then the '
            'phone-side mirror.',
      );
    });

    test('🔴 what is mirrored is the constant that **constrains this field**, not just a same-named number', () {
      // A constant whose name matches but is never used on `text` would make
      // the equality assertion above green and completely irrelevant. This
      // pins that "it is the gate on `inject:request.text`".
      expect(
        _ssot.readAsStringSync(),
        contains('text: z.string().max(INJECT_TEXT_MAX_CHARS)'),
        reason: 'InjectRequestSchema.text is no longer constrained by this constant ⇒ the phone is mirroring something else',
      );
    });

    test('count unit matches zod: UTF-16 code units, not Unicode scalars', () {
      // 🔴 zod's `.max()` counts JS `String.length` (UTF-16 code units); Dart's
      // `String.length` counts the same; the desktop Rust side counts `chars()`
      // (scalars), which for supplementary-plane characters (emoji) is
      // **smaller** ⇒ zod is the tighter of the two gates, and aligning with
      // it is what keeps any frame from slipping through. This pins that with
      // a surrogate pair (😀 = 2 code units / 1 scalar).
      const String astral = '😀';
      expect(astral.length, 2, reason: 'this test\'s premise is gone');
      expect(exceedsInjectTextCap(astral * (kInjectTextMaxChars ~/ 2)), isFalse);
      expect(
        exceedsInjectTextCap(astral * (kInjectTextMaxChars ~/ 2) + 'x'),
        isTrue,
        reason: 'counted as scalars this is only fifty thousand, would be let through, then die at the zod boundary',
      );
    });
  });

  // ── ② Behavior: at the line send, over the line refuse, multi-select over
  //    the line send nothing ────────────────────────────────────────────────
  group('② deliverText\'s fourth gate', () {
    test('🔴 exactly at the cap: send as usual (positive control — without it, "over-line refused" might just be "everything is refused")',
        () async {
      final _Harness h = _Harness();
      h.connect();
      final String atCap = 'x' * kInjectTextMaxChars;

      final ComposeSendFailure? outcome =
          await h.controller.delivery.deliverText(atCap, covered: const <String>[]);

      expect(outcome, isNull, reason: 'exactly at the line is not over the line');
      final List<Map<String, Object?>> manual = h.framesOfSource('manual');
      expect(manual, hasLength(1));
      expect((manual.single['text']! as String).length, kInjectTextMaxChars);
      expect(h.store.entries, hasLength(1), reason: 'D10: its own row');
      expect(h.controller.delivery.failure, isNull);
      await h.dispose();
    });

    test('🔴 one character over: refuse, zero frames, zero rows, and the banner has something to say', () async {
      final _Harness h = _Harness();
      h.connect();
      final String overCap = 'x' * (kInjectTextMaxChars + 1);

      final ComposeSendFailure? outcome = await h.controller.delivery
          .deliverText(overCap, covered: const <String>[]);

      expect(outcome, ComposeSendFailure.tooLong);
      // 🔴 Not one character went on the wire. This is exactly the silence
      // this card is replacing: previously this frame would walk to the zod
      // boundary and be dropped anonymously, and the phone would say nothing.
      expect(h.textLengthsOfSource('manual'), isEmpty);
      expect(h.store.entries, isEmpty, reason: 'a refusal must not leave a half-row');
      expect(h.controller.delivery.failure, ComposeSendFailure.tooLong,
          reason: 'no silent failure: if it was refused, someone has to say so');
      await h.dispose();
    });

    test('🔴 never truncate: not one byte of the refused stretch becomes a delivery', () async {
      // "Send half" is much worse than "don't send" — the user cannot tell
      // where the text on the PC was cut.
      final _Harness h = _Harness();
      h.connect();
      await h.controller.delivery.deliverText(
        'A' * (kInjectTextMaxChars + 500),
        covered: const <String>[],
      );
      // When this goes red it prints "how many frames went out, each how
      // long", so the two bad shapes are immediately distinguishable:
      // length == cap ⇒ someone added truncation; length > cap ⇒ the gate
      // never fired at all.
      expect(h.textLengthsOfSource('manual'), isEmpty);
      await h.dispose();
    });

    test('🔴 must not imply "just try the same thing again": this reason grows no resend button', () async {
      // The copy says 「分几次发送」, and `sendRetryTargets`' whitelist
      // (wireFailed / noResult) decides this reason does not get 重发 — the
      // words and the structure must say the same thing, or the button
      // immediately contradicts the sentence.
      final _Harness h = _Harness();
      h.connect();
      await h.controller.delivery.deliverText(
        'x' * (kInjectTextMaxChars + 1),
        covered: const <String>[],
      );
      // 🔴 First pin that "there really is a tooLong failure sitting there".
      // Without this line, this case is still green when **the gate is
      // ripped out** (no failure ⇒ no targets ⇒ empty), i.e. it is blind to
      // the very regression it is supposed to prevent — which is exactly
      // what this round's reverse-control caught on the spot.
      expect(h.controller.delivery.failure, ComposeSendFailure.tooLong);
      expect(
        sendRetryTargets(
          failure: h.controller.delivery.failure,
          coveredIds: h.controller.delivery.lastFailedCoveredIds,
          store: h.store,
          instanceId: h.controller.session.connectedInstanceId,
        ),
        isEmpty,
      );
      await h.dispose();
    });
  });

  group('③ multi-select: either refuse the whole batch, or refuse nothing', () {
    Future<_Harness> rig(List<TimelineEntry> notes, Set<String> bytes) async {
      final _Harness h = _Harness();
      for (final TimelineEntry n in notes) {
        await h.persistence.upsert(n);
        if (bytes.contains(n.clientId)) {
          await h.blobs.put(requestId: n.clientId, bytes: kPng, extension: 'png');
        }
      }
      await h.store.load();
      h.connect();
      return h;
    }

    List<TimelineEntry> twoPictures() => <TimelineEntry>[
      _noteRow('i1',
          text: '🖼 PNG · 77 B',
          at: DateTime.utc(2026, 8, 2),
          entryType: TimelineEntry.kImage),
      _noteRow('i2',
          text: '🖼 PNG · 77 B',
          at: DateTime.utc(2026, 8, 3),
          entryType: TimelineEntry.kImage),
    ];

    test('🔴 text over length ⇒ not one picture is sent either (a half delivery is worse than a refusal)', () async {
      final List<TimelineEntry> pics = twoPictures();
      final _Harness h = await rig(pics, <String>{'i1', 'i2'});
      final int before = h.store.entries.length;

      await h.controller.sendPlusSelection(
        text: 'x' * (kInjectTextMaxChars + 1),
        images: pics,
      );

      expect(h.textLengthsOfSource('manual'), isEmpty);
      // 🔴 This line is the entire reason this group exists. The pictures
      // themselves can go out just fine (the positive control below proves
      // it), so "send pictures first, then refuse the text" is a real path —
      // walk it and the user receives 2 and has no idea where the rest went.
      expect(h.framesOfSource('image').length, 0,
          reason: 'pictures still went out after the text was refused ⇒ half delivery');
      expect(h.store.entries.length, before, reason: 'not one row may be minted');
      expect(h.controller.delivery.failure, ComposeSendFailure.tooLong);
      await h.dispose();
    });

    test('🔴 positive control: the same selection, text within the line ⇒ 1 + M, not one short', () async {
      // Without this one, the "zero frames" above might just mean this
      // fixture cannot send pictures at all.
      final List<TimelineEntry> pics = twoPictures();
      final _Harness h = await rig(pics, <String>{'i1', 'i2'});
      final int before = h.store.entries.length;

      await h.controller.sendPlusSelection(
        text: '第一句\n第二句',
        images: pics,
      );

      expect(h.framesOfSource('manual'), hasLength(1));
      expect(h.framesOfSource('image'), hasLength(2));
      expect(h.store.entries.length - before, 3);
      expect(h.controller.delivery.failure, isNull);
      await h.dispose();
    });
  });

  // ── ④ Render: that sentence is readable by the user in all four locales ──
  group('④ refusal copy — asserting the painted glyphs', () {
    testWidgets('🔴 all four locales paint in full at 360dp, not one character cut', (WidgetTester tester) async {
      // 360dp = the narrowest screen this repo has measured (the width
      // accounting for the two-row header card was done on this).
      tester.view.physicalSize = const Size(360 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String expected =
            s.composeSendError(ComposeSendFailure.tooLong);
        await tester.pumpWidget(_banner(s, ComposeSendFailure.tooLong));

        // The production mapping really put this sentence up (not me stuffing
        // a string in and reading it back).
        final Finder msg = find.text(expected);
        expect(msg, findsOneWidget, reason: '$locale');

        // A `Row` overflow is this surface's real failure shape: when icon +
        // action + ✕ squeeze `Expanded` to nothing, the user sees yellow-black
        // stripes instead of this sentence.
        expect(tester.takeException(), isNull, reason: '$locale: this banner row overflowed');

        final RenderParagraph p = tester.renderObject<RenderParagraph>(msg);
        // Positive control: this sentence **really is** too long for one line
        // — otherwise "not clipped" proves nothing.
        expect(
          _intrinsicWidth(tester.widget<Text>(msg)),
          greaterThan(p.size.width),
          reason: '$locale: sample too short, this test is blind to the regression',
        );
        // 🔴 The load-bearing one: re-lay at the paragraph's **actually
        // received width**, require the height to equal the **actually
        // painted** height ⇒ the box gave the text all the room it asked
        // for, no line was eaten. ⚠️ Deliberately do not lean on
        // `didExceedMaxLines`: this `Text` in `banner_slot.dart` has no
        // `maxLines` ⇒ that value is always false, using it as a criterion
        // is a tautology.
        final TextPainter painter = TextPainter(
          text: TextSpan(
            text: tester.widget<Text>(msg).data,
            style: tester.widget<Text>(msg).style,
          ),
          textDirection: TextDirection.ltr,
        )..layout(maxWidth: p.size.width);
        expect(painter.height, p.size.height, reason: '$locale: this sentence was cut by the box');
        expect(p.didExceedMaxLines, isFalse, reason: '$locale');

        // Structure and copy say the same thing: no 重发 button to contradict
        // 「请分几次发送」.
        expect(find.text(s.resendAction), findsNothing, reason: '$locale');
      }
    });

    testWidgets('🔴 reverse control: the same sentence stuffed into a narrow box is clipped — proves this measuring method can go red',
        (WidgetTester tester) async {
      // This is not measuring product code; it is proving the measurement
      // group above **is capable of** failing.
      tester.view.physicalSize = const Size(360 * 3, 780 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 56,
              child: Text(
                AppStrings(AppLocale.zh)
                    .composeSendError(ComposeSendFailure.tooLong),
                key: const ValueKey<String>('squeezed'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
      );
      expect(
        tester
            .renderObject<RenderParagraph>(
              find.byKey(const ValueKey<String>('squeezed')),
            )
            .didExceedMaxLines,
        isTrue,
        reason: 'even this does not go red, so the measuring method itself is broken',
      );
    });

    test('all four locales non-empty, and a different sentence from each of the existing six reasons', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String tooLong = s.composeSendError(ComposeSendFailure.tooLong);
        expect(tooLong, isNotEmpty, reason: '$locale');
        for (final ComposeSendFailure other in ComposeSendFailure.values) {
          if (other == ComposeSendFailure.tooLong) continue;
          // One sentence answering two reasons = another "one value answering
          // two questions".
          expect(s.composeSendError(other), isNot(tooLong), reason: '$locale/$other');
        }
      }
    });
  });
}
