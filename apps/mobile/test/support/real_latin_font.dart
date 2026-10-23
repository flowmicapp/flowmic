// A REAL Latin / Cyrillic face for fit tests — the ruler note lives in
// `compose_row_one_fit_test.dart`'s header (this is the same loader, shared so
// a second fit test does not carry a second copy of the SDK path search).
//
// Short version: the default test face paints every glyph one em wide, which
// inflates Latin ~2x, so 「does this Latin word fit」 cannot be answered under
// it. Latin / Cyrillic locales paint in Roboto registered under its own family;
// Han / Kana / Hangul keep the square face, which is the conservative reading
// for em-square scripts (square fits ⇒ device fits; the converse is false).

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/settings/app_settings.dart'
    show AppLocale, LocaleScript;
import 'package:flutter/services.dart' show FontLoader;

/// Registered under a name nothing else asks for, so only cases that opt in
/// through their theme paint in it.
const String kRealLatinFamily = 'FlowMicTestRobotoMeta';

/// Latin and Cyrillic have a real face here; everything else keeps the square.
bool usesRealLatinFace(AppLocale l) =>
    l.script == LocaleScript.latn || l.script == LocaleScript.cyrl;

/// DevTools ships Roboto with the Dart SDK on every host; material_fonts is an
/// optional Flutter artifact. Missing fonts fail loudly rather than silently
/// measuring Latin under the square face.
List<File> _robotoFonts() {
  final List<String> caches = <String>[
    File(Platform.resolvedExecutable).parent.parent.parent.parent.path,
    if (Platform.environment['FLUTTER_ROOT'] case final String root)
      <String>[root, 'bin', 'cache'].join(Platform.pathSeparator),
  ];
  final List<List<File>> candidates = <List<File>>[
    for (final String cache in caches) ...<List<File>>[
      <File>[
        for (final String weight in <String>['Regular', 'Medium', 'Bold'])
          File(
            <String>[
              cache,
              'dart-sdk',
              'bin',
              'resources',
              'devtools',
              'assets',
              'fonts',
              'Roboto',
              'Roboto-$weight.ttf',
            ].join(Platform.pathSeparator),
          ),
      ],
      <File>[
        for (final String weight in <String>['regular', 'medium', 'bold'])
          File(
            <String>[
              cache,
              'artifacts',
              'material_fonts',
              'roboto-$weight.ttf',
            ].join(Platform.pathSeparator),
          ),
      ],
    ],
  ];
  for (final List<File> fonts in candidates) {
    if (fonts.every((File font) => font.existsSync())) return fonts;
  }
  throw StateError(
    'Roboto regular, medium and bold are required to measure real Latin '
    'glyphs; no complete font set found in the SDK. Checked:\n'
    '${candidates.expand((List<File> f) => f).map((File f) => f.path).join('\n')}',
  );
}

Future<void> loadRealLatinFace() async {
  final FontLoader loader = FontLoader(kRealLatinFamily);
  for (final File font in _robotoFonts()) {
    final Uint8List bytes = font.readAsBytesSync();
    loader.addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
  }
  await loader.load();
}
