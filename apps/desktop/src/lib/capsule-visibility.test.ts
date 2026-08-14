import { describe, expect, it } from 'vitest';
import { CapsuleVisibility, DISMISS_SUPPRESS_MS } from './capsule-visibility';

describe('CapsuleVisibility — persistent / talk_triggered FSM (07 §4)', () => {
  it('a phone present in persistent surfaces the capsule', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1'); // phonePresent = mobiles > 0
    expect(v.mode).toBe('persistent');
    expect(v.visible).toBe(true);
    expect(v.isPhonePresent()).toBe(true);
  });

  it('R6-C1: NO phone present never surfaces (the owner-screenshot (截图) bug)', () => {
    const v = new CapsuleVisibility();
    // The desktop socket is up from boot but no phone is paired yet → mobiles = 0.
    v.onConnection(false, 'room-1');
    expect(v.mode).toBe('persistent');
    expect(v.visible).toBe(false);
  });

  it('R6-C1: all phones leaving retreats the capsule (persistent)', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    expect(v.visible).toBe(true);
    // Last phone leaves the room (same session, mobiles → 0).
    v.onConnection(false, 'room-1');
    expect(v.visible).toBe(false);
    // …and rejoining re-surfaces it.
    v.onConnection(true, 'room-1');
    expect(v.visible).toBe(true);
  });

  it('Dismiss → talk_triggered + hidden; audio:start re-surfaces; settled retreats', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    v.onDismiss(0);
    expect(v.mode).toBe('talk_triggered');
    expect(v.visible).toBe(false);

    // owner 2026-07-27 OVERRIDES the F-2359 half of this: "after pressing the
    // speak button…must be forced to show". The suppression window was meant to stop a TRAILING event
    // from re-popping a capsule the user just closed; a fresh press is not
    // trailing, it is the user speaking — and speaking with no capsule leaves
    // the PC showing nothing at all about what is being typed into it.
    v.onAudioStart(DISMISS_SUPPRESS_MS - 1);
    expect(v.visible).toBe(true);

    // Utterance settles → retreat to tray (talk_triggered).
    v.onSettled();
    expect(v.visible).toBe(false);
  });

  it('owner 2026-07-27: the ✕ is refused while an utterance is in flight', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    v.onAudioStart(0);
    expect(v.isSpeaking()).toBe(true);

    expect(v.onDismiss(1)).toBe(false); // "cannot be closed in the transcribing state"
    expect(v.visible).toBe(true);
    expect(v.mode).toBe('persistent'); // and it did NOT slip into talk_triggered

    v.onSettled(); // idle again
    expect(v.isSpeaking()).toBe(false);
    expect(v.onDismiss(2)).toBe(true); // "only in the idle state can it be manually closed"
    expect(v.visible).toBe(false);
  });

  it('owner 2026-07-27: a phone ARRIVING forces the capsule out, even after a Dismiss', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    v.onDismiss(0);
    expect(v.visible).toBe(false);

    // The phone leaves and comes back — the arrival is the user picking this PC
    // up again, so it outranks the earlier Dismiss.
    v.onConnection(false, 'room-1');
    v.onConnection(true, 'room-1');
    expect(v.visible).toBe(true);
    expect(v.mode).toBe('persistent');
  });

  it('a routine presence tick does NOT resurrect a dismissed capsule', () => {
    // The force-on-arrival rule is RISING-EDGE only. Without that, every
    // presence refresh would undo the ✕ and the button would be decorative.
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    v.onDismiss(0);
    v.onConnection(true, 'room-1'); // same phone, still there
    expect(v.visible).toBe(false);
  });

  it('a phone leaving clears the speaking latch — the ✕ cannot be left inert', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    v.onAudioStart(0);
    v.onConnection(false, 'room-1'); // vanished mid-utterance: no settle ever comes
    expect(v.isSpeaking()).toBe(false);
  });

  it('tray summon → back to persistent + visible (a phone is present to show)', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1'); // a phone is on the active instance
    v.onDismiss(0);
    v.onTraySummon();
    expect(v.mode).toBe('persistent');
    expect(v.visible).toBe(true);
  });

  it('a roomUuid change resets talk_triggered → persistent (new session)', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    v.onDismiss(0);
    expect(v.mode).toBe('talk_triggered');
    // New session (roomUuid changed) → reset to persistent, surfaced when connected.
    v.onConnection(true, 'room-2');
    expect(v.mode).toBe('persistent');
    expect(v.visible).toBe(true);
  });

  it('settled in persistent mode keeps the capsule surfaced', () => {
    const v = new CapsuleVisibility();
    v.onConnection(true, 'room-1');
    v.onSettled();
    expect(v.visible).toBe(true);
  });
});

// lead review (主控人审) (R6-C1): a talk_triggered capsule surfaced by audio:start must NOT
// hang visible when the phone vanishes mid-utterance (no inject:result ⇒ no
// onSettled) — losing the last phone retreats it in EVERY mode.
import { describe as d2, expect as e2, it as i2 } from 'vitest';
import { CapsuleVisibility as CV2 } from './capsule-visibility';

d2('capsule-visibility — phone-loss retreat in talk_triggered (lead-review hardening, 主控人审加固)', () => {
  i2('talk_triggered + audio:start surfaced, then all phones leave → retreats', () => {
    const v = new CV2();
    v.onConnection(true, 'room-1');
    v.onDismiss(1000); // → talk_triggered, hidden
    v.onAudioStart(5000); // utterance surfaces it (past the 3s suppress)
    e2(v.visible).toBe(true);
    v.onConnection(false, 'room-1'); // phone gone mid-utterance, no settle coming
    e2(v.visible).toBe(false);
    e2(v.mode).toBe('talk_triggered'); // mode unchanged — only visibility retreats
  });
});

// owner 2026-07-26: the tray summon (double-click / "show capsule" (显示胶囊)) must honour the
// red line — the HUD only exists while a phone is on the active instance. It used
// to surface unconditionally, popping a capsule for a PC with no phone.
d2('capsule-visibility — tray summon is gated on phone presence (owner 2026-07-26)', () => {
  i2('summon with NO phone present does not surface (restores persistent, stays hidden)', () => {
    const v = new CV2();
    v.onConnection(false, 'room-1'); // no phone on the active instance
    v.onDismiss(1000); // → talk_triggered, hidden
    v.onTraySummon();
    e2(v.visible).toBe(false); // nothing to show
    e2(v.mode).toBe('persistent'); // but the ambient behaviour is restored…
    // …so the moment a phone connects, persistent mode surfaces it.
    v.onConnection(true, 'room-1');
    e2(v.visible).toBe(true);
  });
});

// ── 卡 F1 —— the phone switches to background = paused, not left ────────────────────────────────────
// owner ruling ①: "the computer should consider the phone 'paused' (still paired, just with the capsule collapsed)".
//
// 🔴 The red line these tests exist to hold: the phone-LEFT path
// (`onConnection(false, …)`) clears `phonePresent`, and elsewhere on the desktop
// that same fact is what makes the device page say "no phone currently connected" and what arms the
// reconnect logic. A window switch must not touch ANY of it — so every assertion
// below pairs "capsule collapsed" with "presence/room/mode untouched". A test
// that only asserted `visible === false` would pass for the wrong implementation,
// which is precisely the one the ruling forbids.
d2('capsule-visibility — 卡 F1 phone pause is NOT phone loss', () => {
  i2('pause collapses the capsule and leaves presence / room / mode untouched', () => {
    const v = new CV2();
    v.onConnection(true, 'room-1');
    expect(v.visible).toBe(true);

    v.onPhonePaused();
    e2(v.visible).toBe(false); // capsule collapsed
    e2(v.isPhonePresent()).toBe(true); // 🔴 still paired & present — NOT "the phone left"
    e2(v.mode).toBe('persistent'); // no mode flip: this was not a Dismiss either
  });

  i2('resume brings the capsule back', () => {
    const v = new CV2();
    v.onConnection(true, 'room-1');
    v.onPhonePaused();
    v.onPhoneResumed();
    e2(v.visible).toBe(true);
    e2(v.isPhonePresent()).toBe(true);
    e2(v.mode).toBe('persistent');
  });

  i2('🔴 a presence tick while paused does NOT re-pop the capsule', () => {
    // The reason this one exists: CONNECTION frames keep arriving while the phone
    // is backgrounded (owner's 10s presence poll), and persistent mode surfaces on
    // every one of them. Without the gate the capsule flickers back up seconds
    // after collapsing — the exact symptom the card is about.
    const v = new CV2();
    v.onConnection(true, 'room-1');
    v.onPhonePaused();
    v.onConnection(true, 'room-1');
    v.onConnection(true, 'room-1');
    e2(v.visible).toBe(false);
    v.onPhoneResumed();
    e2(v.visible).toBe(true);
  });

  i2('a paused phone that then really LEAVES clears the pause (no stuck state)', () => {
    const v = new CV2();
    v.onConnection(true, 'room-1');
    v.onPhonePaused();
    v.onConnection(false, 'room-1'); // genuinely gone
    e2(v.visible).toBe(false);
    e2(v.isPhonePresent()).toBe(false);
    // …and a fresh phone joining surfaces normally instead of being held down by
    // a pause nobody will ever resume.
    v.onConnection(true, 'room-1');
    e2(v.visible).toBe(true);
  });

  i2('audio:start out-paces a stale pause (an utterance proves the phone is back)', () => {
    const v = new CV2();
    v.onConnection(true, 'room-1');
    v.onPhonePaused();
    v.onAudioStart(1000);
    e2(v.visible).toBe(true);
  });

  i2('a talk_triggered capsule stays hidden through pause/resume', () => {
    // Resume restores what the mode says, not「visible」 unconditionally: a
    // dismissed capsule must not be resurrected by the phone coming back.
    const v = new CV2();
    v.onConnection(true, 'room-1');
    v.onDismiss(1000); // → talk_triggered, hidden
    v.onPhonePaused();
    e2(v.visible).toBe(false);
    v.onPhoneResumed();
    e2(v.visible).toBe(false);
    e2(v.mode).toBe('talk_triggered');
  });

  i2('pause mid-utterance keeps the × inert (the utterance is paused, not over)', () => {
    const v = new CV2();
    v.onConnection(true, 'room-1');
    v.onAudioStart(1000);
    v.onPhonePaused();
    e2(v.isSpeaking()).toBe(true); // still transcribing, just not visible
    v.onPhoneResumed();
    e2(v.visible).toBe(true);
  });
});
