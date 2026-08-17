// 0.3.0 W1 — SEED PROVENANCE: who wrote this settings row, and who gets to win.
//
// 🔴 THE DEFECT (【measured】 by reading the code, 2026-08-06). Every account is born
// with SEEDED `stt.routings` (zh → LAN FunASR, '*' → LAN SenseVoice) and a seeded
// `llm.config`, written by `seedDefaultSettingsForAllUsers` at every boot for every
// user. Those rows were byte-for-byte indistinguishable from rows the user had
// authored, and both resolvers consult the platform managed default only after the
// user's rows miss ⇒ the user tier never missed ⇒ **the managed-default arm was
// structurally unreachable for every account that had ever booted**. Enabling a
// platform-managed Soniox/DeepSeek would have been a silent no-op: every account
// would have kept routing to the LAN box.
//
// The fix CLASSIFIES (mark the rows we wrote) rather than RE-RANKS (make the
// platform outrank the user). Those are different changes and only the first one
// is allowed — the second is forbidden in writing in three separate files.
//
// SPEC-REF: apps/server-core/src/settings/provenance.ts (the argument in full);
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4; CLAUDE.md anti-façade / one value answers one question.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import {
  buildDefaultSettings,
  seedDefaultSettings,
  seedDefaultSettingsForAllUsers,
  stampSettingProvenance,
} from '../src/settings/defaults';
import {
  PROVENANCE_FIELD, SEED_PROVENANCE,
  isSeedMarked, isSeedUnit, reclassifyUnmarked, stampProvenance,
} from '../src/settings/provenance';
import { selectRoutingWithSource, type Routing } from '../src/stt/engine-router';
import { resolveByok, loadRoutings } from '../src/stt/engine-factory';
import { resolveLlmConfigWithSource, resolveByokLlm, managedLlmConfig } from '../src/compose/llm-config';
import { registerSettingsHandlers } from '../src/socket/handlers/settings.handler';
import type { AuthContext } from '../src/auth/middleware';

const U = 'u1';

// 🔴 OSS-DEFAULTS (0.3.0): this whole file is about a SEEDED `llm.config` row —
// who wrote it and who it loses to. Since the card, the STOCK build seeds no
// `llm.config` at all (defaults.ts LLM_NOT_CONFIGURED), so without these three
// variables every test here would exercise the "not configured" path instead of the
// provenance path, and 16 of them failed exactly that way when the card landed.
//
// The values are the PRE-CARD defaults verbatim. That is the point: the
// provenance mechanism is unchanged, only which preset a bare install starts on
// moved — so pinning the old presets here keeps these tests measuring the thing
// they were written to measure, and it doubles as a live demonstration of the
// deployment escape hatch the owner's boxes use.
const PRESET_ENVS: Record<string, string> = {
  FLOWMIC_DEFAULT_STT_ZH_PRESET: 'lan-funasr-ws',
  FLOWMIC_DEFAULT_STT_WILDCARD_PRESET: 'lan-sensevoice',
  FLOWMIC_DEFAULT_LLM_PRESET: 'lan-vllm-qwen35',
};
const savedPresetEnvs: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(PRESET_ENVS)) {
    savedPresetEnvs[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(PRESET_ENVS)) {
    if (savedPresetEnvs[k] === undefined) delete process.env[k];
    else process.env[k] = savedPresetEnvs[k];
  }
});

function freshDb(): DbConnection {
  return createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('provenance-secret-32-bytes-or-more') });
}
function seededDb(): DbConnection {
  const db = freshDb();
  db.users.insert({ id: U, display_name: 'One', plan: 'free' });
  seedDefaultSettings(db.settings, U);
  return db;
}
function defaults(): { key: string; value: unknown }[] {
  return buildDefaultSettings();
}
/** The platform managed STT default used throughout: a DIFFERENT engine from
 *  anything the seeder writes, so "who answered" is readable off the engine id alone. */
const MANAGED: Routing = { language: '*', engine_id: 'deepgram', api_key: 'sk-platform-account-key-0123456789' };
const managedOn = (): Routing | null => MANAGED;
const managedOff = (): Routing | null => null;

const MANAGED_LLM_ENV = {
  FLOWMIC_MANAGED_LLM_ENABLED: '1',
  FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
  FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
  FLOWMIC_MANAGED_LLM_MODEL: 'deepseek-chat',
  FLOWMIC_MANAGED_LLM_API_KEY: 'sk-platform-account-key-0123456789',
} as NodeJS.ProcessEnv;

describe('the marker itself', () => {
  it('the seeder marks what it writes, and the marker survives the enc:v1: round trip', () => {
    const db = seededDb();
    const rows = db.settings.read(U, 'stt.routings')!.value as Routing[];
    expect(rows).toHaveLength(2);
    expect(rows.every(isSeedMarked)).toBe(true);
    // llm.config's seeded api_key is 'EMPTY' — non-empty, so the repo really does
    // encrypt it at rest and decrypt it on read. If the marker travelled through
    // walkEncrypt/walkDecrypt wrong, the comparison it feeds would be silently
    // broken for exactly the key that matters most.
    const llm = db.settings.read(U, 'llm.config')!.value as Record<string, unknown>;
    expect(isSeedMarked(llm)).toBe(true);
    expect(llm.api_key).toBe('EMPTY');
  });

  it('ABSENCE MEANS USER — an un-backfilled row is nobody-touched-it, not ours', () => {
    // The safe failure direction, asserted rather than asserted-in-a-comment: if
    // the reclassification never runs, every row is `user` and behaviour degrades
    // to what it was before this change (seed rows win, managed unreachable).
    // The opposite convention would hand a stranger's platform engine to a user
    // who had configured their own.
    expect(isSeedMarked({ language: 'zh', engine_id: 'funasr' })).toBe(false);
    expect(isSeedMarked({ [PROVENANCE_FIELD]: 'something-else' })).toBe(false);
    expect(isSeedMarked(null)).toBe(false);
    expect(isSeedMarked([{ [PROVENANCE_FIELD]: SEED_PROVENANCE }])).toBe(false);
  });

  it('classification is by VALUE, so re-serialising a row cannot launder it', () => {
    const d = defaults();
    const [zh] = (d.find((x) => x.key === 'stt.routings')!.value as Routing[]);
    // Same fields, keys in a different order — still ours.
    const reordered = Object.fromEntries(Object.entries(zh!).reverse());
    expect(isSeedUnit('stt.routings', reordered, d)).toBe(true);
    // One field different — no longer ours, and that is the direction that matters:
    // a user edit must never be mistaken for a seed row.
    expect(isSeedUnit('stt.routings', { ...zh, endpoint: 'ws://mine:10095' }, d)).toBe(false);
  });
});

describe('STT resolution order: user → managed → seed', () => {
  function routingsOf(db: DbConnection): Routing[] {
    return loadRoutings(db.settings, U);
  }

  it('a SEED row loses to the managed default when one is enabled', () => {
    const db = seededDb();
    const sel = selectRoutingWithSource('zh', routingsOf(db), managedOn)!;
    expect(sel.source).toBe('managed-default');
    expect(sel.routing.engine_id).toBe('deepgram');
    // Positive control on the fixture: the seeded zh row really is present and
    // really would have answered. Without this,「managed won」could just mean the
    // routings failed to load and everything fell through.
    expect(routingsOf(db).some((r) => r.language === 'zh' && r.engine_id === 'funasr')).toBe(true);
  });

  it('a SEED row WINS when no managed default is configured (the fallback line)', () => {
    // Without this the change would break every self-hosted build and every
    // deployment with FLOWMIC_MANAGED_STT_ENABLED off — i.e. all of them today.
    const db = seededDb();
    const zh = selectRoutingWithSource('zh', routingsOf(db), managedOff)!;
    expect(zh.source).toBe('seed');
    expect(zh.routing.engine_id).toBe('funasr');
    // …and the wildcard still serves a language the seed has no exact row for.
    const en = selectRoutingWithSource('en', routingsOf(db), managedOff)!;
    expect(en.source).toBe('seed');
    expect(en.routing.language).toBe('*');
    expect(en.routing.engine_id).toBe('custom-openai-compatible');
  });

  it('a REAL user row beats the managed default, always — this is the forbidden re-ranking', () => {
    const db = seededDb();
    db.settings.write(U, 'stt.routings', [
      { language: 'zh', engine_id: 'openai-whisper', endpoint: 'https://mine/v1', api_key: 'sk-mine' },
    ]);
    const sel = selectRoutingWithSource('zh', routingsOf(db), managedOn)!;
    expect(sel.source).toBe('user');
    expect(sel.routing.engine_id).toBe('openai-whisper');
  });

  it('a user row and a seed row in the SAME array are judged separately', () => {
    // The per-row marker earning its keep: the user retyped only the zh line, so
    // the managed default may take the wildcard while the user's zh still wins.
    const db = seededDb();
    const stored = db.settings.read(U, 'stt.routings')!.value as Routing[];
    const wildcard = stored.find((r) => r.language === '*')!;
    db.settings.write(U, 'stt.routings', [
      { language: 'zh', engine_id: 'openai-whisper', endpoint: 'https://mine/v1' },
      wildcard, // still byte-identical to the seed ⇒ re-derived as seed on write
    ]);
    const zh = selectRoutingWithSource('zh', routingsOf(db), managedOn)!;
    expect(zh).toMatchObject({ source: 'user', routing: { engine_id: 'openai-whisper' } });
    const en = selectRoutingWithSource('en', routingsOf(db), managedOn)!;
    expect(en).toMatchObject({ source: 'managed-default', routing: { engine_id: 'deepgram' } });
  });

  it('with NO markers anywhere the algorithm is byte-for-byte the old one', () => {
    // Every existing unit test passes hand-built arrays with no markers. This says
    // in one place why none of them had to change, and pins it so a future edit
    // cannot quietly alter the un-backfilled path.
    const rows: Routing[] = [
      { language: 'zh', engine_id: 'funasr' },
      { language: '*', engine_id: 'sherpa-local' },
    ];
    expect(selectRoutingWithSource('zh', rows, managedOn)).toMatchObject({ source: 'user', routing: { engine_id: 'funasr' } });
    expect(selectRoutingWithSource('ko', rows, managedOn)).toMatchObject({ source: 'user', routing: { language: '*' } });
    expect(selectRoutingWithSource('ko', [], managedOn)).toMatchObject({ source: 'managed-default' });
    expect(selectRoutingWithSource('ko', [], managedOff)).toBeNull(); // still no silent fallback
  });

  it('authorship beats specificity ACROSS tiers (the deliberate behaviour change)', () => {
    // A user's「everything uses X」outranks a seeded `zh` line. Before 0.3.0 W1 the
    // seeded zh won on specificity, because the two rows looked the same.
    const seedZh = { ...(defaults().find((d) => d.key === 'stt.routings')!.value as Routing[])[0]! };
    const rows: Routing[] = [
      { ...seedZh, [PROVENANCE_FIELD]: SEED_PROVENANCE } as Routing,
      { language: '*', engine_id: 'deepgram', api_key: 'sk-mine' },
    ];
    const sel = selectRoutingWithSource('zh', rows, managedOff)!;
    expect(sel.source).toBe('user');
    expect(sel.routing.engine_id).toBe('deepgram');
  });
});

describe('BYOK: a seed row is never the user’s key (D5)', () => {
  it('resolveByok answers false for a seed routing — verified, not assumed', () => {
    // `resolveByok` tests `source !== 'user'`, so `'seed'` is covered by the SHAPE
    // of the test rather than by a new branch. That is a claim about code in
    // another file, so it gets an assertion instead of a promise (anti-façade ④).
    // The key is deliberately real-looking: if the judgement ever narrows back to
    // a key-shape test, this line goes red.
    const seedRow = { language: '*', engine_id: 'deepgram', api_key: 'sk-looks-exactly-like-a-user-key' } as Routing;
    expect(resolveByok({ routing: seedRow, source: 'seed' })).toBe(false);
    expect(resolveByok({ routing: seedRow, source: 'user' })).toBe(true); // positive control
    expect(resolveByok({ routing: seedRow, source: 'managed-default' })).toBe(false);
  });

  it('the SEEDED account is not BYOK end to end, on both engines', () => {
    const db = seededDb();
    const stt = selectRoutingWithSource('zh', loadRoutings(db.settings, U), managedOff)!;
    expect(resolveByok(stt)).toBe(false);
    const llm = resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig({} as NodeJS.ProcessEnv));
    expect(llm.source).toBe('seed');
    expect(resolveByokLlm(llm)).toBe(false);
  });

  it('NO BILLING REGRESSION: the answer is unchanged from before the marker existed', () => {
    // The seeded rows were already non-BYOK, via the key-shape arm (funasr has no
    // key, sensevoice has '', vLLM has the 'EMPTY' sentinel). They are still
    // non-BYOK, now via provenance. Same answer, better reason — and the reason is
    // what keeps it right if a seeded preset ever carries a real key.
    const d = defaults();
    const rows = d.find((x) => x.key === 'stt.routings')!.value as Routing[];
    for (const r of rows) {
      expect(resolveByok({ routing: r, source: 'user' })).toBe(false); // the OLD verdict
      expect(resolveByok({ routing: r, source: 'seed' })).toBe(false); // the NEW verdict
    }
  });
});

describe('LLM resolution order', () => {
  it('seed loses to managed, wins when managed is off, and a user row beats both', () => {
    const db = seededDb();
    expect(resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig(MANAGED_LLM_ENV)).source).toBe('managed-default');
    expect(resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig({} as NodeJS.ProcessEnv)).source).toBe('seed');

    db.settings.write(U, 'llm.config', { protocol: 'openai-compatible', endpoint: 'http://mine/v1', api_key: 'sk-mine', model: 'm' });
    const mine = resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig(MANAGED_LLM_ENV));
    expect(mine.source).toBe('user');
    expect(mine.cfg.endpoint).toBe('http://mine/v1');
    expect(resolveByokLlm(mine)).toBe(true);
  });

  it('the marker never reaches the engine config', () => {
    // `validate()` rebuilds the four fields, so provenance cannot leak into an
    // outbound request body. Asserted because「it happens to be dropped」is one
    // refactor away from「it happens to be sent」.
    const db = seededDb();
    const { cfg } = resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig({} as NodeJS.ProcessEnv));
    expect(Object.keys(cfg).sort()).toEqual(['api_key', 'endpoint', 'model', 'protocol']);
  });
});

describe('the boot reclassification (D4)', () => {
  it('backfills a pre-marker database, and only the rows that still match', () => {
    const db = freshDb();
    db.users.insert({ id: U, display_name: 'One', plan: 'free' });
    // Exactly what an existing production database holds: the seeded value with no
    // marker, written by an older build.
    const d = defaults();
    const seedRows = d.find((x) => x.key === 'stt.routings')!.value as Routing[];
    const mine: Routing = { language: 'ja', engine_id: 'openai-realtime', api_key: 'sk-mine' };
    db.settings.write(U, 'stt.routings', [...seedRows, mine]);
    db.settings.write(U, 'llm.config', d.find((x) => x.key === 'llm.config')!.value);

    seedDefaultSettingsForAllUsers(db.settings, db.users);

    const after = db.settings.read(U, 'stt.routings')!.value as Routing[];
    expect(after.filter(isSeedMarked)).toHaveLength(2);
    // The user's row is untouched — same fields, same values, no marker added.
    expect(after[2]).toEqual(mine);
    expect(isSeedMarked(db.settings.read(U, 'llm.config')!.value)).toBe(true);
  });

  it('is idempotent: the second run writes nothing at all', () => {
    const db = freshDb();
    db.users.insert({ id: U, display_name: 'One', plan: 'free' });
    const d = defaults();
    db.settings.write(U, 'stt.routings', d.find((x) => x.key === 'stt.routings')!.value);
    db.settings.write(U, 'llm.config', d.find((x) => x.key === 'llm.config')!.value);

    const first = seedDefaultSettingsForAllUsers(db.settings, db.users);
    expect(first).toEqual([{ userId: U, keys: ['stt.routings', 'llm.config'] }]);
    const before = db.settings.read(U, 'stt.routings')!.updated_at;

    // Second boot: nothing to do, and「nothing to do」means no write — proven by
    // updated_at, which a rewrite-with-itself would still bump.
    expect(seedDefaultSettingsForAllUsers(db.settings, db.users)).toEqual([]);
    expect(db.settings.read(U, 'stt.routings')!.updated_at).toBe(before);
  });

  it('leaves a NON-matching row byte-identical, including key order', () => {
    const db = freshDb();
    db.users.insert({ id: U, display_name: 'One', plan: 'free' });
    const mine = [{ engine_id: 'deepgram', language: 'en', endpoint: 'wss://mine', api_key: 'sk-mine' }];
    db.settings.write(U, 'stt.routings', mine);

    seedDefaultSettingsForAllUsers(db.settings, db.users);

    const after = db.settings.read(U, 'stt.routings')!.value;
    expect(JSON.stringify(after)).toBe(JSON.stringify(mine)); // key order too
  });

  it('NEVER strips a marker — a row seeded by an OLDER default stays ours', () => {
    // The failure this guards: promoting a platform-authored row to `user` would
    // make it outrank the managed default and, if it ever carried a key, be judged
    // BYOK. A stale seed row is still a seed row.
    const stale = [{ language: 'zh', engine_id: 'funasr', endpoint: 'ws://an-old-host:10095', [PROVENANCE_FIELD]: SEED_PROVENANCE }];
    expect(reclassifyUnmarked('stt.routings', stale, defaults())).toBeNull();
    expect(isSeedMarked(stale[0])).toBe(true);
  });

  it('ignores keys it has no opinion about', () => {
    expect(reclassifyUnmarked('stt.polish', { enabled: true }, defaults())).toBeNull();
    expect(stampProvenance('stt.polish', { enabled: true, provenance: 'seed' }, defaults()))
      .toEqual({ enabled: true, provenance: 'seed' }); // untouched, not scrubbed
  });
});

describe('D3 — a client cannot forge the marker', () => {
  it('stampSettingProvenance re-derives it: forged `seed` on a user row comes back `user`', () => {
    const forged = [{ language: 'zh', engine_id: 'deepgram', api_key: 'sk-mine', [PROVENANCE_FIELD]: SEED_PROVENANCE }];
    const out = stampSettingProvenance('stt.routings', forged) as Routing[];
    expect(isSeedMarked(out[0])).toBe(false);
    expect(out[0]).toEqual({ language: 'zh', engine_id: 'deepgram', api_key: 'sk-mine' });
  });

  it('…and stripping the marker off a row that IS the seed does not promote it', () => {
    // The forgery runs both ways. A client that deletes the marker must not be able
    // to turn our row into「the user's choice」and thereby block the managed default.
    const d = defaults();
    const bare = (d.find((x) => x.key === 'stt.routings')!.value as Routing[]).map((r) => ({ ...r }));
    const out = stampSettingProvenance('stt.routings', bare) as Routing[];
    expect(out.every(isSeedMarked)).toBe(true);
  });

  it('WIRED: the socket settings:update path re-derives, and tells peers what was STORED', async () => {
    // The unit test above proves the function. This proves the WIRING — the defect
    // class this repo keeps re-learning is a correct function nobody calls.
    const db = seededDb();
    const emitted: { event: string; payload: unknown }[] = [];
    const peer = {
      id: 'peer', data: { auth: { userId: U, kind: 'pc' } as AuthContext },
      emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
    };
    const io = { sockets: { sockets: new Map<string, unknown>([['peer', peer]]) } } as unknown as Server;

    const handlers = new Map<string, (p: unknown, ack: unknown) => void>();
    const origin = {
      id: 'origin', data: { auth: { userId: U, kind: 'pc' } as AuthContext },
      on(event: string, fn: (p: unknown, ack: unknown) => void) { handlers.set(event, fn); return this; },
      emit() { /* origin gets the ack, not a broadcast */ },
    };
    registerSettingsHandlers(origin as unknown as Socket, { io, repo: db.settings });

    const forged = [{ language: 'zh', engine_id: 'deepgram', api_key: 'sk-mine', [PROVENANCE_FIELD]: SEED_PROVENANCE }];
    const ack = await new Promise<Record<string, unknown>>((resolve) => {
      handlers.get('settings:update')!({ key: 'stt.routings', value: forged }, resolve as unknown);
    });
    expect(ack).toEqual({ ok: true });

    const stored = db.settings.read(U, 'stt.routings')!.value as Routing[];
    expect(stored.some(isSeedMarked)).toBe(false);
    // …so the managed default no longer defers to it: this is a real user row now.
    expect(selectRoutingWithSource('zh', stored, managedOn)!.source).toBe('user');
    // The peer was told the stored value, not the submitted one — otherwise a
    // second PC would hold a copy that differs from the database by the marker.
    //
    // 🔴 G2 CHANGED THIS ASSERTION'S SHAPE ON PURPOSE (04 §3.7-a). The broadcast
    // now also carries `updated_at`, so the old strict `toEqual` — which said
    // 「these two keys and NOTHING else」 — was encoding the promise we have just
    // replaced. It is widened rather than loosened: the stamp is asserted to be
    // the one the DATABASE holds, which keeps the sentence above true for the
    // stamp as well as the value. A peer that heard a different time than the one
    // stored would be exactly the divergence this test was written to forbid.
    const storedAt = db.settings.read(U, 'stt.routings')!.updated_at;
    expect(emitted).toEqual([
      { event: 'settings:updated', payload: { key: 'stt.routings', value: stored, updated_at: storedAt } },
    ]);
  });
});

// ── the reverse control lives in the suite, not in a transcript ──────────────
// Every assertion above is positive: it says what the new order IS. The one that
// says what it is NOT is「a SEED row loses to the managed default」— and the way to
// know it can fail is to have watched it fail. It was watched (0.3.0 W1 report):
// putting the seed tier back above the managed tier in selectRoutingWithSource
// turns it, and three others here, red. A negative assertion nobody has seen fail
// is not evidence — CLAUDE.md "a reverse control only counts if it has actually gone red".

let saved: string | undefined;
beforeEach(() => { saved = process.env.FLOWMIC_MANAGED_STT_ENABLED; delete process.env.FLOWMIC_MANAGED_STT_ENABLED; });
afterEach(() => { if (saved === undefined) delete process.env.FLOWMIC_MANAGED_STT_ENABLED; else process.env.FLOWMIC_MANAGED_STT_ENABLED = saved; });
