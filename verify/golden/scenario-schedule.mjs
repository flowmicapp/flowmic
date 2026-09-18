// verify/golden/scenario-schedule.mjs — WHICH golden cases may share the
// machine, and the bounded pool that lets them.
//
// Split out of run-golden.mjs rather than inlined there for the reason that
// file's own header gives about harness.mjs: run-golden.mjs is held to
// verify/lint/file-size.mjs's 800-line SRC_MAX, and the alternative to a split
// is deleting the reasoning that makes the table checkable. The narrative — why
// the suite is split at all, which case is in which group, and the measured
// wall clocks — stays in run-golden.mjs's header where the scheduler is read
// from. What lives here is the DATA plus the two mechanical checks that stop
// the data from drifting away from the tree.
//
// 🔴 THE TABLE IS A CLAIM ABOUT EACH CASE'S SOURCE, so it is cross-checked
// against something the tree can answer on its own: a case that takes the
// shared server's `url` has arity >= 1, one that starts everything itself has
// arity 0. `planSchedule` compares the two and REFUSES to pool a case whose
// signature disagrees with its entry (unless the entry says `ignoresUrl` and
// therefore names the exception out loud). The check cannot prove isolation —
// a case could take no parameter and still write a fixed path — but it does
// close the one drift that will actually happen: somebody adds `url` to a case
// that is listed here as self-starting.
//
// FAIL-SAFE DIRECTION: an unknown id, or a disagreement, lands in the
// SEQUENTIAL chain and prints a line saying so. Being slow is a cost; two
// cases writing one room table is a wrong answer.

/** 'chain' — needs the one shared standalone server, so it runs in table order,
 *  one at a time. 'pool' — starts every server it touches, on an ephemeral port
 *  with an in-memory or mkdtemp database, so N may run at once. */
export const SCENARIO_ISOLATION = new Map(Object.entries({
  G1: { group: 'chain', why: 'registerAndPair(url) on the shared standalone' },
  G2: { group: 'chain', why: 'registerAndPair(url) + compose on the shared standalone' },
  G3: { group: 'chain', why: 'registerAndPair(url) + compose on the shared standalone' },
  G4: { group: 'pool', why: 'unconditional SKIP — touches no server at all' },
  G5: { group: 'chain', why: 'registerAndPair(url) then reconnects that PC token' },
  G6: { group: 'chain', why: 'registerAndPair(url)' },
  G7: { group: 'chain', why: 'registerAndPair(url) + a second mobile socket on it' },
  G8: { group: 'chain', why: 'registerAndPair(url)' },
  G9: { group: 'pool', why: 'own startSaasServer(mailFileEnv(mkdtemp)), :memory: db' },
  G10: { group: 'chain', why: 'registerAndPair(url)' },
  G11: { group: 'pool', why: 'own startSaasServer(mailFileEnv(mkdtemp)), :memory: db' },
  G12: { group: 'chain', why: 'four sockets on the shared url; asserts pc:list-mobiles' },
  G13: { group: 'chain', why: 'LAN leg is crosstalkLeg(url) + POST url/api/inject/image (its cloud leg is its own saas server)' },
  G14: { group: 'chain', why: 'setupMachine(url) twice + POST url/api/inject/image' },
  G15: { group: 'pool', why: 'own startSaasServer(), :memory: db' },
  G16: { group: 'chain', why: 'presence polled over the shared url; reads url/api/health' },
  G17: { group: 'chain', why: 'posts a paddle webhook AT standaloneUrl (its saas half is its own file db)' },
  G18: { group: 'pool', why: 'own startSaasServer per leg, each with its own mailFileDir()' },
  G19: { group: 'chain', why: 'registerAndPair(url) for the LAN leg' },
  G20: { group: 'chain', why: 'registerAndPair(url) for the LAN leg' },
  G21: { group: 'pool', why: 'own startSaasServer() AND its own startServer() standalone' },
  G22: {
    group: 'pool',
    ignoresUrl: true,
    why: 'signature takes _sharedUrl and never reads it; spawns its own standalone + saas, both FLOWMIC_PORT 0, trace into mkdtemp',
  },
  G23: { group: 'chain', why: 'registerAndPair(url) for the LAN leg' },
  G24: { group: 'pool', why: 'own startSaasServer(), mkdtemp file db + mkdtemp mail dir' },
  G25: { group: 'pool', why: 'own startSaasServer(mailFileEnv(mkdtemp)), :memory: db' },
  G26: { group: 'pool', why: 'own startSaasServer() ×2, mkdtemp file db + mkdtemp mail dir' },
  G27: { group: 'chain', why: 'eight sockets in one room on the shared url' },
  G28: { group: 'chain', why: 'parks and drops web clients against the shared url' },
  G30: { group: 'pool', why: 'own startSaasServer() ×2, mkdtemp file db + mkdtemp mail dir' },
  G31: { group: 'pool', why: 'own startSaasServer(), mkdtemp file db + mkdtemp mail dir' },
  G32: { group: 'pool', why: 'own startSaasServer(), mkdtemp file db + mkdtemp mail dir' },
  G33: { group: 'chain', why: 'registerAndPair(url)' },
  G34: { group: 'pool', why: 'own startSaasServer() ×2, mkdtemp file db + mkdtemp mail dir' },
}));

/** Longest-first execution order, measured (see run-golden.mjs's header for the
 *  box and the medians). Scheduling only: a stale entry costs wall clock and
 *  nothing else, so it is a hint, not a contract. Ids absent from it sort last.
 *  The chain is one task, keyed by CHAIN_TASK_ID. */
export const CHAIN_TASK_ID = '<chain>';
// Measured 2026-09-13 with FLOWMIC_GOLDEN_CONCURRENCY=1 (seconds): G32 61.4,
// chain 61.0 (of which G28 alone is 39.3), G30 18.8, G31 11.5, G26 7.1,
// G24 6.2, then a tail every one of which is under 1.1.
// G34 measured 2026-09-16 at 6.3 s on its own (same box, single case).
const COST_ORDER = [
  'G32', CHAIN_TASK_ID, 'G30', 'G31', 'G26', 'G34', 'G24',
  'G22', 'G15', 'G18', 'G21', 'G25', 'G11', 'G9', 'G4',
];

/** Split `golden` into the sequential chain and the poolable set.
 *  @returns {{chain: object[], pool: object[], notes: string[]}} */
export function planSchedule(golden) {
  const chain = [];
  const pool = [];
  const notes = [];
  for (const g of golden) {
    const entry = SCENARIO_ISOLATION.get(g.id);
    if (!entry) {
      chain.push(g);
      notes.push(`${g.id} is not classified in scenario-schedule.mjs — running it in the SEQUENTIAL chain. Classify it there (and say why) to let it share the box.`);
      continue;
    }
    if (entry.group === 'pool' && g.fn.length > 0 && !entry.ignoresUrl) {
      chain.push(g);
      notes.push(`${g.id} is classified 'pool' but its fn takes ${g.fn.length} parameter(s) — it now reads the shared server. Demoted to the SEQUENTIAL chain; fix the entry or add ignoresUrl with the reason.`);
      continue;
    }
    if (entry.group === 'chain' && g.fn.length === 0) {
      notes.push(`${g.id} is classified 'chain' but its fn takes no parameter — kept sequential (safe), but the entry's reason no longer matches the source.`);
    }
    (entry.group === 'pool' ? pool : chain).push(g);
  }
  const stale = [...SCENARIO_ISOLATION.keys()].filter((id) => !golden.some((g) => g.id === id));
  if (stale.length > 0) notes.push(`scenario-schedule.mjs classifies ${stale.join(', ')}, which the GOLDEN table no longer contains.`);
  pool.sort((a, b) => cost(a.id) - cost(b.id));
  return { chain, pool, notes };
}

function cost(id) {
  const i = COST_ORDER.indexOf(id);
  return i === -1 ? COST_ORDER.length : i;
}

/** Read FLOWMIC_GOLDEN_CONCURRENCY. 1 ⇒ fully sequential (the reverse control
 *  that proves the pool is real). A junk value falls back to the default and
 *  says so, rather than silently becoming 0 workers or NaN.
 *
 *  THE DEFAULT IS 4 AND IT IS ONE MORE THAN NEEDED, ON PURPOSE. Measured (see
 *  run-golden.mjs's header): 3 workers already reach the floor, because the
 *  floor is one 61 s product constant, and 4 and 6 both measure 65.6 s. The
 *  spare worker is headroom for the NEXT expensive case rather than a share of
 *  the box someone chose by feel. `verify/run-delivery-fast.mjs` passes 3
 *  explicitly, where five other lanes are competing for the same cores. */
export function resolveConcurrency(env = process.env, fallback = 4) {
  const raw = env.FLOWMIC_GOLDEN_CONCURRENCY;
  if (raw === undefined || raw === '') return { n: fallback, note: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { n: fallback, note: `FLOWMIC_GOLDEN_CONCURRENCY='${raw}' is not a positive integer — using ${fallback}.` };
  }
  return { n, note: null };
}

/** Run `tasks` (async thunks) with at most `n` in flight. Results are NOT
 *  returned: each task owns where it puts its own result, so completion order
 *  cannot leak into the printed order. A task must not reject — the caller
 *  wraps its own failure into a result — but a rejection is not swallowed
 *  here either: it propagates and the runner's `main().catch` prints it. */
export async function runPool(tasks, n) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.max(1, Math.min(n, queue.length || 1)) }, async () => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      await task();
    }
  });
  await Promise.all(workers);
}
