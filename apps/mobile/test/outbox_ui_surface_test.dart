// Window B3-2b — THE QUEUE'S USER-VISIBLE SURFACE.
//
// SPEC-REF: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5 (the
// seven faces + the two banners + the resend gate), §4 R8, RV-67.
//
// Everything asserted here was a façade before this card: `pendingCount`,
// `terminalNotice`, `dismissTerminalNotice`, `canResendImage` and
// `hasImageBytes` had ZERO production readers between them, and the queue's own
// terminal sentence was, in its own words, 「产出了没有人显示」.
//
// ⚠️ Two of these tests are REVERSE CONTROLS and were each run against a
// deliberately broken implementation first (both went red; the raw output is in
// the delivery report). A negative assertion that has never been seen to fail is
// not evidence — it may be asserting on a probe that is blind.

import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_failure_text.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';

const AppStrings _zh = AppStringsZh();

TimelineEntry _entry({
  required EntryStatus status,
  bool cachedByVerdict = false,
  String? failureReason,
  String? entryType,
  String id = 'loc_mobile_c',
}) {
  final DateTime now = DateTime.utc(2026, 7, 31, 14, 32);
  return TimelineEntry(
    id: id,
    clientId: 'c',
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    sourceText: '正文',
    outputText: '正文',
    status: status,
    origin: 'paired',
    entryType: entryType ?? TimelineEntry.kTranscript,
    failureReason: failureReason,
    cachedByVerdict: cachedByVerdict,
    createdAt: now,
    updatedAt: now,
  );
}

Widget _tile(
  TimelineEntry e, {
  bool queued = false,
  bool canResendImage = false,
  void Function(TimelineEntry)? onRetry,
  AppStrings strings = _zh,
}) => MaterialApp(
  home: Scaffold(
    body: ChatMessageTile(
      entry: e,
      strings: strings,
      queued: queued,
      canResendImage: canResendImage,
      onRetry: onRetry ?? (TimelineEntry _) {},
    ),
  ),
);

void main() {
  // ── ① Status-vocabulary close-out (RV-62, the states the queue really
  // produces) ──────────────────────────────────────────────────────────────
  group('① deliveryFaceOf — every word corresponds to a state that really occurs', () {
    test('cached + the queue item is still queued ⇒ queued, not delivering', () {
      final TimelineEntry waiting = _entry(status: EntryStatus.cached);
      // The SAME row, the only difference being where its delivery actually is.
      expect(deliveryFaceOf(waiting, queued: false), DeliveryFace.delivering);
      expect(deliveryFaceOf(waiting, queued: true), DeliveryFace.queued);
    });

    test('a terminal code ⇒ delivery refused, and both the cached / failed branches must be judged', () {
      // The exact frame the server sends for a crosstalk refusal: ok:false with
      // mode:'cached' (relay.handler.ts answerReject) ⇒ the row settles `cached`
      // + cachedByVerdict, which is why this used to read 「未投递」.
      final TimelineEntry crosstalk = _entry(
        status: EntryStatus.cached,
        cachedByVerdict: true,
        failureReason: 'INJECT_PC_MISMATCH',
      );
      expect(deliveryFaceOf(crosstalk, queued: false), DeliveryFace.refused);
      final TimelineEntry onFailed = _entry(
        status: EntryStatus.failed,
        failureReason: 'INJECT_PC_UNSPECIFIED',
      );
      expect(deliveryFaceOf(onFailed, queued: false), DeliveryFace.refused);
      // Positive control: a RETRYABLE code on the same shape of row must NOT be refused,
      // or this assertion would pass for a face that simply swallowed everything.
      //
      // ⚠️ Card F2 (2026-08-02) — **the sample code changed; the thing this
      // positive control must prove did not change one word.**
      // The original sample was `INJECT_FOCUS_LOST`; the previous paragraph
      // still wrote that it 「is the one that really arrives in production
      // carrying `mode:'cached'`」— **that sentence is still true today**,
      // but it no longer belongs to 「待投递」: it is a **PC-authored
      // injection-segment verdict** (`inject-verdict-authorship.ts`),
      // landing `DeliveryFace.deliveredNotInjected`. The class that still
      // carries `mode:'cached'` and is **still retryable** is now
      // represented by the relay-authored `INJECT_NOT_IN_ROOM`
      // (`relay.handler.ts`'s `socket.emit('inject:result', { ok:false,
      //  mode:'cached', error:'INJECT_NOT_IN_ROOM', … })`;
      //  booklet 15 §3.2 「PC 忙」row says it is the one most often landed
      //  after being occupied).
      final TimelineEntry retryable = _entry(
        status: EntryStatus.cached,
        cachedByVerdict: true,
        failureReason: 'INJECT_NOT_IN_ROOM',
      );
      expect(deliveryFaceOf(retryable, queued: false), DeliveryFace.undelivered);
      final TimelineEntry plainFail = _entry(
        status: EntryStatus.failed,
        failureReason: 'LINK_DOWN',
      );
      expect(deliveryFaceOf(plainFail, queued: false), DeliveryFace.failed);
    });

    // ── Window B4-5 / owner 2026-08-01 / booklet 15 G-10 ───────────────────
    //
    // 🔴 CORRECTION TO THE CARD THAT OPENED THIS FILE: G-10 (and the card that
    // dispatched this one) both assumed `INJECT_NO_TEXT_TARGET` lands on
    // `cached + cachedByVerdict` today. It does not, and never did once RV-43
    // shipped — `target_probe.rs refusal_for` is the code's ONLY producer, and
    // it feeds `mode: InjectMode::SendInput` (never `Cached`) into the outcome
    // (`pipeline.rs` Stage 1b; `pipeline_tests.rs
    // text_into_a_proven_non_input_focus_is_refused_by_name` asserts
    // `mode != Cached` in so many words), which the relay maps to `status:
    // 'failed'`. RV-43's OWN design table
    // (`2026-07-30-inject-state-narrowing-design.md` §1) names this code as
    // THE example of `failed`. So the real bug this card fixes is not on the
    // `cached` branch at all — it is that a settled ✗ row carrying this one
    // named code showed a bare, untranslated identifier instead of owner's
    // 「无焦点未注入」. Both branches are still tested below: `failed` because
    // that is what production actually does, `cached` because
    // `deliveryFaceOf`'s own contract (RV-67's precedent) is to key a face off
    // the CONTENT of `failureReason` wherever it appears, not off which bucket
    // happened to carry it — and because a stale-but-not-yet-cleared code
    // sitting on an settled 未投递 row is a real shape this file elsewhere
    // guards against.
    test('🔴 G-10 correction: INJECT_NO_TEXT_TARGET really lands on the failed branch, not cached', () {
      final TimelineEntry onFailed = _entry(
        status: EntryStatus.failed,
        failureReason: 'INJECT_NO_TEXT_TARGET',
      );
      expect(deliveryFaceOf(onFailed, queued: false), DeliveryFace.noFocus);
      // Positive control: same code, cached branch. NOT reachable in production today
      // (see above) — this asserts the DEFENSE-IN-DEPTH branch in
      // status_badge.dart, which exists so deliveryFaceOf keys off the CONTENT
      // of failureReason rather than off which status bucket happens to carry
      // it (RV-67 precedent), not because this shape is expected to occur.
      final TimelineEntry onCached = _entry(
        status: EntryStatus.cached,
        cachedByVerdict: true,
        failureReason: 'INJECT_NO_TEXT_TARGET',
      );
      expect(deliveryFaceOf(onCached, queued: false), DeliveryFace.noFocus);
    });

    test('🔴 stale-code gate: a row still awaiting a verdict after resend must not be mis-judged noFocus by an old code', () {
      // markReinjecting (timeline_store.dart) sets cachedByVerdict:false but
      // CANNOT clear failureReason (copyWith: `failureReason ?? this.failureReason`)
      // — so a row that just got resent after a noFocus settle carries the OLD
      // code while genuinely awaiting a FRESH verdict. Reading it as noFocus
      // here would be exactly the stale-code hazard chat_message_tile.dart
      // already documents for `failed`/`refused`.
      final TimelineEntry awaitingAfterResend = _entry(
        status: EntryStatus.cached,
        cachedByVerdict: false,
        failureReason: 'INJECT_NO_TEXT_TARGET',
      );
      expect(
        deliveryFaceOf(awaitingAfterResend, queued: false),
        DeliveryFace.delivering,
      );
    });

    test('the terminal criterion and the queue use the same predicate, not a second list', () {
      // If these two ever disagree, the pill and the queue disagree about
      // whether a delivery is over. Asserted rather than trusted.
      for (final String code in <String>[
        'INJECT_PC_MISMATCH',
        'INJECT_PC_UNSPECIFIED',
        'INJECT_FRAME_INVALID',
        'INJECT_FRAME_TOO_LARGE',
        kOutboxImageBytesGone,
        kOutboxOverflow,
      ]) {
        expect(isTerminalRefusalCode(code), isTrue, reason: code);
        expect(
          deliveryFaceOf(
            _entry(status: EntryStatus.failed, failureReason: code),
            queued: false,
          ),
          DeliveryFace.refused,
          reason: code,
        );
      }
    });

    test('each of the eight faces has four-language copy; none is empty (and no two share a name)', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final Set<String> labels = <String>{
          for (final DeliveryFace f in DeliveryFace.values)
            deliveryFaceMeta(f, s).label,
        };
        expect(
          labels,
          hasLength(DeliveryFace.values.length),
          reason: '$locale: two faces share a word ⇒ one of them cannot be read',
        );
        for (final String l in labels) {
          expect(l.trim(), isNotEmpty, reason: '$locale');
        }
      }
    });

    test('🔴 queued must never be said as 「已发送」/「已投递」', () {
      for (final AppLocale locale in AppLocale.values) {
        final String queued = AppStrings.of(locale).statusQueued;
        expect(queued.contains('已发送'), isFalse, reason: '$locale');
        expect(queued.contains('已投递'), isFalse, reason: '$locale');
        expect(queued.toLowerCase().contains('sent'), isFalse, reason: '$locale');
      }
    });
  });

  // ── ② RV-67: a terminal state does not get a resend button ──────────────
  group('② RV-67 — a red-line accident and a benign retry must be visually distinguishable', () {
    testWidgets('crosstalk refused ⇒ ⛔delivery refused + human sentence (was a named code before card U5), and no resend button', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(
          _entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            failureReason: 'INJECT_PC_MISMATCH',
          ),
        ),
      );
      // Positive control FIRST: the probe can see the row at all. Without this, the
      // 「no button」 assertion below could be passing because nothing rendered.
      expect(find.textContaining(_zh.statusRefused), findsOneWidget);
      // 🔴 Card U5 (2026-08-04) — what this originally asserted was the
      // bare code itself rendering on screen
      // (`find.textContaining('INJECT_PC_MISMATCH')`, findsOneWidget):
      // that is exactly the class of accident U5 is to fix (same as
      // 0.2.53). `deliveryRefusalNote` (chat_strings.dart) now gives
      // this code a human sentence; after `_humanNoteFor` is wired into
      // chat_message_tile.dart, this row must show the human sentence
      // and no longer the bare identifier — the assertion direction
      // flipped wholesale, rather than deleting the negative 「no
      // resend button」assertion.
      final Finder note = find.byKey(
        const ValueKey<String>('entry.reasonNote.loc_mobile_c'),
      );
      expect(note, findsOneWidget, reason: 'this row must be able to say why, not a bare code');
      expect(
        tester.widget<Text>(note).data,
        _zh.deliveryRefusalNote('INJECT_PC_MISMATCH'),
      );
      expect(find.textContaining('INJECT_PC_MISMATCH'), findsNothing);
      // 🔴 THE NEGATIVE. Asserted on the row's resend KEY, not on the word 重发:
      // the same word is used by the banner, so a text match could be satisfied
      // by something that is not this row's button at all.
      expect(
        find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
        findsNothing,
      );
    });

    testWidgets('reverse control: a benign 「未投递」still gets a resend button as usual', (WidgetTester tester) async {
      await tester.pumpWidget(
        _tile(
          _entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            // ⚠️ Card F2 (2026-08-02) — the sample code was swapped to
            // the relay-authored `INJECT_NOT_IN_ROOM`, for the same
            // reason as the earlier site in this file: `INJECT_FOCUS_LOST`
            // is now a PC-authored injection-segment verdict, landing
            // 「已投递 · 未注入」, no longer a 「待投递」sample. The thing
            // this case must prove — 「a benign pending-delivery still
            // gets a resend button as usual」— did not change one word.
            failureReason: 'INJECT_NOT_IN_ROOM',
          ),
        ),
      );
      expect(find.textContaining(_zh.statusUndelivered), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
        findsOneWidget,
      );
    });

    // ── Window B4-5 / owner 2026-08-01 ─────────────────────────────────────
    testWidgets('no-focus not-injected ⇒ a named word + a resend button, and the raw code is not printed again', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(
          _entry(
            // The REAL production shape (see the G-10 correction group above):
            // INJECT_NO_TEXT_TARGET settles `failed`, not `cached`.
            status: EntryStatus.failed,
            failureReason: 'INJECT_NO_TEXT_TARGET',
          ),
        ),
      );
      // Positive control FIRST: owner's own words render.
      expect(find.textContaining(_zh.statusNoFocus), findsOneWidget);
      expect(find.textContaining('无焦点未注入'), findsOneWidget);
      // Resend is offered — this is retryable (R8: the next attempt genuinely can
      // differ once the user has clicked into a field).
      expect(
        find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
        findsOneWidget,
      );
      // The raw identifier is NOT also printed: unlike ✗/⛔, this face covers
      // exactly one code and the word already says the whole fact.
      expect(find.textContaining('INJECT_NO_TEXT_TARGET'), findsNothing);
    });
  });

  // ── ③ The criterion for image resend ────────────────────────────────────
  //
  // ⚠️⚠️ Correction (RV-93, owner 2026-08-01 「投递成功即删，改为存下来」):
  // this group's original title was 「image two-segment model: the
  // button's existence and the bytes' existence are true or false
  // together / R8: button ⇔ bytes」. The bytes now stay forever ⇒ that
  // equivalence is always true and cannot stop anything. The criterion
  // became:
  //     **resend button ⇔ this item has not yet been delivered
  //     successfully** (the bytes half is left only as 「do not offer
  //     a button that cannot be pressed」).
  // The real risk on this screen is: a successfully delivered image
  // row growing a resend button again — owner explicitly ruled it
  // must not have one. This group's last case is that reverse
  // control.
  group('③ image resend — the criterion is 「not yet delivered successfully」, not 「the bytes are still there」', () {
    testWidgets('bytes still there ⇒ the image row gets a resend button, and does not get a 「已投递」reminder', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(
          _entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            entryType: TimelineEntry.kImage,
          ),
          canResendImage: true,
        ),
      );
      expect(
        find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
        findsOneWidget,
      );
      // 🔴 Positive control (window B3-9 / G-11): the two affordances are mutually
      // exclusive by construction — an un-landed row must NOT also carry the
      // 「已投递成功，无需重发」 sentence, or the row would tell the user two
      // contradictory things about the same picture at once.
      expect(
        find.byKey(const ValueKey<String>('entry.imageResendNote.loc_mobile_c')),
        findsNothing,
      );
    });

    // ⚠️ Original name 「bytes already released (deleted after successful
    // delivery per owner ①) ⇒ no button」. After RV-93 there is no such
    // thing as 「release」; this case now asserts that **when the queue
    // says it cannot be resent** (for whatever reason: already
    // delivered, terminal, or the bytes really are gone), the row
    // does not offer a button.
    testWidgets('the queue says not resendable ⇒ no button (R8: do not offer a button that cannot be pressed)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(
          _entry(
            status: EntryStatus.cached,
            cachedByVerdict: true,
            entryType: TimelineEntry.kImage,
          ),
          canResendImage: false,
        ),
      );
      // Positive control: the row IS an un-landed one, i.e. the face that WOULD offer a
      // retry for text. So the absence below is the byte rule, not the face.
      expect(find.textContaining(_zh.statusUndelivered), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
        findsNothing,
      );
    });

    // 🔴 Window B3-9 / booklet 15 G-11 — not giving a button on a
    // successfully delivered image is already done, but the 「why」
    // sentence previously appeared NOWHERE. This case asserts 「the
    // row itself」, not the banner.
    //
    // ⚠️ Correction (RV-93): that sentence was originally 「原件已投递并清理，无法重发」,
    // the reason being the bytes were deleted. After owner revoked
    // 「投递成功即删」the **picture is still on the phone**, and that
    // sentence became a false statement about the user's storage
    // state ⇒ changed to an honest reason: it already arrived, no
    // need to send it again.
    testWidgets('a successfully delivered image row ⇒ shows 「已投递成功，无需重发」, no button', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(
          _entry(status: EntryStatus.injected, entryType: TimelineEntry.kImage),
          canResendImage: false,
        ),
      );
      // Positive control: the row really did settle ✓ — the explanation is not standing
      // in for a status the row does not actually have.
      // Card L7: exact pill text, not a substring — the 「已投递成功，无需重发」 note
      // on this very row now CONTAINS the label (both start 「已投递」), so a
      // substring finder would match two widgets and this assertion would stop
      // being about the pill at all.
      expect(find.text('✓ ${_zh.statusInjected}'), findsOneWidget);
      expect(
        find.textContaining(_zh.imageResendUnavailableNote),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey<String>('entry.imageResendNote.loc_mobile_c')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
        findsNothing,
      );
    });

    // 🔴🔴 RV-93 reverse control — the one this card is most likely to
    // miss, and the one whose consequence is most direct.
    //
    // Bytes now stay forever, so the old invariant 「button ⇔ bytes」
    // is always true. Here we **deliberately** pass canResendImage as
    // true (= the value the projection layer would pass if it dropped
    // the 「already delivered」criterion), and assert the row still
    // does not offer a button: the face (injected is not in
    // retryableFace) is the second line of defence.
    // Both lines of defence in place is 「a successfully delivered
    // image row must never grow a resend button」.
    // ⟲ Red proof: add `|| face == DeliveryFace.injected` to
    //   chat_message_tile's retryableFace ⇒ this case goes red
    //   immediately (the button appeared).
    testWidgets('⟲ reverse control: already delivered + bytes still there (canResendImage=true) ⇒ still no button', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        _tile(
          _entry(status: EntryStatus.injected, entryType: TimelineEntry.kImage),
          canResendImage: true,
        ),
      );
      // Positive control: the row really is the 「injected」face, and
      // the explanation sentence is still there — it is not that the
      // whole block failed to render.
      // Card L7: exact pill text, not a substring — the 「已投递成功，无需重发」 note
      // on this very row now CONTAINS the label (both start 「已投递」), so a
      // substring finder would match two widgets and this assertion would stop
      // being about the pill at all.
      expect(find.text('✓ ${_zh.statusInjected}'), findsOneWidget);
      expect(
        find.byKey(const ValueKey<String>('entry.imageResendNote.loc_mobile_c')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey<String>('entry.resend.loc_mobile_c')),
        findsNothing,
        reason: '🔴 a successfully delivered image row must never have a resend button (owner ruling)',
      );
    });

    test('OutboxItem.hasImageBytes IS that fact (not a second judgement)', () {
      final DateTime t = DateTime.utc(2026, 7, 31);
      OutboxItem item(String? path) => OutboxItem(
        requestId: 'i0-1',
        entryId: 'loc_a',
        coveredEntryIds: const <String>['loc_a'],
        kind: OutboxPayloadKind.image,
        source: 'image',
        text: '',
        mode: 'realtime',
        createdAt: t,
        enqueuedAt: t,
        destinationMachineUid: 'm-1',
        destinationPairingIdentity: null,
        enqueuedPcId: 'pc-1',
        imagePath: path,
        imageMime: 'image/png',
      );
      expect(item('/blobs/i0-1.png').hasImageBytes, isTrue);
      expect(item(null).hasImageBytes, isFalse);
      expect(item('').hasImageBytes, isFalse);
    });
  });

  // ── ④ The queue's two banners (before this card both of these produced
  // something nobody displayed) ────────────────────────────────────────────
  group('④ queue banners — still N undelivered / the queue\'s own terminal', () {
    BannerQueue build({
      int outboxPending = 0,
      OutboxTerminal? outboxTerminal,
      ConnectionState connection = ConnectionState.connected,
      AppStrings strings = _zh,
    }) => buildChatBanners(
      connection: connection,
      autoStopped: false,
      strings: strings,
      outboxPending: outboxPending,
      outboxTerminal: outboxTerminal,
    );

    test('N>0 ⇒ there is one info banner, it says N, and must not say 「已发送」', () {
      final BannerQueue q = build(outboxPending: 3);
      expect(q.contains(BannerIds.outboxPending), isTrue);
      final BannerItem item = q.all.singleWhere(
        (BannerItem i) => i.id == BannerIds.outboxPending,
      );
      expect(item.severity, BannerSeverity.info);
      expect(item.message, contains('3'));
      expect(item.message.contains('已发送'), isFalse);
      // 🔴 It is a LIVE condition, not a past event ⇒ no ✕. Silencing it would
      // hide a truth that is still true, and the next queued item would raise
      // it again anyway.
      expect(item.dismissible, isFalse);
    });

    test('N==0 ⇒ not one banner (「0 条未投递」is a permanent ornament)', () {
      expect(build().contains(BannerIds.outboxPending), isFalse);
    });

    test('🔴 it is info, so it can never take the seat of a real fault', () {
      // owner: 队列不加拦截步骤. The count must never sit in front of something
      // the user has to act on.
      final BannerQueue q = build(
        outboxPending: 9,
        connection: ConnectionState.disconnected,
      );
      expect(q.top!.id, BannerIds.link);
      expect(q.contains(BannerIds.outboxPending), isTrue, reason: 'still there, just ranked behind');
    });

    test('the queue\'s own terminal ⇒ that named sentence is really rendered (G-4/G-5)', () {
      for (final OutboxTerminal t in OutboxTerminal.values) {
        final BannerQueue q = build(outboxTerminal: t);
        final BannerItem item = q.all.singleWhere(
          (BannerItem i) => i.id == BannerIds.outboxTerminal,
        );
        expect(item.severity, BannerSeverity.blocking);
        expect(item.dismissible, isTrue, reason: 'it describes something that happened in the past');
        expect(item.message.trim(), isNotEmpty, reason: t.name);
        // All four languages must have a sentence, otherwise switching
        // language is a silent failure.
        for (final AppLocale locale in AppLocale.values) {
          expect(
            AppStrings.of(locale).outboxTerminalMessage(t).trim(),
            isNotEmpty,
            reason: '$locale/${t.name}',
          );
        }
      }
    });

    test('both codes map to a terminal; every other code is null (must not invent words on the PC\'s behalf)', () {
      expect(outboxTerminalOf(kOutboxImageBytesGone), OutboxTerminal.imageBytesGone);
      expect(outboxTerminalOf(kOutboxOverflow), OutboxTerminal.overflow);
      expect(outboxTerminalOf('INJECT_PC_MISMATCH'), isNull);
      expect(outboxTerminalOf('INJECT_PC_OFFLINE'), isNull);
    });
  });

  // ── ⑤ 🔴 RV-90 cross-end semantic gate (window B4-7) ────────────────────
  //
  // Booklet 15 §2.5's closing sentence: 「**face is decided by the row
  // and the item together**, not by the item alone.」This group is the
  // **executable edition** of that sentence — it wires both ends onto
  // **the same verdict**, because what owner saw on a real device on
  // 2026-08-01 was exactly the two ends each saying their own thing:
  //   「云端中继传图全部都是显示未投递……手机的历史时间线上这 2 张图显示的是已注入」
  //
  // ⚠️ Why this group must stand up a real TimelineStore and a real
  // DeliveryOutbox at the same time: the RV-90 bug is **invisible in
  // each end's own unit tests**. The row side was always right; the
  // item side at the time also had not one assertion asking 「what is
  // state after settle」(`outbox_test.dart`'s successful-image case
  // only asked whether the bytes were still there). The gap lives in
  // the seam between the two questions — booklet 15 G-6 recorded the
  // same shape.
  group('⑤ 🔴 when the row says injected, the item must not still sit in queued/inflight', () {
    const String kInstance = 'saas|instance:inst-A-cloud';

    Future<void> settleBothEnds({
      required TimelineStore store,
      required DeliveryOutbox box,
      required String correlationId,
      required bool ok,
      String? code,
      String wireMode = 'sendinput',
    }) async {
      // ONE verdict, both ends — the same shape `onInjectResultRouted` has:
      // `delivery.applyInjectResult(r, store)` then `outbox.settle(...)`, keyed
      // off the SAME `InjectResult.correlationId`.
      store.applyInjectResult(
        correlationId: correlationId,
        ok: ok,
        failureReason: code,
        wireMode: ok ? wireMode : (code == null ? null : wireMode),
      );
      await box.settle(correlationId: correlationId, ok: ok, code: code);
    }

    test('🔴 after one ok verdict, both ends must say the same thing (RV-90\'s real-device shape)', () async {
      final TimelineStore store = newTestStore(owner: const _Instance(kInstance));
      final _Host host = _Host(kInstance);
      final DeliveryOutbox box = DeliveryOutbox(
        store: newTestOutboxStore(),
        blobs: newTestOutboxBlobs(),
        host: host,
      );
      final TimelineEntry row = store.buildFromUtterance(
        clientId: 'i-1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '🖼 PNG · 3 B',
        entryType: TimelineEntry.kImage,
      );
      // The CLOUD image leg: persist-before-send, then the socket emit happens outside
      // the queue ⇒ the item is still `queued` when the PC answers.
      final OutboxItem? item = await box.enqueueImage(
        requestId: 'i-1',
        entryId: row.id,
        bytes: Uint8List.fromList(<int>[1, 2, 3]),
        imageMime: 'image/png',
        extension: 'png',
        label: '🖼 PNG · 3 B',
        mode: 'realtime',
        createdAt: row.createdAt,
      );
      expect(item, isNotNull);
      // Positive control FIRST — before the verdict the two ends genuinely disagree in
      // the ALLOWED way (row delivering / item queued), so the assertion below is
      // about the verdict and not about a probe that never sees anything.
      expect(box.pendingCountFor(kInstance), 1);
      expect(box.queuedEntryIds, contains(row.id));

      await settleBothEnds(
        store: store,
        box: box,
        correlationId: row.id,
        ok: true,
      );

      final TimelineEntry settled = store.findById(row.id)!;
      expect(deliveryFaceOf(settled, queued: box.queuedEntryIds.contains(row.id)),
          DeliveryFace.injected);
      // 🔴 THE CROSS-END INVARIANT. The row says injected ⇒ the item
      // must be terminal, and the banner must no longer count it.
      // Before RV-90 was fixed, these three went red together.
      expect(box.queuedEntryIds, isNot(contains(row.id)));
      expect(box.pendingCountFor(kInstance), 0);
      expect(
        buildChatBanners(
          connection: ConnectionState.connected,
          autoStopped: false,
          strings: _zh,
          outboxPending: box.pendingCountFor(kInstance),
        ).contains(BannerIds.outboxPending),
        isFalse,
        reason: '🔴 an injected row must not still be counted into 「还有 N 条未投递」',
      );
    });

    test('🔴 the converse must also hold: while the item is still queued, the row must not be said to be injected', () async {
      // The ALLOWED disagreement — booklet 15 §2.2:「一行可以是 failed，而它的队列项
      // 同时是 queued」. This asserts the invariant is directional, not a demand
      // that the two fields be merged (that merge is what §2.2 forbids).
      final TimelineStore store = newTestStore(owner: const _Instance(kInstance));
      final _Host host = _Host(kInstance);
      final DeliveryOutbox box = DeliveryOutbox(
        store: newTestOutboxStore(),
        blobs: newTestOutboxBlobs(),
        host: host,
      );
      final TimelineEntry row = store.buildFromUtterance(
        clientId: 't-1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '你好',
      );
      await box.enqueueText(
        requestId: 't-1',
        entryId: row.id,
        wireEntryId: row.id,
        source: 'manual',
        text: '你好',
        mode: 'realtime',
        createdAt: row.createdAt,
      );
      await settleBothEnds(
        store: store,
        box: box,
        correlationId: row.id,
        ok: false,
        code: 'INJECT_PC_OFFLINE',
        wireMode: 'cached',
      );
      final TimelineEntry settled = store.findById(row.id)!;
      // 🔴 THE INVARIANT IS DIRECTIONAL: injected ⇒ item terminal. The converse is NOT
      // 「item queued ⇒ row queued」, and asserting that would be demanding the merge
      // booklet 15 §2.2 forbids. What must hold is only this:
      expect(settled.status, isNot(EntryStatus.injected));
      expect(box.pendingCountFor(kInstance), 1);
      // ⚠️ Lead correction, left as a method record: this test first asserted
      // `DeliveryFace.queued` and went red with `Actual: undelivered` — and the
      // IMPLEMENTATION was right. §2.5's order settles it: row 7
      // (`cached + cachedByVerdict` ⇒ 未投递) is reached before row 5 can apply,
      // because row 5 requires `!cachedByVerdict`. A verdict that SAID 「没投递」
      // outranks 「还没上路」: the PC really did answer, and 排队中 would erase
      // the fact that it answered. 「排队中」 is for rows nobody has answered yet
      // (§2.5 row 5's two listed scenarios), which is exactly not this one.
      expect(
        deliveryFaceOf(settled, queued: box.queuedEntryIds.contains(row.id)),
        DeliveryFace.undelivered,
        reason: 'the verdict said 「没投递」⇒ 未投递; the item is still queued, which is the asymmetry §2.2 allows',
      );
    });

    test('🔴 RV-91: on another instance\'s UI, this one is not counted at all', () async {
      final TimelineStore store = newTestStore(owner: const _Instance(kInstance));
      final DeliveryOutbox box = DeliveryOutbox(
        store: newTestOutboxStore(),
        blobs: newTestOutboxBlobs(),
        host: _Host(kInstance),
      );
      final TimelineEntry row = store.buildFromUtterance(
        clientId: 'x-1',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        text: '你好',
      );
      await box.enqueueText(
        requestId: 'x-1',
        entryId: row.id,
        wireEntryId: row.id,
        source: 'manual',
        text: '你好',
        mode: 'realtime',
        createdAt: row.createdAt,
      );
      // 🔴 The two surfaces of the OTHER instance's screen must agree with each
      // other: it shows none of these rows, so it must count none of them.
      const String other = 'standalone|instance:inst-A-lan';
      expect(store.entriesForInstance(other), isEmpty);
      expect(box.pendingCountFor(other), 0);
      // Positive control: on its own instance both surfaces still have it.
      expect(store.entriesForInstance(kInstance), hasLength(1));
      expect(box.pendingCountFor(kInstance), 1);
    });
  });
}

/// The instance this harness's rows are 「spoken to」 — the same string the queue
/// buckets on, because production reads both off `PttSession
/// .connectedInstanceId` in the same breath.
class _Instance implements InstanceOwnerProbe {
  const _Instance(this.instanceId);
  @override
  final String? instanceId;
  @override
  String? get instanceName => 'PC';
}

/// A drain host that never puts anything on the wire: these tests are about the
/// SETTLE path, and a host that "sends" would move items to `inflight` and hide
/// the very state RV-90 was found in.
class _Host implements OutboxDrainHost {
  _Host(this._pairing);
  final String _pairing;
  @override
  LiveConnection get liveConnection => LiveConnection(
    machineUid: 'machine-uid-AAAA',
    pairingIdentity: _pairing,
    pcId: 'pc-A',
    channel: ServerChannel.lan, // card B4-17 — irrelevant here (link is down)
  );
  @override
  Future<bool> ensureLink() async => false;
  @override
  Future<void> reseedDestination() async {}
  @override
  Future<bool> send(
    OutboxItem i,
    String p, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async => false;
  @override
  void onOutboxChanged() {}
}
