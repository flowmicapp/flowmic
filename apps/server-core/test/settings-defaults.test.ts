// owner 2026-07-27 — "set flowmic.app's default STT and LLM services to use
// 10.0.0.68 and 10.0.0.179 by default" + "after connecting directly to the cloud, the phone can
// transcribe and record normally".
//
// Two defects, one file:
//   ① the defaults resolved from presets pointed at 100.64.7.x — the owner's
//      OFFICE LAN, which the flowmic.app VPS has never been able to reach.
//      A deployment now declares its own route to the SAME machines.
//   ② seeding ran for the STANDALONE user only, so every REGISTERED saas
//      account had no stt.routings and no llm.config at all. The mechanism
//      existed and never ran for the users who needed it — the façade class
//      CLAUDE.md calls this project's #1 historical bug.
//
// SPEC-REF: docs/decisions/2026-07-23-lan-model-defaults.md (referenced by preset id,
//   the implementation side adds no hardcoded IP); CLAUDE.md anti-façade / no silent failure.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import {
  buildDefaultSettings,
  seedDefaultSettings,
  seedDefaultSettingsForAllUsers,
  LLM_HOST_ENV,
  STT_HOST_ENV,
  LLM_PRESET_ENV,
  STT_ZH_PRESET_ENV,
  STT_WILDCARD_PRESET_ENV,
} from '../src/settings/defaults';
import { requireEndpoint, type SttEngineError } from '../src/stt/engines/base';

function freshDb(): DbConnection {
  return createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('settings-defaults-secret-32-bytes') });
}

interface Routing { language: string; engine_id: string; endpoint?: string }
function routings(): Routing[] {
  return buildDefaultSettings().find((d) => d.key === 'stt.routings')!.value as Routing[];
}
function llm(): { endpoint: string; model: string; protocol: string } {
  return buildDefaultSettings().find((d) => d.key === 'llm.config')!.value as { endpoint: string; model: string; protocol: string };
}

/**
 * 🔴 OSS-DEFAULTS (0.3.0) — WHY THESE THREE ARE SET FOR MOST OF THIS FILE.
 *
 * The old defaults (`lan-funasr-ws` / `lan-sensevoice` / `lan-vllm-qwen35`) are
 * no longer what a bare process seeds; they are now what a DEPLOYMENT names. Two
 * different questions live in this file and they need opposite setups:
 *
 *   · 「a deployment can still point the seeds at its own boxes, and the host
 *      override still rewrites ONLY the host」 — describes ① and ②, which set
 *      these three so they keep measuring the mechanism they were written for;
 *   · 「a stranger who sets nothing gets nobody's LAN」 — describe ⓪, which
 *      DELETES them and is the new behaviour this card exists to pin.
 *
 * ⓪ is deliberately first in the file even though it is the newer of the two:
 * it is the one that answers 「what does the shipped product do」.
 */
const LEGACY_PRESETS: Record<string, string> = {
  [STT_ZH_PRESET_ENV]: 'lan-funasr-ws',
  [STT_WILDCARD_PRESET_ENV]: 'lan-sensevoice',
  [LLM_PRESET_ENV]: 'lan-vllm-qwen35',
};
const ALL_ENVS = [STT_HOST_ENV, LLM_HOST_ENV, ...Object.keys(LEGACY_PRESETS)];

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ALL_ENVS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(LEGACY_PRESETS)) process.env[k] = v;
});
afterEach(() => {
  for (const k of ALL_ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Clear the preset selection so the process is a STOCK install. */
function stockInstall(): void {
  for (const k of Object.keys(LEGACY_PRESETS)) delete process.env[k];
}

describe('⓪ OSS-DEFAULTS: what a stranger who configures nothing gets', () => {
  it('seeds the BUILT-IN offline engine for both languages, with no endpoint at all', () => {
    stockInstall();
    const rs = routings();
    expect(rs.map((r) => r.language)).toEqual(['zh', '*']);
    for (const r of rs) {
      expect(r.engine_id).toBe('sherpa-local');
      // 🔴 Not 「endpoint is empty」 — the KEY IS ABSENT. An empty string is an
      // address as far as `fetch`/`new URL` are concerned, and it is precisely
      // the shape `requireEndpoint` in stt/engines/base.ts exists to refuse.
      expect(r).not.toHaveProperty('endpoint');
    }
  });

  it('seeds NO llm.config at all — "no config" is an absent row, not a sentinel row', () => {
    stockInstall();
    const keys = buildDefaultSettings().map((d) => d.key);
    expect(keys).toEqual(['stt.routings']);
    expect(keys).not.toContain('llm.config');
  });

  it("the whole seeded payload contains neither private range — the card's acceptance criterion", () => {
    stockInstall();
    const blob = JSON.stringify(buildDefaultSettings());
    // Asserted on the SERIALIZED payload rather than field by field: a field
    // list only catches the addresses somebody remembered to look at, and the
    // point of this assertion is the ones nobody thought of.
    expect(blob).not.toMatch(/172\.77\.77\./);
    expect(blob).not.toMatch(/192\.168\.188\./);
  });

  it('the seeded routing carries no endpoint, and an engine handed one refuses BY NAME', () => {
    // 🔴 THE TWO HALVES OF THIS CARD, COMPOSED. Face 1 made the seed endpoint-less;
    // face 2 deleted the four `DEFAULT_ENDPOINT` constants that used to fill that
    // gap with 100.64.7.68. Each half is pinned in its own file, and neither
    // proves the thing that actually matters: that the gap is now answered by a
    // SENTENCE rather than by a connection to somebody's office.
    //
    // `requireEndpoint` is the single decision point all four engines call, so
    // asserting on it here is asserting on the real production path — not on a
    // re-implementation of it.
    stockInstall();
    const wild = routings().find((r) => r.language === '*')!;
    expect(wild.endpoint).toBeUndefined();

    let thrown: SttEngineError | undefined;
    try {
      requireEndpoint('custom-openai-compatible', wild.endpoint);
    } catch (e) {
      thrown = e as SttEngineError;
    }
    expect(thrown?.code).toBe('STT_CONFIG_MISSING');
    // Retrying cannot make a config key appear, so the refusal must not invite one.
    expect(thrown?.retryable).toBe(false);
    // Both halves the operator needs: WHICH engine, and WHICH key is empty.
    expect(thrown?.message).toContain('custom-openai-compatible');
    expect(thrown?.message).toContain('stt.routings[].endpoint');
  });

  it("a HOST override with no PRESET named THROWS — it does not silently do nothing", () => {
    // The failure this refuses: an operator sets FLOWMIC_DEFAULT_STT_HOST,
    // gets no error, and spends the afternoon wondering why the engine box he
    // configured is idle. The seeded preset runs in-process and has no endpoint
    // for that host to be substituted into, so there is nothing to apply.
    stockInstall();
    process.env[STT_HOST_ENV] = '10.0.0.68';
    expect(() => buildDefaultSettings()).toThrow(/has no endpoint to override/);
    expect(() => buildDefaultSettings()).toThrow(new RegExp(STT_ZH_PRESET_ENV));
  });

  it('the SAME refusal for the LLM host — it was the untested half, and it was silent', () => {
    // 🔴 REGRESSION, and it was the exact shape the card claimed to remove.
    // `llmConfigFromPreset` is the only caller of `hostOverride(…, LLM_HOST_ENV, …)`,
    // and it does not run when no LLM preset is named. So a deployment that set
    // FLOWMIC_DEFAULT_LLM_HOST and forgot FLOWMIC_DEFAULT_LLM_PRESET had its
    // address read by NOTHING — no throw, no log, no row.
    //
    // ⚠️ ONLY the LLM host is set here, on purpose. With STT_HOST_ENV also set the
    // STT throw fires first and this test would pass without the fix — it would be
    // measuring the other branch's refusal and reporting it as this one's.
    stockInstall();
    // 🔴 ONE LITERAL, USED TWICE, AND THAT IS LOAD-BEARING — NOT A TIDINESS EDIT.
    // The public export rewrites this address by PLAIN STRING substitution
    // (scripts/opensource-manifest.mjs REDACTIONS). A regex spelling of it —
    // `/192\.168\.188\.179/` — contains no such substring, so it would ride out of
    // the redaction pass UNTOUCHED while the assignment above it was rewritten,
    // and this test would fail in the exported tree for a reason invisible here.
    // verify/lint/no-lan-ip.mjs records the same trap about its own RANGES.
    // A bare literal moves with the tree; `toThrow(string)` is a substring match.
    const llmHost = '10.0.0.179';
    process.env[LLM_HOST_ENV] = llmHost;
    expect(() => buildDefaultSettings()).toThrow(new RegExp(LLM_HOST_ENV));
    expect(() => buildDefaultSettings()).toThrow(new RegExp(LLM_PRESET_ENV));
    // Names the value it found, so the operator can see WHICH address was dropped.
    expect(() => buildDefaultSettings()).toThrow(llmHost);
  });

  it('…and that refusal does NOT fire when the LLM host is simply unset', () => {
    // The positive control for the assertion above. Without it, a throw wired to
    // fire unconditionally in the stock branch would pass the test above and break
    // every stranger's first boot — the loudest possible version of this bug.
    stockInstall();
    expect(() => buildDefaultSettings()).not.toThrow();
    expect(buildDefaultSettings().map((d) => d.key)).toEqual(['stt.routings']);
  });

  it('an unknown preset id names the env var that supplied it', () => {
    stockInstall();
    process.env[LLM_PRESET_ENV] = 'no-such-preset';
    expect(() => buildDefaultSettings()).toThrow(/unknown LLM preset 'no-such-preset'/);
    expect(() => buildDefaultSettings()).toThrow(new RegExp(LLM_PRESET_ENV));
  });
});

describe("⓪-bis the owner's deployment is byte-identical to before the card", () => {
  // 🔴 THE CONSTRAINT, MEASURED RATHER THAN ASSERTED. The card's rule is that a
  // machine with the FLOWMIC_DEFAULT_* variables set must behave EXACTLY as it
  // did. These are the literal values the old code produced, transcribed from
  // the pre-card assertions further down this file — so if the seed shape ever
  // drifts, this goes red on the owner's behalf rather than on a stranger's.
  it('preset selection alone reproduces the old LAN seeds verbatim', () => {
    // beforeEach already set exactly the three preset variables and no hosts.
    const zh = routings().find((r) => r.language === 'zh')!;
    const wild = routings().find((r) => r.language === '*')!;
    expect(zh).toEqual({ language: 'zh', engine_id: 'funasr', endpoint: 'ws://100.64.7.68:10095' });
    expect(wild).toEqual({
      language: '*',
      engine_id: 'custom-openai-compatible',
      endpoint: 'http://100.64.7.68:50000/v1',
      model: 'SenseVoiceSmall',
      api_key: '',
    });
    expect(llm()).toEqual({
      protocol: 'openai-compatible',
      endpoint: 'http://100.64.7.179:8000/v1',
      api_key: 'EMPTY',
      model: '/mnt/nvme-data/vllm-work/models/Qwen3.5-4B',
    });
  });

  it('with the VPS host overrides on top, the flowmic.app values are unchanged too', () => {
    process.env[STT_HOST_ENV] = '10.0.0.68';
    process.env[LLM_HOST_ENV] = '10.0.0.179';
    expect(routings().find((r) => r.language === 'zh')!.endpoint).toBe('ws://10.0.0.68:10095/');
    expect(routings().find((r) => r.language === '*')!.endpoint).toBe('http://10.0.0.68:50000/v1');
    expect(llm().endpoint).toBe('http://10.0.0.179:8000/v1');
  });
});

describe('① deployment host override', () => {
  it('with the presets named and no host env, the presets are used verbatim', () => {
    const zh = routings().find((r) => r.language === 'zh')!;
    expect(zh.endpoint).toBe('ws://100.64.7.68:10095');
    expect(llm().endpoint).toBe('http://100.64.7.179:8000/v1');
  });

  it('rewrites ONLY the host — scheme, port and path survive', () => {
    process.env[STT_HOST_ENV] = '10.0.0.68';
    process.env[LLM_HOST_ENV] = '10.0.0.179';
    const zh = routings().find((r) => r.language === 'zh')!;
    const wild = routings().find((r) => r.language === '*')!;
    // ws:// and the FunASR port are the engine's contract, not the deployment's
    // choice — a deployment that could change the port could silently point
    // 「FunASR」 at something that is not FunASR.
    expect(zh.endpoint).toBe('ws://10.0.0.68:10095/');
    expect(wild.endpoint).toBe('http://10.0.0.68:50000/v1');
    const l = llm();
    expect(l.endpoint).toBe('http://10.0.0.179:8000/v1');
    expect(l.model).toBe('/mnt/nvme-data/vllm-work/models/Qwen3.5-4B');
    expect(l.protocol).toBe('openai-compatible');
  });

  it('the two hosts are independent (STT box ≠ LLM box)', () => {
    process.env[STT_HOST_ENV] = '10.0.0.1';
    const zh = routings().find((r) => r.language === 'zh')!;
    expect(zh.endpoint).toContain('10.0.0.1');
    expect(llm().endpoint).toContain('100.64.7.179'); // untouched
  });

  it('a nonsense host THROWS at boot rather than seeding an unreachable default', () => {
    // The whole point: flowmic.app spent a release with every routing
    // pointing somewhere it could not reach, and nothing said a word.
    process.env[STT_HOST_ENV] = 'not a host';
    expect(() => buildDefaultSettings()).toThrow(/not a valid host/);
  });

  it('an empty/whitespace env value means「not configured」, not「blank host」', () => {
    process.env[STT_HOST_ENV] = '   ';
    expect(routings().find((r) => r.language === 'zh')!.endpoint).toBe('ws://100.64.7.68:10095');
  });
});

describe('② seeding reaches every account, not just the standalone user', () => {
  it('seeds each user once and is idempotent across restarts', () => {
    const db = freshDb();
    db.users.insert({ id: 'u1', display_name: 'One', plan: 'free' });
    db.users.insert({ id: 'u2', display_name: 'Two', plan: 'free' });

    const first = seedDefaultSettingsForAllUsers(db.settings, db.users);
    expect(first.map((r) => r.userId).sort()).toEqual(['u1', 'u2']);
    expect(first[0]!.keys.sort()).toEqual(['llm.config', 'stt.routings']);
    for (const u of ['u1', 'u2']) {
      expect(db.settings.read(u, 'stt.routings')).not.toBeNull();
      expect(db.settings.read(u, 'llm.config')).not.toBeNull();
    }

    // A second boot writes nothing — an already-seeded account is left alone.
    expect(seedDefaultSettingsForAllUsers(db.settings, db.users)).toEqual([]);
  });

  it('never overwrites what the user configured (save-as-you-edit edits win)', () => {
    const db = freshDb();
    db.users.insert({ id: 'u1', display_name: 'One', plan: 'free' });
    const mine = [{ language: 'en', engine_id: 'deepgram', endpoint: 'wss://mine' }];
    db.settings.write('u1', 'stt.routings', mine);

    const written = seedDefaultSettingsForAllUsers(db.settings, db.users);
    // Only the MISSING key was seeded…
    expect(written).toEqual([{ userId: 'u1', keys: ['llm.config'] }]);
    // …and the user's own routings survived untouched.
    expect(db.settings.read('u1', 'stt.routings')!.value).toEqual(mine);
  });

  it('backfills an account that predates the call (the flowmic.app case)', () => {
    const db = freshDb();
    // Exactly the shape found on the VPS: one unrelated settings row and no
    // engine configuration whatsoever.
    db.users.insert({ id: 'owner', email: 'o@b.co', display_name: 'Owner', plan: 'free' });
    db.settings.write('owner', 'stt.polish', { enabled: true });
    expect(db.settings.read('owner', 'stt.routings')).toBeNull();

    seedDefaultSettingsForAllUsers(db.settings, db.users);
    const seeded = db.settings.read('owner', 'stt.routings')!.value as Routing[];
    expect(seeded).toHaveLength(2);
    expect(db.settings.read('owner', 'stt.polish')!.value).toEqual({ enabled: true });
  });

  it('seedDefaultSettings for one user still behaves (the standalone path)', () => {
    const db = freshDb();
    db.users.insert({ id: 'default', display_name: 'Local User', plan: 'free' });
    expect(seedDefaultSettings(db.settings, 'default').sort()).toEqual(['llm.config', 'stt.routings']);
    expect(seedDefaultSettings(db.settings, 'default')).toEqual([]);
  });
});
