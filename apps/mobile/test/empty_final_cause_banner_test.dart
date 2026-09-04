// Card EMPTY-1 — 「the hold produced nothing, and the phone said nothing」.
//
// THE ACCOUNT (measured on real devices, 0.3.61): silence already raised
// 「No speech detected」 correctly. Chinese spoken with the spoken-language
// setting on French, LAN sidecar, `sherpa-local`, produced
// `{"gatedMs":3060,"voicedMs":1280}`, `stt.final.raw chars 0`, NO error frame
// — and NOTHING on screen: the 「Transcribing」 row simply disappeared. The
// server now says WHY on the final itself (`stt:final.empty_reason`), and this
// file is the join between that field and the glyphs a person can read.
//
// 🔴 WHY IT IS A WIRE-TO-RENDER FILE, not two unit tests. The class of defect
// this card fixes is precisely a green half-suite: a frame the controller
// parses, a queue entry a `buildChatBanners(…)` call with a hand-typed argument
// proves, and nothing asserting the hops between. w83_autostop_banner_test.dart
// paid for that lesson once; every row below pushes a REAL `stt:final` payload
// through the real transport and reads the result off the widget tree.
//
// ⚠️ WHAT A GREEN RUN PROVES, stated so it cannot be overread: the sentence is
// constructed, delivered, and rendered unclipped in the slot. It does not prove
// a person read it during a real recording — that half belongs to the device
// line.
//
// ─────────────────────────────────────────────────────────────────────────────
// REVERSE CONTROL — RUN, and it SAW RED (2026-09-04, machine dev-pc-a).
// Break: delete the `if (why == 'heard_no_words') return sttStallHeardNoWords;`
// arm from `sttStallBannerMessage` (the value then falls to the unknown-token
// line, which is what a build that shipped the field without its sentence would
// do). 1 red, 9 green, verbatim:
//   x THE MEASURED GAP: heard_no_words renders its own sentence
//       Expected: exactly one matching candidate
//         Actual: _DescendantWidgetFinder:<Found 0 widgets with text
//         "..." descending from widgets with type "BannerSlot": []>
//          Which: means none were found but one was expected
//         this is the run that showed NOTHING on a real device
// CONTROL ON THE CONTROL: the `no_voice`, pre-card and unknown-token rows all
// STAYED GREEN, so the break is one arm wide and the fallback still works —
// a suite that only proved 「some banner appears」 would have called it a pass.
// Restored afterwards; `REVERSE-CONTROL` residue grep = 0.
// ─────────────────────────────────────────────────────────────────────────────

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
// `ConnectionState` is also a Flutter widgets name; the show-list keeps the
// production one and leaves the framework's alone (banner_queue_test's pattern).
import 'package:flowmic/src/signaling/state_machine.dart'
    show ConnectionState, SttStall, SttStallReason;
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flowmic/src/ui/chat_banner_sources.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
// `hide ConnectionState`: Flutter exports a name of its own and the production
// enum is the one every row here means.
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

// The rendered rows read the DEFAULT UI locale, which is what `ChatFlowPage`
// paints with — asserting an English string against a zh-painted page finds
// nothing and looks exactly like a missing banner (measured while writing this
// file). The nine-locale rows below use the whole registry instead.
const AppStrings _zh = AppStringsZh();
const AppStrings _en = AppStringsEn();

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

/// Real PttSession + real ChatController + the production banner adapter. Only
/// the socket and the recorder are doubles, so every hop under test is shipped
/// code.
class _Rig {
  _Rig._();

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  static _Rig create() {
    final _Rig r = _Rig._();
    r.transport = FakeSocketTransport();
    r.session = newTestSession(
      transport: r.transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    r.store = newTestStore(owner: _FakeOwner('inst-empty1', 'Study PC'));
    r.destination = DestinationController();
    r.controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: r.session,
      store: r.store,
      destination: r.destination,
      syncGate: TimelineSyncGate(transport: r.transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    r.transport.pushStatus(SocketStatus.connected);
    return r;
  }

  BannerQueue banners(AppStrings s) => chatBannerSources(
    controller: controller,
    strings: s,
    onRetrySendFailure: null,
  );

  /// A TERMINAL `stt:final` carrying no text, byte-shaped as `SttFinalSchema`
  /// puts it on the wire. `emptyReason` omitted ⇒ the pre-card frame, which is
  /// also every relay and every server built before this card.
  void emptyFinal({String? emptyReason}) => transport.pushIncoming(
    FlowMicEvents.sttFinal,
    <String, Object?>{
      'text': '',
      'confidence': 0.0,
      'language': 'fr',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 3060,
      'empty_reason': ?emptyReason,
    },
  );

  /// A terminal `stt:error` — the frame that must keep OWNING the explanation.
  void sttError(String code) => transport.pushIncoming(
    FlowMicEvents.sttError,
    <String, Object?>{'code': code, 'message': 'x', 'retryable': false},
  );

  void teardownSync() {
    debugCancelBannerAutoHideTimers(controller);
    controller.dispose();
    destination.dispose();
    store.dispose();
  }
}

Finder _renderedBanner(String message) => find.descendant(
  of: find.byType(BannerSlot),
  matching: find.text(message),
);

/// After render, did this text overflow its own `maxLines` (= the user sees an
/// ellipsis instead of the sentence)? The 0.2.53 lesson: 1,259 tests were green
/// while the screen showed three letters, because they all read `Text.data`.
bool _clipped(WidgetTester tester, Finder f) =>
    tester.renderObject<RenderParagraph>(f).didExceedMaxLines;

/// Push one empty final through the real chain and return what the slot renders.
Future<void> _pumpEmptyFinal(
  WidgetTester tester,
  _Rig r, {
  String? emptyReason,
  String? errorFirst,
}) async {
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
  // Driven through the FSM rather than `await controller.pttDown()`: awaiting
  // the real PttSession chain inside testWidgets deadlocks (the scar
  // mic_permission_denial_widget_test.dart's header records).
  r.session.fsm.onPttDown();
  await tester.pump();
  if (errorFirst != null) {
    // The wire order the relay actually produces: a terminal `stt:error` lands
    // MID-PRESS, where the FSM latches it (`onSttTerminalError`, RECORDING arm)
    // and only surfaces it when the button is released. Pushing the error and
    // then skipping the release would test a state production never reaches.
    r.sttError(errorFirst);
    await tester.pump();
    r.session.fsm.onPttUp();
    await tester.pump();
  }
  r.emptyFinal(emptyReason: emptyReason);
  await tester.pump();
}

void _releaseTimers(_Rig r) {
  r.session.fsm.onJustDoneTimeout();
  r.controller.delivery.dispose();
  debugCancelBannerAutoHideTimers(r.controller);
  r.session.debugStopIdlePresencePoll();
}

void main() {
  setUp(DiagLog.instance.clear);

  // ── ① wire → rendered glyphs, one row per cause ──────────────────────────
  group('the empty final explains itself on screen', () {
    testWidgets('🔴 THE MEASURED GAP: heard_no_words renders its own sentence',
        (WidgetTester tester) async {
      final _Rig r = _Rig.create();
      addTearDown(() async {
        r.teardownSync();
        await r.session.dispose();
        await r.transport.close();
      });
      await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
      await tester.pump();
      r.session.fsm.onPttDown();
      await tester.pump();
      // Positive control for the finder: nothing is in the slot yet, so a hit
      // below is the frame talking and not a permanently-present widget.
      expect(_renderedBanner(_zh.sttStallHeardNoWords), findsNothing);

      r.emptyFinal(emptyReason: 'heard_no_words');
      await tester.pump();

      final Finder f = _renderedBanner(_zh.sttStallHeardNoWords);
      expect(f, findsOneWidget,
          reason: 'this is the run that showed NOTHING on a real device');
      // 🔴 The assertion lands on the RENDER RESULT, not on `Text.data`: a
      // sentence this long is exactly the shape 0.2.53 shipped as three letters.
      expect(_clipped(tester, f), isFalse);
      // …and it is NOT the sentence that says we heard nothing, which would send
      // the user to shout at a microphone that was working.
      expect(_renderedBanner(_zh.sttStallMessage(SttStallReason.emptyTranscript)),
          findsNothing);
      _releaseTimers(r);
    });

    testWidgets('no_voice keeps the pre-card sentence, byte for byte',
        (WidgetTester tester) async {
      final _Rig r = _Rig.create();
      addTearDown(() async {
        r.teardownSync();
        await r.session.dispose();
        await r.transport.close();
      });
      await _pumpEmptyFinal(tester, r, emptyReason: 'no_voice');
      final Finder f =
          _renderedBanner(_zh.sttStallMessage(SttStallReason.emptyTranscript));
      expect(f, findsOneWidget);
      expect(_clipped(tester, f), isFalse);
      _releaseTimers(r);
    });

    testWidgets('a PRE-CARD frame (no empty_reason) is unchanged',
        (WidgetTester tester) async {
      // The compat direction that matters: an old relay strips the field, and
      // the phone must land exactly where it was rather than in a third state.
      final _Rig r = _Rig.create();
      addTearDown(() async {
        r.teardownSync();
        await r.session.dispose();
        await r.transport.close();
      });
      await _pumpEmptyFinal(tester, r);
      expect(_renderedBanner(_zh.sttStallMessage(SttStallReason.emptyTranscript)),
          findsOneWidget);
      _releaseTimers(r);
    });

    testWidgets('an UNKNOWN reason gets the honest line and the bare token',
        (WidgetTester tester) async {
      // A newer server, or a value added after this build shipped. Inventing a
      // sentence for it would be the 0.2.53 defect with the blame reversed: a
      // confident cause nobody verified.
      const String future = 'a_reason_from_2027';
      final _Rig r = _Rig.create();
      addTearDown(() async {
        r.teardownSync();
        await r.session.dispose();
        await r.transport.close();
      });
      await _pumpEmptyFinal(tester, r, emptyReason: future);
      final Finder f = _renderedBanner(_zh.sttStallEmptyReasonUnknown(future));
      expect(f, findsOneWidget);
      expect(_clipped(tester, f), isFalse);
      expect(_zh.sttStallEmptyReasonUnknown(future), contains(future),
          reason: 'the raw token is the only thing we can honestly show');
      _releaseTimers(r);
    });

    testWidgets('PAIRED — a named refusal still owns the slot',
        (WidgetTester tester) async {
      // The server leaves `empty_reason` off when an `stt:error` already spoke,
      // and the phone's own `namedRefusalHolds` guard keeps the named sentence.
      // Both halves are asserted here because either one alone would let the
      // vaguer sentence win on the frame ordering the relay actually produces.
      final _Rig r = _Rig.create();
      addTearDown(() async {
        r.teardownSync();
        await r.session.dispose();
        await r.transport.close();
      });
      await _pumpEmptyFinal(tester, r, errorFirst: 'STT_NETWORK_DROP');
      expect(_renderedBanner(_zh.sttStallNetworkDrop), findsOneWidget);
      expect(_renderedBanner(_zh.sttStallMessage(SttStallReason.emptyTranscript)),
          findsNothing);
      _releaseTimers(r);
    });
  });

  // ── ② the four codes that used to reach the bilingual registry fallback ───
  group('registered engine codes now have phone copy', () {
    const List<String> codes = <String>[
      'STT_NETWORK_DROP',
      'STT_ENGINE_AUTH_FAIL',
      'STT_ENGINE_RATE_LIMITED',
      'STT_ENGINE_TIMEOUT',
    ];

    test('each code renders its own sentence in every UI locale', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final Map<String, String> byCode = <String, String>{
          'STT_NETWORK_DROP': s.sttStallNetworkDrop,
          'STT_ENGINE_AUTH_FAIL': s.sttStallEngineAuthFail,
          'STT_ENGINE_RATE_LIMITED': s.sttStallEngineRateLimited,
          'STT_ENGINE_TIMEOUT': s.sttStallEngineTimeout,
        };
        for (final String code in codes) {
          final BannerQueue q = buildChatBanners(
            connection: ConnectionState.connected,
            autoStopped: false,
            strings: s,
            sttStalled: SttStall(SttStallReason.engineError, code: code),
          );
          expect(q.top?.id, BannerIds.sttStall, reason: '$locale/$code');
          expect(q.top!.message, byCode[code], reason: '$locale/$code');
          // Never the labelled raw identifier, which is what these four used to
          // fall back to in seven of the nine languages.
          expect(q.top!.message, isNot(contains(code)), reason: '$locale/$code');
        }
        // Four codes, four distinct sentences — the whole point is that the
        // actions differ (check the network / check a key / wait / say it again).
        expect(byCode.values.toSet(), hasLength(4), reason: '$locale');
      }
    });
  });

  // ── ③ nine-locale completeness for everything this card added ────────────
  group('nine-locale completeness', () {
    test('every new sentence exists, is non-empty, and is not the English one '
        'in a non-English locale', () {
      const String token = 'a_reason_from_2027';
      final Map<String, String Function(AppStrings)> added =
          <String, String Function(AppStrings)>{
        'sttStallHeardNoWords': (AppStrings s) => s.sttStallHeardNoWords,
        'sttStallEmptyReasonUnknown': (AppStrings s) =>
            s.sttStallEmptyReasonUnknown(token),
        'sttStallNetworkDrop': (AppStrings s) => s.sttStallNetworkDrop,
        'sttStallEngineAuthFail': (AppStrings s) => s.sttStallEngineAuthFail,
        'sttStallEngineRateLimited': (AppStrings s) => s.sttStallEngineRateLimited,
        'sttStallEngineTimeout': (AppStrings s) => s.sttStallEngineTimeout,
      };
      expect(AppLocale.values, hasLength(9),
          reason: 'the registry is the source of truth for how many there are');
      for (final MapEntry<String, String Function(AppStrings)> e in added.entries) {
        final String base = e.value(_en);
        expect(base.trim(), isNotEmpty, reason: e.key);
        for (final AppLocale locale in AppLocale.values) {
          final String v = e.value(AppStrings.of(locale));
          expect(v.trim(), isNotEmpty, reason: '${e.key}/$locale');
          if (locale != AppLocale.en) {
            // 🔴 A generated catalogue FALLS BACK to English structurally, so a
            // leaf nobody translated compiles and reads fine — an equality with
            // the base string is the only thing that can tell 「translated」 from
            // 「fell back」, and it is the whole reason this row exists.
            expect(v, isNot(base), reason: '${e.key}/$locale fell back to en');
          }
        }
      }
      // The parameterised one must carry the token through in every language —
      // a translation that drops `$reason` turns the honest line into a shrug.
      for (final AppLocale locale in AppLocale.values) {
        expect(AppStrings.of(locale).sttStallEmptyReasonUnknown(token),
            contains(token), reason: '$locale');
      }
    });

    test('heard_no_words is a different sentence from "no speech was heard"', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.sttStallHeardNoWords,
            isNot(s.sttStallMessage(SttStallReason.emptyTranscript)),
            reason: '$locale — one says we heard nothing, the other says we '
                'heard something and could not read it');
      }
    });
  });

  // ── ④ the mapping in isolation, keyed on the WIRE value ──────────────────
  group('sttStallBannerMessage — the empty-final arm', () {
    test('null and no_voice map to the SAME pre-card sentence', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String pre = s.sttStallMessage(SttStallReason.emptyTranscript);
        expect(
            s.sttStallBannerMessage(
                const SttStall(SttStallReason.emptyTranscript)),
            pre,
            reason: '$locale');
        expect(
            s.sttStallBannerMessage(const SttStall(
                SttStallReason.emptyTranscript,
                emptyReason: 'no_voice')),
            pre,
            reason: '$locale');
      }
    });

    test('an empty_reason on a NON-empty-final stall is ignored', () {
      // The field only means something for `emptyTranscript`. A timeout stall
      // that somehow carried one must not be re-narrated by it.
      final AppStrings s = AppStrings.of(AppLocale.en);
      expect(
          s.sttStallBannerMessage(const SttStall(SttStallReason.timeout,
              emptyReason: 'heard_no_words')),
          s.sttStallMessage(SttStallReason.timeout));
    });
  });
}
