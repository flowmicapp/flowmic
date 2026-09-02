// P3 #18 (2026-09-02) — the shape DevicesPage.vue's `loadPaired` needed and
// did not have.
//
// THE DEFECT THIS FIXES. `loadPaired`'s guard was `if (pairedLoading.value)
// return;` — a call that arrives while one is already running is DROPPED, not
// queued, and the caller has no way to tell: the function still returns a
// resolved promise. `performRelease` (lib/release-mobile.ts) does
// `await deps.reload()` right after the server confirms a release/revoke; if
// an unrelated poll (DevicesPage.vue's `watch(..., { immediate: true })`, or a
// presence pull) happened to already be mid-flight at that exact moment, the
// post-release reload silently no-ops and the just-released phone keeps
// showing in `pairedView` — the caller believes it awaited a fresh read, and
// did not.
//
// THE FIX — single-flight WITH a coalesced trailing run, sharing ONE promise:
//   · No run in flight → start one now, return it.
//   · A run IS in flight → do not start a second, overlapping one (that would
//     just be wasted duplicate work); instead return a promise for the run
//     that starts once the in-flight one finishes, so it is guaranteed to see
//     whatever changed while this caller was waiting (the release, here).
//   · Every caller who arrives DURING the same in-flight run shares that ONE
//     trailing promise — three release buttons pressed in a row do not queue
//     three more fetches, they all await the single one that runs next.
export function singleFlight(fn: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let next: Promise<void> | null = null;

  return function run(): Promise<void> {
    if (current === null) {
      current = fn().finally(() => {
        current = null;
      });
      return current;
    }
    if (next === null) {
      const started = current;
      next = started
        .catch(() => undefined) // a failed in-flight run must not skip the trailing one
        .then(() => fn())
        .finally(() => {
          next = null;
        });
    }
    return next;
  };
}
