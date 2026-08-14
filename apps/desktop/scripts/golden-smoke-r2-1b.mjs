// WP-R2-1b smoke — SAFETY-GUARDED, two scenarios over the REAL wire.
//
// Same allowlist safety as golden-smoke.mjs: FLOWMIC_SMOKE_ALLOWLIST=notepad, so
// a LIVE SendInput only ever lands in the sacrificial Notepad; any other
// foreground is DECLINED to cached (never typed into). Structurally impossible
// to type into a foreign window even if the foreground moves.
//
// ⚠️ SIM-MOBILE CAVEAT (R6 T-3a): the "mobile" below is a socket script standing
// in for the phone. It proves the DESKTOP's lock/dedup behaviour on a received
// inject:request — never that the real app emits one. See the caveat header in
// verify/golden/run-golden.mjs.
//
//   Scenario A (focus race): mobile → audio:start (drives the desktop SPEAKING
//     lock off the S→PC fan-out, F-2375) → inject:request. The injection must
//     resolve to the LOCKED target — never a window the foreground moved to.
//   Scenario B (replay dedup, INJ-3): mobile → the SAME request_id twice. The
//     sacrificial window must show the text ONCE and both acks must be truth-
//     identical (the second is a replay of the first cached result, no re-type).
//
// Environment note: where there is no interactive input desktop (a headless /
// session-0 runner), there is no Notepad foreground, so injection resolves to
// the SAFE cached path. In that mode the smoke asserts (1) the audio:start/stop
// S→PC fan-out reached the PC (desktop lock markers), and (2) both replay acks
// are truth-identical — and reports that the INJECTED-once physical assertion
// needs a real desktop (repro command printed). It never fabricates an injected
// verdict. The dedup REPLAY path (typed-once) and the lock-holds-through-switch
// invariant are proven exhaustively by the Rust unit tests
// (socket::dedup::*, focus::state::*).
//
// Requires: `pnpm -F @flowmic/server-core build` and
//   `cargo build --example golden_inject` (in apps/desktop/src-tauri) first.
// Run:  DESKTOP_EXE=<abs path to golden_inject.exe> \
//       node apps/desktop/scripts/golden-smoke-r2-1b.mjs

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
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };
const log = (...a) => console.log('[smoke]', ...a);

let dstderr = '';

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
        FLOWMIC_GOLDEN_HOLD_SECS: '30',
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
    child.stderr.on('data', (d) => {
      dstderr += d;
      process.stderr.write(`[desktop] ${d}`);
    });
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
  new Promise((res) => {
    const t = setTimeout(() => res(undefined), 4000);
    s.emit(ev, p, (r) => { clearTimeout(t); res(r); });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { child: server, port } = await startServer();
  const url = `http://127.0.0.1:${port}`;
  log(`server up on ${url}`);
  let desktop, notepad, mobile;
  const verdicts = [];
  try {
    ({ child: desktop } = await startDesktop(url).then((r) => ((globalThis.__i = r.info), r)));
    const info = globalThis.__i;
    log(`desktop registered: short_code=${info.DESKTOP_SHORT_CODE} room=${info.DESKTOP_ROOM}`);

    // Sacrificial window — the ONLY window the desktop may type into.
    notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    await sleep(1200);

    mobile = await connect(url);
    const results = [];
    mobile.on('inject:result', (r) => results.push(r));
    const pair = await ack(mobile, 'mobile:pair', { short_code: info.DESKTOP_SHORT_CODE });
    log(`mobile paired (room_match=${pair?.room_uuid === info.DESKTOP_ROOM})`);

    // ── Scenario A: focus race — audio:start drives the lock, then inject ──
    log('--- Scenario A: focus race (audio:start → lock → inject) ---');
    await ack(mobile, 'audio:start', AUDIO_START); // fan-out drives the PC lock
    await sleep(400);
    const startedLock = /audio:start → (SPEAKING lock|no live foreground)/.test(dstderr);
    const reqA = { text: 'FlowMic A 你好 😀', source: 'stt', request_id: 'rq-A', entry_id: 'en-A' };
    mobile.emit('inject:request', reqA);
    await sleep(800);
    await ack(mobile, 'audio:stop', {});
    await sleep(300);
    const rA = results.find((r) => r.request_id === 'rq-A');
    const stoppedMirror = /audio:stop → speak ended/.test(dstderr);
    const procA = rA?.inject_target?.process_name ?? '';
    const allowedA = ALLOWLIST.split(',').some((p) => p.toLowerCase() === procA.toLowerCase());
    const safeA = !!rA && (!rA.ok || allowedA); // injected only ever into Notepad
    log(`A: fan-out lock marker=${startedLock} stop mirror=${stoppedMirror}; inject truth=${JSON.stringify(rA)}`);
    log(`A: ${rA?.ok ? (allowedA ? `INJECTED into sacrificial '${procA}'` : `UNSAFE '${procA}'`) : `DECLINED → ${rA?.mode}/${rA?.error} (safe)`}`);
    verdicts.push(['A fan-out reached PC + drove lock', startedLock && stoppedMirror]);
    verdicts.push(['A injection safe (locked/sacrificial or cached)', safeA]);

    // ── Scenario B: replay dedup — same request_id twice ──
    log('--- Scenario B: replay dedup (same request_id x2) ---');
    const before = results.length;
    const reqB = { text: 'FlowMic B replay 😀', source: 'stt', request_id: 'rq-B', entry_id: 'en-B' };
    mobile.emit('inject:request', reqB);
    await sleep(600);
    mobile.emit('inject:request', reqB); // reconnect-flap replay of the SAME utterance
    await sleep(700);
    const bResults = results.slice(before).filter((r) => r.request_id === 'rq-B');
    const dedupHit = /inject dedup HIT request_id=Some\("rq-B"\)/.test(dstderr);
    const twoAcks = bResults.length === 2;
    const truthIdentical = twoAcks && JSON.stringify(bResults[0]) === JSON.stringify(bResults[1]);
    // When the first frame physically typed (injected), the second MUST be a
    // dedup replay (no re-type) → dedupHit. When cached (no live desktop), both
    // frames re-attempt and are truth-identical (cached is not replay-cached, by
    // design — an untouched utterance gets a fresh attempt).
    const firstOk = bResults[0]?.ok === true;
    const safeB = twoAcks && truthIdentical && (!firstOk || dedupHit);
    log(`B: acks=${bResults.length} identical=${truthIdentical} firstOk=${firstOk} dedupHit=${dedupHit}`);
    log(`B: ack[0]=${JSON.stringify(bResults[0])}`);
    verdicts.push(['B two acks truth-identical', twoAcks && truthIdentical]);
    verdicts.push(['B typed-once (dedup replay when live-injected)', safeB]);
    if (!firstOk) log('B: NOTE — no interactive Notepad foreground here, so both frames are cached (safe); the typed-once REPLAY path is proven by socket::dedup unit tests. Repro on a real desktop with Notepad focused.');

    for (const [name, ok] of verdicts) log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
    const allOk = verdicts.every(([, ok]) => ok);
    log(`R2_1B_SMOKE ${allOk ? 'PASS' : 'FAIL'}`);
    process.exitCode = allOk ? 0 : 1;
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
