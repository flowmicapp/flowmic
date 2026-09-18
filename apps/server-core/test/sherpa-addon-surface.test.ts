// NR-45 / NR-46 — the two facts about sherpa-onnx-node that decide two cards,
// pinned so that a version bump reopens them instead of silently keeping them
// shut.
//
// ── NR-45: THERE IS NO WAY TO FREE A RECOGNIZER ─────────────────────────────
// `stt/engines/sherpa-local.ts` keeps every loaded recognizer in
// RECOGNIZER_CACHE for the life of the process and `close()` deliberately does
// not free it, so `stt/sherpa/model-in-use.ts` counts 「this process loaded it」
// as a reason to refuse a delete. The obvious fix — evict by model id and free
// the native handle — needs a free, and 1.13.4 does not expose one: the JS
// classes offer construction, streams, config, decode and results, and NOT ONE
// of the addon's 99 native exports frees anything. The C library's
// `SherpaOnnxDestroyOfflineRecognizer` is linked INTO the addon, so something
// inside it can destroy a recognizer; nothing a JS caller can reach does.
// ⇒ a 「release」 code path would be a promise the dependency cannot keep, so
// none was written. This case is what will tell us the day that changes.
//
// ── NR-46: `decodeAsync` EXISTS ─────────────────────────────────────────────
// The other card's whole question is whether to move decoding off the JS
// thread the way NR-38 moved construction. That option is only on the table
// while the addon has `decodeAsync`; if a future pin loses it, the ledger entry
// is discussing something that is not there any more.
//
// 🔴 WHAT THIS CASE CANNOT DO, STATED SO NOBODY READS ITS GREEN AS MORE THAN IT
// IS. The addon is an optionalDependency: on a machine or a CI runner without
// it, the assertions below do not run at all and the case prints that it proved
// nothing. Green here means either 「measured」 or 「absent」, and only the
// printed line says which — the same reason `copy:audit` prints its controls.
// The numbers that go with these facts (what one decode costs, whether a loaded
// pack can be deleted) need real model packs and live in
// `scripts/drills/local-engine-lifecycle-probe.mjs`.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/** Anything whose name would make a caller believe it releases a resource. The
 *  regex is deliberately wider than 「free」: the day upstream adds a release it
 *  is as likely to be called `dispose` or `unload` as `free`, and a narrow
 *  pattern would keep this case green through exactly the change it exists to
 *  catch. */
const FREE_LIKE = /free|destroy|delete|release|dispose|close|shutdown|unload/i;

interface AddonSurface {
  recognizerMembers: string[];
  streamMembers: string[];
  nativeExports: string[];
}

function loadSurface(): AddonSurface | null {
  let glueDir: string;
  try {
    glueDir = dirname(require.resolve('sherpa-onnx-node/package.json'));
  } catch {
    return null;
  }
  try {
    // The addon's own require() of the native binary needs the bundled DLL
    // directory on PATH on Windows (#3059) — the same step `sherpa-local.ts`
    // does before its first load.
    const winBin = join(glueDir, '..', 'sherpa-onnx-win-x64');
    if (process.platform === 'win32') process.env.PATH = `${winBin};${process.env.PATH ?? ''}`;
    const api = require('sherpa-onnx-node') as { OfflineRecognizer: new (c: unknown) => unknown };
    // `OfflineStream` is not on the package's export map; it is reached through
    // the module that defines it, because a recognizer hands one out and a free
    // would plausibly live there rather than on the recognizer.
    const asr = require(join(glueDir, 'non-streaming-asr.js')) as { OfflineStream: new (h: unknown) => unknown };
    const addon = require(join(glueDir, 'addon.js')) as Record<string, unknown>;
    const own = (c: object): string[] => Object.getOwnPropertyNames(c).filter((n) => !['length', 'name', 'prototype'].includes(n));
    return {
      recognizerMembers: [
        ...Object.getOwnPropertyNames(api.OfflineRecognizer.prototype),
        ...own(api.OfflineRecognizer),
      ],
      streamMembers: Object.getOwnPropertyNames(asr.OfflineStream.prototype),
      nativeExports: Object.keys(addon),
    };
  } catch {
    return null;
  }
}

const surface = loadSurface();

describe('NR-45/NR-46 · the sherpa-onnx-node surface these two cards rest on', () => {
  it('offers no way for a JS caller to free a recognizer, and still offers decodeAsync', () => {
    if (surface === null) {
      // Not `it.skip`: a skipped case is easy to read as 「this passed」 in a
      // 2,000-line run. The line says what happened.
      console.log('[NR-45] sherpa-onnx-node did not resolve here — THIS CASE PROVED NOTHING. Run it on a machine with the optional addon installed.');
      expect(surface).toBeNull();
      return;
    }
    const jsFree = [...surface.recognizerMembers, ...surface.streamMembers].filter((n) => FREE_LIKE.test(n));
    const nativeFree = surface.nativeExports.filter((n) => FREE_LIKE.test(n));
    console.log(`[NR-45] recognizer: ${surface.recognizerMembers.join(', ')}`);
    console.log(`[NR-45] stream: ${surface.streamMembers.join(', ')} · native exports: ${surface.nativeExports.length}`);

    // 🔴 If either of these turns red, NR-45 is BACK ON: the addon grew a way
    // to release a recognizer, and `sherpa-local.ts` can finally evict by model
    // id so `model-in-use.ts` stops refusing deletes for a pack the user spoke
    // with once this session.
    expect(jsFree).toEqual([]);
    expect(nativeFree).toEqual([]);

    // NR-46's precondition. Not a performance claim — an availability one.
    expect(surface.recognizerMembers).toContain('decodeAsync');
    // NR-38 shipped against this one; if it ever disappears, `constructRecognizer`
    // silently falls back to the blocking constructor and the G10 stall returns.
    expect(surface.recognizerMembers).toContain('createAsync');
  });
});
