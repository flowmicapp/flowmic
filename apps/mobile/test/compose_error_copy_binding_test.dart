// Card EMB-15 follow-up 2 — THE BINDING between the codes the server can send on
// the compose path and the phone's own compose copy table
// (`compose_strings.dart` `aiErrorCode`).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// `aiErrorCode` ended in `default: return code`. Any code without an arm went
// onto the banner as a bare identifier — internal vocabulary on screen, which
// the owner's 2026-08-22 rule forbids. It was a live defect the moment EMB-15
// made a visitor's FlowMic app, paired into a website voice-input room, get
// `WEB_EVENT_NOT_ALLOWED` back for translate/organize. `error_code_copy_binding_test.dart`
// does not see this table: it covers the `inject:result` codes only.
//
// Three things are pinned here:
//   1. the REAL banner widget (`BannerSlot`, fed by `buildChatBanners` exactly
//      as the chat page feeds it) shows the new sentence for
//      `WEB_EVENT_NOT_ALLOWED` and the generic sentence for a code nobody named,
//      in every locale and on both failure frames (a typed box run and a
//      spoken utterance); and never renders an identifier;
//   2. every code in [_composePathCodes] — each with the file:line of the place
//      the server (or the phone) raises it — either has an arm or is on the
//      explicit generic list;
//   3. the server files that raise compose-path codes are SCANNED, and a code
//      literal that is not in the table fails the test naming it, so a new code
//      cannot reach the phone unnoticed. (Anchors are also checked: each row's
//      file must still contain its code.)
//
// SPEC-REF:
//   apps/server-core/src/socket/handlers/compose.handler.ts
//   apps/mobile/lib/src/settings/strings/compose_strings.dart `aiErrorCode`
//   CLAUDE.md 红线 没有静默失败 / D-32 (every code needs its copy face)

import 'dart:io';

import 'package:flowmic/src/session/compose_gate.dart'
    show AiComposeFailure, AiComposeOutcome;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart' show ConnectionState;
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/banner_slot.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter/rendering.dart' show RenderParagraph;
import 'package:flutter_test/flutter_test.dart';

/// How the phone answers a compose-path code.
enum _Face {
  /// The code has its own arm in `aiErrorCode`.
  arm,

  /// Deliberately answered by the generic sentence (`aiErrorCode(null)`): the
  /// server can send it on this path, no user-actionable sentence exists for it,
  /// and a bare identifier is the one thing it must never become.
  generic,
}

class _ComposeCode {
  const _ComposeCode(this.code, this.face, this.anchor, this.file);
  final String code;
  final _Face face;

  /// Where the code is raised, `file:line`, measured 2026-09-29 on the EMB-15
  /// branch. The FILE is asserted (it must still mention the code); the line is
  /// documentation and is allowed to drift.
  final String anchor;
  final String file;
}

const String _srv = '../server-core/src';

/// Every code the compose path can send to the phone (`compose:error` event and
/// the ack), or that the phone raises itself into the same failure frame.
const List<_ComposeCode> _composePathCodes = <_ComposeCode>[
  _ComposeCode('AUTH_TOKEN_INVALID', _Face.arm,
      'socket/handlers/compose.handler.ts:123', '$_srv/socket/handlers/compose.handler.ts'),
  _ComposeCode('LLM_INVALID_MODEL', _Face.arm,
      'socket/handlers/compose.handler.ts:132 · compose/llm-config.ts:56,77,80,83,217,220',
      '$_srv/socket/handlers/compose.handler.ts'),
  _ComposeCode('WEB_EVENT_NOT_ALLOWED', _Face.arm,
      'socket/handlers/compose.handler.ts:169', '$_srv/socket/handlers/compose.handler.ts'),
  _ComposeCode('EMAIL_VERIFY_GRACE_EXPIRED', _Face.arm,
      'auth/verification-grace.ts:293', '$_srv/auth/verification-grace.ts'),
  _ComposeCode('QUOTA_EXCEEDED', _Face.arm,
      'billing/quota-guard.ts:130', '$_srv/billing/quota-guard.ts'),
  _ComposeCode('COMPOSE_OUTPUT_REJECTED', _Face.arm,
      'compose/llm/anthropic.ts:187 · compose/llm/openai-compatible.ts:201', '$_srv/compose/llm/anthropic.ts'),
  _ComposeCode('LLM_AUTH_FAIL', _Face.arm,
      'compose/llm/anthropic.ts:130,154 · compose/llm/openai-compatible.ts:112', '$_srv/compose/llm/anthropic.ts'),
  _ComposeCode('LLM_RATE_LIMITED', _Face.arm,
      'compose/llm/anthropic.ts:131,155 · compose/llm/openai-compatible.ts:113', '$_srv/compose/llm/anthropic.ts'),
  _ComposeCode('LLM_TIMEOUT', _Face.arm,
      'compose/orchestrator.ts:186 · compose/llm/anthropic.ts:140,157,209 · compose/llm/openai-compatible.ts:115',
      '$_srv/compose/orchestrator.ts'),
  _ComposeCode('LLM_PROBE_FAIL', _Face.arm,
      'engine/orchestrator.ts:71 (EngineNotWiredError, compose layer)', '$_srv/engine/orchestrator.ts'),
  _ComposeCode('SETTINGS_SCHEMA_INVALID', _Face.arm,
      'compose/scenario-context.ts:64', '$_srv/compose/scenario-context.ts'),
  // errorPayload() turns any non-ServerError throw inside the compose try block
  // into this code; it is not a compose-specific name and has no dedicated arm.
  _ComposeCode('SETTINGS_SYNC_FAIL', _Face.generic,
      'errors.ts:50 (errorPayload fallback, reached from compose.handler.ts catch)', '$_srv/errors.ts'),
];

/// Raised by the PHONE into the same failure frame
/// (`ai_compose_controller.dart:263`), so the server files never mention it.
const String _phoneRaised = 'COMPOSE_EMPTY_OUTPUT';

/// The server files scanned for code literals on the compose path.
const List<String> _scanned = <String>[
  '$_srv/socket/handlers/compose.handler.ts',
  '$_srv/compose/llm/anthropic.ts',
  '$_srv/compose/llm/openai-compatible.ts',
  '$_srv/compose/llm-config.ts',
  '$_srv/compose/scenario-context.ts',
  '$_srv/billing/quota-guard.ts',
];

final RegExp _literal = RegExp(r"""(?:\bcode:|\berror:|ServerError\()\s*'([A-Z][A-Z0-9_]{4,})'""");
final RegExp _identifierInText = RegExp(r'[A-Z]{2,}(?:_[A-Z0-9]+)+');
final RegExp _bareIdentifier = RegExp(r'^[A-Z_]{6,}$');

AiComposeOutcome _outcome(String code) =>
    AiComposeOutcome(reason: AiComposeFailure.serverError, code: code);

Future<List<String>> _bannerTexts(
  WidgetTester tester,
  AppStrings s,
  String code, {
  required bool spoken,
  bool neverSent = false,
}) async {
  final BannerQueue q = buildChatBanners(
    connection: ConnectionState.connected,
    autoStopped: false,
    strings: s,
    aiFailure: spoken ? null : _outcome(code),
    utteranceFailure: spoken ? _outcome(code) : null,
    utteranceFailureNeverSent: neverSent,
  );
  expect(q.top, isNotNull, reason: 'a compose failure must reach the banner');
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: BannerSlot(queue: q, strings: s))),
  );
  return tester
      .widgetList<Text>(find.byType(Text))
      .map((Text t) => t.data ?? t.textSpan?.toPlainText() ?? '')
      .toList();
}

void main() {
  group('the banner a person reads (real BannerSlot)', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);

      for (final bool spoken in <bool>[false, true]) {
        final String frame = spoken ? 'spoken utterance' : 'typed run';

        testWidgets('$locale · $frame · WEB_EVENT_NOT_ALLOWED shows its own sentence',
            (WidgetTester tester) async {
          final List<String> texts =
              await _bannerTexts(tester, s, 'WEB_EVENT_NOT_ALLOWED', spoken: spoken);
          final String own = s.aiErrorCode('WEB_EVENT_NOT_ALLOWED');
          expect(texts.any((String t) => t.contains(own)), isTrue,
              reason: 'banner must carry the new sentence "$own"; got $texts');
          expect(own, isNot(s.aiErrorCode(null)),
              reason: 'it must not be the generic sentence — it says why');
          for (final String t in texts) {
            expect(t, isNot(contains('WEB_EVENT_NOT_ALLOWED')), reason: 'no raw identifier');
            expect(_bareIdentifier.hasMatch(t), isFalse, reason: 'bare identifier rendered: $t');
            expect(_identifierInText.hasMatch(t), isFalse, reason: 'identifier inside text: $t');
          }
        });

        testWidgets('$locale · $frame · AUTH_TOKEN_INVALID shows the sign-in-again sentence',
            (WidgetTester tester) async {
          final List<String> texts =
              await _bannerTexts(tester, s, 'AUTH_TOKEN_INVALID', spoken: spoken);
          final String own = s.cloudError('AUTH_TOKEN_INVALID');
          expect(own, isNot(s.aiErrorCode(null)));
          expect(texts.any((String t) => t.contains(own)), isTrue,
              reason: 'banner must carry the sign-in sentence "$own"; got $texts');
          for (final String t in texts) {
            expect(t, isNot(contains('AUTH_TOKEN_INVALID')), reason: 'no raw identifier');
            expect(_identifierInText.hasMatch(t), isFalse, reason: 'identifier inside text: $t');
          }
        });

        testWidgets('$locale · $frame · an unknown code shows the generic sentence',
            (WidgetTester tester) async {
          const String unknown = 'SOME_CODE_NOBODY_NAMED';
          final List<String> texts = await _bannerTexts(tester, s, unknown, spoken: spoken);
          final String generic = s.aiErrorCode(null);
          expect(texts.any((String t) => t.contains(generic)), isTrue,
              reason: 'banner must carry the generic sentence "$generic"; got $texts');
          for (final String t in texts) {
            expect(t, isNot(contains(unknown)), reason: 'unknown code must not be shown');
            expect(_bareIdentifier.hasMatch(t), isFalse, reason: 'bare identifier rendered: $t');
            expect(_identifierInText.hasMatch(t), isFalse, reason: 'identifier inside text: $t');
          }
        });
      }

      test('$locale · a record-only utterance never shows an identifier either', () {
        for (final String code in <String>['WEB_EVENT_NOT_ALLOWED', 'SOME_CODE_NOBODY_NAMED']) {
          final String line = s.utteranceComposeError(_outcome(code), neverSent: true);
          expect(line, isNot(contains(code)), reason: code);
          expect(_identifierInText.hasMatch(line), isFalse, reason: line);
        }
      });
    }
  });

  // The WEB_EVENT_NOT_ALLOWED reason is a clause embedded in THREE frames
  // (typed run, spoken utterance, record-only utterance). The group above
  // renders the first two; this one renders all three in every locale at the
  // narrowest phone width (360dp) and a 1.3 text scale, and reads the laid-out
  // paragraph (not `Text.data`) so "the person can read the whole sentence" is
  // an assertion on the rendered result.
  group('the website-voice reason, three frames, 360dp at text scale 1.3', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final Map<String, ({bool spoken, bool neverSent})> frames =
          <String, ({bool spoken, bool neverSent})>{
        'typed run': (spoken: false, neverSent: false),
        'spoken utterance': (spoken: true, neverSent: false),
        'record-only utterance': (spoken: true, neverSent: true),
      };
      frames.forEach((String frame, ({bool spoken, bool neverSent}) f) {
        testWidgets('$locale · $frame · the real sentence fits, unclipped',
            (WidgetTester tester) async {
          tester.view.physicalSize = const Size(360, 900);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);

          final String own = s.aiErrorCode('WEB_EVENT_NOT_ALLOWED');
          final BannerQueue q = buildChatBanners(
            connection: ConnectionState.connected,
            autoStopped: false,
            strings: s,
            aiFailure: f.spoken ? null : _outcome('WEB_EVENT_NOT_ALLOWED'),
            utteranceFailure: f.spoken ? _outcome('WEB_EVENT_NOT_ALLOWED') : null,
            utteranceFailureNeverSent: f.neverSent,
          );
          await tester.pumpWidget(
            MaterialApp(
              home: MediaQuery(
                data: const MediaQueryData(
                  size: Size(360, 900),
                  textScaler: TextScaler.linear(1.3),
                ),
                child: Scaffold(body: BannerSlot(queue: q, strings: s)),
              ),
            ),
          );
          expect(tester.takeException(), isNull,
              reason: 'no overflow / layout exception at 360dp × 1.3');

          final Finder banner = find.byWidgetPredicate(
              (Widget w) => w is Text && (w.data ?? '').contains(own));
          expect(banner, findsOneWidget,
              reason: '$locale · $frame: the banner must carry "$own"');
          final RenderParagraph rp = tester.renderObject<RenderParagraph>(banner);
          expect(rp.didExceedMaxLines, isFalse, reason: 'the sentence must not be cut');
          expect(rp.size.width, lessThanOrEqualTo(360.0),
              reason: 'the paragraph must sit inside the 360dp screen');
          expect(tester.getRect(find.byType(BannerSlot)).right, lessThanOrEqualTo(360.0));
        });
      });
    }
  });

  group('every compose-path code has an answer', () {
    for (final _ComposeCode row in _composePathCodes) {
      test('${row.code} (${row.anchor})', () {
        final File f = File(row.file);
        expect(f.existsSync(), isTrue, reason: 'anchor file missing: ${row.file}');
        expect(f.readAsStringSync(), contains(row.code),
            reason: '${row.file} no longer mentions ${row.code}: the table row is stale');
        for (final AppLocale locale in AppLocale.values) {
          final AppStrings s = AppStrings.of(locale);
          final String sentence = s.aiErrorCode(row.code);
          expect(sentence, isNot(row.code), reason: '$locale: bare identifier for ${row.code}');
          expect(_bareIdentifier.hasMatch(sentence), isFalse, reason: '$locale: $sentence');
          expect(sentence.trim(), isNotEmpty);
          if (row.face == _Face.arm) {
            expect(sentence, isNot(s.aiErrorCode(null)),
                reason: '$locale: ${row.code} is listed as having an arm but reads as the generic sentence');
          } else {
            expect(sentence, s.aiErrorCode(null),
                reason: '$locale: ${row.code} is listed as generic but has its own sentence — move it to arm');
          }
        }
      });
    }

    test('COMPOSE_EMPTY_OUTPUT (raised by the phone, ai_compose_controller.dart:263) has an arm', () {
      expect(File('lib/src/session/ai_compose_controller.dart').readAsStringSync(),
          contains(_phoneRaised));
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.aiErrorCode(_phoneRaised), isNot(s.aiErrorCode(null)), reason: '$locale');
      }
    });

    test('a code the phone has never heard of gets the generic sentence, not itself', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        expect(s.aiErrorCode('SOME_CODE_NOBODY_NAMED'), s.aiErrorCode(null), reason: '$locale');
      }
    });
  });

  group('the server files are scanned for a code this table does not know', () {
    test('every code literal on the compose path is a row above', () {
      final Set<String> known = <String>{for (final _ComposeCode r in _composePathCodes) r.code};
      final Map<String, Set<String>> unknown = <String, Set<String>>{};
      for (final String path in _scanned) {
        final File f = File(path);
        expect(f.existsSync(), isTrue, reason: 'scanned file missing: $path');
        for (final RegExpMatch m in _literal.allMatches(f.readAsStringSync())) {
          final String code = m.group(1)!;
          if (!known.contains(code)) (unknown[code] ??= <String>{}).add(path);
        }
      }
      expect(unknown, isEmpty,
          reason: 'a compose-path code has no row in _composePathCodes (and so no decided phone copy): $unknown');
    });

    test('the scan is not blind: it finds the codes it is supposed to find', () {
      final String handler =
          File('$_srv/socket/handlers/compose.handler.ts').readAsStringSync();
      final Set<String> found = <String>{
        for (final RegExpMatch m in _literal.allMatches(handler)) m.group(1)!,
      };
      expect(found, containsAll(<String>['AUTH_TOKEN_INVALID', 'LLM_INVALID_MODEL', 'WEB_EVENT_NOT_ALLOWED']));
    });
  });
}
