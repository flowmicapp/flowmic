// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7-a (settings `updated_at` arbitration)
//   packages/protocol/src/protocol-schemas-sync.ts:145 — the field answers WHEN A
//     HUMAN CHANGED THIS VALUE, so it is authored by the WRITER, never minted on
//     arrival.
//   apps/server-core/src/socket/handlers/settings.handler.ts — the regress
//     guard `existingMs > incomingMs` (a stored stamp strictly newer than the
//     incoming one refuses the write and hands the STORED value back on the
//     pushing socket) and `SETTINGS_STAMP_MAX_SKEW_MS` (an incoming stamp more
//     than five minutes ahead of server time is replaced by server time).
//     🔴 Cited by SYMBOL, not by line: a `:NNN` rots silently, a name that moves
//     greps to zero and fails loud.
//   apps/desktop/src/lib/settings-stamp.ts — the same mechanism, same reasoning,
//     one language over. The two are deliberately twins: they feed ONE
//     comparison, and a correction applied on one side only would move the
//     failure rather than remove it.
//
// ── WHY THIS EXISTS (card C3) ────────────────────────────────────────────────
//
// The arbitration compares two stamps authored on two different machines, so it
// compares two CLOCKS. A phone whose clock lags by Δ stamps a genuinely newer
// edit with a moment already in the other side's past: the server refuses the
// write, pushes the stored value back, [ScenarioCardController] adopts it, and
// THE USER'S CUSTOM TERMS REVERT WITH NO EXPLANATION. It is bounded by Δ and it
// heals once the wall clock catches up, which makes it harder to diagnose rather
// than less harmful.
//
// ⚠️ A phone is the likelier victim, not the unlikelier one. It sleeps, it flies,
// it changes timezone, it comes back from a dead battery before it has talked to
// a time server — and it is also the device this card's own arbitration was built
// around.
//
// ── THE MECHANISM ────────────────────────────────────────────────────────────
//
// Every stamp arriving from the server is evidence about the timebase our writes
// are judged against. One that is AHEAD of our own clock says our clock is behind
// by at least that much, so we carry the difference forward and add it to every
// stamp we author. It needs no new wire field and no server change: the frames
// that carry the evidence already exist (`settings:list` on the room-join edge,
// and the loser frame the server pushes back on a refused write, which arrives as
// `settings:updated`). Both land in [SettingsClient._publish], which is the one
// funnel they share — so there is one place that learns, not two.
//
// ── FOUR THINGS THIS DELIBERATELY DOES NOT DO ────────────────────────────────
//
//  1. It never moves a stamp BACKWARDS: the correction is floored at zero. A
//     device whose clock leads already wins the arbitrations it should, and
//     dragging it back would invent a second way to lose while fixing the first.
//  2. It is not persisted. The correction is a high-water mark and nothing in
//     band can ever say "your clock was just fixed", so it is scoped to one
//     process lifetime and re-learned from zero on the next launch. A phone whose
//     clock is corrected by the network therefore carries a stale correction only
//     until it is next restarted, and the worst it can do meanwhile is point 4.
//  3. It does not average or estimate a round trip. The quantity needed is not
//     "what time is it really" but "what is the smallest stamp that is newer than
//     everything the other side has already recorded" — a maximum is exactly
//     right there and an average is exactly wrong.
//  4. It cannot push a stamp past the server's +5 minute clamp, and that is a
//     property rather than a hope. Every observable stamp was itself inside the
//     clamp when it was stored (S ≤ W₀ + 5min for the server wall clock W₀). If
//     we observe S at local time L₀ we carry ahead = S − L₀, so a stamp minted d
//     later is L₀ + d + ahead = S + d, while the bound has moved to
//     W₁ + 5min = W₀ + d + 5min ≥ S + d. The server's check is inclusive.
//     ⚠️ The one case outside that proof is a local clock that jumps FORWARD
//     after a correction was learned. The stamp can then land beyond the clamp
//     and the server re-stamps it with its own wall clock — the write still
//     happens, at a moment newer than the row it replaced, so the edit still
//     takes effect. Being clamped is not a rejection.
//
// ── THE TRADE-OFF AND THE RESIDUAL, STATED RATHER THAN HIDDEN ────────────────
//
// We cannot tell whose clock authored an observed stamp, so a peer running four
// minutes fast teaches us a four-minute correction. With two clocks and no shared
// timebase there is no answer that avoids that; what bounds it is point 4.
// And the correction is LEARNED, so an edit made before this device has observed
// any server stamp can still lose. In production the observation comes first (the
// snapshot is pulled on the room-join edge and an edit needs a human), and a loss
// teaches the clock through the loser frame — so the window is one round trip
// rather than Δ. It is not zero, and it is not claimed to be.

/// Corrects the stamps this device authors for its own clock skew.
class SettingsStampClock {
  /// [now] is injected so a test can drive a skewed clock without touching the
  /// device's; production passes nothing.
  SettingsStampClock({DateTime Function()? now}) : _now = now ?? DateTime.now;

  final DateTime Function() _now;

  /// How far ahead of this device's clock the other side has been observed to
  /// be. Never negative — see point 1 above.
  Duration _ahead = Duration.zero;

  /// The correction currently in force. Exposed for tests and diagnostics: a
  /// correction that is silently large is exactly the kind of fact this repo
  /// wants readable rather than inferred.
  Duration get correction => _ahead;

  /// Feed one stamp observed from the server.
  ///
  /// ⚠️ Parsed, never string-compared, and unparseable is treated as ABSENT.
  /// `Iso8601` on the wire is `z.string().min(1)` — a name, not a validator — so
  /// junk really does arrive; read as epoch it would teach a correction of minus
  /// fifty-six years, and ranked lexically an unbounded one. No evidence is the
  /// honest reading of a stamp we cannot place in time.
  void observe(String? raw) {
    if (raw == null || raw.isEmpty) return;
    final DateTime? t = DateTime.tryParse(raw);
    if (t == null) return;
    final Duration ahead = t.difference(_now());
    if (ahead > _ahead) _ahead = ahead;
  }

  /// Mint the stamp for an edit happening NOW, corrected by everything observed
  /// so far. ISO-8601 UTC, the same shape the desktop mints, because the server
  /// parses both into one comparison and two devices in two zones have to be
  /// comparable.
  String nowIso() => _now().toUtc().add(_ahead).toIso8601String();
}
