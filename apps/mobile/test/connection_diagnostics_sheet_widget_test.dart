// T-5b-mobile diagnostics sheet — 2026-08-01: the channel row upgraded from plain
// text to ChannelBadge (tokens.dart), the ONE icon+colour definition
// chat_header.dart / connections_page.dart also consume. No dedicated widget test
// existed for this sheet before this card; this is a focused first one, not a
// full behavioural suite (T-5b-mobile's own scope is covered by manual/owner UAT).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/connection_diagnostics_sheet.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

void main() {
  testWidgets('LAN channel row wears Icons.wifi, not Icons.cloud_outlined', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    session.serverChannel.value = ServerChannel.lan;
    addTearDown(session.dispose);
    final DestinationController destination = DestinationController();
    addTearDown(destination.dispose);
    final AppStrings strings = AppStrings.of(AppLocale.zh);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () => showConnectionDiagnostics(
                context,
                connection: ConnectionState.connected,
                session: session,
                destination: destination,
                strings: strings,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('本地局域网'), findsOneWidget);
    expect(find.byIcon(Icons.wifi), findsOneWidget);
    expect(find.byIcon(Icons.cloud_outlined), findsNothing);
  });

  testWidgets('cloud-relay channel row wears Icons.cloud_outlined, not Icons.wifi', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    session.serverChannel.value = ServerChannel.cloudRelay;
    addTearDown(session.dispose);
    final DestinationController destination = DestinationController();
    addTearDown(destination.dispose);
    final AppStrings strings = AppStrings.of(AppLocale.zh);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () => showConnectionDiagnostics(
                context,
                connection: ConnectionState.connected,
                session: session,
                destination: destination,
                strings: strings,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('云端中继'), findsOneWidget);
    expect(find.byIcon(Icons.cloud_outlined), findsOneWidget);
    expect(find.byIcon(Icons.wifi), findsNothing);
  });

  testWidgets('unknown channel (null) omits the row entirely — never a guess', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final PttSession session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    // serverChannel starts null (never probed) — the existing default.
    addTearDown(session.dispose);
    final DestinationController destination = DestinationController();
    addTearDown(destination.dispose);
    final AppStrings strings = AppStrings.of(AppLocale.zh);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () => showConnectionDiagnostics(
                context,
                connection: ConnectionState.connected,
                session: session,
                destination: destination,
                strings: strings,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text(strings.diagChannel), findsNothing);
    expect(find.byIcon(Icons.wifi), findsNothing);
    expect(find.byIcon(Icons.cloud_outlined), findsNothing);
  });
}
