// Companion to probe_large_frame.dart: boots a THROWAWAY 0.2.11 server (the
// exact published portable bundle) + a PC socket, then runs the Dart mobile
// probe against it. Zero contact with the owner's live session or DBs.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
const scRequire = createRequire(path.join(ROOT, 'apps', 'server-core', 'package.json'));
const { io: ioClient } = scRequire('socket.io-client');

const TMP = tmpdir();
for (const n of [200000, 800000, 1600000, 3200000, 3900000, 5600000, 9000000]) {
  const f = path.join(TMP, `pcgot-${n}`);
  if (existsSync(f)) rmSync(f);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['publish/FlowMic-portable/resources/server.js', '--mode', 'standalone', '--port', '0'], {
      cwd: ROOT,
      env: { ...process.env, FLOWMIC_MODE: 'standalone', FLOWMIC_PORT: '0', FLOWMIC_SETTINGS_SECRET: 'probe-secret-32-bytes-minimum-xxxx' },
    });
    let out = '';
    const onData = (d) => {
      out += d;
      const m = /listening[^\n]*"port":(\d+)/.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => reject(new Error(`no port: ${out.slice(0, 500)}`)), 15000);
  });
}

const { child, port } = await startServer();
const url = `http://127.0.0.1:${port}`;
const pc = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
await new Promise((r) => pc.on('connect', r));
const reg = await new Promise((r) => pc.emit('pc:register', { device_name: 'Dart Probe PC', client_instance_id: 'inst-dartprobe-00001' }, r));
console.log(`[node] server ${url}  short_code=${reg.short_code}`);

pc.on('inject:request', (p) => {
  const len = (p.image_b64 || '').length;
  writeFileSync(path.join(TMP, `pcgot-${len}`), 'x');
  console.log(`[node] PC got inject:request len=${len.toLocaleString()}`);
});

const dart = spawn('dart', ['run', 'tool/probe_large_frame.dart', url, reg.short_code], {
  cwd: path.join(ROOT, 'apps', 'mobile'),
  shell: true,
});
dart.stdout.on('data', (d) => process.stdout.write(d));
dart.stderr.on('data', (d) => process.stdout.write(d));
dart.on('exit', (code) => {
  console.log(`[node] dart probe exited ${code}`);
  pc.close();
  child.kill();
  process.exit(0);
});
