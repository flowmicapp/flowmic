#!/usr/bin/env node
// RELAY CONNECT LATENCY PROBE — where the seconds go when a phone opens a cloud session.
//
// ── READ THIS FIRST ─────────────────────────────────────────────────────────
// `flowmic.app` is an ORANGE-CLOUDED Cloudflare hostname. Every anycast metric
// (ping / TCP / TLS / `curl -w time_connect`) measures the distance to the CF
// edge in YOUR city, which is a few milliseconds from everywhere. The relay is
// one machine in New York; a socket.io session has to reach IT. So the same trap
// that `soniox-latency-probe.mjs` documents applies here, with one extra twist
// that is the whole reason this file exists:
//
//   🔴 AN UPGRADED CONNECTION CANNOT BE POOLED. Cloudflare keeps warm keep-alive
//      connections to the origin for ordinary HTTP, but `Connection: Upgrade`
//      needs a dedicated one, so every single WebSocket open pays a FRESH
//      TCP + TLS + upgrade to the origin — three origin round trips — on top of
//      the local edge handshake. socket.io's own `40` connect packet pays a
//      fourth. Those are invisible to every layer-1 tool.
//
// Layers reported, deliberately side by side:
//   L1 EDGE    dns / tcp / tls        — to the local CF colo. Nearly free everywhere.
//   L2 ORIGIN  origin_rtt             — one HTTP round trip through CF to the origin,
//                                       measured on an ALREADY-WARM TLS socket.
//                                       This is the unit everything else is counted in.
//   L3 SESSION upgrade / eio / sio    — what a socket.io connect actually costs.
//
// `origin_rtt` is the ruler. `connect_total / origin_rtt` is the answer: it says
// how many times we pay the ocean before the user can say a word.
//
// Zero dependencies: Node >= 22 (global WebSocket). Nothing is written to the relay:
// the probe connects anonymously (`schema_ver` only, no token), takes its readings and
// disconnects. It does NOT pair, register, join a room, or bill anything.
//
// USAGE
//   node relay-connect-latency-probe.mjs --label=SG --runs=10 --out=sg.jsonl
//   node relay-connect-latency-probe.mjs --url=https://srvjp.flowmic.app --label=SG-to-JP

import { writeFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import os from 'node:os';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`bad argument: ${a}`);
    return [m[1], m[2] ?? 'true'];
  }),
);

const LABEL = argv.label ?? os.hostname();
const RUNS = Number(argv.runs ?? 10);
const BASE = new URL(argv.url ?? 'https://flowmic.app');
const HOST = BASE.hostname;
const PORT = Number(BASE.port || 443);
const SCHEMA_VER = Number(argv['schema-ver'] ?? 2); // packages/protocol PROTOCOL_SCHEMA_VERSION
const HEALTH = argv.health ?? '/api/health';
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, float

function pct(xs, p) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return Math.round(v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))]);
}

// ── L1 + L2: fresh TCP, fresh TLS, then ONE http round trip on the warm socket ──
async function netAndOrigin() {
  const t0 = now();
  const addr = (await dns.lookup(HOST)).address;
  const tDns = now();
  return await new Promise((resolve, reject) => {
    const out = { dns_ms: tDns - t0, ip: addr };
    const sock = net.connect({ host: addr, port: PORT }, () => {
      out.tcp_ms = now() - tDns;
      const tTcp = now();
      const sec = tls.connect(
        { socket: sock, servername: HOST, ALPNProtocols: ['http/1.1'] },
        () => {
          out.tls_ms = now() - tTcp;
          out.tls_version = sec.getProtocol();
          // The origin ruler. Cache-busted so no edge cache can answer it, and sent
          // on a socket whose handshakes are already paid for, so what is left is
          // exactly: edge -> origin -> edge -> here.
          const tReq = now();
          let head = '';
          sec.on('data', (b) => {
            if (out.origin_rtt_ms == null) out.origin_rtt_ms = now() - tReq; // first byte back
            head += b.toString('latin1');
            if (head.includes('\r\n\r\n')) {
              out.cf_ray = /cf-ray:\s*(\S+)/i.exec(head)?.[1] ?? null;
              out.status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? null;
              sec.destroy();
              resolve(out);
            }
          });
          sec.write(
            `GET ${HEALTH}?cb=${Date.now()}${Math.random()} HTTP/1.1\r\nHost: ${HOST}\r\n` +
              `User-Agent: flowmic-relay-probe\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n`,
          );
        },
      );
      sec.on('error', reject);
    });
    sock.on('error', reject);
    sock.setTimeout(20000, () => {
      sock.destroy(new Error('tcp timeout'));
    });
  });
}

// ── L3: the session a phone actually opens ──────────────────────────────────
// socket_core.dart pins `transports: ['websocket']`, so there is no polling
// handshake to measure — the client goes straight to the upgrade, as below.
async function session() {
  const scheme = BASE.protocol === 'http:' ? 'ws' : 'wss';
  const port = PORT === 443 || PORT === 80 ? '' : `:${PORT}`;
  const wsUrl = `${scheme}://${HOST}${port}/socket.io/?EIO=4&transport=websocket`;
  const out = {};
  const t0 = now();
  const ws = new WebSocket(wsUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
      reject(new Error('session timeout'));
    }, 25000);
    let tOpen = 0;
    ws.addEventListener('open', () => {
      // 101 received: fresh TCP + TLS + upgrade, all the way to the origin.
      tOpen = now();
      out.ws_open_ms = tOpen - t0;
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${e?.message ?? 'unknown'}`));
    });
    ws.addEventListener('message', (ev) => {
      const d = String(ev.data ?? '');
      if (d.startsWith('0{') && out.eio_open_ms == null) {
        // engine.io OPEN. Arrives on the same trip as the 101 in practice; if it
        // ever does not, that delta is the origin thinking, not the network.
        out.eio_open_ms = now() - tOpen;
        out._t40 = now();
        ws.send(`40${JSON.stringify({ schema_ver: SCHEMA_VER })}`);
        return;
      }
      if ((d.startsWith('40') || d.startsWith('44')) && out.sio_connect_ms == null) {
        // 40 = namespace admitted, 44 = admitted-then-refused by the auth middleware.
        // BOTH are one full origin round trip; the probe records which, and does not
        // pretend a refusal is a failure of the measurement.
        out.sio_connect_ms = now() - out._t40;
        out.sio_result = d.startsWith('40') ? 'connected' : 'refused';
        out.connect_total_ms = now() - t0;
        delete out._t40;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already gone */ }
        resolve(out);
      }
    });
  });
}

const rows = [];
console.log(`# relay-connect-latency-probe  label=${LABEL}  target=${BASE.origin}  runs=${RUNS}`);
for (let i = 0; i < RUNS; i++) {
  try {
    const a = await netAndOrigin();
    const b = await session();
    // upgrade cost = the 101 minus the handshakes we already priced separately.
    const upgrade = b.ws_open_ms - (a.tcp_ms + a.tls_ms + a.dns_ms);
    const row = {
      label: LABEL, target: BASE.origin, run: i + 1, ...a, ...b, upgrade_ms: upgrade,
      origin_rtt_multiple: a.origin_rtt_ms
        ? Number((b.connect_total_ms / a.origin_rtt_ms).toFixed(2))
        : null,
    };
    rows.push(row);
    console.log(
      `run ${String(i + 1).padStart(2)}  dns ${row.dns_ms.toFixed(0)}  tcp ${row.tcp_ms.toFixed(0)}  tls ${row.tls_ms.toFixed(0)}` +
        `  | origin_rtt ${row.origin_rtt_ms?.toFixed(0)}  | ws_open ${row.ws_open_ms.toFixed(0)} (upgrade ${upgrade.toFixed(0)})` +
        `  eio ${row.eio_open_ms?.toFixed(0)}  sio ${row.sio_connect_ms?.toFixed(0)} [${row.sio_result}]` +
        `  = TOTAL ${row.connect_total_ms.toFixed(0)} ms  (${row.origin_rtt_multiple}x origin RTT)`,
    );
  } catch (e) {
    console.log(`run ${i + 1}  ERROR ${e.message}`);
    rows.push({ label: LABEL, run: i + 1, error: String(e.message) });
  }
  await new Promise((r) => setTimeout(r, 400));
}

const ok = rows.filter((r) => !r.error);
const col = (k) => ok.map((r) => r[k]);
console.log(`\n# p50 (n=${ok.length}/${RUNS})  ${LABEL} -> ${BASE.origin}`);
for (const k of ['dns_ms', 'tcp_ms', 'tls_ms', 'origin_rtt_ms', 'ws_open_ms', 'upgrade_ms', 'eio_open_ms', 'sio_connect_ms', 'connect_total_ms']) {
  console.log(`  ${k.padEnd(18)} p50 ${String(pct(col(k), 0.5)).padStart(5)}   p95 ${String(pct(col(k), 0.95)).padStart(5)}`);
}
const rtt = pct(col('origin_rtt_ms'), 0.5);
const tot = pct(col('connect_total_ms'), 0.5);
if (rtt && tot) {
  console.log(`  => connect costs ${(tot / rtt).toFixed(1)} x one origin round trip (${rtt} ms), i.e. ${tot} ms before the first word can be sent`);
}
console.log(`  cf_ray sample: ${ok[0]?.cf_ray ?? 'n/a'}   tls: ${ok[0]?.tls_version ?? 'n/a'}   status: ${ok[0]?.status ?? 'n/a'}`);
if (argv.out) {
  writeFileSync(argv.out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`  wrote ${argv.out}`);
}
