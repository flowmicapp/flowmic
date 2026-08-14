// card fix-018 — owner's 63-transient / 64-standing ruling, as BEHAVIOUR.
//
// owner 2026-08-07 gave the two macOS injection-refusal codes OPPOSITE queue
// semantics (`docs/decisions/2026-08-07-owner-grants-mac-injection-refusal-
// codes-63-64.md`):
//
//   · 63 `INJECT_SECURE_INPUT_ACTIVE` — TRANSIENT.「可重试；下一次排空应当再试」
//     The OS was blocking synthesized input AT THAT INSTANT (a password field,
//     Terminal's secure keyboard entry, the lock screen). The same frame aimed at
//     the same target can legitimately succeed a moment later.
//   · 64 `INJECT_NO_ACCESSIBILITY` — STANDING.「终态；不许无限重投」
//     Nothing changes until the user grants the permission, so retrying is noise
//     — owner's words for it: 「每次重连都撞同一堵墙」.
//
// 🔴 WHAT THIS FILE HAS TO PROVE, AND WHY A PASSING TEST IS NOT AUTOMATICALLY
// EVIDENCE. Before this card BOTH codes settled `delivered` on the first verdict
// and rendered the same face — the ruling produced ZERO behavioural difference.
// A test that passes for both codes therefore proves nothing here: it would have
// been green on the broken implementation too. **Every assertion below that
// matters is a DIFFERENCE**, written so that flattening the two back together
// fails in EITHER direction (63 made terminal, or 64 made retryable).
//
// ⚠️ WHAT THIS FILE CANNOT PROVE, said out loud rather than left implied by a
// green run: both codes are raised by macOS preflight (`inject/preflight.rs`
// `synthetic_input_verdict`). Everything here is Dart on a Windows gate, so this
// covers the MAPPING and the QUEUE BEHAVIOUR. It does not cover the real macOS
// trigger — no secure-input field and no Accessibility prompt is exercised.
//
// SPEC-REF:
//   docs/decisions/2026-08-07-owner-grants-mac-injection-refusal-codes-63-64.md
//   docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md (the bound)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0.1 / §2.6
//   packages/protocol/src/inject-verdict-authorship.ts (段① authorship, unchanged)

import 'dart:typed_data';

import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/session/outbox_destination.dart';
import 'package:flowmic/src/session/outbox_inject_authorship.dart';
import 'package:flowmic/src/session/outbox_inject_origin.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

const String kSecureInput = 'INJECT_SECURE_INPUT_ACTIVE';
const String kNoAccessibility = 'INJECT_NO_ACCESSIBILITY';

const String _kMachine = 'machine-uid-MAC';
const String _kPairing = 'standalone|instance:inst-mac';
const LiveConnection _kOnLan = LiveConnection(
  machineUid: _kMachine,
  pairingIdentity: _kPairing,
  pcId: 'pc-mac-lan',
  channel: ServerChannel.lan,
);

/// Records what actually went on the wire — the only way to tell 「the queue says it is still owed」
/// apart from 「the queue actually sent it again」. A state assertion alone cannot: an item left
/// at `queued` that nothing ever re-sends is the perpetual-「待投递」 defect, not a retry.
class _Host implements OutboxDrainHost {
  final List<OutboxItem> sent = <OutboxItem>[];

  @override
  LiveConnection get liveConnection => _kOnLan;
  @override
  Future<bool> ensureLink() async => true;
  @override
  Future<void> reseedDestination() async {}
  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    sent.add(item);
    return true;
  }

  @override
  void onOutboxChanged() {}
}

DeliveryOutbox _box(_Host host, OutboxStore store) => DeliveryOutbox(
  store: store,
  blobs: InMemoryOutboxBlobStore(),
  host: host,
  capacity: kOutboxCapacity,
  inflightTimeout: kOutboxInflightTimeout,
);

/// 🔴 THE FIXTURE'S AGE IS THE POINT, so it is expressed RELATIVE TO NOW.
///
/// An absolute literal (what the sibling outbox suites use) would drift further
/// out of the live window every day the repo exists — the test would keep
/// passing while silently ceasing to exercise the fresh-utterance path, which is
/// the only path this card changed.
Future<OutboxItem?> _enqueue(
  DeliveryOutbox box, {
  String requestId = 'r1',
  Duration age = Duration.zero,
}) => box.enqueueText(
  requestId: requestId,
  entryId: 'loc_$requestId',
  wireEntryId: 'loc_$requestId',
  source: 'stt',
  text: 'hello computer',
  mode: 'realtime',
  createdAt: DateTime.now().toUtc().subtract(age),
);

Future<OutboxItem> _read(OutboxStore store, String requestId) async =>
    (await store.findByRequestId(requestId))!;

/// One delivery, drained once, answered once — the shape every case starts from.
Future<({_Host host, OutboxStore store, DeliveryOutbox box})> _deliverAndAnswer(
  String code, {
  Duration age = Duration.zero,
}) async {
  final _Host host = _Host();
  final OutboxStore store = InMemoryOutboxStore();
  final DeliveryOutbox box = _box(host, store);
  await _enqueue(box, age: age);
  await box.drain();
  await box.settle(correlationId: 'r1', ok: false, code: code);
  return (host: host, store: store, box: box);
}

void main() {
  group('fix-018 · 63 and 64 must take DIFFERENT paths', () {
    test(
      '🔴 THE DIFFERENCE ITSELF: a fresh utterance settles 63 non-terminal and '
      '64 terminal — flattening either way fails here',
      () async {
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) secure =
            await _deliverAndAnswer(kSecureInput);
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) noAx =
            await _deliverAndAnswer(kNoAccessibility);

        final OutboxItem afterSecure = await _read(secure.store, 'r1');
        final OutboxItem afterNoAx = await _read(noAx.store, 'r1');

        // 🔴 THE GUARD AGAINST RE-FLATTENING. Stated as an inequality first and
        // on purpose: the two exact expectations below would both have to be
        // edited to collapse these codes again, but somebody "simplifying" one
        // of them still trips this line.
        expect(
          afterSecure.state,
          isNot(afterNoAx.state),
          reason:
              'owner ruled OPPOSITE queue semantics for 63 and 64; identical '
              'states mean the ruling has been flattened back out again',
        );

        // 63 — transient: still owed, because a retry is genuinely pending.
        expect(afterSecure.state, OutboxDeliveryState.queued);
        expect(afterSecure.isTerminal, isFalse);
        expect(afterSecure.lastRefusalNote, kSecureInput);

        // 64 — standing: terminal, and terminal on the SUCCESS side. `refused`
        // would mean 「投递失败（未投递）」, which is false about a frame the PC
        // received, minted a row for and answered (R11 + delivery ≠ injection).
        expect(afterNoAx.state, OutboxDeliveryState.delivered);
        expect(afterNoAx.isTerminal, isTrue);
        expect(afterNoAx.state, isNot(OutboxDeliveryState.refused));

        secure.box.dispose();
        noAx.box.dispose();
      },
    );

    test(
      '🔴 the difference is BEHAVIOUR, not a word: the next drain re-sends 63 '
      'under the SAME request_id and sends nothing at all for 64',
      () async {
        // Without this test 「63 ⇒ queued」 could be satisfied by an item that
        // sits there forever — which is the 0.2.48 P0, not a retry.
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) secure =
            await _deliverAndAnswer(kSecureInput);
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) noAx =
            await _deliverAndAnswer(kNoAccessibility);

        expect(secure.host.sent.length, 1);
        expect(noAx.host.sent.length, 1);

        await secure.box.drain();
        await noAx.box.drain();

        expect(
          secure.host.sent.length,
          2,
          reason: 'owner: 63 「下一次排空应当再试」',
        );
        // 🔴 闸1 — the retry re-sends THIS delivery, it does not mint a new one.
        // That is what keeps the desktop's row an upsert (`row_transit.rs`
        // `row_id` ⇒ `req:{request_id}`) rather than a second row on the user's
        // timeline, and what makes the retry idempotent instead of duplicative.
        expect(secure.host.sent[1].requestId, secure.host.sent[0].requestId);
        expect(
          noAx.host.sent.length,
          1,
          reason: 'owner: 64 「不许无限重投」 — 每次重连都撞同一堵墙',
        );

        secure.box.dispose();
        noAx.box.dispose();
      },
    );

    test(
      '🔴 while the 63 retry is pending the row is NOT finished (R11), and the '
      '64 row is — the queue projections the banner and the tile read',
      () async {
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) secure =
            await _deliverAndAnswer(kSecureInput);
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) noAx =
            await _deliverAndAnswer(kNoAccessibility);

        // 「is this row's delivery still owed」 — the projection `ChatController` hands the
        // tile as `queued:` and the banner counts. A pending retry MUST say yes:
        // a row reading 「已投递」 while another frame is queued for it would be
        // 「凭什么这么说」 with no answer.
        expect(secure.box.owedEntryIds, contains('loc_r1'));
        expect(secure.box.pendingCountFor(_kPairing), 1);

        expect(noAx.box.owedEntryIds, isNot(contains('loc_r1')));
        expect(noAx.box.pendingCountFor(_kPairing), 0);

        secure.box.dispose();
        noAx.box.dispose();
      },
    );
  });

  group('fix-018 · the 63 retry is BOUNDED (「不许无限重试」)', () {
    test(
      '🔴 bound ② — count: exactly ONE automatic re-attempt, then it settles '
      'terminal however many times the OS says 63',
      () async {
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) c =
            await _deliverAndAnswer(kSecureInput);
        expect((await _read(c.store, 'r1')).state, OutboxDeliveryState.queued);

        // The retry goes out and the OS is still blocking.
        await c.box.drain();
        await c.box.settle(correlationId: 'r1', ok: false, code: kSecureInput);

        final OutboxItem after = await _read(c.store, 'r1');
        expect(
          after.state,
          OutboxDeliveryState.delivered,
          reason: 'the budget is spent — it terminates in a readable state, '
              'not in another lap',
        );
        expect(after.isTerminal, isTrue);

        // And the terminal really stops the wire: further drains send nothing.
        final int sentSoFar = c.host.sent.length;
        expect(sentSoFar, 2);
        await c.box.drain();
        await c.box.drain();
        expect(c.host.sent.length, sentSoFar);
        expect(kTransientVerdictAttemptCap, 2);

        c.box.dispose();
      },
    );

    test(
      '🔴 bound ① — time: an utterance past the live window gets NO retry at '
      'all, because the PC would refuse to inject the re-delivery by design',
      () async {
        // owner 2026-08-02:「补投的消息不许自动注入」. Outside
        // `kLiveDeliveryWindow` the drain stamps `deferred` and the PC answers
        // INJECT_DEFERRED_NOT_AUTOINJECTED — so a retry there cannot inject
        // anything; it can only replace one honest verdict with a vaguer one.
        // 🔴 This clause is also what makes 「无限重试」 structurally impossible:
        // `created_at` is frozen (闸3), so it falls false on the wall clock no
        // matter how long secure input stays on.
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) stale =
            await _deliverAndAnswer(
          kSecureInput,
          age: kLiveDeliveryWindow + const Duration(seconds: 30),
        );

        final OutboxItem after = await _read(stale.store, 'r1');
        expect(after.state, OutboxDeliveryState.delivered);
        expect(after.isTerminal, isTrue);

        final int sentSoFar = stale.host.sent.length;
        await stale.box.drain();
        expect(stale.host.sent.length, sentSoFar);

        stale.box.dispose();
      },
    );

    test(
      'the boundary is the live-delivery rule itself, not a second copy of the '
      'number — just inside the window still retries',
      () async {
        // A positive control for the clause above: if the bound had been written
        // as its own threshold, the two would drift and this pair would stop
        // straddling the same edge.
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) fresh =
            await _deliverAndAnswer(
          kSecureInput,
          age: kLiveDeliveryWindow - const Duration(seconds: 5),
        );
        expect(
          (await _read(fresh.store, 'r1')).state,
          OutboxDeliveryState.queued,
        );
        fresh.box.dispose();
      },
    );
  });

  group('fix-018 · nothing else was widened', () {
    test(
      '🔴 the transient set holds exactly the ONE code owner ruled on',
      () {
        expect(kTransientInjectionVerdictCodes, <String>{kSecureInput});
        expect(isTransientInjectionVerdictCode(kSecureInput), isTrue);
        expect(isTransientInjectionVerdictCode(kNoAccessibility), isFalse);
        // Unknown ⇒ false. A wrong `true` here re-sends a frame the PC already
        // has, on a schedule nobody asked for.
        for (final String? code in <String?>[
          null,
          '',
          'INJECT_SOMETHING_NEW',
          'LINK_DOWN',
        ]) {
          expect(isTransientInjectionVerdictCode(code), isFalse, reason: '$code');
        }
      },
    );

    test(
      '🔴 段① is unchanged: BOTH codes are still PC injection-stage verdicts, '
      'and neither is a `refused`',
      () {
        // The retry dimension must not have been bought by moving a code out of
        // the authorship set — that would make the phone say 「未投递」 about a
        // frame that is demonstrably on the PC.
        expect(isPcInjectionVerdictCode(kSecureInput), isTrue);
        expect(isPcInjectionVerdictCode(kNoAccessibility), isTrue);
        expect(isTerminalRefusalCode(kSecureInput), isFalse);
        expect(isTerminalRefusalCode(kNoAccessibility), isFalse);
      },
    );

    test(
      '🔴 the rest of the pc-injection family still converges on the FIRST '
      'verdict even when the utterance is FRESH',
      () async {
        // 🔴 THIS ONE IS NOT DECORATION. Every sibling outbox suite builds its
        // fixture with an absolute `created_at` from 2026-08-02, i.e. always
        // outside the live window — so an implementation that granted the retry
        // to the WHOLE family would be invisible to all of them. Fresh
        // timestamps are the only way this widening shows up.
        for (final String code in <String>[
          'INJECT_FOCUS_LOST',
          'INJECT_CLIPBOARD_FAIL',
          'INJECT_IMAGE_UNSUPPORTED',
          'INJECT_TARGET_INVALID',
          'INJECT_SENDINPUT_FAIL',
          'INJECT_NO_TEXT_TARGET',
          'INJECT_DEFERRED_NOT_AUTOINJECTED',
          'INJECT_SELF_WINDOW_NO_INPUT',
          kNoAccessibility,
        ]) {
          final ({_Host host, OutboxStore store, DeliveryOutbox box}) c =
              await _deliverAndAnswer(code);
          expect(
            (await _read(c.store, 'r1')).state,
            OutboxDeliveryState.delivered,
            reason: code,
          );
          c.box.dispose();
        }
      },
    );

    test(
      '🔴 positive control: codes that were already retryable still are, and '
      'they are NOT the transient dimension',
      () async {
        // Without this, 「63 goes back to queued」 could be satisfied by an
        // implementation that sends everything back to queued.
        for (final String code in <String>[
          'INJECT_NOT_IN_ROOM',
          'INJECT_PC_OFFLINE',
          'INJECT_NOT_PRIMARY',
        ]) {
          final ({_Host host, OutboxStore store, DeliveryOutbox box}) c =
              await _deliverAndAnswer(code);
          expect(
            (await _read(c.store, 'r1')).state,
            OutboxDeliveryState.queued,
            reason: code,
          );
          expect(isTransientInjectionVerdictCode(code), isFalse, reason: code);
          c.box.dispose();
        }
      },
    );
  });

  group('fix-018 · the terminal latch still blocks verdict-replay rollback', () {
    test(
      '🔴 a replayed 63 verdict cannot drag a settled item back to queued',
      () async {
        // 🔴 THE REGRESSION THIS CARD COULD HAVE CAUSED, NAMED. This card added a
        // path that writes `queued` from INSIDE the PC-verdict branch — i.e. the
        // exact rollback shape card F11 ① latched shut (`delivered` → `queued` on a
        // duplicate arrival, which re-delivers a sentence that already landed and
        // turns the row's 「已投递」 back into 「待投递」). The dedup table on the
        // desktop deliberately does NOT record a `Cached` outcome, so a replay of
        // exactly this verdict is a thing that happens.
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) c =
            await _deliverAndAnswer(kSecureInput);

        // Spend the budget so the item is terminal.
        await c.box.drain();
        await c.box.settle(correlationId: 'r1', ok: false, code: kSecureInput);
        expect(
          (await _read(c.store, 'r1')).state,
          OutboxDeliveryState.delivered,
        );

        // Now replay it. Four times, like the F2 convergence suite: 「it is right after
        // the verdict arrived once」 proves nothing about 「it will not be flipped back」.
        for (int i = 0; i < 4; i++) {
          await c.box.settle(correlationId: 'r1', ok: false, code: kSecureInput);
          expect(
            (await _read(c.store, 'r1')).state,
            OutboxDeliveryState.delivered,
            reason: 'replay #$i rolled a settled delivery backwards',
          );
        }

        final int sentSoFar = c.host.sent.length;
        await c.box.drain();
        expect(c.host.sent.length, sentSoFar);
        expect(c.box.pendingCountFor(_kPairing), 0);

        c.box.dispose();
      },
    );

    test(
      '🔴 and it blocks the other direction too: a 64 verdict replayed onto a '
      'settled item does not re-open it',
      () async {
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) c =
            await _deliverAndAnswer(kNoAccessibility);
        for (int i = 0; i < 4; i++) {
          await c.box.settle(
            correlationId: 'r1',
            ok: false,
            code: kNoAccessibility,
          );
        }
        expect(
          (await _read(c.store, 'r1')).state,
          OutboxDeliveryState.delivered,
        );
        expect(c.box.owedEntryIds, isEmpty);
        c.box.dispose();
      },
    );

    test(
      'a named terminal refusal still wins over everything (red-line codes are '
      'not softened by the new branch)',
      () async {
        final ({_Host host, OutboxStore store, DeliveryOutbox box}) c =
            await _deliverAndAnswer('INJECT_PC_MISMATCH');
        final OutboxItem after = await _read(c.store, 'r1');
        expect(after.state, OutboxDeliveryState.refused);
        expect(after.refusedCode, 'INJECT_PC_MISMATCH');
        c.box.dispose();
      },
    );
  });
}
