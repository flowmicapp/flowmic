// SPEC-REF:
//   docs/decisions/2026-07-30-image-http-upload-and-socket-hardening.md
//   CLAUDE.md red line: no silent failure — a delivery verdict must travel back to the
//   sender on a channel that is still alive.
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// A bounded request_id ledger connecting the HTTP image-upload route to the PC's
// `inject:result`. The route relays an inject:request to the PC and then WAITS
// here; relay.handler resolves the waiter when the PC's result arrives (one
// added line there). The HTTP response therefore carries the PC's REAL verdict,
// on a connection whose liveness the phone just proved by making the request —
// precisely what the room socket could not guarantee (RCA-v3: frames written
// into a dead-but-undetected socket).
//
// RV-04 (2026-07-30) — why this file changed shape twice over.
//
//   ① `wait()` returned `null` for THREE different facts: "waited the full time
//      with no receipt", "someone is already waiting on this request_id", and
//      "the wait table is full". The route read that
//      single null as a timeout, so a duplicate request_id was answered
//      `INJECT_RESULT_TIMEOUT` **0 ms after arriving** — a 15 s wait reported
//      without waiting. That is the repo's #1 bug shape (one value answering two
//      questions) sitting directly on the injection path. `begin()` now returns a TAGGED
//      attempt: each fact has its own name and the route answers each one
//      differently. Nothing infers a reason from an absent value.
//
//   ② The phone auto-retries a lost response (image_send_controller). Body
//      arrived, response died in the same dead TCP window RCA-v3 is about →
//      retry → the PC pasted the SAME picture twice (image bypasses the
//      desktop's dedup by deliberate ruling: "the user might genuinely want to
//      paste the same picture twice"). The distinction that ruling is missing is
//      "the same picture again" (allowed) vs "a retry of the same request"
//      (must be idempotent), and a request_id is exactly
//      that difference. So this ledger now also remembers the ANSWER each
//      request_id was already given, and a second arrival is served that answer
//      instead of a second paste.
//
// Two structures, two questions, never one value for both:
//   · `waiters` answers "who is currently waiting on this request_id's receipt";
//   · `answers` answers "what conclusion this request_id has already received".
// Both are size-bounded so a client minting ids can never grow them.

export interface PendingInjectResult {
  ok: boolean;
  mode: string;
  error?: string | undefined;
  inject_target?: unknown;
  entry_id?: string | undefined;
  request_id?: string | undefined;
}

/** The end of ONE wait. A timeout is its own tag — never a null the caller has
 *  to interpret. */
export type InjectWaitOutcome =
  | { readonly kind: 'result'; readonly result: PendingInjectResult }
  /** The window elapsed with no `inject:result`. The frame WAS relayed; whether
   *  it landed is unknown, and that is a different fact from a failure. */
  | { readonly kind: 'timeout' };

/** What may be done with an inbound request_id. The `relay` half is explicit
 *  because emitting on a request whose outcome can never be reported is how
 *  RV-04's double paste happened: only `armed` licenses an emit. */
export type InjectAttempt =
  /** First sight: the caller MUST relay the frame, then await [outcome]. */
  | { readonly kind: 'armed'; readonly outcome: Promise<InjectWaitOutcome> }
  /** Another in-flight request already relayed this exact request_id. Do NOT
   *  relay again — join its wait and report the SAME verdict. */
  | { readonly kind: 'joined'; readonly outcome: Promise<InjectWaitOutcome> }
  /** This request_id already has a conclusion ([answer], verbatim as it was
   *  first sent). Do NOT relay — repeat that answer. */
  | { readonly kind: 'replay'; readonly answer: Record<string, unknown> }
  /** The waiter table is full. Do NOT relay: a frame this route could not
   *  report on is a silent failure waiting to happen. */
  | { readonly kind: 'overloaded' };

const MAX_WAITERS = 64;

/** How many concluded request_ids keep their answer for an idempotent retry.
 *  Only ids this route itself answered are recorded, so the bound covers the
 *  http ingress alone — larger than MAX_WAITERS because an answer must outlive
 *  the request that produced it (the retry arrives AFTER the first concluded). */
const MAX_ANSWERS = 256;

interface Waiter {
  readonly settle: (outcome: InjectWaitOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly clear: typeof clearTimeout;
}

export class InjectPendingRegistry {
  /** request_id → everyone currently awaiting that id's verdict. */
  private readonly waiters = new Map<string, Set<Waiter>>();

  /** request_id → the answer already sent for it (RV-04 idempotency). */
  private readonly answers = new Map<string, Record<string, unknown>>();

  /** Insertion order of [answers] for the bound eviction (oldest at the front). */
  private readonly answerOrder: string[] = [];

  /** The conclusion this request_id already received, or undefined when it has
   *  none. Cheap enough to ask BEFORE doing any row / file work, which is the
   *  point: a retry of a concluded request must cost nothing and change
   *  nothing. */
  answerFor(requestId: string): Record<string, unknown> | undefined {
    return this.answers.get(requestId);
  }

  /** Remember the answer [requestId] was given, so its retry is served this
   *  instead of a second injection. Called by the route with the EXACT body it
   *  sent — a replay is then the same statement, not a reconstruction of it. */
  recordAnswer(requestId: string, answer: Record<string, unknown>): void {
    if (!this.answers.has(requestId)) {
      this.answerOrder.push(requestId);
      while (this.answerOrder.length > MAX_ANSWERS) {
        const stale = this.answerOrder.shift();
        if (stale !== undefined) this.answers.delete(stale);
      }
    }
    this.answers.set(requestId, answer);
  }

  /** Claim [requestId] for one delivery attempt. The returned tag says what the
   *  caller may do; only `armed` licenses relaying the frame. */
  begin(
    requestId: string,
    timeoutMs: number,
    setTimeoutFn: typeof setTimeout = setTimeout,
    clearTimeoutFn: typeof clearTimeout = clearTimeout,
  ): InjectAttempt {
    const answered = this.answers.get(requestId);
    if (answered !== undefined) return { kind: 'replay', answer: answered };

    const existing = this.waiters.get(requestId);
    // Capacity is counted in request_ids, not waiters: joining an id already
    // present costs no new slot, so a retry can never be refused for capacity.
    if (existing === undefined && this.waiters.size >= MAX_WAITERS) {
      return { kind: 'overloaded' };
    }
    const bucket = existing ?? new Set<Waiter>();
    if (existing === undefined) this.waiters.set(requestId, bucket);

    let settle!: (outcome: InjectWaitOutcome) => void;
    const outcome = new Promise<InjectWaitOutcome>((resolve) => {
      settle = resolve;
    });
    const waiter: Waiter = {
      settle,
      clear: clearTimeoutFn,
      timer: setTimeoutFn(() => {
        this.drop(requestId, waiter);
        settle({ kind: 'timeout' });
      }, timeoutMs),
    };
    bucket.add(waiter);
    return existing === undefined ? { kind: 'armed', outcome } : { kind: 'joined', outcome };
  }

  /** Called by relay.handler for EVERY parsed inject:result. A result nobody is
   *  waiting on is the normal socket-path case — a plain no-op. */
  resolve(result: PendingInjectResult): void {
    if (!result.request_id) return;
    const bucket = this.waiters.get(result.request_id);
    if (!bucket) return;
    this.waiters.delete(result.request_id);
    // Every joiner gets the same verdict: one relay, one truth, N reporters.
    for (const waiter of bucket) {
      waiter.clear(waiter.timer);
      waiter.settle({ kind: 'result', result });
    }
  }

  private drop(requestId: string, waiter: Waiter): void {
    const bucket = this.waiters.get(requestId);
    if (!bucket) return;
    bucket.delete(waiter);
    if (bucket.size === 0) this.waiters.delete(requestId);
  }

  /** Distinct request_ids currently awaiting a verdict. */
  get size(): number {
    return this.waiters.size;
  }

  /** Concluded request_ids still able to serve an idempotent retry. */
  get answeredSize(): number {
    return this.answers.size;
  }
}
