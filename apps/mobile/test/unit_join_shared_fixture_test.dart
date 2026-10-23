// Book 08 §3 correction (2026-10-14, card POL-3 review): the phone's copy of the
// four-way row-seam rule against ONE shared fixture,
// verify/fixtures/seam-join-cases.json. The other readers: the Rust reference
// (apps/desktop/src-tauri/src/inject/delivery_spacing.rs cargo test), the PC
// capsule (apps/desktop/src/capsule/seam-join-parity.test.ts) and the relay
// (apps/server-core/test/pol3-unit-join-shared.test.ts). The relay sends the rows
// already on screen as read-only context for the next row's polish, joined the
// way this buffer joins them for the live view.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/stt/segment_buffer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final Map<String, dynamic> doc = jsonDecode(
    File('../../verify/fixtures/seam-join-cases.json').readAsStringSync(),
  ) as Map<String, dynamic>;
  final List<dynamic> cases = doc['cases'] as List<dynamic>;

  test('the shared fixture is not empty (a vacuous pass is not a pin)', () {
    expect(cases.length, greaterThanOrEqualTo(10));
  });

  for (final dynamic raw in cases) {
    final Map<String, dynamic> c = raw as Map<String, dynamic>;
    final String left = c['left'] as String;
    final String right = c['right'] as String;
    final String joiner = c['joiner'] as String;
    final bool pcSpace = c['pc_space'] as bool;
    test('${jsonEncode(left)} + ${jsonEncode(right)} -> ${jsonEncode(joiner)}', () {
      expect(SegmentBuffer.seamTakesSpace(left), pcSpace, reason: 'pc_space');
      expect(SegmentBuffer.joinerBetween(left, right), joiner);
      if (left.trim().isNotEmpty && right.trim().isNotEmpty && right == right.trimLeft()) {
        final SegmentBuffer b = SegmentBuffer();
        b.put(idx: 0, text: left, finalized: true);
        b.put(idx: 1, text: right, finalized: true);
        expect(b.joined, left + joiner + right);
      }
    });
  }
}
