// SPEC-REF:
//   apps/server-core/src/settings/provenance.ts (reclassifyUnmarked — THE thing
//     this tool measures; its header carries the full argument for the marker)
//   apps/server-core/src/settings/defaults.ts §seedDefaultSettings (the caller
//     loop this file mirrors, line-for-line, around L169)
//   apps/server-core/src/db/repos/settings.repo.ts (the real repo — enc:v1:
//     api_key fields are decrypted on read exactly as production decrypts them)
//   apps/server-core/src/db/enc-inventory.ts (the read-only-scan precedent: count
//     shapes, never emit content)
//
// ONE QUESTION, ASKED WITHOUT WRITING ANYTHING:
//   "If seedDefaultSettings() ran against this database right now, how many
//    stt.routings rows and how many llm.config rows would the add-only provenance
//    backfill REWRITE, and how many would it leave alone?"
//
// 🔴 IT CALLS THE REAL CLASSIFIER. `reclassifyUnmarked`, `buildDefaultSettings`
// and `makeSettingsRepo` are IMPORTED, never re-implemented. A copy of the
// comparison logic would measure this file instead of the code about to ship, and
// would agree with itself in exactly the cases where the shipping code is wrong.
// The per-unit breakdown below likewise reads the real function's OUTPUT by
// reference identity (`after[i] !== before[i]`) rather than re-deciding anything —
// that identity is a documented property of `reclassifyUnmarked` ("unchanged units
// are returned by reference and only a changed unit forces a new object").
//
// ── WHY IT DOES NOT USE db/connection.ts ────────────────────────────────────
// 🔴 `openDatabase()` is the repo's only open path and it is NOT read-only by
// construction: it runs `INIT_SQL` and then `reconcileSchema()`, which executes
// `DROP TABLE IF EXISTS transcript_history`, guarded ALTERs and CREATE INDEX. Run
// against a copy of production that is merely a mistake; run against production it
// is an incident. So the connection is opened here directly and the DB layer's
// read side (`makeSettingsRepo` / `makeUserRepo`) is used on top of it. That is a
// FINDING, recorded rather than routed around: the repo has no read-only door.
//
// ── WHAT "NEVER WRITES" DOES AND DOES NOT COVER (【measured】 2026-08-06) ─────
// The DATABASE FILE is untouched: sha256 of the .db, its -wal and its -shm were
// byte-identical before and after a full run on the fixture. But a read-only open
// of a WAL-mode database still CREATES the wal-index beside it if it is absent —
// a 32 KB `<db>-shm` and a 0-byte `<db>-wal` appeared next to a copy that had
// neither. That is SQLite building its shared-memory index, not a content change,
// and it means the ENCLOSING DIRECTORY MUST BE WRITABLE. Stated here rather than
// left to be discovered, because "never writes" would otherwise be read as a
// promise about the whole directory, which it is not.
//
// ── WHY IT DOES NOT USE identity.ts resolveStandaloneSecret() ───────────────
// 🔴 That function MINTS AND PERSISTS a new secret (writeFileSync, 0600) when it
// finds none. On a production box that would both leave a file behind and hand
// this tool a key that decrypts nothing. The env-var precedence below is the same
// one identity.ts applies (FLOWMIC_SETTINGS_SECRET then FLOWMIC_JWT_SECRET); the
// minting branch is deliberately absent, and a missing secret is a hard stop.
//
// ── WHAT THIS FILE IS FORBIDDEN TO PRINT ────────────────────────────────────
// 🔴 Row contents, api_key values (enveloped or plain), user ids, emails,
// endpoints, password hashes. Only aggregate integers and coarse shape (array
// lengths, octet lengths). That includes EXCEPTION MESSAGES: V8's JSON.parse error
// text quotes the offending input, so a caught read error is reported as a
// category count and its `.message` is never emitted.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { deriveKey } from '../auth/crypto';
import { makeSettingsRepo } from '../db/repos/settings.repo';
import { makeUserRepo } from '../db/repos/user.repo';
import { buildDefaultSettings } from '../settings/defaults';
import { LLM_CONFIG_KEY, STT_ROUTINGS_KEY, isSeedMarked, reclassifyUnmarked } from '../settings/provenance';

// esbuild does not know the `node:sqlite` builtin and rewrites the specifier to a
// bare `sqlite` at bundle time — the same trap db/connection.ts documents. A
// runtime require through a non-static specifier is the workaround it uses too.
const nodeRequire = createRequire(import.meta.url);
const SQLITE_SPECIFIER = 'node:sqlite';

type DbCtor = new (path: string, opts?: { readOnly?: boolean }) => DatabaseSync;

const USAGE = 'usage: node provenance-dryrun.mjs <path-to-db-copy>';
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const pad = (label: string): string => label.padEnd(27);
const sub = (label: string): string => label.padEnd(25);

// ── read-only enforcement ───────────────────────────────────────────────────

/**
 * Is `{ readOnly: true }` honoured by THIS runtime, or silently ignored?
 *
 * 🔴 It has to be measured, not assumed: node:sqlite tolerates unknown options
 * (【measured】 2026-08-06 on v22.22.3 — a bogus option neither throws nor warns),
 * so on a Node too old to know `readOnly` the target would be opened READ-WRITE
 * and nothing would say so. The probe runs against a throwaway database in the OS
 * temp dir; it never touches the target file.
 *
 * The first version of this check tried `BEGIN IMMEDIATE` on the target and
 * treated a throw as proof of read-only. 【measured】 that is NOT a proof: on
 * v22.22.3 `BEGIN IMMEDIATE` succeeds on a read-only connection (SQLite defers the
 * write lock), so the probe would have answered a different question than the one
 * asked while looking authoritative.
 */
function probeReadOnlySupport(Ctor: DbCtor): 'honored' | 'ignored' | 'rejected' | 'unknown' {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'flowmic-dryrun-'));
    const p = join(dir, 'probe.db');
    const w = new Ctor(p);
    w.exec('CREATE TABLE t (a INTEGER)');
    w.close();
    let r: DatabaseSync;
    try {
      r = new Ctor(p, { readOnly: true });
    } catch {
      return 'rejected'; // the runtime refuses the option outright
    }
    try {
      r.exec('INSERT INTO t VALUES (1)');
      return 'ignored'; // it wrote — the option did nothing
    } catch {
      return 'honored';
    } finally {
      r.close();
    }
  } catch {
    return 'unknown'; // no writable temp dir; fall back to query_only alone
  } finally {
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * `PRAGMA query_only = TRUE`, verified by reading it back.
 *
 * This is the guard that actually holds, and it holds INDEPENDENTLY of whether
 * the `readOnly` open option was honoured — 【measured】 2026-08-06: on a
 * deliberately read-WRITE handle, query_only=1 turns both `INSERT` and
 * `PRAGMA user_version=…` into `attempt to write a readonly database`, while
 * `SELECT` keeps working. `readOnly` is still requested (defence in depth); this
 * is what makes the promise true on a runtime that ignores it.
 */
function assertQueryOnly(db: DatabaseSync): void {
  db.exec('PRAGMA query_only = TRUE');
  const back = db.prepare('PRAGMA query_only').get() as { query_only?: number } | undefined;
  if (Number(back?.query_only ?? 0) !== 1) {
    throw new Error('refusing to continue: PRAGMA query_only did not take — this connection could write');
  }
}

// ── secret ──────────────────────────────────────────────────────────────────

function resolveSecretReadOnly(): { secret: string; source: string } {
  if (process.env.FLOWMIC_SETTINGS_SECRET) return { secret: process.env.FLOWMIC_SETTINGS_SECRET, source: 'FLOWMIC_SETTINGS_SECRET' };
  if (process.env.FLOWMIC_JWT_SECRET) return { secret: process.env.FLOWMIC_JWT_SECRET, source: 'FLOWMIC_JWT_SECRET' };
  const p = process.env.FLOWMIC_SECRET_PATH;
  if (p && existsSync(p)) {
    const s = readFileSync(p, 'utf8').trim();
    if (s.length >= 32) return { secret: s, source: 'FLOWMIC_SECRET_PATH (read, never minted)' };
  }
  throw new Error(
    'no deployment secret: set FLOWMIC_SETTINGS_SECRET (or FLOWMIC_JWT_SECRET), or FLOWMIC_SECRET_PATH to an ' +
      'existing secret file. Without the secret the llm.config rows cannot be decrypted and every count would be a guess.',
  );
}

// ── counters ────────────────────────────────────────────────────────────────

interface KeyStats {
  present: number;
  missing: number;
  wouldRewrite: number;
  unchanged: number;
  furtherRewrites: number;
  shapeUnexpected: number;
  readErrors: Record<string, number>;
}
const newKeyStats = (): KeyStats => ({ present: 0, missing: 0, wouldRewrite: 0, unchanged: 0, furtherRewrites: 0, shapeUnexpected: 0, readErrors: {} });

interface UnitStats {
  units: number;
  alreadySeed: number;
  wouldGain: number;
  remainUnmarked: number;
  rowsAllMarked: number;
  rowsPartlyMarked: number;
  rowsNoneMarked: number;
}
const newUnitStats = (): UnitStats => ({ units: 0, alreadySeed: 0, wouldGain: 0, remainUnmarked: 0, rowsAllMarked: 0, rowsPartlyMarked: 0, rowsNoneMarked: 0 });

/** bytes → shape counts. Octet length of the STORED json, never its content. */
interface ShapeBucket {
  rows: number;
  units: number;
  gained: number;
  already: number;
  remain: number;
  wouldRewriteRows: number;
}

/** Category only. 🔴 The message is deliberately dropped: V8 quotes the input
 *  inside JSON.parse errors, so echoing it would put row content in a log. */
function errorCategory(err: unknown): string {
  if (err instanceof SyntaxError) return 'malformed-json';
  const m = err instanceof Error ? err.message : '';
  if (m.includes('crypto.decrypt') || m.includes('authenticate') || m.includes('Unsupported state')) return 'decrypt-failed';
  return 'other';
}

// ── the run ─────────────────────────────────────────────────────────────────

function run(dbPath: string): number {
  const { DatabaseSync: Ctor } = nodeRequire(SQLITE_SPECIFIER) as { DatabaseSync: DbCtor };

  const roSupport = probeReadOnlySupport(Ctor);
  if (existsSync(`${dbPath}-wal`) && roSupport !== 'honored') {
    out(`refusing to open: a hot ${dbPath}-wal sits beside the database and this runtime does not honour readOnly`);
    out('  (a read-write open would let SQLite recover/checkpoint that WAL — a write). Checkpoint the COPY first:');
    out(`  sqlite3 ${dbPath} 'PRAGMA wal_checkpoint(TRUNCATE);' && rm -f ${dbPath}-wal ${dbPath}-shm`);
    return 3;
  }

  const db = roSupport === 'rejected' ? new Ctor(dbPath) : new Ctor(dbPath, { readOnly: true });
  try {
    assertQueryOnly(db);

    const { secret, source } = resolveSecretReadOnly();
    const settings = makeSettingsRepo(db, deriveKey(secret));
    const users = makeUserRepo(db);

    // Built once here to fail fast on a bad FLOWMIC_DEFAULT_*_HOST and to
    // fingerprint what this process would seed; the per-user loop below builds
    // its own, exactly as seedDefaultSettings() does.
    const probeDefaults = buildDefaultSettings();
    const fingerprint = createHash('sha256').update(JSON.stringify(probeDefaults)).digest('hex').slice(0, 8);

    const stats = new Map<string, KeyStats>();
    const shapes = new Map<string, Map<number, ShapeBucket>>();
    for (const d of probeDefaults) {
      stats.set(d.key, newKeyStats());
      shapes.set(d.key, new Map());
    }
    const unitStats = newUnitStats();

    const lenStmt = db.prepare('SELECT LENGTH(CAST(value AS BLOB)) AS n FROM user_settings WHERE user_id=? AND key=?');
    const storedBytes = (userId: string, key: string): number => {
      const r = lenStmt.get(userId, key) as { n?: number } | undefined;
      return Number(r?.n ?? -1);
    };
    const bucketFor = (key: string, bytes: number): ShapeBucket => {
      const m = shapes.get(key) as Map<number, ShapeBucket>;
      let b = m.get(bytes);
      if (!b) {
        b = { rows: 0, units: 0, gained: 0, already: 0, remain: 0, wouldRewriteRows: 0 };
        m.set(bytes, b);
      }
      return b;
    };

    // 🔴 THE REAL CALLER'S LOOP SHAPE — settings/defaults.ts seedDefaultSettings():
    // for every user, for each default key, repo.read() then reclassifyUnmarked().
    // The only difference is that repo.write() is never reached.
    const userIds = users.listAll().map((u) => u.id);
    for (const userId of userIds) {
      const defaults = buildDefaultSettings();
      for (const { key } of defaults) {
        const s = stats.get(key) as KeyStats;
        let row: { value: unknown } | null;
        try {
          row = settings.read(userId, key);
        } catch (err) {
          const c = errorCategory(err);
          s.readErrors[c] = (s.readErrors[c] ?? 0) + 1;
          continue;
        }
        if (row === null) {
          // The real function writes here too — a missing key gets freshly
          // seeded. Counted apart from the backfill on purpose: it is a
          // different write for a different reason.
          s.missing += 1;
          continue;
        }
        s.present += 1;

        const before = row.value;
        const remarked = reclassifyUnmarked(key, before, defaults);
        const bytes = storedBytes(userId, key);
        const bucket = bucketFor(key, bytes);
        bucket.rows += 1;

        const shapeOk = key === STT_ROUTINGS_KEY ? Array.isArray(before) : before !== null && typeof before === 'object' && !Array.isArray(before);
        if (!shapeOk) s.shapeUnexpected += 1;

        if (remarked === null) {
          s.unchanged += 1;
        } else {
          s.wouldRewrite += 1;
          bucket.wouldRewriteRows += 1;
          // Idempotence, asserted without writing: the value the classifier
          // returns must classify as "nothing to do" on the next pass.
          if (reclassifyUnmarked(key, remarked, defaults) !== null) s.furtherRewrites += 1;
        }

        if (key === STT_ROUTINGS_KEY && Array.isArray(before)) {
          const after = Array.isArray(remarked) ? (remarked as unknown[]) : null;
          let gained = 0;
          let already = 0;
          for (let i = 0; i < before.length; i += 1) {
            if (isSeedMarked(before[i])) already += 1;
            else if (after !== null && after[i] !== before[i]) gained += 1;
          }
          const remain = before.length - already - gained;
          unitStats.units += before.length;
          unitStats.alreadySeed += already;
          unitStats.wouldGain += gained;
          unitStats.remainUnmarked += remain;
          if (remain === 0 && before.length > 0) unitStats.rowsAllMarked += 1;
          else if (already + gained > 0) unitStats.rowsPartlyMarked += 1;
          else unitStats.rowsNoneMarked += 1;
          bucket.units += before.length;
          bucket.gained += gained;
          bucket.already += already;
          bucket.remain += remain;
        }
      }
    }

    return report({ dbPath, roSupport, source, fingerprint, userCount: userIds.length, keys: probeDefaults.map((d) => d.key), stats, shapes, unitStats });
  } finally {
    db.close();
  }
}

interface ReportInput {
  dbPath: string;
  roSupport: string;
  source: string;
  fingerprint: string;
  userCount: number;
  keys: string[];
  stats: Map<string, KeyStats>;
  shapes: Map<string, Map<number, ShapeBucket>>;
  unitStats: UnitStats;
}

function report(r: ReportInput): number {
  const envFlag = (n: string): string => ((process.env[n] ?? '').trim() === '' ? 'unset' : 'set');
  out('FlowMic provenance backfill — DRY RUN (report only, zero writes)');
  out(`${pad('db')}: ${r.dbPath}`);
  out(`${pad('node')}: ${process.version}`);
  out(`${pad('db guards')}: readOnly=${r.roSupport}  query_only=1 (verified by readback)`);
  out(`${pad('settings secret')}: ${r.source}`);
  out(`${pad('defaults fingerprint')}: ${r.fingerprint}`);
  out(`${pad('default host env')}: FLOWMIC_DEFAULT_STT_HOST=${envFlag('FLOWMIC_DEFAULT_STT_HOST')}  FLOWMIC_DEFAULT_LLM_HOST=${envFlag('FLOWMIC_DEFAULT_LLM_HOST')}`);
  out('');
  out(`${pad('users')}: ${r.userCount}`);
  let further = 0;
  let readErrors = 0;
  let shapeUnexpected = 0;
  for (const key of r.keys) {
    const s = r.stats.get(key) as KeyStats;
    further += s.furtherRewrites;
    shapeUnexpected += s.shapeUnexpected;
    for (const n of Object.values(s.readErrors)) readErrors += n;
    const k = key.padEnd(13);
    out(`${pad(`${k} present`)}: ${s.present}   missing(would seed): ${s.missing}`);
    out(`${pad(`${k} would rewrite`)}: ${s.wouldRewrite}   unchanged: ${s.unchanged}`);
  }
  out(`idempotence check (2nd pass on the in-memory result): ${further} further rewrites   <- must be 0`);

  const u = r.unitStats;
  out('');
  out(`${STT_ROUTINGS_KEY} per-routing-row breakdown (units inside the arrays)`);
  out(`  ${sub('units scanned')}: ${u.units}`);
  out(`  ${sub("already marked 'seed'")}: ${u.alreadySeed}`);
  out(`  ${sub("would gain 'seed'")}: ${u.wouldGain}`);
  out(`  ${sub('remain unmarked (⇒ user)')}: ${u.remainUnmarked}`);
  out(`  ${sub('rows fully marked after')}: ${u.rowsAllMarked}`);
  out(`  ${sub('rows partly marked after')}: ${u.rowsPartlyMarked}`);
  out(`  ${sub('rows with no marker after')}: ${u.rowsNoneMarked}`);

  out('');
  out('stored-value shape histogram (octet length of user_settings.value — length only, never content)');
  for (const key of r.keys) {
    const m = r.shapes.get(key) as Map<number, ShapeBucket>;
    for (const bytes of [...m.keys()].sort((a, b) => a - b)) {
      const b = m.get(bytes) as ShapeBucket;
      const unitPart = key === STT_ROUTINGS_KEY ? `   units=${b.units} would-gain=${b.gained} already=${b.already} remain=${b.remain}` : '';
      out(`  ${key.padEnd(13)} ${String(bytes).padStart(6)} bytes x ${b.rows} row(s)   would-rewrite=${b.wouldRewriteRows}${unitPart}`);
    }
  }

  out('');
  const errParts: string[] = [];
  for (const key of r.keys) {
    const s = r.stats.get(key) as KeyStats;
    for (const [c, n] of Object.entries(s.readErrors)) errParts.push(`${key}:${c}=${n}`);
  }
  out(`${pad('anomalies')}: read errors ${readErrors}${errParts.length > 0 ? ` (${errParts.join(' ')})` : ''}   unexpected shape ${shapeUnexpected}`);
  if (readErrors > 0) {
    out('🔴 INCOMPLETE: at least one row could not be read, so the counts above do not cover every account.');
    out('   The same row would make seedDefaultSettings() THROW at boot (settings.repo.ts toRow has no try/catch).');
    return 1;
  }
  if (further > 0) {
    out("🔴 IDEMPOTENCE VIOLATED: reclassifyUnmarked's own docstring claims a second pass finds nothing.");
    return 1;
  }
  out('OK — nothing was written, and no row would lose content if the backfill ran.');
  return 0;
}

function main(): number {
  const argv = process.argv.slice(2);
  const dbPath = argv[0];
  if (argv.length !== 1 || dbPath === undefined || dbPath === '-h' || dbPath === '--help') {
    out(USAGE);
    return argv.length === 1 ? 0 : 2;
  }
  if (!existsSync(dbPath)) {
    out(`${USAGE}\nno such file: ${dbPath}`);
    return 2;
  }
  try {
    return run(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such built-in module') || msg.includes('ERR_UNKNOWN_BUILTIN_MODULE')) {
      out('node:sqlite is not available unflagged on this runtime (it landed in v22.13.0 / v23.4.0).');
      out(`re-run as:  node --experimental-sqlite ${process.argv[1]} ${dbPath}`);
      return 4;
    }
    // Safe to print: every throw reaching here comes from this file, sqlite open,
    // or crypto — never from JSON.parse over a row (that is caught per row).
    out(`FAILED: ${msg}`);
    return 4;
  }
}

process.exit(main());
