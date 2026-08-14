// WP-R2-2 capsule VISIBILITY FSM (07 §4 — the second orthogonal capsule state
// space; F-2374/2375/2359). Pure + time-injected. Cross-utterance persistent
// intent, distinct from the per-utterance FORM state (capsule-morph.ts).
//
//  persistent    — a paired phone is present in the room: the capsule stays
//                  surfaced (REDESIGN §5.2 L237 trigger moment for appearing (出现时机) = the phone is online and in a session (手机在线且处于会话中)).
//                  A phone joining surfaces it; ALL phones leaving retreats it.
//  talk_triggered — after a manual × (Dismiss) it hides to the tray and only
//                  surfaces for the moment of an utterance (audio:start = surfacing immediately (audio:start即浮现),
//                  not waiting for the first interim — F-2375); once the utterance
//                  settles (injected|cached|inject_failed; manual_pending doesn't count (manual_pending 不算) —
//                  INV-4) it retreats to the tray. Tray double-click → persistent.
//
// R6-C1 fix: the surface signal is PHONE PRESENCE (mobiles>0), NOT the desktop's
// own socket-to-sidecar `connected` (which is true from boot, before any phone is
// paired — the owner-screenshot (截图) bug where the capsule floated with no phone in the room).
//
// Session key (roomUuid) change → reset to persistent; same-session reconnect
// keeps the current mode; a Dismiss suppresses auto-surface for 3 s (F-2359).

export type VisMode = 'persistent' | 'talk_triggered';

export const DISMISS_SUPPRESS_MS = 3000;

export class CapsuleVisibility {
  mode: VisMode = 'persistent';
  visible = false;
  private suppressUntil = 0;
  private room: string | null = null;
  private phonePresent = false;
  /** Between audio:start and the utterance settling. owner 2026-07-27: the
   *  capsule is not dismissible while it is transcribing — it is the ONLY place
   *  the words being typed into another app are visible, so letting a stray ×
   *  take it away mid-utterance loses the one view of what is happening. */
  private speaking = false;
  /** 卡 F1 — the phone is BACKGROUNDED (audio:pause) but still paired and still
   *  in the room. owner ruling ①: "the computer should consider the phone
   *  'paused' (still paired, just with the capsule collapsed)".
   *
   *  🔴 Why this is its OWN flag and not `phonePresent = false`: the phone-left
   *  path is the one that makes the device page say "no phone currently connected" and arms the
   *  reconnect logic. A user who switched windows has not left, so nothing
   *  presence-shaped may move. This flag ONLY suppresses auto-surfacing — the same
   *  shape as `suppressUntil`, and like it, an explicit user gesture (tray summon)
   *  still wins.
   *
   *  Every write is self-healing: a phone that really leaves, a phone that
   *  (re)joins, and an utterance starting all clear it, so a resume that never
   *  arrives can never strand the capsule off-screen. */
  private paused = false;

  /** A CONNECTION bridge event. `phonePresent` is `mobiles > 0` (R6-C1 — real
   *  phone presence, NOT the desktop's own socket state). A roomUuid change is a
   *  NEW session → reset to persistent (07 §4). A same-session reconnect keeps the
   *  current mode. In persistent mode the capsule tracks presence directly: a
   *  phone present surfaces it, an empty room retreats it back to the tray. */
  onConnection(phonePresent: boolean, roomUuid: string | null): void {
    if (roomUuid !== this.room) {
      this.room = roomUuid;
      this.mode = 'persistent';
      this.suppressUntil = 0;
    }
    const arrived = phonePresent && !this.phonePresent;
    this.phonePresent = phonePresent;
    if (!phonePresent) {
      // lead review (主控人审) (R6-C1): NO phone in the room means there is nothing to show in
      // ANY mode — including a talk_triggered capsule surfaced by audio:start
      // whose utterance will never settle because the phone vanished mid-stream
      // (no inject:result ⇒ onSettled never fires ⇒ it would hang visible).
      this.visible = false;
      this.speaking = false; // nothing is transcribing; the × is live again
      this.paused = false; // 卡 F1: a phone that LEFT is no longer a paused one
      return;
    }
    if (arrived) {
      // owner 2026-07-27: "the phone side connects…the PC-side capsule window
      // must be forced to show". A phone
      // JOINING is the user picking this PC up again, so it outranks an earlier
      // Dismiss: persistent is restored and the suppression window is dropped.
      // Only the RISING edge does this — otherwise every routine presence tick
      // would resurrect a capsule the user just dismissed, and × would be dead.
      this.mode = 'persistent';
      this.suppressUntil = 0;
      this.paused = false; // 卡 F1: a fresh join is a fresh attendance
      this.visible = true;
    } else if (this.mode === 'persistent' && !this.paused) {
      // 卡 F1: `!this.paused` is load-bearing. CONNECTION frames keep arriving
      // while the phone is backgrounded (the 10s presence poll), and without this
      // gate each one would re-pop the capsule seconds after it collapsed.
      this.visible = true;
    }
  }

  /** audio:start fan-out (F-2375): surface immediately, not waiting for the first
   *  interim — UNLESS we are inside the post-Dismiss 3 s suppression (F-2359). In
   *  persistent mode we are already surfaced; this mainly re-surfaces a
   *  talk_triggered capsule for the utterance. */
  onAudioStart(now: number): void {
    this.speaking = true;
    // 卡 F1: an utterance is proof the phone is in the foreground, whatever we
    // last believed. Clearing here rather than suppressing means a lost
    // audio:resume degrades to「the capsule comes back on the next utterance」
    // instead of「the capsule never comes back」.
    this.paused = false;
    // owner 2026-07-27: "after pressing the speak button…must be forced to show". The 3 s post-Dismiss
    // suppression (F-2359) exists to stop a TRAILING event from re-popping a
    // capsule the user just closed; a fresh press is not a trailing event, it is
    // the user speaking — and speaking with no capsule is the one state where
    // the PC shows nothing at all about what is being typed into it.
    // `now` is kept on the signature (every caller passes it) but no longer
    // gates anything — the window it used to consult is closed outright.
    this.suppressUntil = Math.min(this.suppressUntil, now);
    this.visible = true;
  }

  /** The utterance settled (injected | cached | inject_failed — INV-4; a
   *  manual_pending is NOT settled). In talk_triggered mode the capsule retreats
   *  to the tray; in persistent mode it stays surfaced. */
  onSettled(): void {
    this.speaking = false; // idle again → the × is live
    if (this.mode === 'talk_triggered') {
      this.visible = false;
    }
  }

  /** Manual × (Dismiss): hide to the tray, switch to talk_triggered, and suppress
   *  auto-surface for 3 s so a trailing event does not immediately re-pop it.
   *
   *  owner 2026-07-27: "in the speaking/transcribing state it also cannot be
   *  closed; only in the idle state can it be manually closed" — refused
   *  mid-utterance. Returns whether it took effect so the caller
   *  can say so instead of swallowing the click (no silent failure). */
  onDismiss(now: number): boolean {
    if (this.speaking) return false;
    this.mode = 'talk_triggered';
    this.visible = false;
    this.suppressUntil = now + DISMISS_SUPPRESS_MS;
    return true;
  }

  /** An utterance is in flight — the × is inert and the UI should show it as
   *  such rather than accept a click and do nothing. */
  isSpeaking(): boolean {
    return this.speaking;
  }

  /** 卡 F1 — `audio:pause` from the phone (the app went to background / the
   *  screen locked). owner ruling ①: the PC treats this as "paused", so the capsule
   *  RETREATS and nothing else moves.
   *
   *  🔴 Deliberately NOT `onConnection(false, …)`: that is "the phone left" — it clears
   *  presence, and downstream that is what makes the device page say
   *  "no phone currently connected" and arms the reconnect logic. Nothing here touches
   *  `phonePresent`, `room`, `mode` or `speaking`: a paused utterance is still an
   *  utterance (the × stays inert) and a paused phone still owns the capsule. */
  onPhonePaused(): void {
    this.paused = true;
    this.visible = false;
  }

  /** 卡 F1 — `audio:resume`: the phone is back in the foreground. Restores what
   *  the FSM's OWN rules say should be on screen rather than forcing `visible`:
   *  a capsule the user dismissed (talk_triggered, idle) must stay dismissed, and
   *  a room with no phone must stay empty. */
  onPhoneResumed(): void {
    this.paused = false;
    this.visible = this.phonePresent && (this.mode === 'persistent' || this.speaking);
  }

  /** Tray double-click / "show capsule" (显示胶囊) (summon): a user gesture to bring back a
   *  DISMISSED capsule mid-session. It restores persistent mode (so the ambient
   *  behaviour resumes) and clears the suppression, but it STILL honours the red
   *  line — the HUD only exists when a phone is on the active instance. owner
   *  2026-07-26: the tray summon must not pop a capsule for a PC with no phone
   *  (nothing to show). So it surfaces IFF a phone is present now; with none, it
   *  stays in the tray and the restored persistent mode surfaces it the moment a
   *  phone connects. */
  onTraySummon(): void {
    this.mode = 'persistent';
    this.suppressUntil = 0;
    this.visible = this.phonePresent;
  }

  isPhonePresent(): boolean {
    return this.phonePresent;
  }
}
