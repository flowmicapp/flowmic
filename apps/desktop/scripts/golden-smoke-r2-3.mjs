// WP-R2-3 pull-the-cable smoke — SPEAKING-lock watchdog self-release on a dropped
// link, then the reconnect ladder + reconcile recovery, asserted from the Rust
// window-forensics.log (07 §10). A golden-smoke variant (deliverable E).
//
// Same allowlist safety as golden-smoke-r2-1b: FLOWMIC_SMOKE_ALLOWLIST=notepad,
// so a LIVE SendInput can only ever land in a sacrificial window; here we never
// even inject — we drive audio:start to arm the SPEAKING lock, then kill the
// server and prove the LOCAL watchdog force-releases the lock (the "拔网线 → latch
// 自解锁" red line) with NO inject:result to close it.
//
//   Phase A (lock watchdog): server up → desktop connects + registers → a mobile
//     pairs → audio:start arms the SPEAKING lock (force_lock, S→PC fan-out) →
//     KILL the server. With no inject ever resolving, the lock watchdog (32s in
//     prod; FLOWMIC_LOCK_TIMEOUT_SECS=3 here so it is scriptable) force-releases
//     the lock. Asserted from forensics: force_lock + watchdog forced release +
//     socket close.
//   Phase B (reconnect ladder): RESTART the server on the SAME port (file DB, so
//     the pc token survives) → the desktop's rust_socketio reconnect ladder
//     re-opens → pc:reconnect reconciles the session (07 §6) → the phase-A mobile
//     resumes by token (mobile:reconnect) → pc:mobile-joined recovers presence.
//     Asserted from forensics: a post-restart socket open + reconcile + presence
//     recovery.
//
// The frontend 6s latch watchdog (deliverable B) is a headless-absent concern
// here (the golden_inject example runs Tauri-free, no Vue) — it is proven by the
// vitest time-injection suite (speaking-watchdog.test.ts); this script asserts
// the RUST-side forensic lines exist and are readable, and prints the tail.
//
// The JOINED_SUPPRESS / ReconcileGate correctness is proven deterministically by
// the Rust unit tests (socket::reconcile::*); this script proves the ladder
// actually RE-RUNS reconcile live after a real disconnect.
//
// Requires: `pnpm -F @flowmic/server-core build` and
//   `cargo build --example golden_inject` (in apps/desktop/src-tauri) first.
// Run:  DESKTOP_EXE=<abs path to golden_inject.exe> \
//       node apps/desktop/scripts/golden-smoke-r2-3.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SERVER_DIR = resolve(REPO, 'apps', 'server-core');
const requireFromServer = createRequire(resolve(SERVER_DIR, 'package.json'));
const { io: ioClient } = requireFromServer('socket.io-client');

const DESKTOP_EXE =
  process.env.DESKTOP_EXE ||
  resolve(REPO, 'apps', 'desktop', 'src-tauri', 'target', 'debug', 'examples', 'golden_inject.exe');
const ALLOWLIST = 'notepad,Notepad';
const LOCK_TIMEOUT_SECS = 3;
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

const PID = process.pid;
const FORENSIC_PATH = resolve(tmpdir(), `flowmic-r2-3-forensic-${PID}.log`);
const CRED_PATH = resolve(tmpdir(), `flowmic-r2-3-cred-${PID}.json`);
const DB_PATH = resolve(tmpdir(), `flowmic-r2-3-db-${PID}.sqlite`);

const log = (...a) => console.log('[r2-3]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const forensic = () => (existsSync(FORENSIC_PATH) ? readFileSync(FORENSIC_PATH, 'utf8') : '');
const cleanupFiles = () => {
  for (const p of [FORENSIC_PATH, CRED_PATH, DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { rmSync(p, { force: true }); } catch {}
  }
};

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => res(port));
    });
  });
}

function startServer(port) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, FLOWMIC_MODE: 'standalone', FLOWMIC_PORT: String(port), FLOWMIC_DB_PATH: DB_PATH },
    });
    let out = '';
    const onData = (d) => {
      out += d;
      if (/^\d+/.test(out.trim())) { child.stdout.off('data', onData); res(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    child.on('exit', (c) => { if (!out) rej(new Error(`server exited early (${c})`)); });
    setTimeout(() => rej(new Error('server start timeout')), 8000);
  });
}

function startDesktop(url) {
  return new Promise((res, rej) => {
    const child = spawn(DESKTOP_EXE, [], {
      env: {
        ...process.env,
        FLOWMIC_SERVER_URL: url,
        FLOWMIC_PC_NAME: 'PullCable PC',
        FLOWMIC_GOLDEN_HOLD_SECS: '60',
        FLOWMIC_SMOKE_ALLOWLIST: ALLOWLIST,
        FLOWMIC_LOCK_TIMEOUT_SECS: String(LOCK_TIMEOUT_SECS),
        FLOWMIC_FORENSIC_PATH: FORENSIC_PATH,
        FLOWMIC_CRED_PATH: CRED_PATH,
      },
    });
    const info = {};
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) log('desktop>', line);
        const kv = /^([A-Z_]+)=(.*)$/.exec(line);
        if (kv) info[kv[1]] = kv[2];
        if (line === 'DESKTOP_READY') res({ child, info });
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[desktop] ${d}`));
    child.on('exit', (c) => { if (!info.DESKTOP_READY) rej(new Error(`desktop exited early (${c})`)); });
    setTimeout(() => rej(new Error('desktop ready timeout')), 15000);
  });
}

function connectMobile(url) {
  const socket = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  return new Promise((res, rej) => {
    socket.on('connect', () => res(socket));
    socket.on('connect_error', rej);
    setTimeout(() => rej(new Error('mobile connect timeout')), 4000);
  });
}
const ack = (s, ev, p) =>
  new Promise((res) => {
    const t = setTimeout(() => res(undefined), 4000);
    s.emit(ev, p, (r) => { clearTimeout(t); res(r); });
  });

/** Poll the forensic log until `re` matches or `ms` elapses. */
async function waitForensic(re, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (re.test(forensic())) return true;
    await sleep(250);
  }
  return re.test(forensic());
}

async function main() {
  cleanupFiles();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let server, desktop, mobile, mobile2;
  const verdicts = [];
  const V = (name, ok) => { verdicts.push([name, ok]); log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };
  const S = (name, why) => { verdicts.push([name, 'SKIP']); log(`  [SKIP] ${name} — ${why}`); };

  try {
    // ── Phase A: lock watchdog on a dropped link ──────────────────────────
    log(`--- Phase A: SPEAKING-lock watchdog on cable pull (lock_timeout=${LOCK_TIMEOUT_SECS}s) ---`);
    server = await startServer(port);
    log(`server up on ${url} (db=${DB_PATH})`);
    ({ child: desktop } = await startDesktop(url).then((r) => ((globalThis.__i = r.info), r)));
    const info = globalThis.__i;
    log(`desktop registered: short_code=${info.DESKTOP_SHORT_CODE} room=${info.DESKTOP_ROOM}`);

    mobile = await connectMobile(url);
    const pair = await ack(mobile, 'mobile:pair', { short_code: info.DESKTOP_SHORT_CODE });
    const mobileToken = pair?.mobile_token;
    log(`mobile paired (room_match=${pair?.room_uuid === info.DESKTOP_ROOM}, token=${mobileToken ? 'yes' : 'NONE'})`);
    V('mobile presence seen by desktop (pc:mobile-joined)', await waitForensic(/pc:mobile-joined \(mobiles=1\)/, 3000));

    // audio:start → arm the SPEAKING lock (S→PC fan-out, F-2375).
    await ack(mobile, 'audio:start', AUDIO_START);
    const locked = await waitForensic(/\[lock\] audio:start → force_lock/, 3000);
    const noForeground = /audio:start → no live foreground to lock/.test(forensic());
    if (locked) V('audio:start armed the SPEAKING lock (force_lock)', true);
    else if (noForeground) S('audio:start armed the SPEAKING lock', 'headless/session-0: no live foreground to lock — needs an interactive desktop');
    else V('audio:start armed the SPEAKING lock (force_lock)', false);

    // ── pull the cable: kill the server ──
    log('--- KILL server (cable pull) ---');
    server.kill();
    server = null;
    V('socket close observed after kill', await waitForensic(/\[socket\] close/, 6000));

    if (locked) {
      // With no inject:result, the lock watchdog is the ONLY thing that can free
      // the lock. It must fire within ~LOCK_TIMEOUT_SECS.
      const released = await waitForensic(/SPEAKING lock watchdog — forced release/, (LOCK_TIMEOUT_SECS + 4) * 1000);
      V(`SPEAKING lock self-released via watchdog (~${LOCK_TIMEOUT_SECS}s)`, released);
    } else {
      S('SPEAKING lock self-released via watchdog', 'lock was not armed (no live foreground) — watchdog has nothing to release');
    }

    // ── Phase B: reconnect ladder + reconcile recovery ────────────────────
    log('--- Phase B: RESTART server (same port, persisted token) ---');
    const opensBefore = (forensic().match(/\[socket\] open/g) || []).length;
    server = await startServer(port);
    log('server restarted');

    // A restart produces a NEW `[socket] open` line; poll the open-line count.
    const reopenOk = await (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if ((forensic().match(/\[socket\] open/g) || []).length > opensBefore) return true;
        await sleep(300);
      }
      return false;
    })();
    V('desktop reconnected after restart (new socket open)', reopenOk);
    V('pc:reconnect reconciled the session (07 §6)', await waitForensic(/\[reconcile\] pc:reconnect ack — mobile_count/, 8000));

    // Mobile resumes by token → pc:mobile-joined recovers presence.
    if (mobileToken && reopenOk) {
      mobile2 = await connectMobile(url);
      const rc = await ack(mobile2, 'mobile:reconnect', { token: mobileToken });
      log(`mobile:reconnect ack=${JSON.stringify(rc)}`);
      V('mobile presence recovered after reconnect (pc:mobile-joined)', await waitForensic(/pc:mobile-joined \(mobiles=1\)[\s\S]*pc:mobile-joined \(mobiles=1\)/, 5000));
    } else {
      S('mobile presence recovered after reconnect', 'no mobile token or desktop did not reopen');
    }

    // ── forensic readability: print the tail 20 lines ──
    const lines = forensic().split('\n').filter(Boolean);
    log(`--- window-forensics.log tail (${lines.length} lines total) ---`);
    for (const l of lines.slice(-20)) console.log('    ' + l);

    const fails = verdicts.filter(([, ok]) => ok === false).length;
    const skips = verdicts.filter(([, ok]) => ok === 'SKIP').length;
    log(`R2_3_SMOKE ${fails === 0 ? 'PASS' : 'FAIL'} (${verdicts.length - fails - skips} pass / ${skips} skip / ${fails} fail)`);
    process.exitCode = fails === 0 ? 0 : 1;
  } catch (e) {
    log('FAIL', e.message);
    process.exitCode = 1;
  } finally {
    try { mobile && mobile.disconnect(); } catch {}
    try { mobile2 && mobile2.disconnect(); } catch {}
    try { desktop && desktop.kill(); } catch {}
    setTimeout(() => {
      try { server && server.kill(); } catch {}
      cleanupFiles();
      process.exit(process.exitCode ?? 0);
    }, 600);
  }
}

main().catch((e) => { console.error('[r2-3] FATAL', e); process.exit(1); });
