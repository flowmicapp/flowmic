// WP-R2-2 keyed debouncer for change-and-save-immediately (即改即存) 200ms settings persistence (07 §8). Per-key
// so rapid edits to DIFFERENT settings don't cancel each other; the same key's
// pending push is coalesced to the last value. Timer fns are injectable so tests
// can drive it deterministically (vitest fake timers also work with the default).

export class KeyedDebouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly delayMs: number,
    // 🔴 These two defaults MUST stay arrow-wrapped. Do NOT "simplify" them back
    //    to bare `= setTimeout` / `= clearTimeout`.
    //    WHY: the default is stored as an INSTANCE FIELD and later invoked as
    //    `this.schedule(...)`, which hands the callee a receiver of
    //    `KeyedDebouncer` instead of the global. `setTimeout`/`clearTimeout` are
    //    Web IDL operations on `Window`: in the Tauri WebView (Chromium) they
    //    brand-check that receiver and throw `TypeError: Illegal invocation`.
    //    The arrow ignores whatever receiver it is called with and calls the
    //    global BARE (receiver `undefined` → the spec substitutes the global),
    //    which is legal. NOTE the rule is about the RECEIVER, not about aliasing:
    //    `const f = setTimeout; f(...)` is fine; `obj.f = setTimeout; obj.f(...)`
    //    is not.
    //    ⚠️ NODE CANNOT TELL YOU THIS. In Node/vitest `setTimeout` is a plain
    //    function with no brand check, so the broken form runs green in every
    //    unit test — this shipped to owner as a red banner on the settings page
    //    (B3-6, 2026-07-31) with a fully green board behind it. The one test that
    //    does catch it installs a receiver-checking stand-in for the globals:
    //    `debounce.test.ts` → «run() survives a brand-checking global». If you
    //    change these two lines, that test is the thing that must still pass.
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
    private readonly cancel: (h: ReturnType<typeof setTimeout>) => void = (h) => clearTimeout(h),
  ) {}

  /** (Re)schedule `fn` for `key`, replacing any pending call for the same key. */
  run(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) this.cancel(existing);
    this.timers.set(
      key,
      this.schedule(() => {
        this.timers.delete(key);
        fn();
      }, this.delayMs),
    );
  }

  pending(key: string): boolean {
    return this.timers.has(key);
  }

  clearAll(): void {
    for (const t of this.timers.values()) this.cancel(t);
    this.timers.clear();
  }
}
