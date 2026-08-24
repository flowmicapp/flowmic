// Should this machine tell the user it is missing the macOS Accessibility
// permission — and is it entitled to say so at all?
//
// ── WHY THE DECISION IS A MODULE AND NOT AN `v-if` ──────────────────────────
//
// Three inputs, and two of them are not booleans about the same thing:
//   · `supported` — does this OS have the permission (macOS only);
//   · `trusted`   — `AXIsProcessTrusted()` right now;
//   · null        — WE COULD NOT ASK (no bridge, command missing, bad shape).
//
// The third is the one an `v-if` gets wrong. Folding "could not ask" into
// "not granted" would put a macOS permission banner on a Windows build the
// first time the command name drifts, and folding it into "granted" would hide
// a real problem. It is its own answer here, and it renders nothing — 「不知道」
// and 「一切正常」 must never share a verdict (the `scanner-blind` rule the APK
// and OPS-4 byte gates are built on, applied to a screen instead of a scan).
//
// ── THE NOTICE IS STATE-STYLE, WHICH IS A CONSTRAINT ON THIS FILE ───────────
//
// owner 2026-08-01: 「提示生命周期匹配事实生命周期」 — an event-style notice
// hides itself after a few seconds; a state-style one stays until the STATE
// changes and then leaves BY DERIVATION, with no dismiss button and no stored
// "user acknowledged" flag. So there is no `dismissed` input below, and adding
// one would be the defect: a banner you can dismiss while the fact is still
// true is a banner that lies the moment you dismiss it.
//
// ⚠️ It follows that the caller must KEEP ASKING. The user grants the
// permission in System Settings while this app is running — that is the whole
// flow — so a value read once at start-up would leave the banner on screen
// after it had been fixed. The poll lives in the component; what lives here is
// the rule that the answer is derived from the latest reading and nothing else.

/** What `accessibility_status` returns. THREE facts, deliberately not one
 *  tri-state — see the Rust side, which explains the same split from its end. */
export interface AccessibilityStatus {
  supported: boolean;
  trusted: boolean;
  /** This copy runs from macOS's App Translocation mount, so the permission
   *  cannot be granted to it at all — see `isBlockedByLocation`. */
  translocated: boolean;
}

/** Field-by-field narrowing rather than a cast.
 *
 *  🔴 CLAUDE.md 反 façade ⑤: a hand-written type predicate is an assertion the
 *  compiler does not check, and this repo has already shipped one that was
 *  wrong in a way nothing could see (`asPairingInfo`'s `lan_candidates`, which
 *  made a real feature render empty on every machine for weeks). So this
 *  returns `null` on any shape it does not recognise, and `null` is a rendered
 *  outcome above, not a silent `false`. */
export function asAccessibilityStatus(v: unknown): AccessibilityStatus | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.supported !== 'boolean' || typeof o.trusted !== 'boolean') return null;
  // ⚠️ NOT narrowed as strictly as its two siblings, and the asymmetry is the
  // point. Rejecting the whole object over this field would turn a REAL missing
  // permission into a blank screen — the notice would vanish rather than degrade.
  // So an absent or malformed value reads as `false`, which means the reader is
  // told to grant the permission: what we told them before this field existed.
  // The failure directions are not equivalent, so the narrowing is not either.
  return { supported: o.supported, trusted: o.trusted, translocated: o.translocated === true };
}

/** The one question the banner asks.
 *
 *  `null` (we could not ask) → false. Stated once, here, so no component can
 *  answer it differently. */
export function needsAccessibilityGrant(s: AccessibilityStatus | null): boolean {
  return s !== null && s.supported && !s.trusted;
}

/** Is the permission UNREACHABLE for this copy, rather than merely ungranted?
 *
 *  🔴 The two states look identical to `AXIsProcessTrusted()` and need opposite
 *  sentences. Ungranted: go and switch it on. Unreachable: switching it on will
 *  not work, however many times you do it — macOS is running this app from a
 *  throwaway location because it was opened straight out of the download folder,
 *  and that location changes on every launch.
 *
 *  [measured, owner's Mac mini, 2026-08-24] this is not a hypothetical: the
 *  owner granted the permission, saw it enabled, restarted the app, and was
 *  refused — repeatedly — while our banner kept telling them to grant it. A
 *  message whose recommended action cannot succeed is the R11 shape one level
 *  up from the status words: not a wrong state, a wrong instruction. */
export function isBlockedByLocation(s: AccessibilityStatus | null): boolean {
  return needsAccessibilityGrant(s) && s !== null && s.translocated;
}
