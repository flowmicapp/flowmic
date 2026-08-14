// REQ-12-10 — identity lane helpers (notes vs PC) + machine-uid stability.
// Design: docs/strategy/2026-08-12-req1210-connection-list-identity-design.md

import 'package:flowmic/src/ui/connection_card_identity.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('empty machine uid has no PC lane index (neutral, not inventing)', () {
    expect(ConnectionCardIdentity.machineLaneIndex(null), isNull);
    expect(ConnectionCardIdentity.machineLaneIndex(''), isNull);
  });

  test('same machine_uid always maps to the same lane index', () {
    const String uid = 'mach-office-pc-aaaa';
    expect(
      ConnectionCardIdentity.machineLaneIndex(uid),
      ConnectionCardIdentity.machineLaneIndex(uid),
    );
  });

  test('two different machine_uids can land on different lanes', () {
    // Not a guarantee for EVERY pair (hash collisions exist) — pin two known
    // strings that currently diverge. If a future hash change collapses them,
    // pick another pair rather than weaken the assertion to "might differ".
    final int? a = ConnectionCardIdentity.machineLaneIndex('machine-alpha-001');
    final int? b = ConnectionCardIdentity.machineLaneIndex('machine-beta-002');
    expect(a, isNotNull);
    expect(b, isNotNull);
    expect(a, isNot(b));
  });

  test('lane index stays inside 0..3', () {
    for (final String uid in <String>[
      'a',
      'mach-1',
      'xxxxxxxxxxxxxxxx',
      'dev-pc-a',
    ]) {
      final int? i = ConnectionCardIdentity.machineLaneIndex(uid);
      expect(i, inInclusiveRange(0, 3), reason: uid);
    }
  });

  test('notes and PC claim different lane keys', () {
    expect(
      ConnectionCardIdentity.laneKey(ConnectionCardKind.notesEntry, null),
      ConnectionCardIdentity.notesLaneKey,
    );
    expect(
      ConnectionCardIdentity.laneKey(ConnectionCardKind.notesSession, null),
      ConnectionCardIdentity.notesLaneKey,
    );
    expect(
      ConnectionCardIdentity.laneKey(ConnectionCardKind.pc, null),
      ConnectionCardIdentity.pcNeutralLaneKey,
    );
    final int i = ConnectionCardIdentity.machineLaneIndex('mach-x')!;
    expect(
      ConnectionCardIdentity.laneKey(ConnectionCardKind.pc, 'mach-x'),
      ConnectionCardIdentity.pcLaneKey(i),
    );
  });

  test('notes entry uses a thicker border than a plain PC card', () {
    expect(
      ConnectionCardIdentity.borderSide(ConnectionCardKind.notesEntry).width,
      greaterThan(
        ConnectionCardIdentity.borderSide(ConnectionCardKind.pc).width,
      ),
    );
  });
}
