// POST /api/stt/model/delete — NR-7 (owner ruling 2026-09-02 §5:
// 「删除前提示大小、当前在用模型不许删」).
//
// Three properties are pinned here and each one is a decision a different layer
// makes, so each is driven through the layer that owns it:
//
//   · THE GUARD IS THE SERVER'S. `stt-model-routes.ts` [MODEL_DELETE_GUARD]
//     refuses an in-use pack BEFORE anything touches the filesystem. The card
//     also disables the button, and that is why the assertion below checks the
//     FILES and not only the status code: a guard that answers 409 after the
//     removal has already run looks identical from the code alone.
//   · 「IN USE」 IS THE §6 LADDER, NOT THE SELECTION FILE. `model-in-use.ts`
//     [MODEL_IN_USE_LADDER] is exercised against the REAL resolver with a
//     synthetic catalog — the same seam `model-resolve.ts` documents, for the
//     same reason (the real rows pin gigabytes of byte-correct files).
//   · CONTAINMENT. `model-delete.ts` [MODEL_DELETE_CONTAINMENT] — a resolved
//     directory outside the models root is refused, which is what keeps the
//     `FLOWMIC_SHERPA_MODEL_DIR` debug staging directory (frequently outside
//     the root, frequently holding other work) out of reach of a recursive
//     remove.
//
// ── 🔴 NEGATIVE CONTROL, ACTUALLY RUN ───────────────────────────────────────
// See the block comment above the in-use case below for the verbatim readings.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId } from '../src/http/account-auth';
import { LOCAL_ONLY_ERROR } from '../src/http/local-only';
import { STT_MODEL_DELETE_PATH } from '../src/http/stt-model-routes';
import { SENSE_VOICE_MODEL_ID, type CatalogModel } from '../src/stt/sherpa/model-catalog';
import {
  getModelController, resetSherpaModelControllers,
} from '../src/stt/sherpa/model-downloader';
import { assertInsideModelsRoot, dirSizeBytes } from '../src/stt/sherpa/model-delete';
import { modelsInUse, type InUseReason } from '../src/stt/sherpa/model-in-use';
import { readModelSelection, writeModelSelection } from '../src/stt/sherpa/model-selection';

afterEach(() => {
  resetSherpaModelControllers();
  vi.restoreAllMocks();
});

const LOOPBACK = '127.0.0.1';
const LAN_PEER = '10.0.0.44';

/** A staged pack's single file. Small, and its bytes are the only figure any
 *  assertion below compares against — no case reads a declared manifest total,
 *  because the whole point of `disk_bytes` is that it is MEASURED. */
const PACK_BODY = Buffer.alloc(4_096, 7);

/** NR-49 — a SECOND catalog pack claiming zh+en, so a case can prove the clear
 *  is keyed on the deleted model id rather than on 「every language this pack
 *  claims」 or 「the whole file」. */
const OTHER_ZH_EN_MODEL_ID = 'sherpa-onnx-zipformer-zh-en-2023-11-22';

interface Staged {
  env: NodeJS.ProcessEnv;
  root: string;
  dir: string;
}

/** A temp APPDATA (both vars — on the public repo's POSIX runners APPDATA alone
 *  falls through to the runner's real ~/.local/share, see model-catalog.test.ts)
 *  with one pack's directory populated under the real models root layout, so
 *  `resolveModelsRoot`/`resolveModelDir` land inside it without a path seam. */
function stage(modelId: string, extra: Record<string, Buffer> = {}): Staged {
  const appData = mkdtempSync(join(tmpdir(), 'flowmic-del-appdata-'));
  const env = { APPDATA: appData, XDG_DATA_HOME: appData } as NodeJS.ProcessEnv;
  const root = join(appData, 'FlowMic', 'models');
  const dir = join(root, modelId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.bin'), PACK_BODY);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
  return { env, root, dir };
}

function request(method: string, url: string, peer: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers = {};
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: peer };
  return req;
}

interface Answer { status: number; body: Record<string, unknown> }

function response(): { res: ServerResponse; done: Promise<Answer> } {
  let settle: (v: Answer) => void;
  const done = new Promise<Answer>((r) => (settle = r));
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader() { /* headers are stt-model-routes.test.ts's subject, not this file's */ },
    writeHead(code: number) { status = code; return res; },
    end(payload?: string) {
      settle({
        status: status || (res as unknown as { statusCode: number }).statusCode,
        body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
      });
    },
    once() { return res; },
  } as unknown as ServerResponse;
  return { res, done };
}

/** The router as bootstrap builds it. NO `controllerFor` seam unless a case is
 *  about the controller itself: this file's subject is the production path from
 *  a model id to a directory, and a seam handing the route a controller over
 *  some other directory would make the containment assertion vacuous. */
function handlerFor(opts: {
  env: NodeJS.ProcessEnv;
  inUse?: Map<string, InUseReason>;
  controller?: ReturnType<typeof getModelController>;
}): (req: IncomingMessage, res: ServerResponse) => boolean {
  return makeHttpHandler({
    config: { mode: 'standalone', port: 41879, mockBilling: true } as never,
    billing: {} as never,
    version: '0.3.85',
    resolveUserId: makeResolveUserId({ mode: 'standalone', standaloneUserId: 'default' }),
    scriptPath: 'C:\\Users\\owner\\AppData\\Local\\FlowMic\\resources\\server.js',
    sttModel: {
      env: opts.env,
      busyController: () => null,
      inUse: () => Promise.resolve(opts.inUse ?? new Map<string, InUseReason>()),
      ...(opts.controller ? { controllerFor: () => opts.controller! } : {}),
    },
  });
}

function del(
  handler: (req: IncomingMessage, res: ServerResponse) => boolean,
  modelId: string,
  peer: string = LOOPBACK,
): Promise<Answer> {
  const { res, done } = response();
  handler(request('POST', STT_MODEL_DELETE_PATH, peer, { model_id: modelId }), res);
  return done;
}

/** The `models[]` row for one pack out of a status body. */
function rowOf(body: Record<string, unknown>, modelId: string): Record<string, unknown> | undefined {
  const models = body['models'] as Record<string, unknown>[] | undefined;
  return models?.find((m) => m['model_id'] === modelId);
}

/** A controller over a directory this file staged, built the production way
 *  (id + env) with an EMPTY manifest so no case has to own 239 MB of correct
 *  bytes to ask a question about disk occupancy. */
function controllerOver(modelId: string, env: NodeJS.ProcessEnv): ReturnType<typeof getModelController> {
  return getModelController({ model_id: modelId, files: [] } as unknown as CatalogModel, env);
}

describe('POST /api/stt/model/delete', () => {
  // ── 🔴 NEGATIVE CONTROL, ACTUALLY RUN ─────────────────────────────────────
  // Machine: this repo's Windows dev box, 2026-09-14, worktree
  // flowmic-app-worktrees/d4-nr7, branch lane/nr7-model-delete. The in-use
  // guard in `stt-model-routes.ts` `handleDelete` — from
  // `const reason = inUse.get(row.model_id);` through its
  // `sendJson(res, 409, … MODEL_IN_USE …)` — was removed, nothing else
  // changed, and this file re-run. The readings are quoted in this card's
  // report; the first assertion to fire is the FILES one, i.e. the route
  // answered 200 and the in-use pack had already been deleted.
  it('🔴 the model IN USE may not be deleted — and the files are still there afterwards', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    const h = handlerFor({ env: s.env, inUse: new Map([[SENSE_VOICE_MODEL_ID, 'would_open']]) });
    const out = await del(h, SENSE_VOICE_MODEL_ID);
    // 🔴 THE FILE ASSERTION FIRST, deliberately. A guard that refuses AFTER
    // removing is indistinguishable from a correct one by status code alone,
    // and it is the shape this whole card exists to prevent.
    expect(
      existsSync(join(s.dir, 'model.bin')),
      "the in-use pack's files must still be on disk after a refused delete",
    ).toBe(true);
    expect(out.status).toBe(409);
  });

  it('the refusal names WHY, machine-readably', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    const h = handlerFor({ env: s.env, inUse: new Map([[SENSE_VOICE_MODEL_ID, 'would_open']]) });
    const out = await del(h, SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(409);
    expect(out.body['error']).toBe('MODEL_IN_USE');
    // NR-49: `recognizer_loaded` was the OTHER value this used to assert, and
    // it is gone with the hold (owner ruling 2026-09-16 §1). The field stays a
    // named reason rather than collapsing into an unexplained 409 — a second
    // reason has existed once and may again, and the card's fold reads it.
    expect(out.body['in_use_reason']).toBe('would_open');
  });

  it('a pack that is NOT in use is removed, the bytes are freed, and the status says so', async () => {
    // A stray file the manifest does not name: `bytes_done` cannot see it and
    // `disk_bytes` must, because it is disk the deletion frees.
    const stray = Buffer.alloc(1_000, 3);
    const s = stage(SENSE_VOICE_MODEL_ID, { 'leftover.part': stray });
    const before = dirSizeBytes(s.dir);
    expect(before).toBe(PACK_BODY.length + stray.length);

    const h = handlerFor({ env: s.env });
    const out = await del(h, SENSE_VOICE_MODEL_ID);

    expect(out.status).toBe(200);
    expect(out.body['deleted_model_id']).toBe(SENSE_VOICE_MODEL_ID);
    expect(out.body['freed_bytes']).toBe(before);
    expect(existsSync(s.dir), 'the pack directory is gone').toBe(false);
    // The SAME response the card adopts — this is what makes the card update
    // without a restart, so the drop is asserted on the wire rather than on a
    // later poll nobody in this test would run.
    expect(rowOf(out.body, SENSE_VOICE_MODEL_ID)?.['disk_bytes']).toBe(0);
    expect(rowOf(out.body, SENSE_VOICE_MODEL_ID)?.['state']).toBe('absent');
  });

  // ── NR-49 (B) · 「如果删模型，已有的配对要留空」 ──────────────────────────
  // owner ruling 2026-09-16 §1. The deletion is only half of it: the settings
  // card renders `selected_by_lang` as 「this is your pick for this language」
  // (LocalModelCard.vue `row.selected` → the in-use chip), so a pairing left
  // behind puts that chip on a row with zero bytes on disk — a state word with
  // nothing behind it (15 册 R11).
  it('🔴 deleting a pack empties every per-language pairing that named it', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    // The multilingual pack is paired for two of the languages it claims; a
    // delete under ONE of them has to empty BOTH, which is the case a
    // per-language clear written at the pressed language would get wrong.
    writeModelSelection('zh', SENSE_VOICE_MODEL_ID, s.env);
    writeModelSelection('en', SENSE_VOICE_MODEL_ID, s.env);
    expect(Object.keys(readModelSelection(s.env)).sort()).toEqual(['en', 'zh']);

    const h = handlerFor({ env: s.env });
    const out = await del(h, SENSE_VOICE_MODEL_ID);

    expect(out.status).toBe(200);
    expect(readModelSelection(s.env), 'the pairing file, on disk').toEqual({});
    // 🔴 AND ON THE WIRE, in the same response the card adopts: without this
    // the card renders one stale in-use chip until the next poll.
    expect(out.body['selected_by_lang']).toEqual({});
    // 🔴 NR-49b — AND WHICH ones, by name. One delete can empty several
    // languages while `selected_by_lang` above can only show that they are
    // gone; naming them is what the card's sentence renders, and the card
    // cannot derive the list from this body alone (the difference needs the
    // state before the clear, which this response no longer carries).
    // Sorted here, not in the route: the file's own key order is what the
    // route returns (the order the user made the picks in), and pinning that
    // would make this case about JSON key order rather than about the list.
    expect([...(out.body['cleared_langs'] as string[])].sort()).toEqual(['en', 'zh']);
  });

  it('🔴 NR-49b cleared_langs is [] when nothing was paired — never missing', async () => {
    // `absent` and `empty` are two facts. A reader that has to treat a missing
    // key as 「none」 cannot tell a server that never sent the field from a
    // delete that genuinely cleared nothing — and the card would then have to
    // choose which of the two to render.
    const s = stage(SENSE_VOICE_MODEL_ID);
    const out = await del(handlerFor({ env: s.env }), SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(200);
    expect(out.body['cleared_langs']).toEqual([]);
  });

  it('cleared_langs names ONLY the pairings this pack held', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    writeModelSelection('zh', SENSE_VOICE_MODEL_ID, s.env);
    writeModelSelection('en', OTHER_ZH_EN_MODEL_ID, s.env);
    const out = await del(handlerFor({ env: s.env }), SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(200);
    // en is still paired — with another pack — so naming it would tell the
    // reader to go and re-pick a language nothing happened to.
    expect(out.body['cleared_langs']).toEqual(['zh']);
  });

  it('a REFUSED delete carries no cleared_langs at all', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    writeModelSelection('zh', SENSE_VOICE_MODEL_ID, s.env);
    const h = handlerFor({ env: s.env, inUse: new Map([[SENSE_VOICE_MODEL_ID, 'would_open']]) });
    const out = await del(h, SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(409);
    // Nothing was cleared, and the refusal body is not the 200 body: an `[]`
    // here would be a delete report on a delete that did not happen.
    expect(out.body['cleared_langs']).toBeUndefined();
  });

  it('a pairing naming ANOTHER pack survives the delete — 「留空」 is not 「reset」', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    // paraformer claims zh+en too; it is not the pack being deleted, so the
    // user's choice for that language must be exactly where they left it.
    writeModelSelection('zh', SENSE_VOICE_MODEL_ID, s.env);
    writeModelSelection('en', OTHER_ZH_EN_MODEL_ID, s.env);
    const out = await del(handlerFor({ env: s.env }), SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(200);
    expect(readModelSelection(s.env)).toEqual({ en: OTHER_ZH_EN_MODEL_ID });
    expect((out.body['selected_by_lang'] as Record<string, string>)['zh']).toBeUndefined();
  });

  // The ordering rule card B2-G established on the download side, on this side:
  // a press that is REFUSED persists nothing. A clear that ran before the
  // removal would empty the user's choice for a pack still sitting on disk.
  it('🔴 a REFUSED delete leaves the pairing exactly as it was', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    writeModelSelection('zh', SENSE_VOICE_MODEL_ID, s.env);
    const h = handlerFor({ env: s.env, inUse: new Map([[SENSE_VOICE_MODEL_ID, 'would_open']]) });
    const out = await del(h, SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(409);
    expect(readModelSelection(s.env)['zh']).toBe(SENSE_VOICE_MODEL_ID);
  });

  it('the listed size is the MEASURED one, not the declared one', async () => {
    const stray = Buffer.alloc(1_000, 3);
    const s = stage(SENSE_VOICE_MODEL_ID, { 'leftover.part': stray });
    const snap = await controllerOver(SENSE_VOICE_MODEL_ID, s.env).snapshot();
    // Manifest-blind (`files: []` ⇒ bytes_done 0) and yet the disk figure is
    // the real occupancy: the two fields answer different questions.
    expect(snap.bytes_done).toBe(0);
    expect(snap.disk_bytes).toBe(PACK_BODY.length + stray.length);
  });

  it('a pack whose directory is downloading is refused before anything is removed', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    const c = controllerOver(SENSE_VOICE_MODEL_ID, s.env);
    vi.spyOn(c, 'busy', 'get').mockReturnValue(true);
    const h = handlerFor({ env: s.env, controller: c });
    const out = await del(h, SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(409);
    expect(out.body['error']).toBe('MODEL_DELETE_BUSY');
    expect(existsSync(join(s.dir, 'model.bin'))).toBe(true);
  });

  it('an unknown model id is a 404, not a removal attempt', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    const h = handlerFor({ env: s.env });
    const out = await del(h, '../../../etc');
    expect(out.status).toBe(404);
    expect(out.body['error']).toBe('MODEL_UNKNOWN');
    expect(existsSync(join(s.dir, 'model.bin'))).toBe(true);
  });

  it('a LAN peer cannot delete anything (RV-32 covers this path too)', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    const h = handlerFor({ env: s.env });
    const out = await del(h, SENSE_VOICE_MODEL_ID, LAN_PEER);
    expect(out.status).toBe(403);
    expect(out.body['error']).toBe(LOCAL_ONLY_ERROR);
    expect(existsSync(join(s.dir, 'model.bin'))).toBe(true);
  });

  it('[MODEL_DELETE_CONTAINMENT] the debug-override directory is out of reach', async () => {
    const s = stage(SENSE_VOICE_MODEL_ID);
    // The override collapses every model id onto one hand-staged directory,
    // which is exactly the directory a recursive remove must never reach.
    const outside = mkdtempSync(join(tmpdir(), 'flowmic-del-outside-'));
    writeFileSync(join(outside, 'someone-elses-work.txt'), 'keep me');
    const env = { ...s.env, FLOWMIC_SHERPA_MODEL_DIR: outside } as NodeJS.ProcessEnv;
    const h = handlerFor({ env });
    const out = await del(h, SENSE_VOICE_MODEL_ID);
    expect(out.status).toBe(400);
    expect(out.body['error']).toBe('MODEL_DELETE_OUTSIDE_ROOT');
    expect(existsSync(join(outside, 'someone-elses-work.txt'))).toBe(true);
  });
});

describe('[MODEL_DELETE_CONTAINMENT] assertInsideModelsRoot', () => {
  it('refuses the root itself, anything above it, and anything deeper than one level', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmic-cont-'));
    mkdirSync(join(root, 'pack', 'sub'), { recursive: true });
    expect(() => assertInsideModelsRoot(join(root, 'pack'), root)).not.toThrow();
    expect(() => assertInsideModelsRoot(root, root)).toThrow(/not inside|one level/);
    expect(() => assertInsideModelsRoot(join(root, 'pack', 'sub'), root)).toThrow(/one level/);
    expect(() => assertInsideModelsRoot(join(root, '..'), root)).toThrow(/not inside/);
  });
});

describe('[MODEL_IN_USE_LADDER] what 「in use」 means', () => {
  /** A synthetic catalog row — the seam `model-resolve.ts` documents, so the
   *  REAL ladder runs without staging the real rows' gigabytes. */
  function row(modelId: string, spoken: string[]): CatalogModel {
    return {
      model_id: modelId,
      spoken,
      tier: 'recommended',
      loader: 'sense-voice',
      license_class: 'osi',
      license_spdx_or_name: 'Apache-2.0',
      attribution: 'synthetic test row',
      streaming: 'offline',
      files: [{
        path: 'model.bin',
        size: PACK_BODY.length,
        sha256: createHash('sha256').update(PACK_BODY).digest('hex'),
      }],
      sources: [],
    } as unknown as CatalogModel;
  }

  it('a READY pack that the ladder would open for a language is in use', async () => {
    const s = stage('synthetic-en-pack');
    const inUse = await modelsInUse(s.env, { catalog: [row('synthetic-en-pack', ['en'])] });
    expect(inUse.get('synthetic-en-pack')).toBe('would_open');
  });

  it('a pack the ladder would NOT open is not in use — 「in use」 is not 「downloaded」', async () => {
    const s = stage('synthetic-en-pack');
    // Two rows claiming the same language; only the first is staged on disk,
    // so the second is not ready and cannot be what would open.
    const inUse = await modelsInUse(s.env, {
      catalog: [row('synthetic-en-pack', ['en']), row('synthetic-spare-pack', ['en'])],
    });
    expect(inUse.has('synthetic-en-pack')).toBe(true);
    expect(inUse.has('synthetic-spare-pack')).toBe(false);
  });

  // 🔴 NR-49 (owner ruling 2026-09-16 §1) — THE SECOND SOURCE IS GONE, and the
  // way it could come back is quietly: one `import` in the engine and every
  // pack spoken with this session is undeletable again, with every test here
  // still green (the guard would simply refuse more). So the pin is on the
  // EDGE that fed it. The case it replaces asserted the opposite
  // (`[MODEL_IN_USE_RECOGNIZER] … is in use`); its premise was measured false
  // on 2026-09-15 and the owner ruled the pack deletable.
  it('🔴 NR-49 the speech engine no longer feeds the delete guard — one source, the ladder', () => {
    // Comments stripped first, and that is not a nicety: this pin went red on
    // its first run against the very note that RECORDS the removal, because
    // the note names the call it removed. A source scan that cannot tell code
    // from prose about code would have to be satisfied by deleting the
    // history, which is the opposite of what this repo does with it.
    const engine = readFileSync(
      new URL('../src/stt/engines/sherpa-local.ts', import.meta.url), 'utf8',
    ).split(String.fromCharCode(10)).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(' ');
    expect(engine).not.toMatch(/from '\.\.\/sherpa\/model-in-use'/);
    expect(engine).not.toMatch(/noteRecognizerLoaded\s*\(/);
    const guard = readFileSync(
      new URL('../src/stt/sherpa/model-in-use.ts', import.meta.url), 'utf8',
    );
    // The type is the other half: a union of one cannot silently grow a member
    // that nothing refuses on, and `tsc` fails the day somebody adds one
    // without also deciding what it means.
    expect(guard).toMatch(/export type InUseReason = 'would_open';/);
  });
});
