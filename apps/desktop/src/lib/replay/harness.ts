// WP-R3.5 cross-FSM coupling-edge REPLAY harness (11 §1: "JSONL trace + closed-
// enum step-types + fsm-edge cross-FSM coupling-edge primitives + deterministic replay ±50ms"). The six coupling
// edges are the transitions single-point FSM tests miss — e.g. AUTH expiry must drain
// PAIRING + SESSION. This is a deterministic, dependency-free replayer: a Trace is
// pure DATA (round-trips through JSONL); a World holds the REAL FSMs + the checks;
// replaying the same JSONL twice yields the same digest (content-addressed).
//
// The virtual clock makes time deterministic (no real timers): `advance` moves it
// and ticks the World (so poll-based FSMs like the SPEAKING watchdog fire), and a
// timed `fsm-edge` asserts the coupling fired within ±50 ms of its deadline.

export const EDGE_TOLERANCE_MS = 50;

/** Closed enum of step kinds (11 §1). No open-ended step type. */
export type Step =
  | { kind: 'signal'; name: string; arg?: unknown } // deliver a stimulus to the World now
  | { kind: 'advance'; ms: number } // move the virtual clock forward + tick
  | { kind: 'fsm-edge'; edge: string; expect: string; deadlineMs?: number } // assert a coupling holds (timed if deadlineMs)
  | { kind: 'assert'; label: string }; // terminal predicate over World state

export type Trace = Step[];

/** A World binds a set of REAL FSMs together and exposes named boolean probes.
 *  `dispatch` applies a signal at the given virtual time; `tick` lets poll-based
 *  FSMs (watchdogs) advance; `checks` are the coupling probes the trace names. */
export interface World {
  readonly checks: Record<string, () => boolean>;
  dispatch(signal: string, arg: unknown, now: number): void;
  tick(now: number): void;
}

export interface EdgeObservation {
  edge: string;
  expect: string;
  at: number;
  deadlineMs?: number;
  withinTolerance: boolean;
}

export interface ReplayResult {
  edges: EdgeObservation[];
  /** Virtual time each check first became true (null = never). */
  firstTrue: Record<string, number | null>;
  /** Content-addressed digest — identical across replays of the same trace. */
  digest: string;
}

export class ReplayError extends Error {}

/** Serialize a Trace to JSONL (one step per line) — the on-disk trace format. */
export function toJsonl(trace: Trace): string {
  return trace.map((s) => JSON.stringify(s)).join('\n');
}

/** Parse a JSONL trace back to steps (deterministic replay from disk). */
export function fromJsonl(jsonl: string): Trace {
  return jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Step);
}

function digestOf(edges: EdgeObservation[], firstTrue: Record<string, number | null>): string {
  const e = edges.map((x) => `${x.edge}:${x.expect}@${x.at}:${x.withinTolerance ? 1 : 0}`).join('|');
  const f = Object.keys(firstTrue)
    .sort()
    .map((k) => `${k}=${firstTrue[k]}`)
    .join(',');
  return `${e}#${f}`;
}

/** Deterministically replay a trace against a World built over the real FSMs. All
 *  checks are polled after every signal/advance so a timed fsm-edge can pin the
 *  virtual time a coupling first held (±50 ms). Throws ReplayError on any failed
 *  edge/assert — a broken coupling is loud, never silent. */
export function replay(trace: Trace, world: World): ReplayResult {
  let t = 0;
  const firstTrue: Record<string, number | null> = {};
  for (const name of Object.keys(world.checks)) firstTrue[name] = null;

  const poll = (): void => {
    for (const [name, fn] of Object.entries(world.checks)) {
      if (firstTrue[name] === null && fn()) firstTrue[name] = t;
    }
  };
  poll(); // t=0 baseline

  const edges: EdgeObservation[] = [];
  for (const step of trace) {
    switch (step.kind) {
      case 'signal':
        world.dispatch(step.name, step.arg, t);
        poll();
        break;
      case 'advance':
        if (step.ms < 0) throw new ReplayError(`advance ms must be >= 0 (got ${step.ms})`);
        t += step.ms;
        world.tick(t);
        poll();
        break;
      case 'fsm-edge': {
        const probe = world.checks[step.expect];
        if (!probe) throw new ReplayError(`fsm-edge ${step.edge}: unknown check "${step.expect}"`);
        if (!probe()) throw new ReplayError(`fsm-edge ${step.edge}: coupling "${step.expect}" did not hold at t=${t}`);
        let withinTolerance = true;
        if (step.deadlineMs !== undefined) {
          const at = firstTrue[step.expect];
          withinTolerance = at != null && Math.abs(at - step.deadlineMs) <= EDGE_TOLERANCE_MS;
          if (!withinTolerance) {
            throw new ReplayError(
              `fsm-edge ${step.edge}: "${step.expect}" first held at t=${at}, expected ${step.deadlineMs}±${EDGE_TOLERANCE_MS}ms`,
            );
          }
        }
        edges.push({
          edge: step.edge,
          expect: step.expect,
          at: firstTrue[step.expect] ?? t,
          ...(step.deadlineMs !== undefined ? { deadlineMs: step.deadlineMs } : {}),
          withinTolerance,
        });
        break;
      }
      case 'assert': {
        const probe = world.checks[step.label];
        if (!probe) throw new ReplayError(`assert: unknown check "${step.label}"`);
        if (!probe()) throw new ReplayError(`assert "${step.label}" failed at t=${t}`);
        break;
      }
    }
  }
  return { edges, firstTrue, digest: digestOf(edges, firstTrue) };
}
