// Card G-18 — the promise 「查看原图」is structurally undeliverable on
// light-record rows.
//
// Ruling = docs/decisions/2026-08-05-it18-leftover-items-rulings.md「G-18」:
// **either store the original, or do not promise; this round ruled 「do
// not promise」** (really storing the original is listed as owner's
// question, because it changes the product concept of 「light record」
// itself, and also touches phone disk and clear-quota).
//
// 🔴 The shape of the defect is not 「tap and get an error」, it is **a
// sentence that was never spoken**. The light-record (origin:'cloud')
// path only stores a 256px thumbnail (`image_send_controller.dart`
// `_saveLocal` writes this as a known gap in so many words; there is
// no `rowImages.put(...)` there) ⇒ `full` is **structurally always
// empty**, a double-tap gets an **enlarged thumbnail**, and the UI
// presents it as if it were the real picture.
// That is exactly the second direction of 「no silent failure」:
// **must not say a thing that was not done was done**.
//
// 🔴 And the honest sentence **already existed, and was already being
// shown to another user**:
// `AppStrings.imagePreviewNote` (「256px 预览图，非原图」, all four
// languages complete) is only hung on the copy-menu subtitle and the
// copy toast. **The person who tapped 「复制」was told; the person who
// double-tapped the picture was not.**
// That asymmetry itself is the defect ⇒ this card wires the same
// getter onto the preview face, **deliberately not writing a second
// sentence** (the doc comment on the `imagePreviewNote` getter says
// in place why this sentence is owned by one getter: if the two
// faces each write a sentence, they will sooner or later drift into
// two wordings of the same fact).
//
// ── Where the criterion hangs (this file's two groups; both required) ─────
//
// ① Component face: the criterion is **「did the large image actually
//    arrive」**, never 「is this row from cloud」.
//    The reason is falsifiability: if light records start storing the
//    original someday, the former becomes right by itself, while an
//    `origin == 'cloud'` writing would **keep printing a sentence that
//    has become false**.
//    ⇒ so the decision stays at the preview layer (it is the only
//    layer that can see how `full` turned out); the caller only
//    passes the string.
//
// ② Production face: **component-only is not enough** (the literal
//    case of the 0.2.51 law) — if you only drive `ImagePreviewPage`,
//    deleting that one wire in `chat_flow_page.dart` leaves this
//    group all green, and that is exactly the shape this card refuses
//    to ship (「the capability is defined and nobody calls it」).
//    ⇒ Group ② walks from a **real `ChatFlowPage` + a real
//    `ChatController`**, double-taps a real picture row, and asserts
//    the user really reads that sentence.
//    ⚠️ Also: `previewOnlyNote` is **required**, so deleting that
//    wire **fails to compile** — the compiler is this wire's first
//    gate; this group is the second.
//
// ── 🔴 Ruler (0.2.53 law + its Ahem caveat, reused verbatim) ──────────────
//
// Any acceptance of 「can the user read this sentence」must land the
// assertion on the **rendered result** (`didExceedMaxLines` /
// intrinsic width vs. the actual box), **never on `Text.data`**.
// The counter-example is written in place in
// `cloud_image_error_copy_test.dart`: it knew it would be clipped,
// then went around the clip to assert `Text.data`, so 1259 cases
// were all green and the screen showed three letters.
//
// 🔴 **Correction 2026-08-07 (W5a adversarial review P1-1,
// [measured]) — the sentence above 「land on the rendered result」
// this file previously only did half of; the original is not
// deleted, because what it said when written was what we believed.**
// This file originally called `_clipped()`=`didExceedMaxLines` on
// the product sentence, but in `image_preview_page.dart` `maxLines`
// **appears only in a comment** (which says exactly 「there is no
// maxLines here」) ⇒ that reading is **always false**, and these
// assertions are structurally unable to go red.
// 🔴 And this file's 「ruler self-check」(the ⟲ case below) **did
// not catch it, and could not**: it proves 「`_clipped` can read a
// number when mounted on a **separately invented** broken
// structure」, not 「this product stretch has the instrument hooked
// up」.
// **An instrument self-check must check 「is THIS reading a real
// reading」, not 「can this instrument move in the lab」.**
// ⇒ the product face now goes through `expectLegible` in
// `support/legibility.dart`: read `didExceedMaxLines` only when
// `maxLines` is set; otherwise assert 「why it cannot be clipped」
// (softWrap / no ellipsis / finite width / the longest unbreakable
// run fits).
//
// ⚠️ `flutter_test` uses the **Ahem placeholder font**; every glyph
//    is a full-em square ⇒ a 411dp line holds only about 35
//    characters; a real font (Chinese ~34, Latin ~70+) is much
//    looser. **This direction is conservative**: not clipped under
//    Ahem ⇒ will not be clipped on a real device; **the converse
//    does not hold**, do not use this file to argue 「it happens to
//    fit on a real device」.
// ⚠️ This file **has no real-device evidence**: G-18 is entirely
//    [unit-test], real-device unproven (this window has no
//    hardware).
//
// SPEC-REF: apps/mobile/lib/src/ui/image_preview_page.dart (the
//   correction block spells out the three states);
//   the `KNOWN GAP, NAMED RATHER THAN IMPLIED (RV-93)` stretch in
//   apps/mobile/lib/src/session/image_send_controller.dart (the gap
//   in place, right after `sniffImageMime`);
//   CLAUDE.md red line: no silent failure (both directions).
//
// ⚠️ This file **deliberately uses a symbol anchor, not a line
// number** (the original wrote `:400-409`, changed 2026-08-07 W5a):
// that coordinate was already wrong on the spot, reddened
// `coordinate-anchors`, and **blocked three windows' commit
// queues**.
// ⇒ a newly written file that cites elsewhere should first ask
// 「will this file still move this round」— if it will, do not
// write a line number.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/image_thumbnail.dart' show decodedThumbnail;
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/image_preview_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart';

const AppStrings _zh = AppStringsZh();

/// The name of that sentence on the tree.
const ValueKey<String> kNoteKey = ValueKey<String>(
  'imagePreview.previewOnlyNote',
);

/// A real 1×1 PNG (`Image.memory` will really decode it) — the list-
/// thumbnail copy.
final Uint8List kThumb = base64Decode(kThumbB64);
const String kThumbB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/// A real 2×2 PNG, bytes different from [kThumb]: you can tell at a
/// glance 「which copy is painted now」.
final Uint8List kBig = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAFjDAGACHtA/wSKAdxAAAAAElFTkSuQmCC',
);

/// After render, did this text overflow its own `maxLines` (= the user
/// sees an ellipsis).
///
/// 🔴 **Only allowed on things that really set `maxLines`** (in this
/// file, only the fake of the ruler self-check). The product sentence
/// does not set `maxLines`; calling this function on it **always
/// returns false** — that is exactly the defect W5a adversarial
/// review P1-1 caught. The product face always goes through
/// [expectLegible].
bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

/// Phone width, not the default 800×600: this class of defect only
/// holds on a narrow screen.
void _phone(WidgetTester tester, {double width = 411}) {
  tester.view.physicalSize = Size(width * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

/// [key] exists for the four-language loop: `pumpWidget` REUSES the element for
/// an identical widget type, so the Navigator (and the route already pushed onto
/// it) survives into the next iteration and covers the 'open' button — measured,
/// the second locale's tap warned 「would not hit test」 and found no page. A
/// distinct key per iteration forces a real remount instead.
Widget _host(Future<Uint8List?>? full, {AppStrings strings = _zh, Key? key}) =>
    MaterialApp(
  key: key,
  home: Builder(
    builder: (BuildContext context) => Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: () => Navigator.of(context).push(
            ImagePreviewPage.route(
              png: kThumb,
              caption: '🖼 PNG · 78 KB',
              closeHint: strings.imageZoomClose,
              previewOnlyNote: strings.imagePreviewNote,
              full: full,
            ),
          ),
          child: const Text('open'),
        ),
      ),
    ),
  ),
);

Future<void> _open(WidgetTester tester, Future<Uint8List?>? full,
    {AppStrings strings = _zh, Key? key}) async {
  await tester.pumpWidget(_host(full, strings: strings, key: key));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  expect(find.byType(ImagePreviewPage), findsOneWidget);
}

Uint8List _shownBytes(WidgetTester tester) =>
    (tester.widget<Image>(find.byType(Image)).image as MemoryImage).bytes;

void main() {
  // ══════════════════════════════════════════════════════════════════════════
  // ① Component face — the criterion is 「did the large image actually
  // arrive」, and what is asserted is the painted words
  // ══════════════════════════════════════════════════════════════════════════
  group('① when there is only a small image, that must be said', () {
    testWidgets('🔴 light-record shape (full always empty) ⇒ that sentence is on screen, and was not eaten by an ellipsis', (
      WidgetTester tester,
    ) async {
      _phone(tester);
      await _open(tester, null);

      final Finder note = find.byKey(kNoteKey);
      expect(note, findsOneWidget, reason: 'what was opened is a thumbnail; the UI must say so');
      // Assert the rendered result: it really occupies space, it really
      // was not clipped.
      expect(tester.getSize(note).width, greaterThan(0));
      expect(tester.getSize(note).height, greaterThan(0));
      expectLegible(tester, note, reason: 'this sentence cannot be read');
      // And it is that **one** getter, not a second sentence written
      // for this face.
      expect(tester.widget<Text>(note).data, _zh.imagePreviewNote);
      // What is painted really is the thumbnail (otherwise this
      // sentence itself becomes a lie).
      expect(_shownBytes(tester), same(kThumb));
    });

    testWidgets('🔴 the large image really arrived ⇒ not one word may be said', (WidgetTester tester) async {
      _phone(tester);
      await _open(tester, Future<Uint8List?>.value(kBig));

      // Positive control: we really took the 「large image」branch, not
      // because the whole tree failed to build.
      expect(_shownBytes(tester), same(kBig));
      expect(
        find.byKey(kNoteKey),
        findsNothing,
        reason: 'what is being viewed IS the copy that was sent; saying 「非原图」turns a truth into a lie',
      );
    });

    testWidgets('the large image came back as empty bytes ⇒ the same fact as 「there is no large image」, still must be said', (
      WidgetTester tester,
    ) async {
      _phone(tester);
      await _open(tester, Future<Uint8List?>.value(Uint8List(0)));
      expect(find.byKey(kNoteKey), findsOneWidget);
      expect(_shownBytes(tester), same(kThumb));
    });

    testWidgets('🔴 third state: still reading disk ⇒ do not say yet (a sentence that will be taken back is worse than not saying)', (
      WidgetTester tester,
    ) async {
      _phone(tester);
      final Completer<Uint8List?> pending = Completer<Uint8List?>();
      await _open(tester, pending.future);

      // Already painting the thumbnail (no empty window), but **do not
      // yet know** whether the large image will come.
      expect(_shownBytes(tester), same(kThumb));
      expect(
        find.byKey(kNoteKey),
        findsNothing,
        reason: 'saying 「非原图」this moment, and taking it back next frame — that is flicker, not information',
      );

      pending.complete(kBig);
      await tester.pumpAndSettle();
      expect(_shownBytes(tester), same(kBig));
      expect(find.byKey(kNoteKey), findsNothing);
    });

    testWidgets('all four languages render the full sentence, none is clipped', (WidgetTester tester) async {
      // ⚠️ Deliberately wider than 411 (600); the reason is an Ahem
      // artefact, not the product: under full-em squares the Latin
      // three sentences have far more glyphs than Chinese. After
      // widening to 600 it is still stricter than a real device
      // (Ahem@600 one line ≈ 52 chars, real font@411 one line ≈ 70
      // chars ⇒ if it passes here, a real device must pass).
      _phone(tester, width: 600);
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        await _open(tester, null, strings: s, key: ValueKey<AppLocale>(locale));
        final Finder note = find.byKey(kNoteKey);
        expect(note, findsOneWidget, reason: '$locale');
        expectLegible(tester, note, reason: '$locale');
        expect(tester.widget<Text>(note).data!.trim(), isNotEmpty, reason: '$locale');
      }
    });

    testWidgets('⟲ ruler self-check: stuffing the same sentence into a narrow box must go red (otherwise the measuring method is blind)', (
      WidgetTester tester,
    ) async {
      // This is not measuring product code; it is proving `_clipped`
      // **is able** to see a truncation.
      //
      // 🔴 **It cannot prove the assertions above are real readings
      // (W5a P1-1 correction, 2026-08-07).**
      // The next sentence of the original comment wrote 「without this
      // case, every 『not clipped』above may only be because the probe
      // is blind」— **and with this case, every one above may still
      // be blind**: the `Text` here is invented by this test, and it
      // set `maxLines: 1`; the product sentence did not. The
      // instrument can read true on this fake and always reads false
      // on the product; what sits between those two things is exactly
      // that defect.
      // ⇒ keep it (it still answers 「did I use the
      // `didExceedMaxLines` API correctly」), but the product-face
      // criterion has moved to `expectLegible`, which picks the
      // instrument by structure.
      _phone(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 40,
              child: Text(
                _zh.imagePreviewNote,
                key: const ValueKey<String>('squeezed'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
      );
      expect(
        _clipped(tester, find.byKey(const ValueKey<String>('squeezed'))),
        isTrue,
        reason: 'if even this does not go red, the measuring method itself is blind',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ② Production face — walk once from a real ChatFlowPage
  //
  // 🔴 The only reason this group exists: group ① all green does not
  //    prove anyone on the production path is passing that string.
  //    The 0.2.51 lesson is this shape verbatim (tracker unit tests
  //    all green while the entry was unwired).
  // ══════════════════════════════════════════════════════════════════════════
  group('② production wire: double-tap a real picture row, the user really reads that sentence', () {
    /// Same skeleton as chat_stick_bottom_widget_test: a real pair
    /// (fake ack), and stamp ownership on the row with the production
    /// `InstanceOwnerProbe` (main.dart `_SessionInstanceOwner`) —
    /// otherwise the narrowed timeline correctly hides them, and the
    /// test measures nothing.
    Future<ChatController> controller(
      FakeSocketTransport transport,
      OutboxBlobStore blobs,
    ) async {
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      transport.connectSucceeds = true;
      transport.ackQueue.add(<String, Object?>{
        'token': 'tok-g18-0000000000000000000000000',
        'pc_name': 'Widget PC',
        'pc_instance_id': 'inst-g18',
      });
      final PairResult pair = await session.pair(
        PairEntry.parse('1234'),
        endpoint: 'ws://192.0.2.5:41879',
      );
      expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
      return ChatController(
        outboxStore: newTestOutboxStore(),
        outboxBlobs: blobs,
        session: session,
        store: newTestStore(owner: _SessionOwner(session)),
        destination: DestinationController(),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(),
      );
    }

    /// A light-record picture row: `origin:'cloud'`, thumbnail only.
    TimelineEntry seedPicture(ChatController c, {required String clientId}) =>
        c.store.buildFromUtterance(
          clientId: clientId,
          mode: FlowMode.realtime,
          delivery: Delivery.none,
          text: '🖼 PNG · 78 KB',
          origin: 'cloud',
          entryType: TimelineEntry.kImage,
          thumbB64: kThumbB64,
        );

    /// Open the real page and warm the thumbnail until it can be
    /// tapped (decode is truly async; a fake-clock settle cannot
    /// finish it; before decode Image lays out at height 0, and the
    /// tap lands elsewhere).
    ///
    /// 🔴 What must be warmed is **that one instance** of
    /// `decodedThumbnail(kThumbB64)`, not another equal-bytes copy we
    /// `base64Decode` ourselves. `MemoryImage`'s identity is its
    /// `bytes` **compared by reference** (the whole decode cache in
    /// image_thumbnail.dart exists for this; so does owner's 「页面会疯狂闪烁」
    /// of that year), so warming the wrong instance = not warming:
    /// measured exactly that way — `pixels: null`, tap misses, reports
    /// 「would not hit test」.
    Future<void> openPage(
      WidgetTester tester,
      ChatController c, {
      AppSettingsController? settings,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: ChatFlowPage(controller: c, appSettings: settings),
        ),
      );
      await tester.pump();
      final BuildContext ctx = tester.element(find.byType(ChatFlowPage));
      final Uint8List tileBytes = decodedThumbnail(kThumbB64)!;
      await tester.runAsync(() => precacheImage(MemoryImage(tileBytes), ctx));
      await tester.pumpAndSettle();
    }

    /// Production gesture: double-tap the picture in the row
    /// (`ChatMessageTile`'s onDoubleTap → onZoom).
    Future<void> doubleTapPicture(WidgetTester tester) async {
      final Finder img = find.byType(Image).first;
      expect(
        tester.getSize(img),
        isNot(const Size(0, 0)),
        reason: 'the thumbnail did not decode; the tap below will miss',
      );
      await tester.tap(img);
      await tester.pump(const Duration(milliseconds: 60));
      await tester.tap(img);
      await tester.pumpAndSettle();
    }

    testWidgets('🔴 light-record row: double-tap ⇒ the preview page really says 「256px 预览图，非原图」', (
      WidgetTester tester,
    ) async {
      _phone(tester);
      final FakeSocketTransport transport = FakeSocketTransport();
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final ChatController c = await controller(transport, blobs);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });

      seedPicture(c, clientId: 'g18-cloud');
      transport.pushStatus(SocketStatus.connected);
      await openPage(tester, c);
      await doubleTapPicture(tester);

      expect(find.byType(ImagePreviewPage), findsOneWidget, reason: 'preview did not open');
      final Finder note = find.byKey(kNoteKey);
      expect(
        note,
        findsOneWidget,
        reason: 'nobody on the production path passed previewOnlyNote — the wire dropped',
      );
      expectLegible(tester, note, reason: 'that sentence on the production path cannot be read');
      expect(tester.widget<Text>(note).data, _zh.imagePreviewNote);

      // G-15①: the idle-presence poll Timer armed by a real pair(),
      // will be checked the moment the tree is torn down;
      // addTearDown is too late (same escape hatch as
      // chat_stick_bottom_widget_test).
      c.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 reverse control: the same path, the row has a large image ⇒ not one word is said', (
      WidgetTester tester,
    ) async {
      _phone(tester);
      final FakeSocketTransport transport = FakeSocketTransport();
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final ChatController c = await controller(transport, blobs);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });

      // The same production lookup path (rowImageBytes →
      // pathFor(entry.clientId)) can find the bytes.
      const String clientId = 'g18-delivered';
      await blobs.put(requestId: clientId, bytes: kBig, extension: 'png');
      seedPicture(c, clientId: clientId);
      transport.pushStatus(SocketStatus.connected);
      await openPage(tester, c);
      await doubleTapPicture(tester);

      expect(find.byType(ImagePreviewPage), findsOneWidget);
      // Positive control: the large image really was fetched (otherwise
      // 「said nothing」is only because the whole path never ran).
      expect(
        find.byType(Image).evaluate().any(
          (Element e) =>
              ((e.widget as Image).image as MemoryImage).bytes == kBig,
        ),
        isTrue,
        reason: 'the large image was not painted; this reverse control controlled nothing',
      );
      expect(find.byKey(kNoteKey), findsNothing);

      c.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 what is passed down is the sentence in the local language, not hardcoded Chinese', (
      WidgetTester tester,
    ) async {
      // This case tightens 「wiring」one more notch: the production
      // path is not just 「a string was passed」, it must be **the
      // current language's** sentence. A hardcoded Chinese sentence
      // would equally green the previous case.
      _phone(tester, width: 600);
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      final AppSettingsController settings = AppSettingsController(prefs: prefs);
      await settings.load();
      settings.setLocale(AppLocale.ja);
      addTearDown(settings.dispose);

      final FakeSocketTransport transport = FakeSocketTransport();
      final InMemoryOutboxBlobStore blobs = InMemoryOutboxBlobStore();
      final ChatController c = await controller(transport, blobs);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });

      seedPicture(c, clientId: 'g18-ja');
      transport.pushStatus(SocketStatus.connected);
      await openPage(tester, c, settings: settings);
      await doubleTapPicture(tester);

      final Finder note = find.byKey(kNoteKey);
      expect(note, findsOneWidget);
      expect(
        tester.widget<Text>(note).data,
        AppStrings.of(AppLocale.ja).imagePreviewNote,
      );
      expect(
        tester.widget<Text>(note).data,
        isNot(_zh.imagePreviewNote),
        reason: 'the two languages\' sentences must differ, otherwise this assertion proved nothing',
      );

      c.session.debugStopIdlePresencePoll();
    });
  });
}

/// The production ownership probe (a same-shape stand-in for main.dart
/// `_SessionInstanceOwner`).
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}
