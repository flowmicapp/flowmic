// R6 T-5 acceptance — the single-slot banner queue contract (REDESIGN §3 P-3
// 「永不静默，但只吵一次」): priority blocking > degraded > info, id dedupe, dismiss promotes
// the next entry, and the overflow count keeps every deferred banner reachable.
// Pure model tests — no WidgetTester, no session chain.

import 'package:flowmic/src/session/compose_gate.dart'
    show AiComposeFailure, AiComposeOutcome, ComposeSendFailure;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/locale_terms.dart';

BannerItem _item(
  String id,
  BannerSeverity severity, {
  String? message,
  bool dismissible = false,
}) => BannerItem(
  id: id,
  severity: severity,
  message: message ?? '$id-msg',
  dismissible: dismissible,
);

void main() {
  group('priority', () {
    test('blocking outranks degraded outranks info regardless of push order', () {
      final BannerQueue q = BannerQueue();
      q.push(_item('c', BannerSeverity.info));
      q.push(_item('b', BannerSeverity.degraded));
      q.push(_item('a', BannerSeverity.blocking));
      expect(q.top?.id, 'a');
      expect(
        q.all.map((BannerItem i) => i.id).toList(),
        <String>['a', 'b', 'c'],
      );
    });

    test('equal severity keeps FIFO — a later push never displaces the first', () {
      final BannerQueue q = BannerQueue();
      q.push(_item('first', BannerSeverity.degraded));
      q.push(_item('second', BannerSeverity.degraded));
      expect(q.top?.id, 'first');
      expect(
        q.all.map((BannerItem i) => i.id).toList(),
        <String>['first', 'second'],
      );
    });

    test('a degraded entry promoted to blocking takes the slot', () {
      final BannerQueue q = BannerQueue();
      q.push(_item('link', BannerSeverity.degraded));
      q.push(_item('other', BannerSeverity.degraded));
      expect(q.top?.id, 'link');
      q.push(_item('link', BannerSeverity.blocking));
      expect(q.top?.id, 'link');
      expect(q.top?.severity, BannerSeverity.blocking);
      expect(q.length, 2); // still deduped, not stacked
    });
  });

  group('dedupe', () {
    test('same id never enqueues twice; identical face reports no change', () {
      final BannerQueue q = BannerQueue();
      expect(q.push(_item('link', BannerSeverity.blocking)), isTrue);
      expect(q.push(_item('link', BannerSeverity.blocking)), isFalse);
      expect(q.length, 1);
      expect(q.overflowCount, 0);
    });

    test('same id with new copy refreshes IN PLACE, keeping its FIFO rank', () {
      final BannerQueue q = BannerQueue();
      q.push(_item('a', BannerSeverity.degraded, message: 'old'));
      q.push(_item('b', BannerSeverity.degraded, message: 'b'));
      expect(q.push(_item('a', BannerSeverity.degraded, message: 'new')), isTrue);
      expect(q.length, 2);
      expect(q.top?.id, 'a'); // rank preserved — did not jump behind b
      expect(q.top?.message, 'new');
    });

    test('the action closure is excluded from equality (rebuilt every frame)', () {
      final BannerQueue q = BannerQueue();
      q.push(
        BannerItem(
          id: 'x',
          severity: BannerSeverity.info,
          message: 'm',
          onAction: () {},
        ),
      );
      final bool changed = q.push(
        BannerItem(
          id: 'x',
          severity: BannerSeverity.info,
          message: 'm',
          onAction: () {},
        ),
      );
      expect(changed, isFalse, reason: 'a fresh closure must not look like churn');
    });
  });

  group('dismiss + overflow', () {
    test('overflowCount is everything queued behind the top', () {
      final BannerQueue q = BannerQueue();
      expect(q.overflowCount, 0);
      q.push(_item('a', BannerSeverity.blocking));
      expect(q.overflowCount, 0);
      q.push(_item('b', BannerSeverity.degraded));
      q.push(_item('c', BannerSeverity.info));
      expect(q.overflowCount, 2);
    });

    test('removing the top promotes the next entry — nothing is swallowed', () {
      final BannerQueue q = BannerQueue();
      q.push(_item('block', BannerSeverity.blocking));
      q.push(_item('warn', BannerSeverity.degraded, dismissible: true));
      q.push(_item('note', BannerSeverity.info));
      expect(q.top?.id, 'block');
      expect(q.remove('block'), isTrue);
      expect(q.top?.id, 'warn');
      expect(q.overflowCount, 1);
      expect(q.remove('warn'), isTrue);
      expect(q.top?.id, 'note');
      expect(q.overflowCount, 0);
      expect(q.remove('nope'), isFalse);
    });

    test('clear empties the slot and reports whether anything was there', () {
      final BannerQueue q = BannerQueue();
      expect(q.clear(), isFalse);
      q.push(_item('a', BannerSeverity.info));
      expect(q.clear(), isTrue);
      expect(q.isEmpty, isTrue);
      expect(q.top, isNull);
    });
  });

  group('buildChatBanners — live source mapping', () {
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    test('connected + nothing pending = an empty slot', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
      );
      expect(q.isEmpty, isTrue);
      expect(q.top, isNull);
    });

    test('disconnected is BLOCKING (the PTT gate is shut), reconnecting is '
        'DEGRADED (capture continues, chunks buffer)', () {
      for (final ConnectionState down in <ConnectionState>[
        ConnectionState.disconnected,
        ConnectionState.error,
      ]) {
        final BannerQueue q = buildChatBanners(
          connection: down,
          autoStopped: false,
          strings: zh,
        );
        expect(q.top?.severity, BannerSeverity.blocking, reason: '$down');
        expect(q.top?.dismissible, isFalse, reason: 'a live block cannot be silenced');
      }
      for (final ConnectionState soft in <ConnectionState>[
        ConnectionState.connecting,
        ConnectionState.reconnecting,
      ]) {
        final BannerQueue q = buildChatBanners(
          connection: soft,
          autoStopped: false,
          strings: zh,
        );
        expect(q.top?.severity, BannerSeverity.degraded, reason: '$soft');
      }
    });

    test('link down + auto-stop: ONE slot shows the link, the auto-stop notice '
        'is deferred behind 「还有 1 条」 — never dropped', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: true,
        strings: zh,
      );
      expect(q.length, 2);
      expect(q.top?.id, BannerIds.link);
      expect(q.overflowCount, 1);
      expect(q.all.last.id, BannerIds.autoStop);
      expect(zh.bannerMore(q.overflowCount), '还有 1 条');
    });

    test('auto-stop alone is a dismissible degraded notice and fires the '
        'controller callback on ✕', () {
      int dismissed = 0;
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: true,
        strings: zh,
        onDismissAutoStop: () => dismissed++,
      );
      expect(q.top?.id, BannerIds.autoStop);
      expect(q.top?.severity, BannerSeverity.degraded);
      expect(q.top?.dismissible, isTrue);
      q.top!.onAction!();
      expect(dismissed, 1);
    });

    test('GA-01: a failed utterance transform is a BLOCKING, dismissible banner '
        'that names the wall and says the original was not sent instead', () {
      int dismissed = 0;
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        utteranceFailure: const AiComposeOutcome(
          reason: AiComposeFailure.serverError,
          code: 'LLM_AUTH_FAIL',
        ),
        onDismissUtteranceFailure: () => dismissed++,
      );
      expect(q.top?.id, BannerIds.utteranceCompose);
      expect(q.top?.severity, BannerSeverity.blocking);
      expect(q.top?.dismissible, isTrue);
      // red-line wording: nothing was sent, and the ORIGINAL was not sent either.
      expect(q.top?.message, contains('未发送'));
      expect(q.top?.message, contains('也没有发原文'));
      q.top!.onAction!();
      expect(dismissed, 1);
    });

    test('GA-01: an utterance failure and a BUFFER AI failure keep separate '
        'slots — one is undelivered speech, the other an untouched buffer', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        utteranceFailure: const AiComposeOutcome(
          reason: AiComposeFailure.timeout,
        ),
        aiFailure: const AiComposeOutcome(reason: AiComposeFailure.timeout),
      );
      expect(q.length, 2);
      expect(
        q.all.map((BannerItem b) => b.id),
        containsAll(<String>[BannerIds.utteranceCompose, BannerIds.aiCompose]),
      );
      // Same reason, DIFFERENT copy: one says the buffer was kept, the other
      // says the speech was not delivered.
      final String utter = q.all
          .firstWhere((BannerItem b) => b.id == BannerIds.utteranceCompose)
          .message;
      final String ai = q.all
          .firstWhere((BannerItem b) => b.id == BannerIds.aiCompose)
          .message;
      expect(utter, isNot(ai));
      expect(ai, contains('原文已保留'));
    });

    test('an equally-degraded link wins the tie against the auto-stop notice', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.reconnecting,
        autoStopped: true,
        strings: zh,
      );
      expect(q.top?.id, BannerIds.link);
      expect(q.overflowCount, 1);
    });

    test('copy is bilingual — en never falls back to the zh string', () {
      final AppStrings en = AppStrings.of(AppLocale.en);
      final BannerQueue enQ = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: true,
        strings: en,
      );
      final BannerQueue zhQ = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: true,
        strings: zh,
      );
      expect(enQ.top!.message, isNot(zhQ.top!.message));
      expect(enQ.all.last.message, isNot(zhQ.all.last.message));
      expect(en.bannerMore(3), isNot(zh.bannerMore(3)));
    });
  });

  // ── GA-03: the PROCESSING-stall source ─────────────────────────────────
  group('stt stall', () {
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    test('a stalled utterance is BLOCKING and dismissible — a PTT press that '
        'produced nothing must never look like nothing happened', () {
      for (final SttStallReason reason in SttStallReason.values) {
        int dismissed = 0;
        final BannerQueue q = buildChatBanners(
          connection: ConnectionState.connected,
          autoStopped: false,
          strings: zh,
          sttStalled: SttStall(reason),
          onDismissSttStalled: () => dismissed++,
        );
        expect(q.top?.id, BannerIds.sttStall, reason: '$reason');
        expect(q.top?.severity, BannerSeverity.blocking);
        expect(q.top?.dismissible, isTrue);
        expect(q.top!.message, zh.sttStallMessage(reason));
        q.top!.onAction!();
        expect(dismissed, 1);
      }
    });

    test('the two causes read differently — timeout is not the engine error', () {
      expect(
        zh.sttStallMessage(SttStallReason.timeout),
        isNot(zh.sttStallMessage(SttStallReason.engineError)),
      );
    });

    test('stall copy is bilingual', () {
      final AppStrings en = AppStrings.of(AppLocale.en);
      for (final SttStallReason reason in SttStallReason.values) {
        expect(en.sttStallMessage(reason), isNot(zh.sttStallMessage(reason)));
      }
    });

    // ── ENG-3 (fix-030): the NAMED engine refusal renders its own sentence ──
    test('ENG-3: STT_CONFIG_MISSING renders the both-exits sentence, not the '
        'generic 「转写引擎报错」, in all four languages', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final BannerQueue q = buildChatBanners(
          connection: ConnectionState.connected,
          autoStopped: false,
          strings: s,
          sttStalled: const SttStall(
            SttStallReason.engineError,
            code: 'STT_CONFIG_MISSING',
            message: "Cannot find module 'sherpa-onnx-node'",
          ),
        );
        expect(q.top?.id, BannerIds.sttStall, reason: '$locale');
        expect(q.top!.message, s.sttStallConfigMissing, reason: '$locale');
        // The named sentence differs from the generic one — that difference IS
        // this card: the generic sentence is what the user got at best before.
        expect(
          q.top!.message,
          isNot(s.sttStallMessage(SttStallReason.engineError)),
          reason: '$locale',
        );
        // Both exits are named: the runtime component AND the model files.
        // (Spot-check on the identifiers common to zh/en spellings is not
        // possible across ja/ko, so pin the zh/en pair explicitly below.)
      }
      expect(
        AppStrings.of(AppLocale.zh).sttStallConfigMissing,
        allOf(contains('引擎组件'), contains('模型文件')),
      );
      expect(
        AppStrings.of(AppLocale.en).sttStallConfigMissing,
        allOf(contains('runtime component'), contains('model files')),
      );
    });

    // ── REQ-12-05 / w83 (2026-08-12): "no audio reached the engine" got the INSTALL copy ──
    // Production measured a Soniox 「No audio received.」 arriving as
    // STT_CONFIG_MISSING, i.e. the user was told their engine components were
    // missing on a machine whose install was fine. The server side now answers
    // STT_NO_ENGINE_REACHED; without a sentence HERE that only moves the defect,
    // because this build would print the raw identifier instead (0.2.53).
    test('REQ-12-05: STT_NO_ENGINE_REACHED gets its own four-language sentence, '
        'never the install copy and never a bare identifier', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final BannerQueue q = buildChatBanners(
          connection: ConnectionState.connected,
          autoStopped: false,
          strings: s,
          sttStalled: const SttStall(
            SttStallReason.engineError,
            code: 'STT_NO_ENGINE_REACHED',
            message: '[invalid_request] No audio received.',
          ),
        );
        expect(q.top?.id, BannerIds.sttStall, reason: '$locale');
        expect(q.top!.message, s.sttStallNoEngineReached, reason: '$locale');
        // 🔴 The two failures this card separates must not read alike.
        expect(q.top!.message, isNot(s.sttStallConfigMissing), reason: '$locale');
        // …and it must not be the 「转写引擎报错（CODE）」 fallback.
        expect(
          q.top!.message,
          isNot(contains('STT_NO_ENGINE_REACHED')),
          reason: '$locale',
        );
      }
      // The action the user CAN take is present, in both spellings we can pin.
      expect(AppStrings.of(AppLocale.zh).sttStallNoEngineReached, contains('重新说一次'));
      expect(AppStrings.of(AppLocale.en).sttStallNoEngineReached, contains('Say it again'));
      // …and the install claim is absent — that is the sentence being retired.
      expect(AppStrings.of(AppLocale.zh).sttStallNoEngineReached, isNot(contains('引擎组件')));
    });

    test('ENG-3: an engine code this build has no sentence for prints the raw '
        'identifier — never an invented cause (0.2.53 rule)', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        sttStalled: const SttStall(
          SttStallReason.engineError,
          code: 'STT_SOMETHING_FROM_THE_FUTURE',
        ),
      );
      expect(q.top!.message, contains('STT_SOMETHING_FROM_THE_FUTURE'));
      expect(q.top!.message, contains('转写引擎报错'));
    });

    test('ENG-3: a code-less engine stall keeps the pre-existing generic '
        'sentence byte-for-byte', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        sttStalled: const SttStall(SttStallReason.engineError),
      );
      expect(q.top!.message, zh.sttStallMessage(SttStallReason.engineError));
    });

    test('an equally-blocking link drop keeps the slot; the stall stays '
        'reachable behind 「还有 N 条」 rather than being dropped', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: false,
        strings: zh,
        sttStalled: const SttStall(SttStallReason.timeout),
      );
      expect(q.length, 2);
      expect(q.top?.id, BannerIds.link); // pushed first → wins the FIFO tie
      expect(q.top?.severity, BannerSeverity.blocking);
      expect(q.overflowCount, 1);
      expect(q.all.last.id, BannerIds.sttStall);
    });

    test('it outranks a degraded auto-stop notice regardless of push order', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: true,
        strings: zh,
        sttStalled: const SttStall(SttStallReason.engineError),
      );
      expect(q.top?.id, BannerIds.sttStall);
      expect(q.all.last.id, BannerIds.autoStop);
    });
  });

  // ── R6 T-3b ④: the AI-row failure source ───────────────────────────────
  group('AI compose failure', () {
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    test('a server-side LLM failure is BLOCKING and names the raw code — an '
        'LLM failure must never look like nothing happened', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        aiFailure: const AiComposeOutcome(
          reason: AiComposeFailure.serverError,
          code: 'QUOTA_EXCEEDED',
        ),
      );
      expect(q.top?.id, BannerIds.aiCompose);
      expect(q.top?.severity, BannerSeverity.blocking);
      expect(q.top?.dismissible, isTrue);
      expect(q.top!.message, contains(zh.aiErrorCode('QUOTA_EXCEEDED')));
    });

    test('an UNKNOWN server code is surfaced verbatim rather than swallowed', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        aiFailure: const AiComposeOutcome(
          reason: AiComposeFailure.serverError,
          code: 'SOME_NEW_CODE',
        ),
      );
      expect(q.top!.message, contains('SOME_NEW_CODE'));
    });

    test('a user-caused abort is a DEGRADED notice, not a fault to act on', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        aiFailure: const AiComposeOutcome(reason: AiComposeFailure.aborted),
      );
      expect(q.top?.severity, BannerSeverity.degraded);
    });

    test('it shares the single slot: a link drop outranks it and the AI notice '
        'stays reachable behind 「还有 N 条」 rather than being dropped', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: false,
        strings: zh,
        aiFailure: const AiComposeOutcome(reason: AiComposeFailure.timeout),
      );
      expect(q.top?.id, BannerIds.link);
      expect(q.overflowCount, 1);
      expect(q.all.map((BannerItem b) => b.id), contains(BannerIds.aiCompose));
    });

    test('AI failure copy is bilingual', () {
      const AiComposeOutcome outcome = AiComposeOutcome(
        reason: AiComposeFailure.timeout,
      );
      expect(
        AppStrings.of(AppLocale.en).aiComposeError(outcome),
        isNot(zh.aiComposeError(outcome)),
      );
    });
  });

  // ── M2: the send-failure banner's resend action ────────────────────────────
  group('send failure retry', () {
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    test('without a retry callback the banner keeps the legacy single-callback '
        'shape: ✕ fires the dismiss, no action button', () {
      int dismissed = 0;
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        sendFailure: ComposeSendFailure.noResult,
        onDismissSendFailure: () => dismissed++,
      );
      final BannerItem top = q.top!;
      expect(top.id, BannerIds.composeSend);
      expect(top.severity, BannerSeverity.blocking);
      expect(top.dismissible, isTrue);
      expect(top.actionLabel, isNull);
      expect(top.onDismiss, isNull);
      top.onAction!();
      expect(dismissed, 1);
    });

    test('with a retry callback the banner carries BOTH: the action button '
        'fires the retry, ✕ fires the dismiss — never the retry', () {
      int retried = 0;
      int dismissed = 0;
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.connected,
        autoStopped: false,
        strings: zh,
        sendFailure: ComposeSendFailure.wireFailed,
        onDismissSendFailure: () => dismissed++,
        onRetrySendFailure: () => retried++,
      );
      final BannerItem top = q.top!;
      expect(top.actionLabel, zh.resendAction);
      expect(top.dismissible, isTrue);
      top.onAction!();
      expect(retried, 1);
      expect(dismissed, 0, reason: 'the action button is not a dismiss');
      // ✕ resolves through the dedicated dismiss, not the retry.
      top.onDismiss!();
      expect(dismissed, 1);
      expect(retried, 1, reason: '✕ must never fire the retry');
    });

    test('resend copy is per-locale distinct', () {
      // Nine-locale expansion (2026-08-14): the criterion changed from
      // `hasLength(4)` to `expectPerLocaleDistinct`. The former, under nine
      // locales, required "exactly 4 distinct values among nine" = **required
      // five of them to be copies**; the latter requires pairwise distinctness,
      // and any allowed collision must be named. measured: resendAction is
      // distinct in all nine locales, so this case needs not a single mayShare.
      expectPerLocaleDistinct(
        (AppStrings s) => s.resendAction,
        what: 'resendAction',
      );
    });
  });

  // ── 0.2.27: the cross-device conflict group was HERE ────────────────────────
  //
  // Five cases covered `BannerIds.timelineConflict` — the severity ruling
  // (degraded + dismissible, never blocking), the two-kinds-two-sentences rule,
  // FIFO deferral behind an equally-degraded link notice, and the four-locale
  // distinctness of both sentences. All five described a banner whose ONLY
  // producer was the `history:update` ack, retired with the uplink (owner
  // 架构裁定: 云端不存转录). Deleted together with the banner, the id and the two
  // strings — keeping tests over a surface that can never appear would make the
  // suite assert a flow the product no longer has.
}
