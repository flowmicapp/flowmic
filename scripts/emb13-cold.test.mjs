import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { instrument } from './emb13-wv7.mjs';
import { coldConfig } from './emb13-cold-lib.mjs';
import { resolveWv7Config } from './emb13-wv7-acceptance.mjs';

test('RIG4 scene selection enables touch, retains gesture and rejects incompatible or unknown scenes', () => {
  const config = (scenario, extra = {}) => resolveWv7Config({ FLOWMIC_EMB13_WV7_SCENARIO: scenario, ...extra }, []);
  assert.equal(config('cold-first-word-touch').cold.touch, true);
  assert.equal(config('cold-first-word-touch', { FLOWMIC_EMB13_GESTURE: 'hold' }).cold.gesture, 'hold');
  assert.equal(config('second-press').cold.secondPress, true);
  assert.equal(config('cold-first-word').cold.secondPress, false);
  assert.equal(config('quiet-release').cold.quietPauseMs, 250);
  assert.equal(config('quiet-release', { FLOWMIC_EMB13_QUIET_PAUSE_MS: '600' }).cold.quietPauseMs, 600);
  assert.throws(() => config('quiet-release', { FLOWMIC_EMB13_QUIET_PAUSE_MS: '300' }));
  assert.throws(() => config('second-press', { FLOWMIC_EMB13_GESTURE: 'hold' }));
  assert.throws(() => config('unknown-cold'));
});

test('RIG3 actual interception delays entry/runtime/room once; HEAD and unrelated resources stay immediate', async () => {
  let routeHandler;
  const ctx = { addInitScript: async () => {}, route: async (_pattern, cb) => { routeHandler = cb; } };
  const rows = await instrument(ctx, { ...coldConfig({}), entryMs: 8, runtimeMs: 9, roomMs: 10 });
  for (const [path, method, delay] of [['/go/demo-card/v1.js', 'GET', 8], ['/go/integrator/runtime.hash.js', 'GET', 9], ['/api/web/rooms', 'POST', 10], ['/go/demo-card/v1.js', 'HEAD', null], ['/site.js', 'GET', null]]) {
    let fetched = false, fulfilled = false, continued = false;
    await routeHandler({ request: () => ({ url: () => `http://127.0.0.1:9000${path}`, method: () => method }),
      fetch: async () => { fetched = true; return 'untouched-response'; },
      fulfill: async (data) => { fulfilled = true; assert.equal(data.response, 'untouched-response'); },
      continue: async () => { continued = true; } });
    assert.equal(fetched, delay !== null); assert.equal(fulfilled, delay !== null); assert.equal(continued, delay === null);
    if (delay !== null) { assert.equal(rows.at(-1).delayMs, delay); assert.ok(rows.at(-1).delivered - rows.at(-1).requested >= delay - 1); }
  }
  let body, blocked = false;
  await routeHandler({ request: () => ({ url: () => 'https://challenges.cloudflare.com/turnstile/v0/api.js' }), fulfill: async (r) => { body = r.body; } });
  let timer, callback = false;
  const window = { __wv7: { marks: [] } };
  runInNewContext(body, { window, performance: { now: () => 0 }, setTimeout(fn, ms) { timer = { fn, ms }; } });
  window.turnstile.render(null, { callback() { callback = true; } });
  assert.equal(timer.ms, 8000); assert.equal(callback, false); timer.fn(); assert.equal(callback, true);
  await routeHandler({ request: () => ({ url: () => 'https://vendor.example/transcribe' }), abort: async () => { blocked = true; } });
  assert.equal(blocked, true);
});

test('RIG3 join interception delays actual pair packet without modifying bytes', async () => {
  let socketHandler, outgoing;
  const sent = [];
  const ctx = { addInitScript: async () => {}, route: async () => {}, routeWebSocket: async (_pattern, cb) => { socketHandler = cb; } };
  const rows = await instrument(ctx, { ...coldConfig({}), joinMs: 8 });
  socketHandler({ connectToServer: () => ({ send: (m) => sent.push(m) }), onMessage: (cb) => { outgoing = cb; } });
  const pair = '421["mobile:pair",{"fixture":true}]';
  outgoing('2'); assert.deepEqual(sent, ['2']); outgoing(pair); assert.deepEqual(sent, ['2']);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['2', pair]); assert.equal(rows[0].kind, 'join'); assert.equal(rows[0].delayMs, 8);
  const reconnect = '422["mobile:reconnect",{"fixture":true}]';
  outgoing(reconnect); assert.deepEqual(sent, ['2', pair]);
  await new Promise((r) => setTimeout(r, 20)); assert.deepEqual(sent, ['2', pair, reconnect]);
  assert.equal(rows.length, 2);
});

test('RIG3 fake adapter opt-in cannot select an unrelated scene or fall through to managed STT', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FLOWMIC_')));
  const run = (extra) => spawnSync(process.execPath, ['scripts/emb13-live-rig.mjs'], { env: { ...env, ...extra }, encoding: 'utf8' });
  const wrongScene = run({ FLOWMIC_EMB13_LIVE: '1', FLOWMIC_EMB13_FAKE_STT: '1', FLOWMIC_EMB13_WV7: '1', FLOWMIC_EMB13_WV7_SCENARIO: 'budget' });
  assert.equal(wrongScene.status, 1); assert.match(wrongScene.stderr, /FAKE_STT supports only/);
  for (const scene of ['cold-first-word', 'cold-first-word-touch', 'second-press', 'quiet-release']) {
    const missingFake = run({ FLOWMIC_EMB13_LIVE: '1', FLOWMIC_EMB13_WV7: '1', FLOWMIC_EMB13_WV7_SCENARIO: scene });
    assert.equal(missingFake.status, 1); assert.match(missingFake.stderr, /requires FLOWMIC_EMB13_FAKE_STT=1/);
  }
});
