// owner 2026-07-27:「双击图片可全屏预览，再双击或返回关闭预览」.
//
// What matters is that the way OUT works, in all three forms. A full-screen view
// you cannot leave is worse than no preview at all, and back is the primary exit
// on Android — which is why this is a route rather than an overlay.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/image_preview_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A real 1×1 PNG so Image.memory decodes for real.
final Uint8List kPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);
const AppStrings _zh = AppStringsZh();

/// A host with a button that opens the preview, so the ROUTE is exercised the
/// way the chat page uses it (push + pop), not just the widget in isolation.
Widget _host() => MaterialApp(
  home: Builder(
    builder: (BuildContext context) => Scaffold(
      body: Center(
        child: ElevatedButton(
          onPressed: () => Navigator.of(context).push(
            ImagePreviewPage.route(
              png: kPng,
              caption: '🖼 PNG · 78 KB',
              closeHint: _zh.imageZoomClose,
              // card G-18: required, so this argument cannot be forgotten by a
              // call site — see image_preview_page.dart's header for why the
              // compiler is deliberately the wiring test here.
              previewOnlyNote: _zh.imagePreviewNote,
            ),
          ),
          child: const Text('open'),
        ),
      ),
    ),
  ),
);

Future<void> _open(WidgetTester tester) async {
  await tester.pumpWidget(_host());
  // Decoding is REAL async — the fake test clock cannot settle it, and until
  // the PNG resolves the Image lays out at 0×0, so a tap aimed at it falls
  // through to the backdrop instead (whose onTap then pops the route this
  // test just opened — and a second tap at the same spot can even land back
  // on the host's 'open' button and push a NEW page). Precache the bytes for
  // real so every tap below lands on the picture itself, deterministically.
  final BuildContext host = tester.element(find.text('open'));
  await tester.runAsync(() => precacheImage(MemoryImage(kPng), host));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  expect(find.byType(ImagePreviewPage), findsOneWidget);
  // Guard the invariant the gestures depend on — if the precache above ever
  // stops taking effect this fails deterministically instead of flaking.
  expect(tester.getSize(find.byType(Image)), isNot(const Size(0, 0)));
}

void main() {
  testWidgets('it opens with the caption and states how to close', (WidgetTester tester) async {
    await _open(tester);
    expect(find.text('🖼 PNG · 78 KB'), findsOneWidget);
    expect(find.text(_zh.imageZoomClose), findsOneWidget);
  });

  testWidgets('double-tapping the picture closes it', (WidgetTester tester) async {
    await _open(tester);
    // The IMAGE, not the backdrop — a double-tap on the picture itself is the
    // gesture the owner named.
    final Finder img = find.byType(Image);
    await tester.tap(img);
    // Inside the double-tap window (300 ms) so the two taps register as one
    // double-tap rather than two singles.
    await tester.pump(const Duration(milliseconds: 60));
    await tester.tap(img);
    await tester.pumpAndSettle();
    expect(find.byType(ImagePreviewPage), findsNothing);
  });

  testWidgets('the system back gesture closes it (the Android way out)', (WidgetTester tester) async {
    await _open(tester);
    final NavigatorState nav = tester.state(find.byType(Navigator).last);
    await nav.maybePop();
    await tester.pumpAndSettle();
    expect(find.byType(ImagePreviewPage), findsNothing);
  });

  testWidgets('a SINGLE tap on the picture does NOT close it', (WidgetTester tester) async {
    // …otherwise a stray tap dismisses what you just deliberately opened.
    await _open(tester);
    await tester.tap(find.byType(Image));
    await tester.pumpAndSettle();
    expect(find.byType(ImagePreviewPage), findsOneWidget);
  });

  // ── RV-93 two sizes ────────────────────────────────────────────────────────
  //
  // owner:「双击之后，能够预览相对大的图」. The criterion is that **the
  // rendered bytes switched to that copy**, not "whether an argument was
  // passed" — passing the argument and still painting the thumbnail is
  // exactly the false-green this card is most likely to produce.
  group('RV-93 — opening shows the copy that was sent, not the list thumbnail', () {
    /// A real 2×2 PNG, different bytes from kPng: Image.memory can decode it
    /// for real, and you can tell at a glance "which copy is painted now".
    final Uint8List kBig = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QzwAFjDAGACHtA/wSKAdxAAAAAElFTkSuQmCC',
    );

    Widget host(Future<Uint8List?>? full) => MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => Navigator.of(context).push(
                ImagePreviewPage.route(
                  png: kPng,
                  caption: '🖼 PNG · 78 KB',
                  closeHint: _zh.imageZoomClose,
                  previewOnlyNote: _zh.imagePreviewNote,
                  full: full,
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    Future<Uint8List> shownBytes(WidgetTester tester) async {
      final Image img = tester.widget<Image>(find.byType(Image));
      return (img.image as MemoryImage).bytes;
    }

    testWidgets('full image obtained ⇒ the full image is what is painted', (WidgetTester tester) async {
      await tester.pumpWidget(host(Future<Uint8List?>.value(kBig)));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(await shownBytes(tester), same(kBig));
    });

    testWidgets('⟲ reverse control: no full image (old row / bytes gone) ⇒ fall back to thumbnail, not a blank', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(host(Future<Uint8List?>.value(null)));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      // "only the small image" is a smaller picture, not a broken one: there
      // is still an Image, and it paints the thumbnail.
      expect(await shownBytes(tester), same(kPng));
      expect(find.text('🖼 PNG · 78 KB'), findsOneWidget);
    });

    testWidgets('the instant the full image is still unread ⇒ already painting the thumbnail (no empty window)', (
      WidgetTester tester,
    ) async {
      final Completer<Uint8List?> pending = Completer<Uint8List?>();
      await tester.pumpWidget(host(pending.future));
      await tester.tap(find.text('open'));
      // The route animation has finished, but the future has not — that is
      // the instant "disk read has not come back yet".
      await tester.pumpAndSettle();
      expect(await shownBytes(tester), same(kPng));
      pending.complete(kBig);
      await tester.pumpAndSettle();
      expect(await shownBytes(tester), same(kBig), reason: 'once read, switch to the full image');
    });
  });

  testWidgets('is bilingual — the close hint resolves in both locales', (WidgetTester tester) async {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      expect(s.imageZoomClose.trim(), isNotEmpty, reason: '$locale');
    }
    // …and the two are genuinely different strings, not one copied across.
    expect(
      AppStrings(AppLocale.zh).imageZoomClose,
      isNot(AppStrings(AppLocale.en).imageZoomClose),
    );
  });
}
