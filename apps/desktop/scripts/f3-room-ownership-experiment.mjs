// EXPERIMENT (A) for card F-3 — orchestrator.
//
// THE QUESTION. When a second desktop session registers with the SAME device
// token, does the server route the room's frames to the NEW session (leaving the
// incumbent orphaned in the slot) or keep them on the OLD one?
//
// WHY IT IS BEING ASKED AT ALL. docs/strategy/2026-08-07-w9-legacy-fixes-and-oss-ledger.md
// section 4.1-bis: F-3's mechanism half is settled from vendored rust_socketio
// source, but the room-ownership half is 【未验】. The previous investigation
// inferred the answer from 500 ms beat PHASE — a correlation standing in for
// object identity — and withdrew its own recommendation when challenged. The
// ruling is 【未验】, not 【已否决】. This program is what settles it, and it
// settles it by asking WHICH OBJECT moved, never when.
//
//   1. start server-core (standalone, ephemeral port) — a REAL socket.io server
//   2. spawn examples/f3_room_ownership, which builds TWO DesktopSocket values in
//      one process against the SAME credential file, so the second one sends
//      pc:reconnect{token} — the frame the F-3 zombie sends
//   3. wait for its BOTH_READY barrier. This is load-bearing: a pc:reconnect ack
//      carries a connectedMobiles roster that ALSO writes mobile_count, so a phone
//      that joined before B handshook would move B's counter for a reason that has
//      nothing to do with routing
//   4. drive a simulated mobile: mobile:pair against A's short code
//   5. read which session's connected_mobiles() moves
//
// ⚠️ SIM-MOBILE CAVEAT (verify/golden/run-golden.mjs's header, same rule): the
// "phone" here is a socket.io script. That is fine for this question — the subject
// is the SERVER's routing and the DESKTOP's two sockets, and the phone only has to
// occupy the room. Nothing here says anything about what the Dart app emits.
//
// POSITIVE CONTROL, and why the negative reading is not self-certifying: "session
// B did not move" and "the instrument saw nothing at all" look identical. So a run
// only produces a VERDICT when the pairing acked AND exactly one counter moved.
// Neither moving is reported as INCONCLUSIVE — an instrument failure, not an
// answer about the fork.
//
// IT MUST BE ABLE TO FAIL. F3_EXPECT=first|last turns the measurement into an
// assertion and exits non-zero when the run disagrees. Run it against the wrong
// branch and it goes red; that is how this harness was shown not to be a rubber
// stamp before its reading was believed.
//
// AND THE NULL READING MUST BE FALSIFIABLE TOO. F3_BREAK_PAIRING=1 pairs against a
// deliberately wrong short code. The phone then never enters the room, and the run
// must report INSTRUMENT — not "session B did not move", which is the sentence a
// dead probe and a real negative would otherwise share. Measured, not assumed.
//
// 🔴 THIS IS DELIBERATELY NOT WIRED INTO `pnpm golden` / `verify:delivery`, and the
// reason is a law this repo paid for (0.2.52 item 3): a control pointed the wrong
// way does not miss a defect, it WRITES THE DEFECT INTO THE SPEC and then goes red
// on the day the fix arrives, making the fix look like the regression. The branch
// this measures today is the DEFECT. Wiring it as `F3_EXPECT=last` would pin
// "the zombie steals the room" as an acceptance criterion. When F-3's server-side
// half (Fix#2 / card F-3-b, W4S district — pc.handler.ts consuming joinPc's
// `previous`) lands, THAT card flips the expectation to `first` and may wire it
// then. Until then this is a runnable experiment, not a gate.
//
// Requires: `pnpm -F @flowmic/server-core build` and, in apps/desktop/src-tauri,
//   `cargo build --example f3_room_ownership`
// Run:  node apps/desktop/scripts/f3-room-ownership-experiment.mjs
//       (add F3_EXPECT=last to assert the last registrant owns the room)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SERVER_DIR = resolve(REPO, 'apps', 'server-core');
const requireFromServer = createRequire(resolve(SERVER_DIR, 'package.json'));
const { io: ioClient } = requireFromServer('socket.io-client');

const EXE =
  process.env.F3_EXE ||
  resolve(REPO, 'apps', 'desktop', 'src-tauri', 'target', 'debug', 'examples', 'f3_room_ownership.exe');
const EXPECT = process.env.F3_EXPECT || ''; // '', 'first' or 'last'
const log = (...a) => console.log('[f3]', ...a);

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
    setTimeout(() => rej(new Error('server start timeout')), 8000);
  });
}

/// Spawn the two-session program and resolve at its BOTH_READY barrier. Every
/// line it prints is echoed, and the KEY=VALUE ones are collected; `readings` keeps
/// the MOBILES timeline so the verdict can be re-derived from the raw log.
function startDesktop(url) {
  return new Promise((res, rej) => {
    const child = spawn(EXE, [], {
      env: { ...process.env, FLOWMIC_SERVER_URL: url, F3_OBSERVE_SECS: '20' },
    });
    const info = {};
    const readings = [];
    let buf = '';
    let barrier = false;
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        log('desktop>', line);
        const kv = /^([A-Z_]+)=(.*)$/.exec(line);
        if (kv) info[kv[1]] = kv[2];
        const m = /^(?:MOBILES|FINAL) a=(\d+) b=(\d+)/.exec(line);
        if (m) readings.push({ a: Number(m[1]), b: Number(m[2]), raw: line });
        if (line === 'BOTH_READY') {
          barrier = true;
          res({ child, info, readings });
        }
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[desktop] ${d}`));
    child.on('exit', (c) => {
      if (!barrier) rej(new Error(`desktop exited before BOTH_READY (${c})`));
    });
    setTimeout(() => rej(new Error('BOTH_READY timeout')), 30000);
  });
}

function connect(url) {
  const socket = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  return new Promise((res, rej) => {
    socket.on('connect', () => res(socket));
    socket.on('connect_error', rej);
    setTimeout(() => rej(new Error('mobile connect timeout')), 5000);
  });
}
const ack = (s, ev, p) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${ev} ack timeout`)), 6000);
    s.emit(ev, p, (r) => {
      clearTimeout(t);
      res(r);
    });
  });

/// Wait until a reading shows one of the counters non-zero, or give up.
function waitForMove(readings, ms) {
  const deadline = Date.now() + ms;
  return new Promise((res) => {
    const tick = () => {
      const hit = readings.find((r) => r.a > 0 || r.b > 0);
      if (hit) return res(hit);
      if (Date.now() > deadline) return res(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function main() {
  const { child: server, port } = await startServer();
  const url = `http://127.0.0.1:${port}`;
  log(`server up on ${url}`);
  let desktop, mobile;
  let verdict = 'INCONCLUSIVE';
  let detail = '';
  try {
    const started = await startDesktop(url);
    desktop = started.child;
    const { info, readings } = started;
    log(`A pc_id=${info.A_PC_ID} room=${info.A_ROOM} short_code=${info.A_SHORT_CODE}`);
    log(`B pc_id=${info.B_PC_ID} (same token, so it sent pc:reconnect)`);

    // POSITIVE CONTROL #1 — the phone really is in the room. Without this a
    // silent pairing failure reads as "neither session owns it".
    mobile = await connect(url);
    // F3_BREAK_PAIRING is the self-test of THIS control: with a wrong code the
    // phone never enters the room, and the run must come out INSTRUMENT rather
    // than reporting a branch it did not observe.
    const code = process.env.F3_BREAK_PAIRING ? '0000' : info.A_SHORT_CODE;
    const pair = await ack(mobile, 'mobile:pair', { short_code: code });
    const paired = !pair?.error && pair?.room_uuid === info.A_ROOM;
    log(`mobile:pair ack ${JSON.stringify(pair)}`);
    if (!paired) {
      detail = `pairing did not put the phone in A's room (ack=${JSON.stringify(pair)})`;
      throw new Error(`INSTRUMENT: ${detail}`);
    }

    // POSITIVE CONTROL #2 — one of the two counters must actually move.
    const moved = await waitForMove(readings, 12000);
    if (!moved) {
      verdict = 'INCONCLUSIVE';
      detail =
        'neither session observed the join. That is an instrument failure, not a ' +
        'reading about the fork: the phone paired, so a presence frame was owed to ' +
        'SOMEBODY and this harness saw it reach nobody.';
    } else if (moved.a > 0 && moved.b > 0) {
      verdict = 'INCONCLUSIVE';
      detail = `both counters moved (${moved.raw}) — the room is not exclusive, which is a THIRD branch neither side of the fork predicted`;
    } else if (moved.a > 0) {
      verdict = 'FIRST';
      detail = `session A (the incumbent, registered first) observed the join; B did not — ${moved.raw}`;
    } else {
      verdict = 'LAST';
      detail = `session B (the challenger, registered last) observed the join; A did not — ${moved.raw}`;
    }
  } catch (e) {
    detail = detail || e.message;
    if (!detail.startsWith('INSTRUMENT')) detail = `INSTRUMENT: ${detail}`;
  } finally {
    try { mobile && mobile.disconnect(); } catch {}
    try { desktop && desktop.kill(); } catch {}
    try { server.kill(); } catch {}
  }

  console.log('');
  console.log('════════════════ F-3 EXPERIMENT (A) — ROOM OWNERSHIP ════════════════');
  console.log(`  BRANCH MEASURED : ${verdict}`);
  console.log(`  EVIDENCE        : ${detail}`);
  console.log('  BASIS           : which DesktopSocket object\'s connected_mobiles()');
  console.log('                    moved. Not phase, not order, not timing.');
  if (EXPECT) {
    const want = EXPECT.toUpperCase();
    const okExpect = verdict === want;
    console.log(`  ASSERTED        : ${want}  →  ${okExpect ? 'PASS' : 'FAIL'}`);
    console.log('═════════════════════════════════════════════════════════════════════');
    process.exit(okExpect ? 0 : 1);
  }
  console.log('  (no F3_EXPECT set — measured only, nothing asserted)');
  console.log('═════════════════════════════════════════════════════════════════════');
  process.exit(verdict === 'INCONCLUSIVE' ? 2 : 0);
}

main().catch((e) => {
  console.error('[f3] harness error', e);
  process.exit(3);
});
