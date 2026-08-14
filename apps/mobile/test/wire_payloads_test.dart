// Wire-payload contract test (WP-R3-1): audio:start carries the delivery field
// (default 'inject', §4.0 B), audio:start shape matches AudioStartSchema, and
// the three-way pairing entry parser (code / QR / cloud).
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §3-4;
//           docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 B.

import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('audio:start (AudioStartSchema + delivery)', () {
    test('defaults to delivery=inject', () {
      final json = const AudioStartPayload(
        mode: FlowMode.realtime,
        sourceLang: 'zh',
      ).toJson();
      expect(json['delivery'], 'inject');
      expect(json['sample_rate'], 16000);
      expect(json['channels'], 1);
      expect(json['encoding'], 'pcm_s16le');
      expect(json['mode'], 'realtime');
      expect(json['send_policy'], 'direct');
      expect(json['source_lang'], 'zh');
      expect(json.containsKey('target_lang'), isFalse);
    });

    test('record-only carries delivery=none', () {
      final json = const AudioStartPayload(
        mode: FlowMode.translate,
        sourceLang: 'zh',
        targetLang: 'en',
        delivery: Delivery.none,
      ).toJson();
      expect(json['delivery'], 'none');
      expect(json['mode'], 'translate');
      expect(json['target_lang'], 'en');
    });
  });

  group('pairing entry parser', () {
    test('a bare 4-digit code → short_code, no endpoint', () {
      final e = PairEntry.parse('1234');
      expect(e.payload.toJson(), <String, Object?>{'short_code': '1234'});
      expect(e.endpoint, isNull);
    });

    test('a QR URI → qr_payload with the endpoint extracted for dialling', () {
      const qr = 'flowmic://pair?endpoint=ws://192.0.2.5:41879&code=1234&channel=standalone';
      final e = PairEntry.parse(qr);
      expect(e.payload.toJson(), <String, Object?>{'qr_payload': qr});
      expect(e.endpoint, 'ws://192.0.2.5:41879');
    });

    test('a QR without a 4-digit code is rejected (fail-loud)', () {
      expect(
        () => PairEntry.parse('flowmic://pair?endpoint=ws://x&code=abc'),
        throwsFormatException,
      );
    });

    test('unrecognized input is rejected', () {
      expect(() => PairEntry.parse('not-a-code'), throwsFormatException);
    });

    test('cloud instance → cloud_instance:true, no code', () {
      final e = PairEntry.cloud();
      expect(e.payload.toJson(), <String, Object?>{'cloud_instance': true});
    });
  });

  // R6 T-3a. These mirror FROZEN schemas (protocol-schemas-inject.ts); the
  // assertions below are what keeps the mirror honest.
  group('inject:request (InjectRequestSchema)', () {
    // Today's stt direct-send call site still omits `mode`, but 卡 P removed
    // the F-2361 superRefine that used to make that look like a wire rule —
    // `mode` on a non-manual source is legal (see the test below). This case
    // only pins omission-when-unset, not a prohibition.
    test('direct-send: source stt, both correlation keys, mode omitted when unset',
        () {
      final json = const InjectRequestPayload(
        text: '明天下午三点开会',
        source: InjectSource.stt,
        injectOrigin: InjectOrigin.live,
        requestId: 'u0-123',
        entryId: 'loc_mobile_u0-123',
      ).toJson();
      expect(json, <String, Object?>{
        'text': '明天下午三点开会',
        'source': 'stt',
        // 🔴 L8 (owner 2026-08-02) — ALWAYS written, both values, never omitted.
        // This exact-map assertion is the reason to say it here: with a 0.2.48+
        // phone stamping unconditionally, an ABSENT key on the PC can only mean
        // "stripped on the way" (a relay older than this round strips unknown keys), and
        // that is the whole diagnosis. If a future "save a few bytes" refactor omits
        // `live`, this line is what goes red.
        'inject_origin': 'live',
        'request_id': 'u0-123',
        'entry_id': 'loc_mobile_u0-123',
        // 卡 M: `source_text` is the ONE row-transit field toJson never omits —
        // an explicit wire `null` IS a meaning (「no original, this IS the
        // words」), distinct from the key being absent. A caller (this one
        // included) that does not set it gets that default, not a dropped key.
        'source_text': null,
      });
    });

    // F-2361 used to reserve `mode` for source:'manual' only; 卡 P removed that
    // superRefine (same round as the comment block below). Manual send still
    // supplies `mode` at the call site — the stale part was only the claim that
    // the schema still enforces the pairing.
    test('manual send: mode rides along when the caller supplies it', () {
      final json = const InjectRequestPayload(
        text: '手动发送的内容',
        source: InjectSource.manual,
        injectOrigin: InjectOrigin.live,
        requestId: 'm0-999',
        mode: FlowMode.organize,
      ).toJson();
      expect(json['source'], 'manual');
      expect(json['mode'], 'organize');
      expect(json.containsKey('entry_id'), isFalse);
    });

    test('empty correlation ids are omitted, not sent blank (NonEmpty)', () {
      final json = const InjectRequestPayload(
        text: 'x',
        source: InjectSource.manual,
        injectOrigin: InjectOrigin.live,
        requestId: '',
        entryId: '',
      ).toJson();
      expect(json.containsKey('request_id'), isFalse);
      expect(json.containsKey('entry_id'), isFalse);
    });

    // 卡 P (protocol-schemas-inject.ts, row-transit round) REMOVED the
    // F-2361 superRefine this test used to pin ("mode is reserved for
    // source:'manual'"): the server no longer records a row keyed on `mode`,
    // so the second answer that clause was defending against does not exist
    // any more. There is now NO cross-field rule between `mode` and `source` —
    // every combination is legal — so this test's old name and its
    // `throwsA(AssertionError)` expectation are both stale. Rather than delete
    // it silently (a future reader would have no way to know this pairing was
    // ever checked, or why it stopped being), it is re-pointed at what is
    // actually still true: the combination is now ACCEPTED, on the wire, as-is.
    test('mode + non-manual source is LEGAL as of 卡 P — the F-2361 restriction '
        'on this pairing is GONE, not silently broken', () {
      expect(
        () => const InjectRequestPayload(
          text: 'x',
          source: InjectSource.stt,
          injectOrigin: InjectOrigin.live,
          mode: FlowMode.translate,
        ),
        returnsNormally,
      );
      final Map<String, Object?> json = const InjectRequestPayload(
        text: 'x',
        source: InjectSource.stt,
        injectOrigin: InjectOrigin.live,
        mode: FlowMode.translate,
      ).toJson();
      expect(json['source'], 'stt');
      expect(json['mode'], 'translate',
          reason: 'toJson is no longer gated to source:manual either');
    });

    // The OTHER superRefine rule — image_b64/image_mime bound to source:image —
    // is UNCHANGED and still enforced client-side. Not re-tested here (it has
    // its own coverage in image_send_test.dart / image_send_downscale_test.dart
    // via the real ImageSendController path); named so a reader does not read
    // the test above and assume ALL client-side asserts on this DTO are gone.
  });

  group('control:key (ControlKeySchema)', () {
    test('the wire field is `kind`, and chord kinds serialise by enum name', () {
      expect(
        const ControlKeyPayload(ControlKeyKind.backspace).toJson(),
        <String, Object?>{'kind': 'backspace'},
      );
    });

    // ── REQ-12-13 — device_label (04 册 F-3115, additive optional) ──────────
    test('device_label is OMITTED when the phone has none, never sent as ""', () {
      // `NonEmpty` refuses an empty string at the server boundary, and a boundary
      // refusal is ANONYMOUS (the frame dies as a zod error naming no field) — on
      // an event that has no result frame, that is a key press that silently does
      // nothing. Absence is a real state: an older phone, or a label not yet read.
      expect(
        const ControlKeyPayload(ControlKeyKind.clear).toJson(),
        <String, Object?>{'kind': 'clear'},
      );
      expect(
        const ControlKeyPayload(ControlKeyKind.clear, deviceLabel: '').toJson(),
        <String, Object?>{'kind': 'clear'},
      );
      expect(
        const ControlKeyPayload(ControlKeyKind.clear, deviceLabel: 'Pixel 8-3f2a')
            .toJson(),
        <String, Object?>{'kind': 'clear', 'device_label': 'Pixel 8-3f2a'},
      );
    });

    test('🔴 the frame carries NO target_pc_id — the absence is the ruling', () {
      // 15 册 §2.0-e / 04 册 F-3115: no queue means nothing re-derives "who it is right now"
      // at drain time (the shape the 串号 red line guards), and no result frame
      // means a mismatched address could only be refused SILENTLY. Pinned so that
      // "casually filling in an address" has to argue with a test rather than quietly ship a
      // silent drop.
      expect(
        const ControlKeyPayload(ControlKeyKind.undo, deviceLabel: 'x').toJson().keys,
        <String>['kind', 'device_label'],
      );
    });

    test('the whitelist is the SIX chords plus the SIX punctuation kinds', () {
      expect(
        ControlKeyKind.values.map(controlKeyWireName).toList(),
        <String>[
          'enter', 'backspace', 'undo', 'clear', 'tab', 'space',
          'punct_comma', 'punct_question', 'punct_exclamation',
          'punct_enumeration', 'punct_colon', 'punct_period',
        ],
      );
    });

    test('punctuation kinds serialise SNAKE_CASE, not the camelCase enum name', () {
      // Dart's enum name is `punctPeriod`; the server's zod enum is
      // `punct_period`. Sending the enum name would be rejected at the server
      // boundary — silently, from the phone's point of view, because control:key
      // has no result frame. This assertion is the only thing standing between
      // that and a key that does nothing forever.
      expect(
        const ControlKeyPayload(ControlKeyKind.punctPeriod).toJson(),
        <String, Object?>{'kind': 'punct_period'},
      );
      for (final ControlKeyKind k in ControlKeyKind.values) {
        if (controlKeyGlyph(k) == null) continue;
        expect(controlKeyWireName(k), startsWith('punct_'), reason: k.name);
        expect(controlKeyWireName(k), isNot(k.name), reason: k.name);
      }
    });

    test('the glyph table matches the protocol SSOT and carries no wire payload', () {
      expect(
        <ControlKeyKind, String?>{
          for (final ControlKeyKind k in ControlKeyKind.values) k: controlKeyGlyph(k),
        },
        <ControlKeyKind, String?>{
          ControlKeyKind.enter: null,
          ControlKeyKind.backspace: null,
          ControlKeyKind.undo: null,
          ControlKeyKind.clear: null,
          ControlKeyKind.tab: null,
          ControlKeyKind.space: null,
          ControlKeyKind.punctComma: '，',
          ControlKeyKind.punctQuestion: '？',
          ControlKeyKind.punctExclamation: '！',
          ControlKeyKind.punctEnumeration: '、',
          ControlKeyKind.punctColon: '：',
          ControlKeyKind.punctPeriod: '。',
        },
      );
      // The character never rides the wire — only the kind does.
      expect(
        const ControlKeyPayload(ControlKeyKind.punctComma).toJson().values.join(),
        isNot(contains('，')),
      );
    });
  });

  group('compose:start (ComposeStartSchema §3.4)', () {
    test('exactly three tasks, and 润色 is the FROZEN `draft_polish` literal — '
        'never `polish`, never the enum name', () {
      expect(
        ComposeTask.values.map((ComposeTask t) => t.wire).toList(),
        <String>['draft_polish', 'organize', 'translate'],
      );
      expect(ComposeTask.draftPolish.wire, isNot(ComposeTask.draftPolish.name));
    });

    test('draft:true always rides along — omitting it would declare the Tier-1 '
        'auto-compose intent, which INJECTS (F-2137)', () {
      final Map<String, Object?> json = const ComposeStartPayload(
        task: ComposeTask.draftPolish,
        sourceText: '帮我润色',
        requestId: 'c0-1',
      ).toJson();
      expect(json, <String, Object?>{
        'task': 'draft_polish',
        'source_text': '帮我润色',
        'draft': true,
        'request_id': 'c0-1',
      });
    });

    test('target_lang is omitted unless explicitly given (the server defaults '
        'translate to en — the phone hardcodes no language pair)', () {
      expect(
        const ComposeStartPayload(
          task: ComposeTask.translate,
          sourceText: 'x',
          requestId: 'c1-1',
        ).toJson().containsKey('target_lang'),
        isFalse,
      );
      expect(
        const ComposeStartPayload(
          task: ComposeTask.translate,
          sourceText: 'x',
          requestId: 'c1-1',
          targetLang: 'ja',
        ).toJson()['target_lang'],
        'ja',
      );
    });

    test('GA-01: source_lang and entry_id ride along only when the caller has '
        'them (a buffer run has neither)', () {
      final Map<String, Object?> buffer = const ComposeStartPayload(
        task: ComposeTask.translate,
        sourceText: 'x',
        requestId: 'c1-1',
      ).toJson();
      expect(buffer.containsKey('source_lang'), isFalse,
          reason: 'typed text was never heard — do not guess a language');
      expect(buffer.containsKey('entry_id'), isFalse,
          reason: 'a buffer run has no timeline row');

      final Map<String, Object?> utterance = const ComposeStartPayload(
        task: ComposeTask.translate,
        sourceText: '你好',
        requestId: 'u0-1',
        sourceLang: 'zh',
        targetLang: 'en',
        entryId: 'loc-abc',
      ).toJson();
      expect(utterance['source_lang'], 'zh');
      expect(utterance['entry_id'], 'loc-abc');
      expect(utterance['draft'], true,
          reason: 'an utterance run still forbids server-side commit/inject');
      // Empty strings are omitted, never sent as blanks the server must guess at.
      expect(
        const ComposeStartPayload(
          task: ComposeTask.organize,
          sourceText: 'x',
          requestId: 'c1-2',
          sourceLang: '',
          entryId: '',
        ).toJson().keys,
        isNot(contains('source_lang')),
      );
    });
  });

  group('compose reply parsing (Chunk/Done/Error)', () {
    test('each variant parses its required field and the request_id echo', () {
      final AiComposeChunk chunk = AiComposeChunk.tryFromJson(
        <String, Object?>{'delta': '片段', 'request_id': 'c0-1'},
      )!;
      expect(chunk.delta, '片段');
      expect(chunk.requestId, 'c0-1');

      final AiComposeDone done = AiComposeDone.tryFromJson(
        <String, Object?>{'output_text': '结果', 'task': 'organize'},
      )!;
      expect(done.outputText, '结果');
      expect(done.task, 'organize');
      expect(done.requestId, isNull, reason: 'absent echo is null, not empty');

      final AiComposeError err = AiComposeError.tryFromJson(
        <String, Object?>{'code': 'LLM_TIMEOUT', 'message': 'no response'},
      )!;
      expect(err.code, 'LLM_TIMEOUT');
      expect(err.message, 'no response');
    });

    test('an off-contract frame parses to null rather than a half-built event',
        () {
      expect(AiComposeChunk.tryFromJson(const <String, Object?>{}), isNull);
      expect(AiComposeDone.tryFromJson(const <String, Object?>{}), isNull);
      expect(
        AiComposeError.tryFromJson(const <String, Object?>{'code': ''}),
        isNull,
      );
    });
  });
}
