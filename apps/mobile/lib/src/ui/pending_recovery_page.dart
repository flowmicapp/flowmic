// Card RC-1b — THE SCREEN FOR AUDIO THAT IS STILL ON THIS PHONE.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md  (O-3, O-5, O-8, O-9)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A6 R-2 (a manual retry MUST exist), §A7-3 (tier C has no button),
//     §A8-1 P2-10 (copy branches on real capability)
//   apps/mobile/lib/src/session/pending_recovery.dart (the states and actions)
//   apps/mobile/lib/src/ui/pending_recovery_card.dart (one card)
//
// ── WHY A SCREEN AT ALL ─────────────────────────────────────────────────────
//
// Everything before this card made audio survive and made a queue that feeds it
// back. Neither of those is visible: with the automatic budget spent (owner
// ruling O-9: five attempts) or with an old server in front of us (A7-3 tier
// C), a recording sits on the disk with no route and nothing on any screen
// saying so. §A6 R-2 is one line long — 「增加手动重试入口（用户可见）」, add a
// manual retry entry the user can see — and this is it.
//
// 🔴 IT IS A READ PLUS TWO ACTIONS, AND THE TWO ARE THE ONLY TWO. No playback,
// no export (O-3), no 「send to PC」 (O-8). pending_recovery_card.dart's header
// carries the same list, because the temptation lands on the card.

import 'dart:async';

import 'package:flutter/material.dart';

import '../session/pending_recovery.dart';
import '../settings/app_strings.dart';
import 'confirm_dialog.dart';
import 'pending_recovery_card.dart';
import 'tokens.dart';

/// The list of recordings still waiting, with the two sanctioned actions.
class PendingRecoveryPage extends StatefulWidget {
  const PendingRecoveryPage({
    super.key,
    required this.source,
    required this.strings,
  });

  final PendingRecoverySource source;
  final AppStrings strings;

  @override
  State<PendingRecoveryPage> createState() => _PendingRecoveryPageState();
}

class _PendingRecoveryPageState extends State<PendingRecoveryPage> {
  List<PendingRecoveryItem> _items = const <PendingRecoveryItem>[];
  bool _loading = true;

  /// Which card, if any, has an action in flight.
  ///
  /// 🔴 ONE AT A TIME, AND IT IS NOT COSMETIC. `BackfillRunner.retranscribe`
  /// queues behind whatever is running, so a second press would sit there and
  /// then run a second attempt the user never meant to ask for — and the first
  /// press's own reload would already have redrawn the list underneath them.
  String? _busy;

  /// The last refusal, shown under the list until the next action.
  ///
  /// ⚠️ It is NOT a banner and NOT a timer: this page is the only thing on
  /// screen, the message describes the press that just happened, and the next
  /// press replaces it. A transient toast here would let the answer disappear
  /// before the person looked back up from the button.
  String? _notice;

  @override
  void initState() {
    super.initState();
    unawaited(_reload());
  }

  Future<void> _reload() async {
    final List<PendingRecoveryItem> rows = await widget.source.list();
    if (!mounted) return;
    setState(() {
      _items = rows;
      _loading = false;
    });
  }

  /// §A6 R-2's press.
  ///
  /// 🔴 THE REFUSALS COME BACK FROM THE PRODUCT, NOT FROM A GUESS MADE HERE.
  /// This page hides the button while a recording is running, but that is a
  /// courtesy — the FSM and `evaluateRecoveryGate` are the authorities, and a
  /// press that reaches them and is refused gets the refusal's own sentence.
  /// Deciding here would put a second author on a rule that already has one.
  Future<void> _retry(PendingRecoveryItem item) async {
    setState(() {
      _busy = item.id;
      _notice = null;
    });
    final PendingRetryOutcome outcome = await widget.source.retryNow(item);
    if (!mounted) return;
    setState(() {
      _busy = null;
      _notice = _noticeFor(outcome);
    });
    await _reload();
  }

  /// 🔴 EXHAUSTIVE, NO DEFAULT — see [PendingRecoveryCard.sentenceFor] for the
  /// same rule and the same reason.
  ///
  /// [PendingRetryOutcome.done] says nothing: the list is re-read and the card
  /// either changed or went away, which is a stronger statement than a sentence
  /// claiming a success this layer cannot see (A5-3 may still have kept the
  /// bytes).
  String? _noticeFor(PendingRetryOutcome outcome) {
    final AppStrings s = widget.strings;
    return switch (outcome) {
      PendingRetryOutcome.done => null,
      PendingRetryOutcome.refusedBusy => s.pendingRecoveryRetryBusy,
      PendingRetryOutcome.refusedServer =>
        s.pendingRecoveryStateServerUnsupported,
      PendingRetryOutcome.failed => s.pendingRecoveryRetryFailed,
      // Nothing to drive and nothing went wrong. The card is simply gone on the
      // next read (it was settled, cancelled or removed under us), so the
      // reload below is the whole answer.
      PendingRetryOutcome.unavailable => null,
    };
  }

  /// Owner ruling O-5's delete — the one path by which captured audio leaves
  /// this phone at a person's request.
  Future<void> _delete(PendingRecoveryItem item) async {
    final AppStrings s = widget.strings;
    final bool ok = await confirmDestructive(
      context,
      title: s.pendingRecoveryDeleteTitle,
      message: s.pendingRecoveryDeleteBody,
      confirmLabel: s.confirmDelete,
      cancelLabel: s.cancel,
      // 🔴 NO `unaffected` PANEL. `confirm_dialog.dart`'s own doc: a delete
      // that really does destroy everything it touches must not grow a
      // reassurance panel just because the widget offers one. This one does.
    );
    if (!ok || !mounted) return;
    setState(() {
      _busy = item.id;
      _notice = null;
    });
    final PendingDeleteOutcome outcome = await widget.source.delete(item);
    if (!mounted) return;
    setState(() {
      _busy = null;
      // 🔴 A FAILED DELETE GETS A SENTENCE. The card coming back is not one:
      // this page re-reads its list after every action, so 「still there」 is
      // also what a successful delete of some OTHER card looks like, and the
      // user pressed a destructive confirm to make this one go away. Silence
      // here is how the invisible orphan started (PendingDeleteOutcome).
      _notice =
          outcome == PendingDeleteOutcome.failed ? s.pendingRecoveryDeleteFailed : null;
    });
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      appBar: AppBar(
        backgroundColor: FlowMicColors.surface,
        surfaceTintColor: FlowMicColors.surface,
        title: Text(
          s.pendingRecoveryTitle,
          key: const Key('pendingRecovery.title'),
          style: TextStyle(color: FlowMicColors.t1, fontSize: 15),
        ),
        iconTheme: IconThemeData(color: FlowMicColors.t2),
      ),
      body: SafeArea(child: _body(s)),
    );
  }

  Widget _body(AppStrings s) {
    if (_loading) {
      return const Center(
        child: SizedBox(
          key: Key('pendingRecovery.loading'),
          width: 18,
          height: 18,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_items.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Text(
          s.pendingRecoveryEmpty,
          key: const Key('pendingRecovery.empty'),
          style: TextStyle(color: FlowMicColors.t2, fontSize: 12.5),
        ),
      );
    }
    // 🔴 `recordingNow` IS READ ONCE PER BUILD, NOT CACHED IN STATE. The
    // microphone can open while this page is up (the chat page is underneath
    // it), and a snapshot taken in `initState` would leave a button enabled
    // through a whole recording. It is still only a courtesy — see [_retry].
    final bool recording = widget.source.recordingNow;
    return ListView.builder(
      key: const Key('pendingRecovery.list'),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 20),
      itemCount: _items.length + (_notice == null ? 0 : 1),
      itemBuilder: (BuildContext context, int i) {
        if (i == _items.length) return _noticeLine(_notice!);
        final PendingRecoveryItem item = _items[i];
        return PendingRecoveryCard(
          item: item,
          strings: s,
          onRetry: recording || _busy != null
              ? null
              : () => unawaited(_retry(item)),
          // 🔴 DELETE IS GATED ON `_busy` TOO, and it is not symmetry for its
          // own sake. A retry in flight holds an open journal handle on that
          // recording; deleting underneath it let
          // `RecoveryJournalLeg._finish` write an outcome onto a recording
          // that no longer exists, which re-created the manifest of audio the
          // user had just removed. The leg now refuses that as well (it
          // re-checks the manifest before it commits), because a UI courtesy
          // is not a guarantee — but the two together mean the press never has
          // to race at all.
          onDelete: _busy != null ? null : () => unawaited(_delete(item)),
        );
      },
    );
  }

  Widget _noticeLine(String text) => Padding(
        key: const Key('pendingRecovery.notice'),
        padding: const EdgeInsets.only(top: 4),
        child: Text(
          text,
          style: TextStyle(
            color: FlowMicColors.t2,
            fontSize: 12,
            height: 1.35,
          ),
        ),
      );
}
