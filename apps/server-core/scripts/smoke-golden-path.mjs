// Golden-path smoke: spawns the built server (standalone, ephemeral port),
// drives a real socket.io client through cold-start → pc:register → short code →
// mobile:pair → settings:update/list → PC disconnect → pc:reconnect, and prints
// each step. Run: node scripts/smoke-golden-path.mjs (after `pnpm build`).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { io as ioClient } from 'socket.io-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function startServer() {
  return new Promise((resolveFn, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: ROOT,
      env: { ...process.env, FLOWMIC_MODE: 'standalone', FLOWMIC_PORT: '0', FLOWMIC_SETTINGS_SECRET: 'smoke-secret-32-bytes-minimum-xx' },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m) resolveFn({ child, port: Number(m[1]) });
    });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });
}

function connect(url, auth = {}) {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  return new Promise((res, rej) => {
    socket.on('connect', () => res(socket));
    socket.on('connect_error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 3000);
  });
}

function ack(socket, event, payload) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (r) => {
      clearTimeout(t);
      res(r);
    });
  });
}

function once(socket, event) {
  return new Promise((res) => socket.once(event, res));
}

const log = (step, data) => console.log(`  ${step.padEnd(28)} ${JSON.stringify(data)}`);

async function main() {
  const { child, port } = await startServer();
  const url = `http://localhost:${port}`;
  console.log(`[golden-path] server up on ${url}`);
  try {
    const pc = await connect(url);
    const reg = await ack(pc, 'pc:register', { device_name: 'Smoke PC', client_instance_id: 'inst-smoke0123456789' });
    log('pc:register →', { token: `${reg.token.slice(0, 10)}…`, short_code: reg.short_code, room_uuid: `${reg.room_uuid.slice(0, 8)}…` });

    const mobile = await connect(url);
    const joinedP = once(pc, 'pc:mobile-joined');
    const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code });
    log('mobile:pair →', { pairing_id: `${pair.pairing_id.slice(0, 8)}…`, pc_online: pair.pc_online, room_match: pair.room_uuid === reg.room_uuid });
    const joined = await joinedP;
    log('pc got pc:mobile-joined', { mobile_id: joined.mobile_id === pair.pairing_id });

    const updatedOnPc = once(pc, 'settings:updated');
    const upd = await ack(mobile, 'settings:update', { key: 'stt.polish', value: true });
    log('settings:update →', upd);
    log('pc got settings:updated', await updatedOnPc);

    const list = await ack(mobile, 'settings:list', {});
    log('settings:list keys →', list.items.map((i) => i.key));

    pc.disconnect();
    const pc2 = await connect(url, { token: reg.token });
    const recon = await ack(pc2, 'pc:reconnect', { token: reg.token });
    log('pc:reconnect →', { room_match: recon.room_uuid === reg.room_uuid, pc_match: recon.pc_id === reg.pc_id });

    console.log('[golden-path] PASS');
    pc2.disconnect();
    mobile.disconnect();
  } finally {
    child.kill();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[golden-path] FAIL', err.message);
    process.exit(1);
  },
);
