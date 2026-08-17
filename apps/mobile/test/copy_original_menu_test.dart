// 🔴 WP3 C15 (owner 2026-08-17) — 「Copy original text」 in the history
// long-press menu, offered ONLY where a distinct original exists.
//
// The card's own trap, spelled out so this file guards it rather than assumes
// it: the item's purpose is to copy the original BEHIND a translated or
// organized result. In realtime there is no original distinct from what is
// shown, so an always-present item would copy the same string under a name
// that promises something else. The gate is therefore the ROW's own
// `showsSourceLine` (「this entry has a source that differs from what is
// displayed」), never the session's current mode — a history list holds rows
// from several modes, and the mode at capture time is already stamped on the
// row as `processMode`.
//
// Four things asserted here, in four groups:
//   ① the gate: present on a processed row with a distinct source; ABSENT on a
//      realtime row (reverse control), on a processed row with no stored
//      original (nullable field — old rows predate it), and on a processed row
//      whose output equals its source.
//   ② the value: what lands on the clipboard is `source_text` (immutable by
//      product red line), never the rendered face; and an empty source writes
//      NOTHING rather than overwriting the user's clipboard with ''.
//   ③ the wiring: through the REAL page (long-press → sheet → tap), the
//      clipboard receives the original — the closed-enum switch guarantees a
//      dispatcher case exists, but only this proves the case does the right thing.
//   ④ the 0.2.53 law: the menu row's label and sub-line assert on the RENDERED
//      result in all nine locales, with the same wrap-pressure shape as
//      rerun_copy_render_test.dart (its header explains why `didExceedMaxLines`
//      alone would be vacuous for this slot).
//
// ⚠️ Like every legibility file: Ahem font ⇒ the budget is conservative, the
// implication runs one way only (fits here ⇒ fits on a real phone).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/image_clipboard.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart' show InstanceOwnerProbe;
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/entry_context_menu.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// The narrowest phone this project targets (the card M6-1 measurement width).
const Size kPhone = Size(411 * 3, 890 * 3);

/// `entry_context_menu.dart` renders the sub-line at this size; the wrap test
/// needs it to know what 「one line」 is.
const double kSubFontSize = 10;

double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

/// Hand-built row. The four gate cases differ ONLY in the three fields the
/// gate reads (`processMode`, `sourceText`, `outputText`), so each test names
/// exactly what it varies.
TimelineEntry _entry({
  String? processMode,
  String? source,
  required String output,
}) {
  final DateTime now = DateTime.utc(2026, 8, 18, 9, 0);
  return TimelineEntry(
    id: 'loc_c15',
    clientId: 'c-c15',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: source,
    outputText: output,
    processMode: processMode,
    status: EntryStatus.injected,
    origin: 'paired',
    entryType: TimelineEntry.kTranscript,
    createdAt: now,
    updatedAt: now,
  );
}

/// Opens the real sheet through its real entry point and captures the chosen
/// action — the sheet's own class is private, and reaching past the entry
/// point would let this file pass on a widget the app never builds.
Widget _menuHost(
  TimelineEntry entry,
  AppStrings strings, {
  void Function(EntryAction?)? onClosed,
}) => MaterialApp(
  home: Scaffold(
    body: Builder(
      builder: (BuildContext context) => Center(
        child: TextButton(
          onPressed: () async {
            final EntryAction? a =
                await showEntryContextMenu(context, entry, strings: strings);
            onClosed?.call(a);
          },
          child: const Text('open'),
        ),
      ),
    ),
  ),
);

/// The page narrows history to the instance this phone is talking to, so the
/// seeded row must be OWNED by the paired session or it renders nowhere.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

void main() {
  final AppStrings zh = AppStrings.of(AppLocale.zh);

  group('① the gate is the row\'s own distinct source, not the mode', () {
    testWidgets(
        'a translate row with a distinct original offers the item, and tapping '
        'it chooses EntryAction.copyOriginal', (WidgetTester tester) async {
      EntryAction? chosen;
      await tester.pumpWidget(_menuHost(
        _entry(processMode: 'translate', source: '你好世界', output: 'hello world'),
        zh,
        onClosed: (EntryAction? a) => chosen = a,
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text(zh.entryCopyOriginal), findsOneWidget);
      // …right under plain copy, so the pair reads as one cluster.
      expect(find.text(zh.entryCopy), findsOneWidget);
      await tester.tap(find.text(zh.entryCopyOriginal));
      await tester.pumpAndSettle();
      expect(chosen, EntryAction.copyOriginal);
    });

    testWidgets(
        '🔴 reverse control: a realtime row (no distinct original) does NOT '
        'offer it', (WidgetTester tester) async {
      await tester.pumpWidget(_menuHost(
        _entry(processMode: null, source: '正文', output: '正文'),
        zh,
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      // The sheet itself is open (plain copy is there) — only OUR item is gone.
      expect(find.text(zh.entryCopy), findsOneWidget);
      expect(find.text(zh.entryCopyOriginal), findsNothing);
    });

    testWidgets(
        'a processed row with NO stored original (old rows predate the field) '
        'hides the item rather than copying nothing', (WidgetTester tester) async {
      await tester.pumpWidget(_menuHost(
        _entry(processMode: 'translate', source: null, output: 'hello world'),
        zh,
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text(zh.entryCopy), findsOneWidget);
      expect(find.text(zh.entryCopyOriginal), findsNothing);
    });

    testWidgets(
        'a processed row whose output EQUALS its source hides the item — there '
        'is nothing 「original」 to reveal', (WidgetTester tester) async {
      await tester.pumpWidget(_menuHost(
        _entry(processMode: 'organize', source: '一样的', output: '一样的'),
        zh,
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text(zh.entryCopy), findsOneWidget);
      expect(find.text(zh.entryCopyOriginal), findsNothing);
    });
  });

  group('② the value copied is source_text, never the rendered face', () {
    test('copyEntrySourceText hands the ORIGINAL to the clipboard', () async {
      final List<String> copied = <String>[];
      await copyEntrySourceText(
        _entry(processMode: 'translate', source: '你好世界', output: 'hello world'),
        text: (String t) async => copied.add(t),
      );
      expect(copied, <String>['你好世界']);
    });

    test('a null source writes NOTHING — never an empty string over what the '
        'user had on the clipboard', () async {
      final List<String> copied = <String>[];
      await copyEntrySourceText(
        _entry(processMode: 'translate', source: null, output: 'hello world'),
        text: (String t) async => copied.add(t),
      );
      await copyEntrySourceText(
        _entry(processMode: 'translate', source: '', output: 'hello world'),
        text: (String t) async => copied.add(t),
      );
      expect(copied, isEmpty);
    });
  });

  group('③ through the real page: long-press → sheet → tap → clipboard', () {
    late List<String> clipboard;

    setUp(() {
      clipboard = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform,
              (MethodCall call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard
              .add((call.arguments as Map<Object?, Object?>)['text']! as String);
        }
        return null;
      });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    testWidgets('the clipboard receives the original words, not the displayed '
        'translation', (WidgetTester tester) async {
      tester.view.physicalSize = kPhone;
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      transport.connectSucceeds = true;
      transport.ackQueue.add(<String, Object?>{
        'token': 'tok-c15-000000000000000000000000',
        'pc_id': 'pc-c15',
        'pc_name': 'Widget PC',
        'pc_instance_id': 'inst-c15',
      });
      final PairResult pair = await session.pair(
        PairEntry.parse('1234'),
        endpoint: 'ws://192.0.2.5:41879',
      );
      expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
      final ChatController controller = ChatController(
        outboxStore: newTestOutboxStore(),
        outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: newTestStore(owner: _SessionOwner(session)),
        destination: DestinationController(),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.direct),
      );
      addTearDown(() async {
        await controller.dispose();
        controller.destination.dispose();
        controller.store.dispose();
        await controller.session.dispose();
        await transport.close();
      });
      transport.pushStatus(SocketStatus.connected);

      // Seeded through the store's own builders rather than the PTT chain —
      // this test is about the menu wiring, and the store is the writer the
      // real chain funnels through anyway.
      final TimelineEntry seeded = controller.store.buildFromUtterance(
        clientId: 'c-c15-e2e',
        mode: FlowMode.translate,
        delivery: Delivery.inject,
        text: '你好世界',
      );
      controller.store.applyProcessed(seeded.id, 'hello world', FlowMode.translate);

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );
      await tester.pumpAndSettle();

      await tester.longPress(find.text('hello world').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text(zh.entryCopyOriginal));
      await tester.pumpAndSettle();

      expect(clipboard, <String>['你好世界'],
          reason: 'the item promises the ORIGINAL — the displayed translation '
              'is what plain copy is for');

      // Window C-5 escape hatch — a REAL pair() arms a periodic presence
      // Timer, and flutter_test checks pending timers before async teardown.
      controller.session.debugStopIdlePresencePoll();
    });
  });

  group('④ 0.2.53 law: the label and sub-line render in all nine locales', () {
    testWidgets('label never clipped; sub-line wraps where it is under '
        'pressure; at least one locale IS under pressure', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = kPhone;
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final List<AppLocale> pressured = <AppLocale>[];
      final TimelineEntry row =
          _entry(processMode: 'translate', source: '你好世界', output: 'hello world');

      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        await tester.pumpWidget(_menuHost(row, s));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();

        // The action's own NAME — it is what the user is choosing.
        final Finder label = find.text(s.entryCopyOriginal);
        expect(label, findsOneWidget, reason: '$locale');
        expect(_clipped(tester, label), isFalse,
            reason: '$locale label was eaten by an ellipsis');

        final Finder sub = find.text(s.entryCopyOriginalSub);
        expect(sub, findsOneWidget,
            reason: '$locale entryCopyOriginalSub did not render');
        final Text w = tester.widget<Text>(sub);
        final Size box = tester.getSize(sub);
        expect(box.width, lessThanOrEqualTo(411.0),
            reason: '$locale overflowed the screen');
        expect(_clipped(tester, sub), isFalse,
            reason: '$locale was eaten by an ellipsis');
        if (_intrinsicWidth(w) > box.width) {
          pressured.add(locale);
          // It did not fit on one line, so it must have WRAPPED — a layout
          // that dropped the wrap would report the same single-line height
          // while the tail of the sentence was gone.
          expect(box.height, greaterThan(kSubFontSize * 1.5),
              reason:
                  '$locale did not fit yet occupied only one line — where did '
                  'the second half go');
        }

        Navigator.of(tester.element(find.text('open'))).pop();
        await tester.pumpAndSettle();
      }

      expect(pressured, isNotEmpty,
          reason: 'no language\'s sentence is long enough to need a wrap — '
              'this test is blind to the regression it exists for');
    });
  });
}
