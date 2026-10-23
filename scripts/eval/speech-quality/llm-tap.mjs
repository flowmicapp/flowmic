// scripts/eval/speech-quality/llm-tap.mjs — a local recording proxy between a
// LOCAL eval relay and the LLM vendor (card PRE-0.3.111).
//
// The relay's polish call is the only place the raw STT text of a final is
// visible without a product change: the user message of the request IS the text
// the relay asked the model to correct, and the streamed answer is the model's
// candidate before the guard. run-relay.mjs `--llm-tap` points
// FLOWMIC_MANAGED_LLM_ENDPOINT of its relays at this proxy and stores, per
// utterance, every exchange that happened during it.
//
// It forwards bytes unchanged (headers, body, SSE stream) and only reads a copy.
// The Authorization header is passed through and never recorded.
//
// NOT A GATE. Listens on 127.0.0.1 only.

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

/** The copy we read is decoded; the bytes forwarded to the relay are not touched. */
function decode(buf, enc) {
  try {
    if (enc === 'gzip') return gunzipSync(buf);
    if (enc === 'br') return brotliDecompressSync(buf);
    if (enc === 'deflate') return inflateSync(buf);
  } catch { /* undecodable: keep raw */ }
  return buf;
}

/** Content of an OpenAI-compatible SSE stream (or a plain JSON answer). */
function assemble(body) {
  const txt = body.toString('utf8');
  if (!/^\s*data:/m.test(txt)) {
    try { const j = JSON.parse(txt); return j?.choices?.[0]?.message?.content ?? null; } catch { return null; }
  }
  let out = '';
  for (const line of txt.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || m[1].trim() === '[DONE]') continue;
    try { const j = JSON.parse(m[1]); out += j?.choices?.[0]?.delta?.content ?? ''; } catch { /* partial frame */ }
  }
  return out;
}

/** INC-1: the token usage the vendor reported (last frame carrying it), or null. */
function usageOf(body) {
  const txt = body.toString('utf8');
  const last = (re) => { let v = null; for (const m of txt.matchAll(re)) v = Number(m[1]); return v; };
  const tin = last(/"prompt_tokens":\s*(\d+)/g);
  if (tin === null) return null;
  return { in: tin, out: last(/"completion_tokens":\s*(\d+)/g) ?? 0, cached: last(/"prompt_cache_hit_tokens":\s*(\d+)/g) };
}

export async function startLlmTap({ upstream }) {
  const up = new URL(upstream.replace(/\/+$/, ''));
  const records = [];
  const server = createServer((req, res) => {
    const t0 = performance.now();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reqBody = Buffer.concat(chunks);
      const path = up.pathname + req.url.replace(/^\/v1/, '');
      const headers = { ...req.headers, host: up.host, 'content-length': String(reqBody.length) };
      const fwd = httpsRequest({ protocol: up.protocol, hostname: up.hostname, port: up.port || 443, path, method: req.method, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        const rc = [];
        ur.on('data', (c) => { rc.push(c); res.write(c); });
        ur.on('end', () => {
          res.end();
          let messages = [];
          try { messages = JSON.parse(reqBody.toString('utf8'))?.messages ?? []; } catch { /* not JSON */ }
          const sys = messages.filter((m) => m.role === 'system').map((m) => String(m.content ?? '')).join('\n');
          const users = messages.filter((m) => m.role !== 'system');
          records.push({
            t0, t1: performance.now(), status: ur.statusCode,
            system_sha: sys ? createHash('sha256').update(sys).digest('hex').slice(0, 12) : null,
            system_head: sys.slice(0, 80),
            smooth: /Remove fillers/.test(sys),
            n_messages: messages.length,
            user: users.length ? String(users[users.length - 1].content ?? '') : null,
            output: assemble(decode(Buffer.concat(rc), String(ur.headers['content-encoding'] ?? '').trim())),
            usage: usageOf(decode(Buffer.concat(rc), String(ur.headers['content-encoding'] ?? '').trim())),
          });
        });
      });
      fwd.on('error', (e) => { records.push({ t0, t1: performance.now(), status: 0, error: String(e) }); try { res.writeHead(502); res.end(); } catch { /* closed */ } });
      fwd.end(reqBody);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    between: (a, b) => records.filter((r) => r.t0 >= a && r.t0 <= b).map((r) => ({ ...r, t0: Math.round(r.t0 - a), t1: Math.round(r.t1 - a) })),
    stop: () => new Promise((r) => server.close(r)),
  };
}
