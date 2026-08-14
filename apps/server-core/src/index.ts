// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §2 (index.ts CLI), §4 (self-host)
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (sidecar handshake: the desktop reads the
//     stdout line `FLOWMIC_LISTENING port=… mode=… version=…`)
//   docs/rebuild/13-LESSONS-LEARNED.md §4 (deploy: fail-loud bind, clean shutdown)
//
// CLI entry: parse `--mode/--port/--db` (the sidecar spawns
// `node server.js --mode standalone --port 41879`; env still works and CLI wins),
// load config, start the server, then print TWO stdout lines — first the bare
// resolved port (the legacy machine-readable line the smoke harnesses parse),
// then the richer `FLOWMIC_LISTENING …` handshake line the desktop sidecar reads.
// A bind failure exits non-zero (fail-loud) — never a silent 0-port drift.

import { pathToFileURL } from 'node:url';
import { loadConfig, type LoadConfigOverrides } from './config';
import { startServer, SERVER_VERSION } from './bootstrap';
import { installProcessGuards } from './error-handling';
import { initLogFile, log } from './log';

/** Parse `--mode <m>`, `--port <n>`, `--db <path>` (and `--key=value`) into
 *  loadConfig overrides. CLI beats env; anything unrecognized is ignored. */
export function parseArgv(argv: readonly string[]): LoadConfigOverrides {
  const out: LoadConfigOverrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    // For the space form, only consume the next token as the value if it is not
    // itself a flag — so a valueless boolean flag (`--verbose`) never swallows the
    // following `--mode`.
    const next = argv[i + 1];
    const val = eq >= 0 ? arg.slice(eq + 1) : next !== undefined && !next.startsWith('--') ? argv[++i] : undefined;
    if (val === undefined) continue;
    switch (key) {
      case 'mode':
        if (val === 'standalone' || val === 'saas') out.mode = val;
        break;
      case 'port': {
        const n = Number(val);
        if (Number.isInteger(n) && n >= 0 && n <= 65_535) out.port = n;
        break;
      }
      case 'db':
      case 'db-path':
        out.dbPath = val;
        break;
      default:
        break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  // FIRST — before anything can log. Importing log.ts already installed the
  // stdio error guards (an EPIPE on a dangling pipe used to kill this process
  // outright); this only creates the durable sink's directory.
  initLogFile();
  const config = loadConfig(parseArgv(process.argv.slice(2)));
  const handle = await startServer(config);
  // Line 1 — the legacy bare port (smoke harnesses key on /^(\d+)/).
  process.stdout.write(`${handle.port}\n`);
  // Line 2 — the sidecar handshake (07 §5). Emitted AFTER the bare line so the
  // `/^\d+/` first-line parse in the existing smokes is unaffected.
  process.stdout.write(`FLOWMIC_LISTENING port=${handle.port} mode=${config.mode} version=${SERVER_VERSION}\n`);

  // ONE memoized close shared by the signal path and the fatal path below —
  // the RV-65 close() is a 5-step sequence whose steps (db.close in
  // particular) are not re-entrant, and a fatal arriving mid-SIGTERM (or vice
  // versa) must join the in-flight close, not start a second one.
  let closePromise: Promise<void> | null = null;
  const closeOnce = (): Promise<void> => (closePromise ??= handle.close());

  // D4 layer 1 — uncaughtException/unhandledRejection guards. Until here the
  // process installed SIGNAL handlers only, so one throwing socket.io handler
  // (dispatched in a bare process.nextTick — see error-handling.ts header) or
  // one stray rejection took the whole relay down for every online user.
  // Installed AFTER startServer on purpose: a fatal during boot has no handle
  // to close, and Node's default (print stack, exit non-zero) is already the
  // honest fail-loud answer there — systemd restarts either way.
  installProcessGuards({ close: closeOnce });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    void closeOnce().then(
      () => process.exit(0),
      (err) => {
        log.error('shutdown error', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** True when this module is the process entry (`node server.js`), false when it is
 *  imported (e.g. a test importing `parseArgv`). Guards the boot so importing the
 *  CLI parser never starts a server. When bundled to a single file and run via
 *  `node server.js`, argv[1] is that file and import.meta.url matches it. */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    log.error('fatal: server failed to start', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
