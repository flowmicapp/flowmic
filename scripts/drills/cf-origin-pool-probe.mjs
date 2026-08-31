#!/usr/bin/env node
// CF ORIGIN POOL PROBE — is Cloudflare's connection to our origin warm or cold?
//
// WHY THIS EXISTS. `relay-connect-latency-probe.mjs` measured, from Tokyo, a 495 ms
// round trip for one plain `GET /api/health` through the edge — three times the
// 162 ms that the same box pays for one socket.io round trip once the session is
// open. Three times is exactly TCP + TLS + request, i.e. Cloudflare had NO warm
// connection to the origin and built one for that request. But there is a second
// explanation for the same number, and it is OUR OWN FAULT rather than CF's: the
// first probe sent `Connection: close`, which can make the edge tear the origin
// connection down after each request and leave the pool cold for the next one.
//
// 🔴 SO THIS PROBE MEASURES THE RULER. It opens ONE TLS connection to the edge and
// sends N keep-alive requests down it, printing each one's time to first byte:
//   · first high, rest low   => the pool warms up. The 495 ms was a COLD START and
//                               a busy relay would rarely pay it.
//   · all of them high       => the edge is opening a fresh origin connection every
//                               time. Then every API call from Asia costs 3 crossings,
//                               and that is a property of our traffic volume, not a
//                               property of this probe.
// Either way the WebSocket number stands, because an upgrade can never be pooled.
//
// Zero dependencies. Node >= 18.

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
const BASE = new URL(argv.url ?? 'https://flowmic.app');
const PATHS = (argv.paths ?? '/api/health').split(',');
const N = Number(argv.n ?? 5);
const SOCKETS = Number(argv.sockets ?? 2); // repeat on a second fresh TLS conn
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

async function once(bust) {
  const addr = (await dns.lookup(BASE.hostname)).address;
  return await new Promise((resolve, reject) => {
    const rows = [];
    const sock = net.connect({ host: addr, port: 443 }, () => {
      const sec = tls.connect(
        { socket: sock, servername: BASE.hostname, ALPNProtocols: ['http/1.1'] },
        async () => {
          for (let i = 0; i < N; i++) {
            const p = PATHS[i % PATHS.length];
            const url = bust ? `${p}${p.includes('?') ? '&' : '?'}cb=${Date.now()}_${i}` : p;
            const t = now();
            let buf = '';
            const row = await new Promise((res) => {
              const onData = (b) => {
                if (row0.ttfb == null) row0.ttfb = now() - t;
                buf += b.toString('latin1');
                const hEnd = buf.indexOf('\r\n\r\n');
                if (hEnd < 0) return;
                const head = buf.slice(0, hEnd);
                const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
                if (buf.length - (hEnd + 4) >= len) {
                  sec.off('data', onData);
                  res({
                    path: url.split('?')[0],
                    ttfb: Math.round(row0.ttfb),
                    status: /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? '?',
                    ray: /cf-ray:\s*(\S+)/i.exec(head)?.[1] ?? null,
                    cache: /cf-cache-status:\s*(\S+)/i.exec(head)?.[1] ?? null,
                  });
                }
              };
              const row0 = { ttfb: null };
              sec.on('data', onData);
              sec.write(
                `GET ${url} HTTP/1.1\r\nHost: ${BASE.hostname}\r\n` +
                  `User-Agent: flowmic-pool-probe\r\nConnection: keep-alive\r\n\r\n`,
              );
            });
            rows.push(row);
          }
          sec.destroy();
          resolve(rows);
        },
      );
      sec.on('error', reject);
    });
    sock.on('error', reject);
    sock.setTimeout(20000, () => sock.destroy(new Error('timeout')));
  });
}

console.log(`# cf-origin-pool-probe  label=${LABEL}  target=${BASE.origin}  paths=${PATHS.join(',')}  keep-alive, ${N} requests x ${SOCKETS} sockets`);
for (let s = 0; s < SOCKETS; s++) {
  const bust = s === 0; // socket 1 cache-busted, socket 2 plain — so a cached answer is visible
  const rows = await once(bust);
  console.log(`socket ${s + 1} (${bust ? 'cache-busted' : 'plain URL'}):`);
  rows.forEach((r, i) =>
    console.log(`   #${i + 1} ${String(r.ttfb).padStart(5)} ms   ${r.status}  ${r.path}  cf-cache=${r.cache}  ray=${r.ray}`),
  );
  await new Promise((r) => setTimeout(r, 300));
}
