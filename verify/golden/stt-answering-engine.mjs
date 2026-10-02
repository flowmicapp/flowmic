// A LOCAL TRANSCRIPTION ENGINE THAT ANSWERS — for the golden cases whose subject is METERING a recording.
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.10 (NR-138 item 5, owner ruling 2026-10-01: a session that
//     ends on an engine failure with no usable transcript is NOT charged)
//   apps/server-core/src/stt/engines/custom-openai-compatible.ts (the batch adapter: POST <api>/audio/transcriptions,
//     reads `{ text }` from a JSON body)
//
// 🔴 WHY THIS EXISTS. G24, G26, G30, G31 and G34 assert that a recording moves a ledger (budget pushes, payer
// branches, the demo cap, the integrator sub-quota). They used to point their pool at a CLOSED PORT
// (`http://127.0.0.1:9/v1`): `open()` resolves without the network, the session runs and is metered, and the engine
// only fails at the closing flush — a shortcut that was harmless while every session was billed whatever it ended
// in. Under §4.10 that flush failure is exactly the case the owner ruled must NOT be charged, so those cases would
// assert a debit the product now (correctly) refuses to make. Their subject was never "an engine that fails"; it is
// "a recording that was transcribed and must be billed to the right account". So they get an engine that answers.
//
// ⚠️ The cases that are ABOUT an unreachable engine (G32 reads only the relay's own clock) keep the closed port.
// G35, whose subject IS the failure, uses this engine with its own id switched to answer 503 (`setEngineFailing`),
// so its positive control can run on the same relay, account and engine.
//
// Module-level, started once per process at import, `unref`'d so it never holds a run open. Loopback only.
//
// 🔴 ONE ROUTE PER CASE ID (`/k/<id>/v1`). The pool cases run CONCURRENTLY in this one process
// (scenario-schedule.mjs, group 'pool'), so G35's switch that makes its engine fail must not be a global one:
// a global switch would make G24's or G30's recording fail mid-run, i.e. one case's fixture deciding another
// case's verdict. Each id has its own failing flag and its own request count.

import { createServer } from 'node:http';

/** What every answered recording says. Content is irrelevant to the cases; non-empty is the point. */
export const ANSWERED_TEXT = 'golden transcript';

/** Ids whose engine currently answers 503 (`custom-openai-compatible` maps that to STT_ENGINE_TIMEOUT). */
const failing = new Set();
/** Transcription requests received, per id — a case's proof that its engine was actually asked. */
const requests = new Map();

const ROUTE = /^\/k\/([^/]+)\/v1\/audio\/transcriptions$/;

const engine = await new Promise((resolve) => {
  const srv = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const m = req.method === 'POST' ? ROUTE.exec(req.url ?? '') : null;
      if (!m) {
        res.writeHead(404);
        res.end();
        return;
      }
      const id = decodeURIComponent(m[1]);
      requests.set(id, (requests.get(id) ?? 0) + 1);
      if (failing.has(id)) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'golden engine told to fail' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: ANSWERED_TEXT }));
    });
  });
  srv.listen(0, '127.0.0.1', () => { srv.unref(); resolve({ srv, port: srv.address().port }); });
});

/** A `FLOWMIC_STT_POOL` value whose one route is this engine, under its own id. */
export function answeringPool(id) {
  return JSON.stringify([{
    id, provider: 'custom-openai-compatible', model: id,
    api: `http://127.0.0.1:${engine.port}/k/${encodeURIComponent(id)}/v1`, api_key: id, enabled: true, priority: 1,
  }]);
}

/** Make [id]'s engine answer 503 from now on (true) or answer again (false). Affects that id only. */
export function setEngineFailing(id, on) {
  if (on) failing.add(id);
  else failing.delete(id);
}

/** How many transcription requests [id]'s engine has received. */
export function engineRequests(id) {
  return requests.get(id) ?? 0;
}
