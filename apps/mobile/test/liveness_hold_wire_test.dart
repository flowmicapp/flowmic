// The hold is applied to the ROW THE USER READS — not merely implemented.
//
// SPEC-REF: docs/strategy/2026-08-30-mobile-connection-state-determinism-design.md §2-4 H-5.
//
// 🔴 WHY THIS FILE EXISTS SEPARATELY FROM `liveness_hold_test.dart`. That file
// pins the rules and would stay green for as long as nobody called them — which
// is exactly what happened one week ago to the article collapse (0.3.47: the
// rules were right, the screen never ran them, every test green, the feature
// absent on the device). The rules and the wiring are two claims and they need
// two files.
//
// It asserts on the RENDERED WORD (0.2.53), because 「what does the row say」 is
// a question about the screen, not about a model.

import 'dart:io';

import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/liveness_hold.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

final AppStrings _zh = AppStrings(AppLocale.zh);

/// The projection the row computes, before the hold.
InstanceLivenessFace _round({
  required InstanceReach reach,
  PcPresence presence = PcPresence.unknown,
}) =>
    instanceLivenessFaceOf(
      reach: reach,
      answeringChannel: ServerChannel.cloudRelay,
      target: InstanceTarget.pc,
      pcPresence: presence,
    );

void main() {
  test('🔴 the production source applies the hold, and does so per row', () {
    // A source-level guard on the one line that matters, for the reason card
    // F10's own wiring guard gives: what is at risk here is a one-line
    // omission, and no widget test would notice it — every widget test builds
    // its own controller, so the hold would look wired in all of them.
    final String src = _read('lib/src/ui/connections_row_faces.dart');
    expect(src.contains('livenessHolds.observe('), isTrue,
        reason: 'the row must draw the HELD face, not this round\'s projection');
    expect(
      src.indexOf('final InstanceLivenessFace face = held.face;') > 0,
      isTrue,
      reason: 'and everything below — label, colour, dot — must read that one',
    );
    // The key is the row's own identity: one hold per row, or two paired PCs
    // would share one answer.
    expect(RegExp(r'observe\(\s*key,').hasMatch(src), isTrue);
  });

  test('H-1 through the real projection: a timed-out round keeps the word', () {
    // Drives `instanceLivenessFaceOf` — the same function the row calls — so a
    // change to which faces are conclusive is caught here too.
    final LivenessHold hold = LivenessHold();
    final InstanceLivenessFace onlineRound =
        _round(reach: InstanceReach.online, presence: PcPresence.online);
    expect(hold.observe(onlineRound, nowMs: 0).face,
        InstanceLivenessFace.pcOnline);

    // The 7.5 % case: the relay is serving, this attempt ran past its budget.
    final InstanceLivenessFace missed = _round(reach: InstanceReach.unanswered);
    expect(missed, InstanceLivenessFace.reachUnanswered,
        reason: 'the projection itself is unchanged — the hold is what is new');

    final HeldLiveness held = hold.observe(missed, nowMs: 10_000);
    expect(held.face, InstanceLivenessFace.pcOnline);
    expect(held.rechecking, isTrue);
  });

  test('the two words this row can say are still DIFFERENT words', () {
    // A regression guard on the copy the hold now keeps on screen for longer:
    // 「电脑已离线」 and 「问不到」 send a user to two different places, and the
    // hold makes each of them last longer, which makes conflating them worse
    // rather than cheaper.
    expect(_zh.pcOfflineChip, isNot(_zh.reachUnanswered));
    expect(_zh.relayUpPcUnknown, isNot(_zh.reachUnanswered));
    expect(_zh.offline, isNot(_zh.pcOfflineChip));
  });
}

String _read(String rel) {
  final File f = File(rel);
  expect(f.existsSync(), isTrue,
      reason: 'run from apps/mobile; this test reads the production source');
  return f.readAsStringSync();
}
