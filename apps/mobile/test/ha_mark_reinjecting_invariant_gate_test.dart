// card H-a (ruling 2026-08-05, landed 2026-08-13) — the `markReinjecting` invariant
// gets a gate that goes red the day it drifts.
//
// SPEC-REF:
//   docs/decisions/2026-08-05-it18-leftover-items-rulings.md §H-a
//   apps/mobile/lib/src/timeline/timeline_store_inject_writeback.dart
//     (the IT-05 latch — its ENTIRE safety argument is the invariant below)
//   apps/mobile/lib/src/timeline/timeline_store.dart `markReinjecting`
//
// ── THE INVARIANT, in one sentence ──────────────────────────────────────────
// Every path that RE-ASKS the delivery question stamps
// `TimelineStore.markReinjecting` FIRST, and that stamp clears the previous
// verdict's bit (`cachedByVerdict: false`) and puts the row back to delivering —
// so the IT-05 one-way latch only ever catches a verdict NOBODY is waiting
// for. Both halves are load-bearing: lose the clearing half and the latch
// eats the answer the user just asked for; lose the coverage half (a new
// re-ask path that does not stamp) and that path's verdicts are eaten too.
//
// ── WHY A GATE, when the ruling's facts say the invariant "can be pinned in code" ──
// It HAS drifted once already, silently: `timeline_store.dart`'s doc asserted
// 「grep markReinjecting lib/ = one production call site」 while the truth was
// two (the correction block at that doc records it). Nothing structural noticed.
// The ruling: 「一个被别处当前提用的性质，必须有东西钉住它」 — this file is
// that thing. The latch's own behaviour tests live in
// late_verdict_terminal_row_test.dart (group ④); THIS file owns the
// invariant, so the two drift directions each have a named home.

import 'dart:io';

import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart'
    show Delivery, FlowMode;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

/// The complete production call-site enumeration, file → expected call count.
///
/// 🔴 THIS IS A TRIPWIRE, NOT A CONVENIENCE (the output-guard.ts `deliverText`
/// enumeration is the precedent, and its tripwire has already fired once and
/// worked). If the assertion below fails, DO NOT PATCH THE NUMBERS:
///   1. find the new/moved call site (`grep -rn "\.markReinjecting(" lib/`);
///   2. verify the new path stamps BEFORE it re-emits — that ordering is the
///      whole IT-05 latch argument (a fresh answer must find the row already
///      back at delivering);
///   3. only then update this map AND the prose in
///      timeline_store_inject_writeback.dart (「3 call sites / 2 files」) and
///      timeline_store.dart's markReinjecting doc — they state the same count
///      in words, and a count stated twice with one copy stale is how this
///      invariant drifted the first time.
const Map<String, int> kExpectedCallSites = <String, int>{
  // in-row ✗ resend (outboxResendEntry) + image resend (outboxResendImage).
  'lib/src/session/chat_outbox_host.dart': 2,
  // long-press deferred resend / resend after edit / banner resend — all funnel through runReInject.
  'lib/src/session/manual_delivery_reinject.dart': 1,
};

/// Strip `//` line comments (incl. `///` docs) so prose that NAMES the method
/// cannot count as a call — the same reason opensource-export's
/// stripFullLineComments exists. Inline `//` after code keeps the code half.
String _stripLineComments(String src) => src
    .split('\n')
    .map((String l) {
      final int at = l.indexOf('//');
      return at < 0 ? l : l.substring(0, at);
    })
    .join('\n');

TimelineEntry _pcVerdictSettledRow(TimelineStore store, String clientId) {
  store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    text: '这句话到了电脑上，但没能自动打出来',
  );
  final bool applied = store.applyInjectResult(
    correlationId: clientId,
    ok: false,
    wireMode: TimelineStore.kWireModeCached,
    failureReason: 'INJECT_SELF_WINDOW_NO_INPUT',
  );
  expect(applied, isTrue, reason: 'setup: the PC verdict must land');
  final TimelineEntry e = store.findByClientId(clientId)!;
  expect(e.cachedByVerdict, isTrue, reason: 'setup');
  return e;
}

void main() {
  group('H-a ① coverage: the re-ask paths are exactly the enumerated ones', () {
    test('production call sites of markReinjecting match the tripwire map', () {
      final Map<String, int> found = <String, int>{};
      final RegExp call = RegExp(r'\.markReinjecting\(');
      for (final FileSystemEntity f in Directory('lib').listSync(
        recursive: true,
      )) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        final int n =
            call.allMatches(_stripLineComments(f.readAsStringSync())).length;
        if (n > 0) found[f.path.replaceAll(r'\', '/')] = n;
      }
      expect(
        found,
        kExpectedCallSites,
        reason: 'the markReinjecting call-site set moved. Read the tripwire '
            'note on kExpectedCallSites BEFORE touching this map: a re-ask '
            'path that does not stamp first hands its verdicts to the IT-05 '
            'latch, which will silently eat them.',
      );
    });

    test('positive control: the scanner sees through what it scans', () {
      // A scanner that returned an empty map for everything would make the
      // enumeration test above compare {} to a non-empty map and fail — but a
      // scanner whose REGEX rotted while the map was edited to match could
      // pass forever. Feed it a known string instead.
      expect(
        RegExp(r'\.markReinjecting\(')
            .allMatches(_stripLineComments(
              'x.markReinjecting(id);\n// x.markReinjecting(id) in prose\n',
            ))
            .length,
        1,
        reason: 'code counts once, the commented copy not at all',
      );
    });
  });

  group('H-a ② behaviour: the stamp clears the bit the latch keys on', () {
    test('markReinjecting: back to delivering, verdict bit cleared, act stamped',
        () {
      final TimelineStore store = newTestStore();
      final TimelineEntry settled = _pcVerdictSettledRow(store, 'ha-1');

      final TimelineEntry? re = store.markReinjecting(settled.id);
      expect(re, isNotNull);
      expect(re!.status, EntryStatus.cached, reason: 'waiting again');
      expect(
        re.cachedByVerdict,
        isFalse,
        reason: 'THE invariant: the previous verdict\'s bit must be cleared '
            'BEFORE a fresh answer can return, or the IT-05 latch reads the '
            'new question as a late replay and eats its answer',
      );
      expect(re.lastResentAt, isNotNull, reason: 'the ACT is recorded');
      store.dispose();
    });

    test('…and therefore a fresh verdict lands instead of being latched', () {
      final TimelineStore store = newTestStore();
      final TimelineEntry settled = _pcVerdictSettledRow(store, 'ha-2');
      store.markReinjecting(settled.id);

      final bool applied = store.applyInjectResult(
        correlationId: 'ha-2',
        ok: true,
        pcName: 'dev-pc-a',
      );
      expect(applied, isTrue,
          reason: 'the latch may only catch answers nobody is waiting for');
      expect(store.findById(settled.id)!.status, EntryStatus.injected);
      store.dispose();
    });
  });
}
