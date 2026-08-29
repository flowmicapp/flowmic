// scripts/loadtest/lib/cli-args.mjs — shared CLI parsing for run.mjs and baseline.mjs.

export const DEFAULTS = Object.freeze({
  clients: 10,
  minutes: 1,
  ramp: 5,
  host: null,        // null ⇒ spawn a local server (see lib/local-server.mjs); always loopback
  port: null,
  engine: 'off',      // 'off' | 'local' — see README "engine modes"
  utteranceMs: 3000,
  gapMs: 800,
  heartbeatMs: 5000,
  sampleIntervalMs: 2000,
  allowNonLoopback: false,
  label: null,
});

const FLAG_TO_KEY = {
  '--clients': ['clients', Number],
  '--minutes': ['minutes', Number],
  '--ramp': ['ramp', Number],
  '--host': ['host', String],
  '--port': ['port', Number],
  '--engine': ['engine', String],
  '--utterance-ms': ['utteranceMs', Number],
  '--gap-ms': ['gapMs', Number],
  '--heartbeat-ms': ['heartbeatMs', Number],
  '--sample-interval-ms': ['sampleIntervalMs', Number],
  '--label': ['label', String],
};

export const USAGE = `
Usage: node scripts/loadtest/run.mjs [options]

  --clients N              concurrent simulated phone+PC pairs (default ${DEFAULTS.clients})
  --minutes M               how long the steady-state phase runs, in minutes (default ${DEFAULTS.minutes})
  --ramp S                  seconds over which clients stagger-start (default ${DEFAULTS.ramp})
  --engine off|local        STT leg mode (default '${DEFAULTS.engine}') — see README "engine modes"
  --utterance-ms N          simulated PTT utterance length, ms (default ${DEFAULTS.utteranceMs})
  --gap-ms N                 pause between utterances, ms (default ${DEFAULTS.gapMs})
  --heartbeat-ms N           heartbeat cadence / event-loop-lag probe interval (default ${DEFAULTS.heartbeatMs})
  --sample-interval-ms N     server CPU/RSS poll interval, ms (default ${DEFAULTS.sampleIntervalMs})
  --host HOST                connect to an ALREADY-RUNNING instance instead of spawning one
                              (requires --port too). Defaults to spawning a local server on
                              a random loopback port — see README.
  --port N                   paired with --host, or the local server's fixed port (default: random)
  --label TEXT               tag included in the output filenames
  --i-know-this-is-not-production
                              REQUIRED to point --host at anything but loopback. There is no
                              other way to do this — see lib/target-guard.mjs.
`;

export function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--i-know-this-is-not-production') { out.allowNonLoopback = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const entry = FLAG_TO_KEY[a];
    if (!entry) throw new Error(`unrecognized argument: ${a}\n${USAGE}`);
    const [key, cast] = entry;
    const raw = argv[++i];
    if (raw === undefined) throw new Error(`${a} requires a value\n${USAGE}`);
    out[key] = cast === Number ? Number(raw) : raw;
    if (cast === Number && !Number.isFinite(out[key])) throw new Error(`${a} must be a number, got "${raw}"`);
  }
  if (out.host !== null && out.port === null) {
    throw new Error('--host requires --port (this tool never guesses a port on someone else\'s server)');
  }
  if (out.engine !== 'off' && out.engine !== 'local') {
    throw new Error(`--engine must be 'off' or 'local', got "${out.engine}"`);
  }
  if (!Number.isInteger(out.clients) || out.clients < 1) {
    throw new Error(`--clients must be a positive integer, got "${out.clients}"`);
  }
  if (out.minutes <= 0) throw new Error(`--minutes must be > 0, got "${out.minutes}"`);
  if (out.ramp < 0) throw new Error(`--ramp must be >= 0, got "${out.ramp}"`);
  return out;
}
