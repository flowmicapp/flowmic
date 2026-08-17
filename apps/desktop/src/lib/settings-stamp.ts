// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7-a (settings `updated_at` arbitration)
//   packages/protocol/src/protocol-schemas-sync.ts:145 — the field answers WHEN A
//     HUMAN CHANGED THIS VALUE, so it is authored by the WRITER and never minted
//     on arrival; a server-minted stamp would make every copy look equally fresh
//     the moment it landed, which is the same as having no stamp at all.
//   apps/server-core/src/socket/handlers/settings.handler.ts — the regress
//     guard `existingMs > incomingMs` (a stored stamp strictly newer than the
//     incoming one refuses the write and sends the STORED value back on the
//     pushing socket) and `SETTINGS_STAMP_MAX_SKEW_MS` (an incoming stamp more
//     than five minutes ahead of server time is replaced by server time).
//     🔴 Cited by SYMBOL, not by line: a `:NNN` into that file rots silently
//     (the reader lands on the wrong line and gets no signal), while a name
//     that moves greps to zero and fails loud. verify/lint coordinate-anchors
//     exists to push citations onto this form.
//
// ── WHY THIS EXISTS (card C3) ────────────────────────────────────────────────
//
// The arbitration compares two stamps authored on two different machines, which
// means it compares two CLOCKS. A client whose clock lags by Δ stamps a
// genuinely newer edit with a moment that is already in the other side's past:
// the server refuses the write, hands back the stored value, the client adopts
// it, and THE USER'S EDIT REVERTS WITH NO EXPLANATION. It is bounded by Δ and it
// heals once the wall clock catches up, which makes it harder to diagnose rather
// than less harmful — and it lands squarely on the one thing this subsystem
// promises, that a setting the user changed takes effect.
//
// ── THE CORRECTION ───────────────────────────────────────────────────────────
//
// Every stamp we observe coming back from the server is evidence about the
// timebase our writes are judged against. An observed stamp that is AHEAD of our
// own clock says our clock is behind by at least that much, so we carry the
// difference forward and add it to every stamp we author. That is the whole
// mechanism; it needs no new wire field, no new event and no server change,
// because the frames that carry the evidence already exist:
//   · the settings:list snapshot pulled on the connected rising edge, and
//   · the loser frame the server pushes back on a refused write, which reaches
//     this window as a settings:updated notification → one more settings:list
//     pull (settings-model.ts watchServerSettingsUpdates).
//
// ── FOUR THINGS THIS DELIBERATELY DOES NOT DO ────────────────────────────────
//
//  1. It never moves a stamp BACKWARDS (the correction is floored at zero). A
//     client whose clock is ahead already wins every arbitration it should win;
//     pulling it back would invent a second way to lose in the course of fixing
//     the first.
//  2. It is not persisted, and that is the only in-band way this can heal. The
//     correction is a high-water mark, and nothing on this wire can ever tell us
//     "your clock was just fixed" — so it is scoped to one process lifetime and
//     re-learned from zero on the next launch. A machine whose clock gets
//     corrected by NTP therefore carries a stale correction only until it is
//     next restarted, and the worst that correction can do meanwhile is stated
//     in point 4.
//  3. It does not average, smooth, or estimate a round-trip. The quantity we
//     need is not "what time is it really" — it is "what is the smallest stamp
//     that is newer than everything the other side has already recorded", and
//     for that a maximum is exactly right and an average is exactly wrong.
//  4. It cannot push a stamp past the server's +5 minute clamp, and this is a
//     property rather than a hope. Every stamp we can observe was itself inside
//     the clamp at the moment it was stored, i.e. S ≤ W₀ + 5min for the server
//     wall clock W₀ at that write. If we observe S at local time L₀ we carry
//     ahead = S − L₀, and a stamp minted d later is L₀ + d + ahead = S + d,
//     while the clamp bound has moved to W₁ + 5min = W₀ + d + 5min ≥ S + d.
//     So the minted stamp is at or below the bound, and the server's check is
//     inclusive (`incomingMs <= wall + SETTINGS_STAMP_MAX_SKEW_MS`).
//     ⚠️ The one case that escapes that proof is a local clock that jumps
//     FORWARD after a correction was learned (NTP repairing a slow clock
//     mid-session). Then our stamp can land beyond the clamp, and the server
//     re-stamps it with its own wall clock — the write still happens, and it is
//     recorded at a moment that is newer than the row it replaced, so the edit
//     still takes effect and still wins. Being clamped is not a rejection.
//
// ── THE TRADE-OFF, STATED RATHER THAN HIDDEN ─────────────────────────────────
//
// We cannot tell whose clock authored an observed stamp. A peer whose clock runs
// four minutes fast will teach us a four-minute correction, and our stamps are
// then four minutes ahead of true time. With two clocks and no shared timebase
// there is no answer that avoids this; what bounds it is the server's clamp,
// which is why point 4 is worth proving rather than assuming.
//
// ── THE RESIDUAL ─────────────────────────────────────────────────────────────
//
// The correction is LEARNED, so an edit made before this client has observed any
// server stamp can still lose. In production the observation comes first (the
// snapshot is pulled on the admission edge and an edit needs a human), and a
// loss teaches the clock through the loser frame, so the window is one round
// trip rather than Δ. It is not zero, and it is not claimed to be.

/** Parse a wire stamp to epoch millis, or null when it cannot be used as an
 *  instant.
 *
 *  ⚠️ `Iso8601` in @flowmic/protocol is `z.string().min(1)` — a NAME, not a
 *  validator (measured 2026-08-16) — so an unparseable string really does cross
 *  the boundary. Unparseable is treated as ABSENT, i.e. as no evidence at all,
 *  never as epoch zero: a garbage stamp read as 1970 would teach a correction of
 *  minus fifty-six years, and one read lexically would teach an unbounded one. */
export function stampMs(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export class SettingsStampClock {
  /** How far ahead of this machine's clock the other side has been observed to
   *  be, in milliseconds. Never negative — see point 1 in the header. */
  private aheadMs = 0;

  /** `now` is injected so a test can drive a skewed clock without touching the
   *  machine's; production passes nothing. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Feed one stamp observed from the server (a settings:list item, or the value
   *  the loser frame handed back). Absent / unparseable stamps are not evidence
   *  and are dropped rather than defaulted. */
  observe(raw: string | null | undefined): void {
    const t = stampMs(raw);
    if (t === null) return;
    const ahead = t - this.now();
    if (ahead > this.aheadMs) this.aheadMs = ahead;
  }

  /** The correction currently being applied, in ms. Exposed for tests and for a
   *  future diagnostic line — a correction that is silently large is exactly the
   *  kind of fact this repo wants readable rather than inferred. */
  get correctionMs(): number {
    return this.aheadMs;
  }

  /** Mint the stamp for an edit happening NOW, corrected by everything observed
   *  so far. ISO-8601 UTC, byte-compatible with the phone's
   *  `DateTime.now().toUtc().toIso8601String()`. */
  nowIso(): string {
    return new Date(this.now() + this.aheadMs).toISOString();
  }
}
