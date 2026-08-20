// The instance list re-probes itself while it is on screen, and stops the
// instant it is not.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/connections_page.dart (`_presencePoll`)
//   apps/mobile/lib/src/session/pc_presence.dart
//     ([kInstanceListPresencePollInterval])
//
// 🔴 THE DEFECT. `ConnectionsController.refreshReachability` had no timer at
// all — its only callers were `initState`, returning from chat, returning from
// the background, and the pull gesture. So a computer that came online twenty
// seconds after launch, or a row that lost one probe to a stall, stayed painted
// wrong **until the user happened to think of pulling down**. A status word
// whose only correction is a gesture the user has to guess at is not answering
// 「此刻」 ("right now").
//
// 🔴 WHY THE SECOND HALF (cancel-on-dispose) IS ITS OWN ASSERTION AND NOT AN
// AFTERTHOUGHT. A leaked periodic timer on THIS route is not a tidiness
// problem: every tick carries the pairing's bearer token to a server, forever,
// behind a screen nobody is watching. `flutter_test` does fail a test that
// leaves a pending timer — but that failure reads as an infrastructure
// complaint and is routinely papered over with an escape hatch, which is
// exactly how a leak survives. So this file asserts the OBSERVABLE
// consequence: after the page is gone, time passing produces no further
// requests.
//
// ── REVERSE CONTROLS (both executed 2026-08-16, observed — not reasoned) ─────
// Break A — delete `_presencePoll?.cancel()` from
// `_ConnectionsPageState.dispose` (connections_page.dart), leaving the `= null`
// so the field still looks tended.
//   'the tick dies with the page — no request after dispose'  went RED with
//     Expected: <2>  Actual: <6>
//   i.e. the four ticks that ran after the page was gone, each one a bearer
//   token on the wire for a screen that no longer exists. That is the defect
//   itself, not an incidental failure.
//   ⚠️ 'the list keeps asking…' also went red under this break, but for an
//   INCIDENTAL reason (flutter_test's pending-timer check at teardown, since
//   nothing cancels the timer any more). Recorded here so nobody counts it as
//   evidence: only the `2 vs 6` failure is evidence for Break A.
//
// Break B — arm the timer with `const Duration(days: 1)` instead of
// [kInstanceListPresencePollInterval], i.e. a page that never re-probes, which
// is the behaviour that existed before this card.
//   'the list keeps asking while it is on screen (no pull needed)' went RED with
//     Expected: a value greater than <1>
//       Actual: <1>
//       a tick must re-ask without any user gesture
//   — the launch probe fired and nothing ever corrected it, which is exactly
//   what owner would be looking at.
// Both restored, re-run: 4/4 green.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/ui/connections_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Counts every presence question that actually left the page.
class _CountingPresence {
  int asks = 0;
  Future<PcPresenceReading> read(Uri u, String t, Duration d) async {
    asks++;
    return const PcPresenceReading(presence: PcPresence.online, pcId: 'pc-1');
  }
}

MobileSession _seeded() => const MobileSession(
  token: 'tok-seeded-00000000000000000000',
  endpoint: 'http://192.168.1.5:41879',
  channel: 'standalone',
  pcName: 'Studio PC',
  pairingId: 'pair-seed',
  pcId: 'pc-1',
);

Future<HealthReading> _reachable(Uri url, Duration timeout) async =>
    const HealthReading(ok: true, channel: ServerChannel.lan);

Future<({Widget app, _CountingPresence presence})> _rig() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  await appSettings.load();
  appSettings.setLocale(AppLocale.en);
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(_seeded());
  final FakeSocketTransport t = FakeSocketTransport();
  final PttSession session = PttSession(
    transport: t,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  final LoginController login = newTestLogin(transport: session.transport);
  final _CountingPresence presence = _CountingPresence();
  final ConnectionsController connections = ConnectionsController(
    session: session,
    login: login,
    healthReader: _reachable,
    presenceReader: presence.read,
  );
  return (
    app: MaterialApp(
      home: ConnectionsPage(
        connections: connections,
        appSettings: appSettings,
        login: login,
        destination: DestinationController(),
        chatPageBuilder: () => const Scaffold(body: Text('CHAT')),
        settingsPageBuilder: () => const Scaffold(body: Text('SETTINGS')),
        historyPageBuilder: () => const Scaffold(body: Text('HISTORY')),
        updateListenable: ValueNotifier<bool>(false),
        hasUpdate: () => false,
      ),
    ),
    presence: presence,
  );
}

void main() {
  testWidgets('🔴 the list keeps asking while it is on screen (no pull needed)', (
    WidgetTester tester,
  ) async {
    final r = await _rig();
    await tester.pumpWidget(r.app);
    await tester.pumpAndSettle();
    final int afterLaunch = r.presence.asks;
    expect(afterLaunch, greaterThan(0), reason: 'the launch probe still runs');

    // One tick's worth of time, with nobody touching the phone.
    await tester.pump(kInstanceListPresencePollInterval);
    await tester.pumpAndSettle();
    expect(
      r.presence.asks,
      greaterThan(afterLaunch),
      reason: 'a tick must re-ask without any user gesture',
    );

    final int afterOne = r.presence.asks;
    await tester.pump(kInstanceListPresencePollInterval);
    await tester.pumpAndSettle();
    expect(
      r.presence.asks,
      greaterThan(afterOne),
      reason: 'and it must keep asking, not fire once',
    );

    // Leave the page so the periodic timer is cancelled before teardown.
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('GONE'))));
    await tester.pumpAndSettle();
  });

  testWidgets('🔴 the tick dies with the page — no request after dispose', (
    WidgetTester tester,
  ) async {
    final r = await _rig();
    await tester.pumpWidget(r.app);
    await tester.pumpAndSettle();
    await tester.pump(kInstanceListPresencePollInterval);
    await tester.pumpAndSettle();
    expect(r.presence.asks, greaterThan(0));

    // Replace the tree: `_ConnectionsPageState.dispose` runs.
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('GONE'))));
    await tester.pumpAndSettle();
    final int atDispose = r.presence.asks;

    // 🔴 Four ticks' worth of time with the page gone. Every one of these would
    // have carried this pairing's bearer token to a server on behalf of a
    // screen that no longer exists.
    await tester.pump(kInstanceListPresencePollInterval * 4);
    await tester.pumpAndSettle();
    expect(
      r.presence.asks,
      atDispose,
      reason: 'a cancelled timer must produce exactly zero further requests',
    );
  });

  test('the cadence is slower than the in-session poll, deliberately', () {
    // The list asks about N pairings per tick; the session poll asks about one.
    // Matching the numbers would look tidy and would quietly multiply traffic.
    expect(kInstanceListPresencePollInterval, const Duration(seconds: 15));
    expect(
      kInstanceListPresencePollInterval,
      greaterThan(kIdlePcPresencePollInterval),
    );
  });

  test('🔴 one full retry cycle still fits inside one tick', () {
    // Otherwise a stalled tick would still be running when the next one starts.
    // `refreshReachability` is re-entrant-safe per target, so the overlap would
    // not corrupt anything — it would just mean the list quietly stops honouring
    // its own cadence, which is the kind of drift nobody notices.
    expect(
      kInstanceListPresenceBudget.worstCase,
      lessThan(kInstanceListPresencePollInterval),
    );
  });
}
