// WP-R2-1 golden-path smoke — SAFETY-GUARDED live injection.
//
//   1. spawn server-core (standalone, ephemeral port)
//   2. spawn the Rust desktop client (examples/golden_inject.exe) with
//      FLOWMIC_SMOKE_ALLOWLIST=notepad — so it will perform a LIVE SendInput /
//      control:key ONLY when the foreground process is the sacrificial Notepad;
//      any other foreground is DECLINED to the cached path (never typed into)
//   3. spawn a sacrificial Notepad and let it take the foreground
//   4. drive a simulated mobile: pair → inject:request → inject:result truth
//      ⚠️ the sim STANDS IN for the phone here (R6 T-3a): this proves the DESKTOP
//      injects what it is asked to inject, never that the real app asks. See the
//      SIM-MOBILE CAVEAT at the head of verify/golden/run-golden.mjs.
//   5. assert the truth is SAFE: either injected INTO Notepad, or cached (the
//      desktop refused to type into a non-allowlisted window)
//
// Why the allowlist: an earlier smoke injected a test string into the owner's
// ChatGPT. The desktop-side allowlist makes it structurally impossible to type
// into any window that is not the sacrificial one, even if the foreground moves.
//
// Requires: `pnpm -F @flowmic/server-core build` and
//   `cargo build --example golden_inject` (in apps/desktop/src-tauri) first.
// Run:  DESKTOP_EXE=<abs path to golden_inject.exe> \
//       node apps/desktop/scripts/golden-smoke.mjs
// (socket.io-client is resolved from apps/server-core/node_modules.)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SERVER_DIR = resolve(REPO, 'apps', 'server-core');
const requireFromServer = createRequire(resolve(SERVER_DIR, 'package.json'));
const { io: ioClient } = requireFromServer('socket.io-client');

const DESKTOP_EXE =
  process.env.DESKTOP_EXE ||
  resolve(REPO, 'apps', 'desktop', 'src-tauri', 'target', 'debug', 'examples', 'golden_inject.exe');
const ALLOWLIST = 'notepad,Notepad';
const log = (...a) => console.log('[smoke]', ...a);

function startServer() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, FLOWMIC_MODE: 'standalone', FLOWMIC_PORT: '0' },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m) res({ child, port: Number(m[1]) });
    });
    child.on('exit', (c) => rej(new Error(`server exited early (${c})`)));
    setTimeout(() => rej(new Error('server start timeout')), 6000);
  });
}

function startDesktop(url) {
  return new Promise((res, rej) => {
    const child = spawn(DESKTOP_EXE, [], {
      env: {
        ...process.env,
        FLOWMIC_SERVER_URL: url,
        FLOWMIC_PC_NAME: 'Smoke PC',
        FLOWMIC_GOLDEN_HOLD_SECS: '25',
        FLOWMIC_SMOKE_ALLOWLIST: ALLOWLIST,
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
    child.on('exit', (c) => {
      if (!info.DESKTOP_READY) rej(new Error(`desktop exited early (${c})`));
    });
    setTimeout(() => rej(new Error('desktop ready timeout')), 15000);
  });
}

function connect(url) {
  const socket = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  return new Promise((res, rej) => {
    socket.on('connect', () => res(socket));
    socket.on('connect_error', rej);
    setTimeout(() => rej(new Error('mobile connect timeout')), 4000);
  });
}
const ack = (s, ev, p) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${ev} ack timeout`)), 4000);
    s.emit(ev, p, (r) => {
      clearTimeout(t);
      res(r);
    });
  });
const once = (s, ev, ms = 5000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${ev} wait timeout`)), ms);
    s.once(ev, (d) => {
      clearTimeout(t);
      res(d);
    });
  });

async function main() {
  const { child: server, port } = await startServer();
  const url = `http://127.0.0.1:${port}`;
  log(`server up on ${url}`);
  let desktop, notepad, mobile;
  try {
    ({ child: desktop } = await startDesktop(url).then((r) => ((globalThis.__i = r.info), r)));
    const info = globalThis.__i;
    log(`desktop registered: short_code=${info.DESKTOP_SHORT_CODE} room=${info.DESKTOP_ROOM}`);

    // Sacrificial window — the ONLY window the desktop is allowed to type into.
    notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1200)); // let it take the foreground

    mobile = await connect(url);
    const pair = await ack(mobile, 'mobile:pair', { short_code: info.DESKTOP_SHORT_CODE });
    log(`mobile paired (room_match=${pair.room_uuid === info.DESKTOP_ROOM})`);

    const resultP = once(mobile, 'inject:result');
    const req = { text: 'FlowMic smoke 你好 😀', source: 'stt', request_id: 'rq-smoke', entry_id: 'en-smoke' };
    log('mobile → inject:request', JSON.stringify(req.text));
    mobile.emit('inject:request', req);
    const r = await resultP;
    log('mobile ← inject:result', JSON.stringify(r));

    // A-58 echo must always be exact.
    const echoOk = r.request_id === req.request_id && r.entry_id === req.entry_id;
    // SAFETY assertion: a live injection is only ever INTO the allowlisted
    // window; otherwise the desktop must have declined to a cached/failed truth.
    const proc = r.inject_target?.process_name ?? '';
    const allowed = ALLOWLIST.split(',').some((p) => p.toLowerCase() === proc.toLowerCase());
    let verdict;
    if (r.ok) {
      verdict = allowed
        ? `INJECTED into sacrificial '${proc}' (safe)`
        : `UNSAFE — injected into non-allowlisted '${proc}'`;
    } else {
      verdict = `DECLINED → mode=${r.mode} error=${r.error} (safe: never typed into a foreign window)`;
    }
    log(`truth: ok=${r.ok} mode=${r.mode}; A-58 echo exact=${echoOk}; ${verdict}`);

    // control:key is allowlist-gated the same way — safe to send.
    mobile.emit('control:key', { kind: 'enter' });
    await new Promise((r) => setTimeout(r, 500));

    const safe = echoOk && (!r.ok || allowed);
    log(`GOLDEN_SMOKE ${safe ? 'PASS' : 'FAIL'}`);
    process.exitCode = safe ? 0 : 1;
  } finally {
    try { mobile && mobile.disconnect(); } catch {}
    try { desktop && desktop.kill(); } catch {}
    try { notepad && process.kill(-notepad.pid); } catch { try { notepad && notepad.kill(); } catch {} }
    setTimeout(() => { try { server.kill(); } catch {} process.exit(process.exitCode ?? 0); }, 500);
  }
}

main().catch((e) => {
  console.error('[smoke] FAIL', e.message);
  process.exit(1);
});
