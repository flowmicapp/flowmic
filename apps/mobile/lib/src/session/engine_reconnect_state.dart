// SPEC-REF:
//   docs/strategy/2026-09-24-reconnect-visibility-design.md §3.1 (the five
//     rules), §3.4 (this class — the single writer), §3.5 (the three optional
//     wire fields and what their absence means), §3.8 (one value, one question)
//   docs/rebuild/04-PROTOCOL.md §3 `stt:engine-status`
//
// Card NR-96-B — 「the relay is re-dialling the speech engine, and this is
// attempt n」, as a fact the recording screens can READ rather than infer.
//
// ── 🔴 ONE WRITER, THREE READERS ────────────────────────────────────────────
//
// The writer is the inbound dispatch loop (`ptt_inbound.dart`), the only
// place that sees `stt:engine-status`, `stt:interim` and `stt:final`; the
// capture-boundary edge (`ptt_continuous.dart`) is one more clearing edge. The
// readers are the push-to-talk strip's chip (`recording_panel.dart`), the
// long recording's bar chip (`continuous_live_bar.dart`) and the in-progress
// article page's status line (`article_page_live.dart`). None of the readers
// computes anything from `retry_count` itself: two screens that each worked
// it out could disagree about the same frame.
//
// ── 🔴 WHAT EACH EDGE MEANS (§3.1 rules 2 and 3) ────────────────────────────
//
//   · `reconnecting` ⇒ write. `retry_count` answers 「which attempt」 and
//     nothing else; it never says the engine is alive or dead (§3.8).
//   · `ready` / `failed` / `loading` ⇒ clear. `failed` is the give-up edge and
//     the relay sends it BEFORE `stt:error` (`engine-session.ts failTerminal`),
//     so the chip is gone before the named failure is drawn.
//   · any `stt:interim` / `stt:final` ⇒ clear. Transcript text can only come
//     from a live engine leg; that is a fact about the frame, not a guess.
//   · the capture ends (or a fresh one starts) ⇒ clear. What the chip
//     describes is THIS recording.
//   · the watchdog expires ⇒ clear, with a forensic line and NO sentence. The
//     expiry means 「the relay stopped reporting progress」 — neither success
//     nor failure, so it may be drawn as neither.
//
// ⚠️ The watchdog's deadline comes off the frame: `retry_in_ms` (the wait
// before the next attempt) + `attempt_timeout_ms` (how long that attempt may
// take). A frame that lacks either one — an old relay — arms no watchdog at
// all: there is no fact to compute it from, and this repo does not accept a
// local constant standing in for one (15 册 §1.4). Such a chip is cleared by
// the four other edges only.
//
// ── Card RC-3 — A SECOND VALUE, BECAUSE IT ANSWERS A SECOND QUESTION ────────
//
// The face answers 「is the relay re-dialling right now, and which attempt」,
// and it is right for it to go blank on `failed` and on the watchdog: there is
// no attempt to print. [engineDown] answers 「has a live engine leg been heard
// from since the relay said it lost one」 — the recording-side fact the retention
// sentence and the owed-tail accounting hang on (card RC-3; design
// docs/strategy/2026-09-24-cr12e-defects-root-cause.md §5 RC-3). The two
// disagree on exactly three edges, and that is why this is not the face read
// with `!= null`:
//   · `failed` — the relay gave up. The chip goes (nothing is being dialled),
//     the engine is still down: nothing after this point is being transcribed;
//   · the watchdog — the relay stopped reporting progress. Silence is not a
//     recovery either;
//   · `loading` — a local engine loading its model is not a leg that came back.
// It is cleared ONLY by `ready`, by an interim (a draft comes only from an open
// leg — a FINAL does not count, see [noteContentFrame]), and at the capture
// boundary (it describes THIS recording).

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../diag/diag_log.dart';

/// What the recording screens draw while the relay re-dials the engine.
@immutable
class EngineReconnectFace {
  const EngineReconnectFace({
    required this.attempt,
    required this.provider,
    this.max,
    this.expiresAt,
  });

  /// The relay's `retry_count`: which attempt this is, 1-based.
  final int attempt;

  /// The relay's `retry_max`, or null when the frame did not carry a usable
  /// one. Null means 「do not print a total」, whether because the ladder has
  /// none or because the relay is too old to say — the screens act the same in
  /// both cases (§3.8).
  final int? max;

  /// Which engine the relay named. Forensics only; no screen prints it.
  final String provider;

  /// When the relay's own numbers say the next progress frame is overdue, on
  /// this phone's clock. Null ⇒ no watchdog (the frame did not say).
  final DateTime? expiresAt;
}

/// The single writer's state. See the file header for every edge.
class EngineReconnectState {
  EngineReconnectState({DateTime Function()? clock})
      : _clock = clock ?? DateTime.now;

  final DateTime Function() _clock;
  final ValueNotifier<EngineReconnectFace?> _face =
      ValueNotifier<EngineReconnectFace?>(null);
  final ValueNotifier<bool> _engineDown = ValueNotifier<bool>(false);
  Timer? _watchdog;

  /// The readers' handle. Read-only on purpose: there is one writer.
  ValueListenable<EngineReconnectFace?> get listenable => _face;

  /// The current face, or null when nothing is being re-dialled.
  EngineReconnectFace? get value => _face.value;

  /// Card RC-3 — a `reconnecting` frame arrived and no live engine leg has been
  /// heard from since (see the header for the three edges on which this and
  /// [value] disagree). Readers: `PttSession.continuousOffline`
  /// (ptt/ptt_link_loss.dart) and the owed-tail accounting in
  /// ptt/ptt_capture_pump.dart.
  bool get engineDown => _engineDown.value;

  /// The page's rebuild handle for [engineDown]. Read-only: one writer.
  ValueListenable<bool> get engineDownListenable => _engineDown;

  /// One `stt:engine-status` frame, raw off the wire.
  void observeStatusFrame(Map<String, Object?> data) {
    final Object? status = data['status'];
    if (status != 'reconnecting') {
      // ready / failed / loading all end the reconnect this chip describes.
      // An off-contract status is not a reconnect either.
      _clear();
      // RC-3 — only `ready` says a leg is back (see the header).
      if (status == 'ready') _engineDown.value = false;
      return;
    }
    _engineDown.value = true; // RC-3 — the relay lost the leg, whatever the count
    final int? attempt = _positiveInt(data['retry_count']);
    if (attempt == null) {
      // No count ⇒ nothing honest to print. Left as it was, and said.
      diag('engine.reconnect.no_count', <String, Object?>{
        'retry_count': data['retry_count'],
      });
      return;
    }
    int? max = _positiveInt(data['retry_max']);
    // 「attempt 4 of 3」 is a relay bug, and printing it would be a lie on
    // this phone's screen. Drop the total, keep the count.
    if (max != null && max < attempt) max = null;
    final int? waitMs = _nonNegativeInt(data['retry_in_ms']);
    final int? timeoutMs = _positiveInt(data['attempt_timeout_ms']);
    final DateTime? expiresAt = waitMs == null || timeoutMs == null
        ? null
        : _clock().add(Duration(milliseconds: waitMs + timeoutMs));
    final Object? provider = data['provider'];
    _arm(expiresAt);
    _face.value = EngineReconnectFace(
      attempt: attempt,
      max: max,
      provider: provider is String ? provider : '',
      expiresAt: expiresAt,
    );
  }

  /// An `stt:interim` / `stt:final` arrived: only a live engine produces one.
  ///
  /// ⚠️ RC-3 — FOR THE CHIP ONLY. A FINAL does not clear [engineDown]: the relay
  /// emits one when it cuts a row from text it had already banked, and that cut
  /// can land while no leg is open (root-cause §1.4 step 1 — row u5 went out at
  /// 00:22:58.380 through a flush that resolved on a leg that never opened).
  /// See [noteInterimFrame] for the frame that does prove a live leg.
  void noteContentFrame() => _clear();

  /// Card RC-3 — an `stt:interim` arrived. Drafts are produced only by an open
  /// engine leg, so this is the one content frame that clears [engineDown].
  void noteInterimFrame() {
    _clear();
    _engineDown.value = false;
  }

  /// A capture started afresh or ended: whatever the chip said was about
  /// another one.
  void noteCaptureBoundary() {
    _clear();
    _engineDown.value = false;
  }

  void dispose() {
    _watchdog?.cancel();
    _watchdog = null;
    _face.dispose();
    _engineDown.dispose();
  }

  void _arm(DateTime? expiresAt) {
    _watchdog?.cancel();
    _watchdog = null;
    if (expiresAt == null) return;
    final Duration wait = expiresAt.difference(_clock());
    _watchdog = Timer(wait.isNegative ? Duration.zero : wait, () {
      _watchdog = null;
      final EngineReconnectFace? f = _face.value;
      diag('engine.reconnect.progress_silent', <String, Object?>{
        'attempt': f?.attempt,
        'max': f?.max,
        'provider': f?.provider,
      });
      _face.value = null;
    });
  }

  void _clear() {
    _watchdog?.cancel();
    _watchdog = null;
    _face.value = null;
  }

  static int? _positiveInt(Object? v) => v is int && v >= 1 ? v : null;
  static int? _nonNegativeInt(Object? v) => v is int && v >= 0 ? v : null;
}
