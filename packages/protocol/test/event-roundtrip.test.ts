import { describe, it, expect } from 'vitest';
import { EVENT_NAMES, type EventName } from '../src/events';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';

// A well-formed and an ill-formed sample for EVERY whitelisted event. The
// well-formed one MUST parse; the ill-formed one MUST be rejected. Several
// invalid cases double as rename-window guards (audio:start mode 'draft',
// control:key kind 'escape', timeline:push wrong enc prefix, …).

const TOKEN = 'a'.repeat(32);
const INSTANCE = 'b'.repeat(16);

const validHistoryItem = {
  id: 'h1',
  pairing_id: null,
  pc_device_id: 'pc1',
  user_id: 'u1',
  mobile_id: null,
  mode: 'realtime',
  source_text: null,
  source_lang: null,
  output_text: 'hello world',
  output_lang: null,
  duration_ms: null,
  segments_count: 0,
  status: 'injected',
  created_at: '2026-07-23T00:00:00.000Z',
  updated_at: '2026-07-23T00:00:00.000Z',
};

const validBlob = {
  id: 'e1',
  seq: 0,
  ciphertext: 'e2e:v1:AAAABBBBCCCC',
  created_at: 1_700_000_000,
  schema_ver: 1,
};

interface Fixture {
  valid: unknown;
  invalid: unknown;
}

const FIXTURES: Record<EventName, Fixture> = {
  // §3.1 auth / pairing
  'pc:register': { valid: { device_name: 'My PC' }, invalid: { device_name: '' } },
  'pc:reconnect': { valid: { token: TOKEN, client_instance_id: INSTANCE }, invalid: { token: 'short' } },
  'pc:refresh-code': { valid: {}, invalid: null },
  // GA-08: the additive `revoke` flag rides the SAME payload (see the dedicated
  // release-mobile-revoke.test.ts for the two-meanings contract).
  'pc:release-mobile': { valid: { mobile_id: 'm1', revoke: true }, invalid: 42 },
  'pc:list-mobiles': { valid: {}, invalid: null },
  'pc:mobile-joined': { valid: { mobile_id: 'm1', mobile_name: 'Pixel' }, invalid: { mobile_id: 'm1' } },
  'pc:mobile-left': { valid: { mobile_id: 'm1' }, invalid: {} },
  'mobile:pair': { valid: { short_code: '1234' }, invalid: { short_code: '12' } },
  'mobile:reconnect': { valid: { token: TOKEN }, invalid: { token: 'short' } },
  // v0.2.3 — an empty object; the token on the SOCKET says which pairing. `null`
  // is the invalid case for the same reason mobile:list-pcs uses it: an empty
  // schema still refuses a non-object.
  'mobile:unpair': { valid: {}, invalid: null },
  'mobile:list-pcs': { valid: {}, invalid: null },
  'mobile:login': { valid: { email: 'a@b.com', password: 'pw' }, invalid: { email: 'not-an-email', password: 'pw' } },
  'mobile:logout': { valid: {}, invalid: null },
  'auth:expired': { valid: {}, invalid: null },

  // §3.2 heartbeat / liveness (RENAMED sys:ping / sys:pong)
  'heartbeat': { valid: { ts: 1_700_000_000 }, invalid: { ts: 1.5 } },
  'sys:ping': { valid: { nonce: 'abc' }, invalid: {} },
  'sys:pong': { valid: { nonce: 'abc', ok: true }, invalid: { nonce: 'abc' } },

  // §3.3 audio / STT
  'audio:start': {
    valid: { sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh-CN' },
    // mode 'draft' was deleted in the rename window — must be rejected.
    invalid: { sample_rate: 16_000, channels: 1, encoding: 'pcm_s16le', mode: 'draft', source_lang: 'zh-CN' },
  },
  'audio:chunk': { valid: { seq: 0, data_b64: 'AAAA', ts_ms: 1000 }, invalid: { seq: -1, data_b64: 'AAAA', ts_ms: 1000 } },
  'audio:pause': { valid: { reason: 'background' }, invalid: {} },
  'audio:resume': { valid: {}, invalid: null },
  'audio:stop': { valid: {}, invalid: null },
  'audio:auto-stopped': { valid: { reason: 'hard_limit' }, invalid: { reason: 'other' } },
  'stt:interim': { valid: { text: 'hi', confidence: 0.9, language: 'zh-CN', segment_idx: 0 }, invalid: { text: 'hi', confidence: 1.5, language: 'zh-CN', segment_idx: 0 } },
  'stt:final': {
    valid: { text: 'hi', confidence: 0.9, language: 'zh-CN', segment_idx: 0, is_segment: false, duration_ms: 1200 },
    invalid: { text: 'hi', confidence: 0.9, language: 'zh-CN', segment_idx: 0, duration_ms: 1200 },
  },
  'stt:error': { valid: { code: 'STT_ENGINE_TIMEOUT', message: 'timeout', retryable: true }, invalid: { code: 'STT_ENGINE_TIMEOUT', message: 'timeout' } },
  'stt:engine-status': { valid: { provider: 'funasr', status: 'ready' }, invalid: { provider: 'funasr', status: 'dead' } },
  'stt:level': { valid: { amplitude_db: -30 }, invalid: { amplitude_db: 'loud' } },
  // GA-14: correlated by request_id (A-58), no FSM meaning. A confidence outside
  // 0..1 is refused rather than clamped — an invented number is worse than none.
  'stt:refined': { valid: { text: '第二遍的更好版本', request_id: 'utt-1', confidence: 0.93 }, invalid: { text: 'x', confidence: 1.5 } },

  // §3.4 LLM / compose
  'compose:start': { valid: { task: 'translate', source_text: 'hello' }, invalid: { task: 'summarize', source_text: 'hello' } },
  'compose:chunk': { valid: { delta: 'a' }, invalid: {} },
  'compose:done': { valid: { output_text: 'done' }, invalid: {} },
  'compose:error': { valid: { code: 'LLM_TIMEOUT', message: 'timeout' }, invalid: { code: 'LLM_TIMEOUT' } },

  // §3.5 inject / control (RENAMED control:key)
  'inject:request': { valid: { text: 'hi', source: 'stt' }, invalid: { text: 'hi', source: 'unknown' } },
  'inject:result': { valid: { ok: true, mode: 'sendinput' }, invalid: { ok: true, mode: 'paste' } },
  'focus:state': { valid: { window_title: 'Notepad', process_name: 'notepad' }, invalid: { window_title: 'Notepad' } },
  // kind 'escape' is outside the locked whitelist — must be rejected.
  'control:key': { valid: { kind: 'enter' }, invalid: { kind: 'escape' } },

  // §3.6 history sync
  'history:list': { valid: { limit: 50 }, invalid: { limit: 0 } },
  'history:list-result': { valid: { items: [validHistoryItem], has_more: false }, invalid: { items: [validHistoryItem], has_more: 'no' } },
  'history:create': { valid: { item: validHistoryItem }, invalid: { item: {} } },
  'history:update': { valid: { id: 'h1', output_text: 'x' }, invalid: { id: 'h1' } },
  'history:updated': { valid: { item: validHistoryItem }, invalid: { item: {} } },
  'history:delete': { valid: { id: 'h1' }, invalid: {} },
  'history:deleted': { valid: { id: 'h1' }, invalid: {} },
  'history:inject': { valid: { id: 'h1' }, invalid: {} },

  // §3.7 settings sync
  'settings:list': { valid: {}, invalid: null },
  'settings:update': { valid: { key: 'stt.routings', value: [] }, invalid: { key: '', value: [] } },
  'settings:updated': { valid: { key: 'stt.routings', value: [] }, invalid: { value: [] } },

  // §3.8 timeline sync
  // wrong prefix (enc:v1: instead of e2e:v1:) must be rejected — the double-
  // prefix redline guard.
  'timeline:push': { valid: { entries: [validBlob] }, invalid: { entries: [{ ...validBlob, ciphertext: 'enc:v1:AAAA' }] } },
  'timeline:pull': { valid: { since_seq: 0, limit: 100 }, invalid: { limit: 0 } },
  'timeline:pull-result': { valid: { blobs: [validBlob], next_seq: 1 }, invalid: { blobs: [validBlob], next_seq: -1 } },
  'timeline:tombstone': { valid: { ids: ['e1'] }, invalid: { ids: [''] } },
  // GRANT-1: gid/origin (request) and gid/expires_at_ms (grant) are zod-OPTIONAL
  // additive fields — a fixture WITH them must parse (this pins the addition),
  // and the pre-GRANT-1 minimal frames must keep parsing (the handlers, not zod,
  // refuse frames missing them — design §3.1「缺字段＝畸形」at the handler).
  'timeline:grant-request': { valid: { web_pubkey: 'pk', session_fingerprint: 'fp', gid: 'g-1', origin: 'https://app.flowmic.app' }, invalid: { web_pubkey: 'pk' } },
  'timeline:grant': { valid: { wrap: 'e2e:v1:AAAA', gid: 'g-1', expires_at_ms: 1_754_900_000_000 }, invalid: { wrap: 'plaintext' } },
};

describe('every event schema round-trips', () => {
  it('has a fixture for every whitelisted event (completeness guard)', () => {
    const fixtured = Object.keys(FIXTURES).sort();
    expect(fixtured).toEqual([...EVENT_NAMES].sort());
  });

  for (const name of EVENT_NAMES) {
    it(`${name}: accepts a valid payload`, () => {
      const r = safeParseEvent(name, FIXTURES[name].valid);
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
    });

    it(`${name}: rejects an invalid payload`, () => {
      const r = EVENT_SCHEMAS[name].safeParse(FIXTURES[name].invalid);
      expect(r.success).toBe(false);
    });
  }
});

describe('GRANT-1 additivity: the pre-GRANT-1 minimal grant frames still parse', () => {
  // The four new fields are OPTIONAL at zod so the schema change is purely
  // additive; refusing their absence is the HANDLERS' job (design §3.1). This
  // pin fails the day someone「tightens」them to required at the schema — which
  // would move the refusal to the zod boundary, where it is anonymous.
  it('timeline:grant-request without gid/origin parses (handler refuses it, zod does not)', () => {
    expect(safeParseEvent('timeline:grant-request', { web_pubkey: 'pk', session_fingerprint: 'fp' }).success).toBe(true);
  });
  it('timeline:grant without gid/expires_at_ms parses (handler refuses it, zod does not)', () => {
    expect(safeParseEvent('timeline:grant', { wrap: 'e2e:v1:AAAA' }).success).toBe(true);
  });
});
