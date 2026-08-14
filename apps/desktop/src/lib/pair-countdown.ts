// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pairing short code, 5-min TTL)
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-18
//
// Pure, Tauri-free, DOM-free countdown logic for the「添加手机」("Add phone") modal,
// extracted so the two rules that are easy to get wrong are unit-testable:
//
//   ① A DURATION IS NOT A DEADLINE. The server answers「this code has 214 s
//      left」 — true at the instant it was read and stale one tick later. It is
//      converted to an absolute local deadline ONCE, at read time; the ticking UI
//      then subtracts the clock from that. Keeping the duration and re-rendering
//      it would freeze the countdown at its initial value (and a code that never
//      appears to expire is worse than no countdown at all: the phone gets
//      PAIR_INVALID_CODE while the screen still shows 「有效」("valid")).
//   ② NO TTL FROM THE UI. When the server sends no expiry (pre-GA-18 sidecar)
//      there is NO countdown — the modal falls back to its static TTL sentence.
//      Inventing 5 minutes here would duplicate the governor's constant in a
//      second place, which is exactly how the two drift apart.

/** Convert the server's remaining-ms (read at `readAt`) into an absolute local
 *  deadline. `null` when the server offered no expiry — see rule ②. A
 *  non-positive value still yields a deadline (an already-expired code is a real
 *  state the modal must show, not a missing one). */
export function deadlineFrom(expiresInMs: number | null | undefined, readAt: number): number | null {
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs)) return null;
  return readAt + expiresInMs;
}

/** Milliseconds left at `now`, floored at 0. `null` when there is no deadline. */
export function remainingMs(deadline: number | null, now: number): number | null {
  if (deadline === null) return null;
  return Math.max(0, deadline - now);
}

/** `M:SS`, hand-built so this fixed zh-CN surface never picks up an OS locale
 *  format (UI 不跟随 OS locale 红线 — "UI does not follow the OS locale", a red
 *  line). Rounds UP so the last displayed second is a full second of validity,
 *  and 0 shows as 0:00 rather than vanishing. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface CountdownView {
  /** The `M:SS` label, or null when there is nothing truthful to count down. */
  label: string | null;
  /** True once the code is past its deadline (drives the auto-refresh). */
  expired: boolean;
}

/** What the modal renders. No deadline → no label AND not「expired」: an unknown
 *  expiry is not an expiry, and reporting it as one would fire a refresh loop
 *  against a server that simply never sends the field. */
export function deriveCountdown(deadline: number | null, now: number): CountdownView {
  const left = remainingMs(deadline, now);
  if (left === null) return { label: null, expired: false };
  return { label: formatCountdown(left), expired: left <= 0 };
}

export interface AutoRefreshInput {
  /** Only a VISIBLE modal polls — a closed one refreshes nothing (GA-18 验收,
   *  "GA-18 acceptance criteria"). */
  open: boolean;
  deadline: number | null;
  now: number;
  /** The existing in-flight guard; never two refreshes at once. */
  refreshing: boolean;
  /** A loud, already-reported failure. Without this the tick would retry every
   *  second forever against a down socket, hammering it and burying the notice. */
  failed: boolean;
}

/** Whether this tick should mint a fresh code. */
export function shouldAutoRefresh(input: AutoRefreshInput): boolean {
  if (!input.open || input.refreshing || input.failed) return false;
  return deriveCountdown(input.deadline, input.now).expired;
}

export interface MintAbsentInput {
  open: boolean;
  /** `derivePairingModal(...).reason` for the SELECTED channel. Only `'no-code'`
   *  may mint: `'pending'` is still the other channel's answer, `'disconnected'`
   *  has no server to mint on, and `'ok'`/`'loopback'` both HAVE a code. */
  reason: string;
  /** The same gate as the 「刷新配对码」("refresh pairing code") button (tab not
   *  blocked, snapshot
   *  settled, channel connected) — auto-minting must never do what the button
   *  would refuse to offer. */
  canRefresh: boolean;
  refreshing: boolean;
  /** The loud, already-reported failure — same poison pill as the expiry path. */
  failed: boolean;
  /** One shot per absence: the component latches this after firing, so a server
   *  that mints-but-returns-no-code cannot be hammered once a second forever.
   *  Re-armed when the reason leaves `'no-code'` (a code arrived or the user
   *  switched channels). */
  alreadyTried: boolean;
}

/** REQ-13-21 (owner 2026-08-13) — mint when a channel switch (or modal open)
 *  lands on a snapshot that simply HAS no code. GA-18's auto-refresh keys off an
 *  expiry deadline, and an absent code has none, so the modal used to sit on
 *  「尚无有效配对码」("no valid pairing code yet") waiting for a manual click — the
 *  owner hit exactly that. */
export function shouldMintAbsent(input: MintAbsentInput): boolean {
  if (!input.open || input.refreshing || input.failed || input.alreadyTried) return false;
  if (!input.canRefresh) return false;
  return input.reason === 'no-code';
}
