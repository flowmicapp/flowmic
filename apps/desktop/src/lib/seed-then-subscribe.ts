// E7 (2026-09-02) — the race a "register-then-pull" seed still has.
//
// Four sites (App.vue's cloud/sidecar seed, DevicesPage's onMounted seed,
// store.ts's initBridge, ConnDiagPage's loadOnce) already follow RV-24's rule:
// register the push LISTENER before firing the seed PULL, so a push landing
// between "mount" and "listener attached" is not lost — both writers are
// idempotent, so overlap costs nothing. That rule protects the WINDOW before
// the listener exists. It says nothing about the window AFTER the listener
// exists but WHILE the seed's own pull is still in flight:
//
//   1. register the push listener
//   2. call fetchSeed() — an async round trip
//   3. a PUSH arrives; the listener applies it (newer, correct)
//   4. fetchSeed() FINALLY resolves with a value read BEFORE step 3
//   5. the seed's `apply(older)` overwrites the push from step 3
//
// Nothing here calls the pull "stale" by comparing timestamps carried on the
// payload — none of the four sites' payloads carry one. Instead this counts
// how many pushes have already landed by the time the pull STARTED, and skips
// applying the pull's answer if that count has moved by the time it resolves:
// a push is a strictly newer fact than a pull that was already racing it.
//
// This is a coordination primitive, not a fetch wrapper — `subscribe` and
// `fetchSeed` are both injectable, so it is testable with a hand-driven push
// and a hand-controlled promise, no Tauri and no real timers required.

/** Subscribes first (so nothing pushed before the listener exists is lost),
 *  then seeds via `fetchSeed()` — discarding the seed's answer if a push has
 *  already landed while the fetch was in flight. Returns the subscription's
 *  own unlisten function, unchanged, so call sites keep their existing
 *  teardown wiring.
 *
 *  `apply` is the ONE writer for both the push and (conditionally) the seed —
 *  same reason `settings-model.ts`'s "one value, one question" note gives for
 *  every reactive field in this repo: two writers of one field is how the
 *  race being fixed here gets reintroduced by the next call site. */
export async function seedThenSubscribe<T>(
  subscribe: (apply: (value: T) => void) => Promise<() => void>,
  fetchSeed: () => Promise<T>,
  apply: (value: T) => void,
): Promise<() => void> {
  let pushCount = 0;
  const unlisten = await subscribe((value) => {
    pushCount += 1;
    apply(value);
  });
  const seed = await fetchSeed();
  // If ANY push landed by the time `fetchSeed()` resolves — whether during
  // `subscribe`'s own setup or during the fetch itself — it is newer than
  // whatever the seed read, so the seed must not overwrite it. Comparing
  // against the count taken right after `await subscribe(...)` (rather than
  // against `0`, captured before it) would miss a push that happens to land
  // in the same microtask turn `subscribe`'s own promise settles in — a real
  // possibility this repo has hit before (0.2.35's QR/channel race) and not
  // a fixture artefact: nothing here can prove `subscribe`'s underlying
  // transport always defers its FIRST possible callback to a later tick than
  // its own registration promise.
  if (pushCount === 0) apply(seed);
  return unlisten;
}
