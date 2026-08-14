// card B4-12 (15 册 G-16 local disposition) — human copy for the two 2026-08-01 cloud-image
// relay refusals (RV-87): INJECT_CLOUD_IMAGE_TOO_LARGE /
// INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED. Everything else the phone shows for a
// server error code is UNCHANGED by this card — that scope line is asserted
// below too, not just claimed in a comment.
//
// SPEC-REF:
//   packages/protocol/src/error-codes.ts (the two codes' zh/en sentences)
//   packages/protocol/src/constants.ts (CLOUD_IMAGE_BYTES_MAX /
//     CLOUD_IMAGE_QUOTA_MAX / CLOUD_IMAGE_QUOTA_WINDOW_MS — this phone's
//     mirror constants must track these; see the header comments on
//     kCloudImageQuotaMax / kCloudImageQuotaWindowHours in
//     settings/strings/image_strings.dart)
//   apps/mobile/lib/src/ui/chat_message_tile.dart (_reasonLineFor —
//     the one call site deciding whether the reason line shows and what it
//     says)
//
// ⚠️ TWO OF THE GROUPS BELOW ARE REVERSE CONTROLS and were each run against a
// deliberately broken implementation first (see the comment on each — the
// break and the restore are described in the delivery report, not repeated
// here). A negative/positive assertion that has never been seen to flip is
// not evidence.

import 'package:flowmic/src/session/image_payload.dart'
    show formatBytes, kCloudImageBytesMax;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

const AppStrings _zh = AppStringsZh();

const String kTooLarge = 'INJECT_CLOUD_IMAGE_TOO_LARGE';
const String kQuotaExceeded = 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED';

TimelineEntry _entry({
  required EntryStatus status,
  bool cachedByVerdict = false,
  String? failureReason,
  String id = 'loc_cloud_img',
}) {
  final DateTime now = DateTime.utc(2026, 8, 1, 12, 0);
  return TimelineEntry(
    id: id,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: null,
    outputText: '🖼 图片',
    status: status,
    origin: 'paired',
    // Both codes are image-only in production (cloud-image-policy.ts judges
    // `source === 'image'` exclusively) — kept realistic rather than
    // incidental, though [_reasonLineFor] itself does not branch on entryType.
    entryType: TimelineEntry.kImage,
    failureReason: failureReason,
    cachedByVerdict: cachedByVerdict,
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(TimelineEntry e, {AppStrings strings = _zh}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      queued: false,
      canResendImage: true,
      onRetry: (TimelineEntry _) {},
    ),
  ),
);

void main() {
  // ── ① AppStrings.cloudImageRelayErrorNote — the pure mapping ───────────────
  group('① cloudImageRelayErrorNote', () {
    test('🔴 numbers are pinned to this phone\'s own mirror constants', () {
      // These three integers are this file's manual-sync guard against
      // packages/protocol/src/constants.ts (Dart cannot import a TypeScript
      // module, so this is the only automated check available — same
      // limitation the pre-existing kCloudImageBytesMax mirror already had).
      // If protocol's CLOUD_IMAGE_BYTES_MAX / CLOUD_IMAGE_QUOTA_MAX /
      // CLOUD_IMAGE_QUOTA_WINDOW_MS ever move, this line and the constants in
      // image_strings.dart must move with them in the same edit.
      expect(kCloudImageBytesMax, 1048576);
      expect(kCloudImageQuotaMax, 200);
      expect(kCloudImageQuotaWindowHours, 24);
    });

    test('both notes quote the SAME numbers the constants hold, all four locales', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final String tooLarge = s.cloudImageRelayErrorNote(kTooLarge)!;
        // Derived, not a second literal: if kCloudImageBytesMax ever changes,
        // this assertion changes with it automatically.
        expect(tooLarge, contains(formatBytes(kCloudImageBytesMax)), reason: '$locale');
        final String quota = s.cloudImageRelayErrorNote(kQuotaExceeded)!;
        expect(quota, contains('$kCloudImageQuotaMax'), reason: '$locale');
        expect(quota, contains('$kCloudImageQuotaWindowHours'), reason: '$locale');
        // Says what the user can DO, in both branches (card requirement:「说清用户能做
        // 什么」) — not just that something was refused. One word per locale
        // that only appears in the "join the LAN" clause, so this is a real
        // check on that sentence rather than a coincidental substring match.
        // Nine-locale expansion (2026-08-14): a four-entry Map + `[locale]!` ⇒
        // exhaustive switch (the five new locales were originally a
        // null-assertion crash). The fr/es/de/ru translations all use the
        // word form 'LAN' directly; zh-TW uses 「區域網路」.
        final String lanWord = switch (locale) {
          AppLocale.zh => '局域网',
          AppLocale.zhTw => '區域網路',
          AppLocale.en => 'LAN',
          AppLocale.fr => 'LAN',
          AppLocale.es => 'LAN',
          AppLocale.de => 'LAN',
          AppLocale.ja => 'ローカルネットワーク',
          AppLocale.ko => '로컬 네트워크',
          AppLocale.ru => 'LAN',
        };
        expect(tooLarge, contains(lanWord), reason: '$locale tooLarge must name the fix');
        expect(quota, contains(lanWord), reason: '$locale quota must name a fix too');
      }
    });

    test('every OTHER code still returns null — this is not a general error-code table', () {
      // 🔴 card scope line: the card explicitly forbids translating every server code
      // as a side effect of this one. If this ever starts returning non-null
      // for an unrelated code, that is scope creep this test exists to catch.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final String code in <String>[
          'INJECT_PC_MISMATCH',
          'INJECT_PC_UNSPECIFIED',
          'INJECT_FOCUS_LOST',
          'INJECT_NO_TEXT_TARGET',
          'LINK_DOWN',
          'PC_BUSY',
          '',
        ]) {
          expect(s.cloudImageRelayErrorNote(code), isNull, reason: '$locale/$code');
        }
      }
    });
  });

  // ── ② the ACTUAL production shape: both codes settle `undelivered` ─────────
  //
  // relay.handler.ts `answerReject` always sends `mode:'cached'`, and neither
  // code is in `isTerminalRefusalCode` (outbox_item.dart) — retrying genuinely
  // can succeed (a different link, or the 24h window rolling), which is
  // clause ① of that predicate's own test. So `deliveryFaceOf` settles
  // `cached + cachedByVerdict` to `DeliveryFace.undelivered`, NEVER `refused`
  // or `failed`. Asserted here rather than assumed, because the whole reason
  // this card had to widen `_reasonLineFor` past ✗/⛔ is that 未投递 normally
  // shows NOTHING — not a raw identifier, NOTHING — so without that widening
  // this feature would have zero production callers.
  group('② the real wire shape — cached + cachedByVerdict, not failed/refused', () {
    test('both codes settle DeliveryFace.undelivered, confirming the face this card must speak on', () {
      for (final String code in <String>[kTooLarge, kQuotaExceeded]) {
        final TimelineEntry e = _entry(
          status: EntryStatus.cached,
          cachedByVerdict: true,
          failureReason: code,
        );
        expect(deliveryFaceOf(e, queued: false), DeliveryFace.undelivered, reason: code);
      }
    });

    testWidgets(
      '🔴 cloud quota exceeded ⇒ 📥未投递 + a human explanation + the 重发 button (not the raw code, and not blank)',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          _tile(_entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: kQuotaExceeded,
          )),
        );
        // positive control FIRST: the row renders at all, on the face production
        // actually uses.
        expect(find.textContaining(_zh.statusUndelivered), findsOneWidget);
        // The human sentence is there, in full (find.textContaining reads the
        // Text widget's own data, not the rendered/clipped glyphs, so this
        // still matches even though the row's Flexible+ellipsis would visually
        // truncate a sentence this long).
        expect(
          find.textContaining(_zh.cloudImageRelayErrorNote(kQuotaExceeded)!),
          findsOneWidget,
        );
        // The raw identifier is NOT what is shown.
        expect(find.textContaining(kQuotaExceeded), findsNothing);
        // 重发 stays offered — both codes are genuinely retryable (换局域网 /
        // 等待), which the sentence itself says.
        expect(
          find.byKey(const ValueKey<String>('entry.resend.loc_cloud_img')),
          findsOneWidget,
        );
      },
    );

    testWidgets('🔴 cloud image too large ⇒ also speaks in human words, not the raw code', (WidgetTester tester) async {
      await tester.pumpWidget(
        _tile(_entry(
          status: EntryStatus.cached,
          cachedByVerdict: true,
          failureReason: kTooLarge,
        )),
      );
      expect(find.textContaining(_zh.statusUndelivered), findsOneWidget);
      expect(
        find.textContaining(_zh.cloudImageRelayErrorNote(kTooLarge)!),
        findsOneWidget,
      );
      expect(find.textContaining(kTooLarge), findsNothing);
    });

    testWidgets(
      '⟲ reverse control: another undelivered code (INJECT_NOT_IN_ROOM) still gets no reason line — this card did not open the 未投递 face as a whole',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          _tile(_entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            // ⚠️ card F2 (2026-08-02) — **the sample code changed; the thing this
            // reverse control has to prove did not change by a single word.**
            // The original sample `INJECT_FOCUS_LOST` is now a PC-authored
            // injection-stage verdict ⇒ it lands on the 「已投递 · 未注入」 face,
            // and that face **prints the named code by design**. What this case
            // has to prove is 「the 待投递 face was not opened as a whole」, so
            // the sample must still land on 待投递:
            // `INJECT_NOT_IN_ROOM` (relay-authored, retryable, `mode:'cached'`).
            failureReason: 'INJECT_NOT_IN_ROOM',
          )),
        );
        expect(find.textContaining(_zh.statusUndelivered), findsOneWidget);
        expect(find.textContaining('INJECT_NOT_IN_ROOM'), findsNothing);
        // No stray '·' clause of any kind for this code — 未投递's ordinary
        // silence is exactly as before this card.
        expect(find.textContaining('· '), findsNothing);
      },
    );
  });

  // ── ③ defense in depth: IF a future change ever routed these two codes
  // through failed/refused instead (the card's own original, slightly
  // incomplete premise — see the delivery report), the human sentence must
  // still win over the raw-identifier fallback there too. `_reasonLineFor` is
  // one function for both faces; this pins the OTHER branch of that same
  // function, not a second implementation of it.
  group('③ defense in depth — if they ever land on failed/refused, the same human sentence still wins', () {
    testWidgets('failed + a cloud code ⇒ human words, not a truncated raw identifier', (WidgetTester tester) async {
      await tester.pumpWidget(
        _tile(_entry(status: EntryStatus.failed, failureReason: kTooLarge)),
      );
      expect(find.textContaining(_zh.statusFailed), findsOneWidget);
      expect(
        find.textContaining(_zh.cloudImageRelayErrorNote(kTooLarge)!),
        findsOneWidget,
      );
      expect(find.textContaining(kTooLarge), findsNothing);
    });

    testWidgets('failed + an unrecognised code ⇒ behaviour completely unchanged, still the truncated raw identifier', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(_entry(status: EntryStatus.failed, failureReason: 'LINK_DOWN')),
      );
      expect(find.textContaining(_zh.statusFailed), findsOneWidget);
      // Unchanged pre-existing behaviour: raw identifier, verbatim (short
      // enough that _truncateFailureReason does not cut it).
      expect(find.textContaining('LINK_DOWN'), findsOneWidget);
    });
  });
}
