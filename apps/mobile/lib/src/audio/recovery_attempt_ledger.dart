// Card RC-N — WHICH WIRE SESSION A LATE FRAME BELONGS TO, AND WHAT MAY BECOME
// OF IT.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §3.3 / §4.2 / §8 RC-N,
//     §11 MAIN ruling 2 (option B)
//   apps/mobile/lib/src/audio/article_scribe.dart (the one owner of this object)
//   apps/mobile/lib/src/session/chat_utterance_owner.dart (the one reader of a
//     frame's owner)
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// One replay cursor answered 「where does the next row go」 for EVERY row that
// settled while it was open, whoever's frame it was. Two measured shapes:
//   · S5: the phone gave up on a live stop at 15 s, a recovery opened the
//     cursor, and the live terminal final that arrived 585 ms later was placed
//     on the recovery's cursor — 60,714 + 5,000 = 65,714, an offset another row
//     already held;
//   · S6: a recovery attempt the phone had judged failed kept its cursor open,
//     its result arrived 11 s later and was minted anyway; the next attempt
//     minted the same words again — 1:42 of recording read 3:54.
//
// ⇒ every recovery attempt that opens on the wire is registered here with its
// own cursor, and a frame is placed by the session it BELONGS to (the receipt's
// echo on a terminal final; the session open on the wire for the rest).
//
// ── MAIN RULING 2, OPTION B ──────────────────────────────────────────────────
//
// A late, complete result of an attempt judged failed is SETTLED when no newer
// attempt has been opened for the same range — the relay already transcribed
// it and the account already paid for it. When a newer attempt exists the late
// result is DROPPED and writes no row: the newer attempt owns that range now.
//
// ⚠️ IN MEMORY ONLY, AND BOUNDED. A late frame outlives its attempt by seconds
// (the relay's flush), never by a process: after a restart there is no wire
// session it could belong to. [kLedgerCapacity] is far above one sweep's worth.

import 'article_replay.dart';

/// Where a frame of a known attempt goes now. See [RecoveryAttemptLedger.routeOf].
enum AttemptRoute {
  /// The attempt is still waiting on its result: the ordinary path.
  current,

  /// The attempt reached its conclusion and was not judged failed: its rows may
  /// still be landing (the settle runs a microtask after the terminal frame).
  concluded,

  /// The attempt was judged failed, and nothing newer covers its range yet:
  /// ruling 2 option B — its result is settled when it comes.
  lateFailed,

  /// A newer attempt covers the same range: the frame is dropped.
  superseded,
}

/// What a late failed attempt's terminal final brought. [rowIds] are the rows
/// minted for it (empty when it carried no words).
typedef LateAttemptResult = void Function(List<String> rowIds, Object finalFrame);

class _Attempt {
  _Attempt({
    required this.rangeKey,
    required this.rangeMs,
    required this.cursor,
  });

  final String rangeKey;
  final int rangeMs;
  final ArticleReplayCursor? cursor;
  bool concluded = false;
  bool failed = false;
  bool superseded = false;
  LateAttemptResult? onLate;

  /// Codex rc3 ⑥ — the wait ended without a result and the leg has not yet
  /// written its verdict; a late result that lands now is kept for it.
  bool pendingVerdict = false;
  (List<String>, Object)? buffered;
}

/// Bound on remembered attempts. One sweep opens one attempt per owed stretch.
const int kLedgerCapacity = 32;

class RecoveryAttemptLedger {
  final Map<String, _Attempt> _attempts = <String, _Attempt>{};

  /// How a late settle is run. `BackfillRunner` installs its single-flight
  /// queue here (`journalLeg`), so a late settle never writes a manifest while
  /// an attempt holds a handle on it; the default runs it at once.
  Future<void> Function(Future<void> Function() work) serialize =
      (Future<void> Function() work) => work();

  /// The recovery attempt whose session is open on the wire — the last
  /// `audio:start` this phone sent — or null when that was not a registered
  /// attempt (see [wireIsLive]).
  String? _wireAttemptId;
  String? get wireAttemptId => _wireAttemptId;

  /// True when the last `audio:start` was a live press; false when it was a
  /// recovery; null before any, and for the legacy segment leg, whose frames
  /// keep the placement they always had (whichever cursor is open).
  bool? _wireIsLive;
  bool? get wireIsLive => _wireIsLive;

  /// A live press opened the wire (`ptt_edges.dart` `pttDown`).
  void openedLive() {
    _wireAttemptId = null;
    _wireIsLive = true;
  }

  /// A recovery without an identity opened the wire (the legacy segment leg,
  /// `ptt_backfill.dart` `beginBackfill`).
  void openedUntracked() {
    _wireAttemptId = null;
    _wireIsLive = null;
    _wireYielded = false;
  }

  // ── Follow-up (MAIN 2026-09-24): LIVE SPEECH OWNS THE WIRE ────────────────
  //
  // A recovery attempt and live speech contend for one socket. Live wins, both
  // ways round: a live press or recording that starts while an attempt is on
  // the wire makes it YIELD (`ptt_backfill.dart` `yieldRecoveryForLive`), and
  // no attempt opens from the moment a live press begins until its terminal
  // final has landed (or is given up on) — so a live final can never arrive
  // while a recovery holds the wire, and the live settle stays the live
  // recording's to do.

  bool _liveHold = false;
  bool _heldSweep = false;
  bool _wireYielded = false;
  bool _discardUntilAck = false;

  /// Card RC5 — how many account changes this phone has begun. An attempt
  /// reads it when it starts preparing (`RecoveryJournalLeg._attempt`) and
  /// `_runOnWire` refuses to send `audio:start` when it has moved: the account
  /// the attempt was checked against is no longer the one signed in. Bumped by
  /// the account-change hook (chat_ptt_lifecycle.dart
  /// `stopRecordingForAccountChange`).
  int _accountChanges = 0;
  int get accountChanges => _accountChanges;
  void accountChanging() => _accountChanges += 1;

  /// Card RC6 — an account change is waiting for a yielded attempt's discard
  /// stop to be acknowledged, with the outgoing account still signed in. No
  /// attempt may open meanwhile (`_runOnWire` refuses): the yield's own resume
  /// and the recording-end sweep would otherwise start the stretch again under
  /// the account that is leaving. Opened and lifted by the account-change hook
  /// (chat_ptt_lifecycle.dart `stopRecordingForAccountChange`).
  bool _accountChangeOpen = false;
  bool get accountChangeOpen => _accountChangeOpen;
  void accountChangeOpened() => _accountChangeOpen = true;
  void accountChangeSettled() => _accountChangeOpen = false;

  /// A live press has begun and its terminal final has not landed yet.
  bool get liveHold => _liveHold;
  void liveStarted() => _liveHold = true;
  void liveSettled() => _liveHold = false;

  /// A recovery pass was held (or yielded) for live speech; the pass owed
  /// runs once the live session settles. Read-and-clear.
  ///
  /// [onSweepHeld] is told each time (the chat layer arms the wait for the
  /// live final only then, so a press that owes nothing leaves no timer).
  void noteHeldSweep() {
    _heldSweep = true;
    onSweepHeld?.call();
  }

  void Function()? onSweepHeld;

  /// Whether a held pass is waiting (without taking it).
  bool get hasHeldSweep => _heldSweep;
  bool takeHeldSweep() {
    final bool held = _heldSweep;
    _heldSweep = false;
    return held;
  }

  /// The recovery attempt on the wire yields to live speech: its frames are
  /// dropped from here on (a newer session owns the wire, exactly as a newer
  /// attempt of the same range would), and inbound transcript frames are
  /// discarded until the relay acknowledges the discarding `audio:stop` —
  /// the socket is ordered, so every frame the relay produced for the
  /// attempt precedes that acknowledgement (server-core `audio.handler.ts`:
  /// a `discard` stop disposes the session, which emits nothing further, and
  /// acks at the end of the handler).
  void yieldWire() {
    final String? id = _wireAttemptId;
    final _Attempt? a = id == null ? null : _attempts[id];
    if (a != null) {
      a
        ..superseded = true
        ..concluded = true
        ..onLate = null;
    }
    _wireYielded = true;
    _yieldedAttemptId = id;
    _discardUntilAck = true;
    _heldSweep = true;
  }

  String? _yieldedAttemptId;

  /// A registered recovery attempt holds the wire and is still waiting on its
  /// result (neither concluded nor yielded).
  bool get wireAttemptInFlight {
    final String? id = _wireAttemptId;
    return _wireIsLive == false &&
        id != null &&
        !_wireYielded &&
        routeOf(id) == AttemptRoute.current;
  }

  /// The last recovery attempt opened on the wire has yielded.
  bool get wireYielded => _wireYielded;

  /// Whether [attemptId] is the attempt that yielded (kept across the live
  /// press that follows, which re-points the wire).
  bool wasYielded(String attemptId) =>
      _wireYielded && _yieldedAttemptId == attemptId;

  /// Inbound transcript frames are the yielded attempt's until this clears.
  bool get discardingYieldedFrames => _discardUntilAck;
  void yieldedStopAcknowledged() => _discardUntilAck = false;

  /// A recovery attempt opened the wire (`recovery_leg_wire.dart` `_runOnWire`).
  /// Every earlier attempt of the same range is superseded from here on.
  void openedRecovery({
    required String attemptId,
    required String recordingId,
    required int rangeStartSample,
    required int rangeEndSample,
    required int rangeMs,
    ArticleReplayCursor? cursor,
  }) {
    final String key = '$recordingId@$rangeStartSample-$rangeEndSample';
    for (final _Attempt a in _attempts.values) {
      if (a.rangeKey == key) {
        a.superseded = true;
        a.onLate = null;
      }
    }
    _attempts.remove(attemptId);
    _attempts[attemptId] =
        _Attempt(rangeKey: key, rangeMs: rangeMs, cursor: cursor);
    while (_attempts.length > kLedgerCapacity) {
      _attempts.remove(_attempts.keys.first);
    }
    _wireAttemptId = attemptId;
    _wireIsLive = false;
    _wireYielded = false;
  }

  /// The attempt id the session open on the wire answers to — the live
  /// attempt's ([liveAttemptId], stamped on its `audio:start`) or the
  /// registered recovery's — or null when that cannot be said.
  String? wireEchoId({String? liveAttemptId}) => switch (_wireIsLive) {
        true => liveAttemptId,
        false => _wireAttemptId,
        null => null,
      };

  /// A terminal final's receipt [echo] names a session OTHER than the one open
  /// on the wire. Such a frame must not touch the open session's segment
  /// buffer or close its PROCESSING (`ptt_inbound.dart`), and is settled on its
  /// own (`chat_utterance_owner.dart`). A null echo, or a wire that cannot be
  /// named, is never foreign: the frame keeps today's path.
  bool isForeignEcho(String? echo, {String? liveAttemptId}) {
    final String? wire = wireEchoId(liveAttemptId: liveAttemptId);
    return echo != null && wire != null && echo != wire;
  }

  /// Codex rc3 ④ — the live attempts this phone opened, with the article each
  /// was filed under (null for an ordinary press). A late terminal final whose
  /// receipt names one that is no longer the live attempt belongs to THAT
  /// recording, never to the one running now.
  final Map<String, String?> _liveArticles = <String, String?>{};

  void noteLiveAttempt(String attemptId, String? articleId) {
    _liveArticles.remove(attemptId);
    _liveArticles[attemptId] = articleId;
    while (_liveArticles.length > kLedgerCapacity) {
      _liveArticles.remove(_liveArticles.keys.first);
    }
  }

  String? articleOfLive(String attemptId) => _liveArticles[attemptId];

  /// Card RC6 (F2 ③) — live attempts whose owed tail was handed to a recovery
  /// WITHOUT their terminal final (the stop wait or its grace ran out). Their
  /// words are the recovery's now: a late final of one of them is dropped,
  /// which is RC-N's rule for a result a newer attempt already covers.
  final Set<String> _supersededLive = <String>{};

  void supersedeLive(String attemptId) {
    _supersededLive.add(attemptId);
    while (_supersededLive.length > kLedgerCapacity) {
      _supersededLive.remove(_supersededLive.first);
    }
  }

  bool isSupersededLive(String attemptId) => _supersededLive.contains(attemptId);

  /// Whether this ledger has ever seen [attemptId].
  bool knows(String attemptId) => _attempts.containsKey(attemptId);

  /// The attempt's wait ended (`_runOnWire` returned).
  ///
  /// Codex rc3 ⑥ — [awaitingVerdict]: it ended WITHOUT its result, so the leg
  /// is about to judge it (`_finish`, which awaits storage before it writes a
  /// failure). Until [failed] or [verdictGiven], the attempt already routes as
  /// a late failed one, and a result that lands in that gap is kept for
  /// [failed]'s hook instead of being minted as an ordinary row that nothing
  /// ever settles.
  void concluded(String attemptId, {bool awaitingVerdict = false}) {
    final _Attempt? a = _attempts[attemptId];
    if (a == null) return;
    a.concluded = true;
    if (awaitingVerdict && !a.superseded) {
      a
        ..failed = true
        ..pendingVerdict = true;
    }
  }

  /// The attempt was closed as FAILED (`recovery_leg_settle.dart` `_finish`).
  /// [onLate] is called once if its terminal final still arrives while no
  /// newer attempt covers its range — or at once, with a result that already
  /// arrived while the verdict was being written.
  void failed(String attemptId, {LateAttemptResult? onLate}) {
    final _Attempt? a = _attempts[attemptId];
    if (a == null) return;
    a
      ..concluded = true
      ..failed = true
      ..pendingVerdict = false
      ..onLate = a.superseded ? null : onLate;
    final (List<String>, Object)? b = a.buffered;
    a.buffered = null;
    if (b != null) lateResultLanded(attemptId, b.$1, b.$2);
  }

  /// Codex rc3 ⑥ — the leg wrote a verdict that is not a failure (rows came
  /// back, a shortfall, an empty result…): the provisional late-failed routing
  /// ends and a kept result is dropped (its row, if any, already exists).
  void verdictGiven(String attemptId) {
    final _Attempt? a = _attempts[attemptId];
    if (a == null || !a.pendingVerdict) return;
    a
      ..pendingVerdict = false
      ..failed = false
      ..buffered = null;
  }

  AttemptRoute routeOf(String attemptId) {
    final _Attempt? a = _attempts[attemptId];
    if (a == null) return AttemptRoute.current;
    if (a.superseded) return AttemptRoute.superseded;
    if (!a.concluded) return AttemptRoute.current;
    return a.failed ? AttemptRoute.lateFailed : AttemptRoute.concluded;
  }

  /// The cursor [attemptId] was opened with, or null when its range is not
  /// inside an article (its rows are ordinary rows).
  ArticleReplayCursor? cursorOf(String attemptId) => _attempts[attemptId]?.cursor;

  /// The fed range's length, for a late row that has no buffer to sum.
  int? rangeMsOf(String attemptId) => _attempts[attemptId]?.rangeMs;

  /// A late failed attempt's terminal final settled: hand it to the leg, once.
  void lateResultLanded(String attemptId, List<String> rowIds, Object finalFrame) {
    final _Attempt? a = _attempts[attemptId];
    final LateAttemptResult? f = a?.onLate;
    if (a != null && f == null && a.pendingVerdict) {
      a.buffered ??= (rowIds, finalFrame); // Codex rc3 ⑥ — for [failed]
      return;
    }
    if (a == null || f == null) return;
    a.onLate = null;
    f(rowIds, finalFrame);
  }
}
