// CARD-UI ruler — a fallback face for the glyphs Roboto does not carry.
//
// Why it exists (measured 2026-10-14 under Flutter 3.44.0): in a widget test
// whose theme names a loaded Roboto family, every glyph Roboto lacks — Han,
// Kana, Hangul, and the emoji / symbol glyphs the delivery pill leads with
// (🚫 📥 📤 ⏳ ⏸ ⛔ ✓ ✗ ⤓) — is laid out as Roboto's `.notdef`, 0.47 em wide.
// The tester does NOT fall back to its square default face for them, whatever
// family name is put in `fontFamilyFallback` ('Ahem', 'FlutterTest' were both
// tried). So a Latin cell under real Roboto measured its pill's emoji at less
// than half of what a phone draws (Noto Color Emoji ≈ 1.25 em), and a CJK cell
// could only be measured entirely in the square face, digits included (a time
// stamp 「2025/12/31 23:59」 read 172 px instead of about 89).
//
// This builds, in memory, a TrueType face with two blank-box glyphs and loads
// it as [kSquareFallbackFamily], to be named in `fontFamilyFallback` after
// Roboto:
//   · CJK / Kana / Hangul / fullwidth forms → exactly 1 em (what Noto Sans CJK,
//     PingFang and Apple SD Gothic Neo advance an ideograph or syllable by);
//   · symbols, arrows, dingbats and emoji → 1.375 em, wider than Noto Color
//     Emoji (≈1.25 em) and Segoe UI Emoji (1.373 em), so these glyphs are read
//     conservatively, never narrower than a phone draws them.
// Generated rather than committed as a binary so the widths are reviewable
// here and no font file has to travel with the repo.

import 'dart:typed_data';

import 'package:flutter/services.dart' show FontLoader;

const String kSquareFallbackFamily = 'FlowMicTestSquareFallback';

const int _upm = 1000;
const int _square = 1000;
const int _wide = 1375;

/// (first, last, glyph) — glyph 1 = 1 em square, glyph 2 = wide symbol box.
const List<(int, int, int)> _ranges = <(int, int, int)>[
  (0x1100, 0x11FF, 1), // Hangul Jamo
  (0x2190, 0x2BFF, 2), // arrows, math, technical (⏳ ⏸), symbols (⛔ ★),
  //                      dingbats (✓ ✗), supplemental arrows (⤓)
  (0x2E80, 0x2FFF, 1), // CJK radicals
  (0x3000, 0x303F, 1), // CJK punctuation
  (0x3040, 0x30FF, 1), // Hiragana, Katakana
  (0x3100, 0x33FF, 1), // Bopomofo … CJK compatibility
  (0x3400, 0x4DBF, 1), // CJK extension A
  (0x4E00, 0x9FFF, 1), // CJK unified ideographs
  (0xA960, 0xA97F, 1), // Hangul Jamo extended-A
  (0xAC00, 0xD7AF, 1), // Hangul syllables
  (0xF900, 0xFAFF, 1), // CJK compatibility ideographs
  (0xFE30, 0xFE4F, 1), // CJK compatibility forms
  (0xFF00, 0xFFEF, 1), // halfwidth / fullwidth forms
  (0x1F000, 0x1FAFF, 2), // emoji (🚫 📥 📤 …)
  (0x20000, 0x2FFFF, 1), // CJK extensions B…
];

Future<void> loadSquareFallbackFace() async {
  final FontLoader loader = FontLoader(kSquareFallbackFamily);
  loader.addFont(Future<ByteData>.value(ByteData.sublistView(_buildFont())));
  await loader.load();
}

class _W {
  final BytesBuilder b = BytesBuilder();
  void u8(int v) => b.addByte(v & 0xFF);
  void u16(int v) {
    u8(v >> 8);
    u8(v);
  }

  void u32(int v) {
    u16(v >> 16);
    u16(v);
  }

  void i16(int v) => u16(v < 0 ? v + 0x10000 : v);
  Uint8List get bytes => b.toBytes();
}

Uint8List _rectGlyph(int w) {
  final _W g = _W()
    ..i16(1) // one contour
    ..i16(0)
    ..i16(0)
    ..i16(w)
    ..i16(800)
    ..u16(3) // endPts
    ..u16(0); // no instructions
  for (int i = 0; i < 4; i++) {
    g.u8(0x01); // on curve, 16-bit deltas
  }
  for (final int dx in <int>[0, w, 0, -w]) {
    g.i16(dx);
  }
  for (final int dy in <int>[0, 0, 800, 0]) {
    g.i16(dy);
  }
  final Uint8List out = g.bytes;
  return out.length.isEven ? out : Uint8List.fromList(<int>[...out, 0]);
}

Uint8List _buildFont() {
  final Uint8List g1 = _rectGlyph(_square);
  final Uint8List g2 = _rectGlyph(_wide);
  final Uint8List glyf = Uint8List.fromList(<int>[...g1, ...g2]);
  final _W loca = _W()
    ..u32(0)
    ..u32(0)
    ..u32(g1.length)
    ..u32(g1.length + g2.length);

  final _W head = _W()
    ..u32(0x00010000)
    ..u32(0x00010000)
    ..u32(0) // checkSumAdjustment (not verified by the loaders)
    ..u32(0x5F0F3CF5)
    ..u16(0x000B)
    ..u16(_upm)
    ..u32(0)
    ..u32(0)
    ..u32(0)
    ..u32(0)
    ..i16(0)
    ..i16(-200)
    ..i16(_wide)
    ..i16(800)
    ..u16(0)
    ..u16(8)
    ..i16(2)
    ..i16(1) // long loca
    ..i16(0);

  final _W hhea = _W()
    ..u32(0x00010000)
    ..i16(930)
    ..i16(-240)
    ..i16(0)
    ..u16(_wide)
    ..i16(0)
    ..i16(0)
    ..i16(_wide)
    ..i16(1)
    ..i16(0)
    ..i16(0);
  for (int i = 0; i < 4; i++) {
    hhea.i16(0);
  }
  hhea
    ..i16(0)
    ..u16(3);

  final _W maxp = _W()
    ..u32(0x00010000)
    ..u16(3)
    ..u16(4)
    ..u16(1)
    ..u16(0)
    ..u16(0)
    ..u16(2)
    ..u16(0)
    ..u16(0)
    ..u16(0)
    ..u16(0)
    ..u16(0)
    ..u16(0)
    ..u16(0)
    ..u16(0);

  final _W hmtx = _W()
    ..u16(500)
    ..i16(0)
    ..u16(_square)
    ..i16(0)
    ..u16(_wide)
    ..i16(0);

  final _W os2 = _W()
    ..u16(4)
    ..i16(_square)
    ..u16(400)
    ..u16(5)
    ..u16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0)
    ..i16(0);
  for (int i = 0; i < 10; i++) {
    os2.u8(0); // panose
  }
  for (int i = 0; i < 4; i++) {
    os2.u32(0); // unicode ranges
  }
  os2
    ..u32(0x4E4F4E45) // vendor
    ..u16(0x40)
    ..u16(0x1100)
    ..u16(0xFFFF)
    ..i16(930)
    ..i16(-240)
    ..i16(0)
    ..u16(930)
    ..u16(240)
    ..u32(0)
    ..u32(0)
    ..i16(500)
    ..i16(800)
    ..u16(0)
    ..u16(0x20)
    ..u16(0);

  final _W post = _W()
    ..u32(0x00030000)
    ..u32(0)
    ..i16(-100)
    ..i16(50)
    ..u32(0)
    ..u32(0)
    ..u32(0)
    ..u32(0)
    ..u32(0);

  // name: family (1), subfamily (2), full (4), postscript (6) in UTF-16BE.
  final List<(int, String)> names = <(int, String)>[
    (1, kSquareFallbackFamily),
    (2, 'Regular'),
    (4, kSquareFallbackFamily),
    (6, kSquareFallbackFamily),
  ];
  final _W strs = _W();
  final _W name = _W()
    ..u16(0)
    ..u16(names.length)
    ..u16(6 + 12 * names.length);
  int off = 0;
  for (final (int id, String s) in names) {
    name
      ..u16(3)
      ..u16(1)
      ..u16(0x409)
      ..u16(id)
      ..u16(s.length * 2)
      ..u16(off);
    for (final int c in s.codeUnits) {
      strs.u16(c);
    }
    off += s.length * 2;
  }
  final Uint8List nameBytes = Uint8List.fromList(<int>[
    ...name.bytes,
    ...strs.bytes,
  ]);

  // Format 13 (many-to-one ranges): every code point of a range maps to
  // the SAME glyph. (Format 12 would map a range to consecutive glyph ids.)
  final _W sub = _W()
    ..u16(13)
    ..u16(0)
    ..u32(16 + 12 * _ranges.length)
    ..u32(0)
    ..u32(_ranges.length);
  for (final (int a, int z, int gid) in _ranges) {
    sub
      ..u32(a)
      ..u32(z)
      ..u32(gid);
  }
  final _W cmap = _W()
    ..u16(0)
    ..u16(2)
    ..u16(0)
    ..u16(4)
    ..u32(20)
    ..u16(3)
    ..u16(10)
    ..u32(20);
  final Uint8List cmapBytes = Uint8List.fromList(<int>[
    ...cmap.bytes,
    ...sub.bytes,
  ]);

  final Map<String, Uint8List> tables = <String, Uint8List>{
    'OS/2': os2.bytes,
    'cmap': cmapBytes,
    'glyf': glyf,
    'head': head.bytes,
    'hhea': hhea.bytes,
    'hmtx': hmtx.bytes,
    'loca': loca.bytes,
    'maxp': maxp.bytes,
    'name': nameBytes,
    'post': post.bytes,
  };
  final List<String> tags = tables.keys.toList()..sort();
  final _W font = _W()
    ..u32(0x00010000)
    ..u16(tags.length)
    ..u16(128)
    ..u16(3)
    ..u16(tags.length * 16 - 128);
  int offset = 12 + 16 * tags.length;
  final List<Uint8List> bodies = <Uint8List>[];
  for (final String t in tags) {
    final Uint8List body = tables[t]!;
    int sum = 0;
    final Uint8List padded = Uint8List((body.length + 3) & ~3)..setAll(0, body);
    final ByteData bd = ByteData.sublistView(padded);
    for (int i = 0; i < padded.length; i += 4) {
      sum = (sum + bd.getUint32(i)) & 0xFFFFFFFF;
    }
    for (final int c in t.codeUnits) {
      font.u8(c);
    }
    font
      ..u32(sum)
      ..u32(offset)
      ..u32(body.length);
    offset += padded.length;
    bodies.add(padded);
  }
  for (final Uint8List p in bodies) {
    font.b.add(p);
  }
  return font.bytes;
}
