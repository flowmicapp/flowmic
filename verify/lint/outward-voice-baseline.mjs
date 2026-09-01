// verify/lint/outward-voice-baseline.mjs
// Baseline DATA for verify/lint/outward-voice.mjs. Nothing else imports it and
// run-all.mjs never runs it — same shape as the other baselines here.
//
// 🔴 THIS IS NOT A PLACE TO PUT COPY YOU DO NOT FEEL LIKE FIXING. Every entry
// names an occurrence that was already on a shipped surface when the gate
// landed, and a ruling or a card that owns the fix. An entry with no owner is
// not an entry: it is the gate being switched off one line at a time.
//
// Pins are EXACT. More occurrences fail as new; fewer fail as a pin that has to
// be lowered or deleted. A pin that matches nothing fails as stale, so the
// register cannot outlive the debt — the same ratchet no-cjk and no-lan-ip use.
//
// ── WHY A PIN AND NOT A RED GATE ────────────────────────────────────────────
// The alternative was to ship this gate red on the day it landed. This
// repository's own record says what happens next: a gate that is red on day one
// is ignored by day three. The alternative to THAT was to drop `probe` from the
// term list, which would have removed the gate from exactly the leak the owner
// ruled on. A dated, owned, exact pin is the only shape that leaves the rule
// enforced and the tree green.
//
// WP3 card 4 (ruling D6) replaced the six English "probe" values in the desktop
// catalogue. The pin that held those six is gone: a pin that matches nothing is
// stale, and this file's own scanner tells you to delete it. KNOWN_HITS empty
// is the success state — if "probe" returns on the app surface, the gate goes
// red because nothing is pinned.

export const KNOWN_HITS = [];
