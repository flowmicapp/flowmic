import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/image_preview_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/inset_geometry.dart';

Future<Uint8List> png(int width, int height) async {
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = const ui.Color(0xFF44AA88),
  );
  final ui.Picture picture = recorder.endRecording();
  final ui.Image image = await picture.toImage(width, height);
  final ByteData data = (await image.toByteData(
    format: ui.ImageByteFormat.png,
  ))!;
  image.dispose();
  picture.dispose();
  return data.buffer.asUint8List();
}

void main() {
  const AppStrings s = AppStringsZh();
  for (final InsetCase c in insetCases.where((InsetCase c) => c.ime == 0)) {
    for (final bool tall in <bool>[true, false]) {
      testWidgets('image content safe ${c.name} tall=$tall', (
        WidgetTester tester,
      ) async {
        final Uint8List bytes = (await tester.runAsync(
          () => png(tall ? 60 : 600, tall ? 600 : 60),
        ))!;
        c.apply(tester);
        final String caption = List<String>.filled(25, '图片说明').join(' ');
        await tester.pumpWidget(
          c.app(
            Scaffold(
              body: Builder(
                builder: (BuildContext context) => Center(
                  child: TextButton(
                    onPressed: () => Navigator.of(context).push(
                      ImagePreviewPage.route(
                        png: bytes,
                        caption: caption,
                        closeHint: s.imageZoomClose,
                        previewOnlyNote: s.imagePreviewNote,
                      ),
                    ),
                    child: const Text('open'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.runAsync(
          () => precacheImage(
            MemoryImage(bytes),
            tester.element(find.text('open')),
          ),
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        final Finder image = find.byType(Image);
        expectInside(tester, image, c);
        await reveal(tester, find.text(s.imageZoomClose));
        expectInside(tester, find.text(s.imageZoomClose), c);
        await reveal(tester, image);
        await tester.tap(image);
        await tester.pump(const Duration(milliseconds: 60));
        await tester.tap(image);
        await tester.pumpAndSettle();
        expect(find.byType(ImagePreviewPage), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
