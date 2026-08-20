// SPEC-REF:
//   docs/decisions/2026-08-02-in-app-update-both-ends.md
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §2.2 ② (hash gate, second line) / §3 (failure-direction table)
//   apps/server-core/src/http/update-routes.ts
//
// Shape contract and failure directions for GET /api/updates/latest.
//
// 🔴 This file only pins two things; do not be misled by the case count:
//   ① **Any illegal sha256 ⇒ the whole manifest is 503**, not "skip that one" and not "200 but one artifact short".
//      The hash is the only integrity gate on the installer (download center is HTTP-only; phase-one Windows is unsigned),
//      so "the gate is broken" must turn the entire answer into a refusal, not into a normal answer that is missing one lock.
//   ② **Unavailable ⇒ 503, never 200 + empty manifest**. An empty manifest is read by the client as
//      "no update, you are already current", while the truth is "we do not know". **Unknown ≠ current.**
//
// Every negative assertion has a positive control (G13 rule ②): the same manifest goes red when exactly one field is broken
// and green when it is not — otherwise that "503" could mean the probe is blind rather than the implementation being right.

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeUpdateRoutes, validateUpdateManifest, UPDATE_MANIFEST_PATH } from '../src/http/update-routes';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** Under `noUncheckedIndexedAccess` every indexed read is `T | undefined`. Assert rather than `!`:
 *  if it really is undefined, fail on THIS line, instead of becoming an opaque error downstream. */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`fixture broken: ${what} is undefined`);
  return v;
}

/** Take one platform from a "manifest under test" (these fixtures are deliberately wide-shaped, because they have to hold
 *  illegal values). */
function platformFixture(m: Record<string, unknown>, platform: string): { version: string; artifacts: Record<string, unknown>[] } {
  const plats = m.platforms as Record<string, { version: string; artifacts: Record<string, unknown>[] }>;
  return must(plats[platform], `platforms.${platform}`);
}

/** Same as above, artifacts array only. */
function artifactsOf(m: Record<string, unknown>, platform: string): Record<string, unknown>[] {
  return platformFixture(m, platform).artifacts;
}

/** Take one platform from a manifest that has **already passed validation**. */
function platformOf(body: unknown, platform: string): { version: string; artifacts: { sha256: string; kind: string }[] } {
  const b = body as { platforms: Record<string, { version: string; artifacts: { sha256: string; kind: string }[] }> };
  return must(b.platforms[platform], `platforms.${platform}`);
}

/** A legal manifest — every negative case starts from this and changes exactly one place; that is the positive control. */
function goodManifest(): Record<string, unknown> {
  return {
    manifest_version: 1,
    generated_at: '2026-08-02T12:00:00.000Z',
    platforms: {
      'windows-x64': {
        version: '0.2.50',
        notes_url: 'http://updates.example.invalid/dl/flowmic/release/FlowMic-0.2.50-RELEASE_NOTES.md',
        artifacts: [
          {
            kind: 'msi',
            locale: 'zh-CN',
            filename: 'FlowMic_0.2.50_x64_zh-CN.msi',
            url: 'http://updates.example.invalid/dl/flowmic/release/FlowMic_0.2.50_x64_zh-CN.msi',
            sha256: SHA_A,
            size: 12_345_678,
          },
        ],
      },
      android: {
        version: '0.2.50',
        notes_url: null,
        artifacts: [
          {
            kind: 'apk',
            locale: null,
            filename: 'FlowMic-0.2.50-release.apk',
            url: 'http://updates.example.invalid/dl/flowmic/release/FlowMic-0.2.50-release.apk',
            sha256: SHA_B,
            size: 45_678_901,
          },
        ],
      },
    },
  };
}

// ── pure validator ────────────────────────────────────────────────────────────
describe('validateUpdateManifest — shape contract', () => {
  it('positive control: a complete manifest passes, both platforms are kept', () => {
    const v = validateUpdateManifest(goodManifest());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(Object.keys(v.manifest.platforms).sort()).toEqual(['android', 'windows-x64']);
    expect(must(must(v.manifest.platforms['windows-x64'], 'win').artifacts[0], 'artifact0').sha256).toBe(SHA_A);
  });

  // 🔴 Gate ②. Each of the four "broken hash" shapes once — they are four different
  //    ways the writing can drift, and an implementation that only blocks undefined is green on the other three.
  it.each([
    ['missing', undefined],
    ['empty string', ''],
    ['truncated', 'a'.repeat(63)],
    ['uppercase', 'A'.repeat(64)],
    ['with spaces', ` ${'a'.repeat(64)} `],
    ['not a string', 12345],
  ])('rejects sha256 %s — the whole manifest is illegal', (_label, bad) => {
    const m = goodManifest();
    const art = must(artifactsOf(m, 'windows-x64')[0], 'artifact0');
    if (bad === undefined) delete art.sha256;
    else art.sha256 = bad;
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/^bad_sha256:/);
  });

  it('🔴 one bad sha256 makes the **whole** manifest illegal — not "skip that one"', () => {
    // The android entry is good. If the implementation changes to "filter out bad entries", this assertion goes red.
    const m = goodManifest();
    must(artifactsOf(m, 'windows-x64')[0], 'artifact0').sha256 = '';
    expect(validateUpdateManifest(m).ok).toBe(false);
  });

  it.each([
    ['file: scheme', 'file:///C:/evil.msi'],
    ['relative path', '/dl/flowmic/release/x.msi'],
    ['empty string', ''],
    ['not a URL', 'not a url'],
  ])('rejects url %s (owner\'s "may be some other URL" is not "may be anything")', (_label, bad) => {
    const m = goodManifest();
    must(artifactsOf(m, 'windows-x64')[0], 'artifact0').url = bad;
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/^bad_url:/);
  });

  it('allows plaintext http (that is what the download center is) — this is exactly why sha256 is required, not something to fix', () => {
    expect(validateUpdateManifest(goodManifest()).ok).toBe(true);
  });

  it.each([
    ['path separator /', 'a/b.msi'],
    ['path separator \\', 'a\\b.msi'],
    ['directory traversal', '..\\..\\evil.msi'],
    ['empty string', ''],
  ])('rejects filename %s — the client will write it to disk; refusing at the boundary is better than every call site being careful', (_label, bad) => {
    const m = goodManifest();
    must(artifactsOf(m, 'windows-x64')[0], 'artifact0').filename = bad;
    expect(validateUpdateManifest(m).ok).toBe(false);
  });

  it('🔴 rejects empty platforms — an empty manifest would be read as "no update on any platform", which is not something we know', () => {
    const v = validateUpdateManifest({ manifest_version: 1, generated_at: 'x', platforms: {} });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('empty_platforms');
  });

  it('rejects empty artifacts (same: a platform entry with no artifacts is not "no update")', () => {
    const m = goodManifest();
    platformFixture(m, 'android').artifacts = [];
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('empty_artifacts:android');
  });

  it.each([['0.2', '0.2'], ['with suffix', '0.2.50-beta'], ['empty string', ''], ['letters', 'latest']])(
    'rejects version %s — the same shape as the 9 version faces of bump-version.mjs',
    (_label, bad) => {
      const m = goodManifest();
      platformFixture(m, 'windows-x64').version = bad;
      expect(validateUpdateManifest(m).ok).toBe(false);
    },
  );

  it('rejects an unknown manifest_version (when the structure changes later, an old relay must not pretend it understands)', () => {
    const m = { ...goodManifest(), manifest_version: 2 };
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('unsupported_manifest_version');
  });

  it('platform keys are a map, not fixed fields — adding macos-arm64 is additive', () => {
    const m = goodManifest();
    (m.platforms as Record<string, unknown>)['macos-arm64'] = {
      version: '0.2.50',
      notes_url: null,
      artifacts: [
        { kind: 'dmg', locale: null, filename: 'FlowMic-0.2.50.dmg', url: 'https://x.test/a.dmg', sha256: SHA_A, size: 1 },
      ],
    };
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(true);
    if (v.ok) expect(must(must(v.manifest.platforms['macos-arm64'], 'mac').artifacts[0], 'artifact0').kind).toBe('dmg');
  });

  it('reason never contains a file path (RV-32: /api/health\'s script once leaked the install layout)', () => {
    const v = validateUpdateManifest({ manifest_version: 1, generated_at: 'x', platforms: {} });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).not.toMatch(/[\\/]/);
      expect(v.reason).not.toMatch(/etc|Users|AppData/i);
    }
  });

  // ── store_platforms — the additive block for store-delivered platforms ─────
  // Why it exists at all (and why ios is NOT an artifact-less `platforms`
  // entry): every fielded client rejects the whole manifest on
  // `empty_artifacts`, so the ios announcement must ride a key old validators
  // never read. See UpdateStorePlatform's doc in update-routes.ts.

  it('store_platforms: a valid ios entry passes and is carried through', () => {
    const m = goodManifest();
    m.store_platforms = {
      ios: {
        version: '0.3.12',
        notes_url: 'https://github.com/flowmicapp/flowmic/releases/tag/v0.3.12',
        store_url: 'https://testflight.apple.com/join/example',
      },
    };
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(must(v.manifest.store_platforms?.ios, 'store ios').version).toBe('0.3.12');
    }
  });

  it('🔴 a manifest WITHOUT store_platforms serves without the key — old files stay byte-identical', () => {
    const v = validateUpdateManifest(goodManifest());
    expect(v.ok).toBe(true);
    if (v.ok) {
      // The property must be genuinely ABSENT (JSON.stringify drops undefined),
      // not present-as-empty: `"store_platforms":{}` would be a new byte in
      // every previously published manifest.
      expect('store_platforms' in v.manifest).toBe(false);
    }
  });

  it('🔴 a mangled store version rejects the whole manifest — a phone must never compare against garbage', () => {
    const m = goodManifest();
    m.store_platforms = { ios: { version: 'v0.3.12', notes_url: null, store_url: null } };
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_store_version:ios');
    // Positive control: the same entry with a legal version passes.
    m.store_platforms = { ios: { version: '0.3.12', notes_url: null, store_url: null } };
    expect(validateUpdateManifest(m).ok).toBe(true);
  });

  it('store_url takes http(s) only — `itms-services:` and friends die at the boundary', () => {
    const m = goodManifest();
    m.store_platforms = {
      ios: { version: '0.3.12', notes_url: null, store_url: 'itms-services://?action=x' },
    };
    const v = validateUpdateManifest(m);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_store_url:ios');
  });
});

// ── route layer ──────────────────────────────────────────────────────────────
interface Captured { status: number; body: unknown; headers: Record<string, string> }

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null, headers: {} };
  const res = {
    setHeader(k: string, v: string) { captured.headers[k.toLowerCase()] = v; },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      for (const [k, v] of Object.entries(headers ?? {})) captured.headers[k.toLowerCase()] = v;
      return this;
    },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  return { res, captured };
}

function fakeReq(url: string, method = 'GET'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.url = url;
  req.method = method;
  return req;
}

/** A controllable fake filesystem: both content and mtime can be changed by the test. */
function fakeFs(initial: string | null) {
  let content = initial;
  let mtimeMs = 1;
  return {
    set(next: string | null) { content = next; mtimeMs += 1; },
    readFile(): string {
      if (content === null) throw new Error('ENOENT');
      return content;
    },
    statFile(): { mtimeMs: number; size: number } {
      if (content === null) throw new Error('ENOENT');
      return { mtimeMs, size: content.length };
    },
  };
}

describe('GET /api/updates/latest', () => {
  it('positive control: a legal manifest ⇒ 200 + the manifest body', () => {
    const fs = fakeFs(JSON.stringify(goodManifest()));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res, captured } = fakeRes();
    expect(handle(fakeReq(UPDATE_MANIFEST_PATH), res)).toBe(true);
    expect(captured.status).toBe(200);
    expect((captured.body as { platforms: Record<string, unknown> }).platforms).toHaveProperty('windows-x64');
    expect(platformOf(captured.body, 'windows-x64').artifacts).toHaveLength(1);
  });

  // 🔴 §3 table, row 3. This is the first-class assertion of this file.
  it('🔴 manifest file missing ⇒ 503, **never 200** (unknown ≠ current)', () => {
    const fs = fakeFs(null);
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res, captured } = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), res);
    expect(captured.status).toBe(503);
    expect(captured.body).toEqual({ error: 'UPDATE_MANIFEST_UNAVAILABLE', detail: 'manifest_unreadable' });
    // Positive control for the negative assertion: the body has no shape that can be read as "already current".
    expect(captured.body).not.toHaveProperty('platforms');
    expect(captured.body).not.toHaveProperty('version');
  });

  it('🔴 one sha256 in the manifest is empty ⇒ 503, not 200 with one artifact short', () => {
    const bad = goodManifest();
    must(artifactsOf(bad, 'windows-x64')[0], 'artifact0').sha256 = '';
    const fs = fakeFs(JSON.stringify(bad));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res, captured } = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), res);
    expect(captured.status).toBe(503);
    expect((captured.body as { detail: string }).detail).toMatch(/^bad_sha256:/);
  });

  it('malformed JSON and an illegal shape are two different diagnostics', () => {
    const fs = fakeFs('{ not json');
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res, captured } = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), res);
    expect(captured.status).toBe(503);
    expect((captured.body as { detail: string }).detail).toBe('unparsable_json');
  });

  it('other paths are not its job (return false ⇒ fall through so the router keeps looking)', () => {
    const fs = fakeFs(JSON.stringify(goodManifest()));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res } = fakeRes();
    expect(handle(fakeReq('/api/health'), res)).toBe(false);
  });

  it('POST to the same path ⇒ 405, must not masquerade as "this route does not exist"', () => {
    const fs = fakeFs(JSON.stringify(goodManifest()));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res, captured } = fakeRes();
    expect(handle(fakeReq(UPDATE_MANIFEST_PATH, 'POST'), res)).toBe(true);
    expect(captured.status).toBe(405);
    expect(captured.headers.allow).toBe('GET');
  });

  it('also recognizes a query string (cache-busting params like ?t=…)', () => {
    const fs = fakeFs(JSON.stringify(goodManifest()));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res, captured } = fakeRes();
    handle(fakeReq(`${UPDATE_MANIFEST_PATH}?t=1`), res);
    expect(captured.status).toBe(200);
  });

  it('Cache-Control: no-store — at a 24h check cadence caching saves nothing and invents "I just shipped, why no prompt"', () => {
    const fs = fakeFs(JSON.stringify(goodManifest()));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const { res, captured } = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), res);
    expect(captured.headers['cache-control']).toBe('no-store');
  });

  it('🔴 a rewritten manifest file takes effect immediately (the cache key is mtime+size, not a TTL)', () => {
    const first = goodManifest();
    const fs = fakeFs(JSON.stringify(first));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const a = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), a.res);
    expect(platformOf(a.captured.body, 'android').version).toBe('0.2.50');

    const next = goodManifest();
    platformFixture(next, 'android').version = '0.2.51';
    fs.set(JSON.stringify(next));
    const b = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), b.res);
    expect(platformOf(b.captured.body, 'android').version).toBe('0.2.51');
  });

  it('🔴 after the file disappears it must not serve the previously cached manifest', () => {
    const fs = fakeFs(JSON.stringify(goodManifest()));
    const handle = makeUpdateRoutes({ manifestPath: '/x', readFile: fs.readFile, statFile: fs.statFile });
    const a = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), a.res);
    expect(a.captured.status).toBe(200); // positive control: the cache really did hold a good copy

    fs.set(null);
    const b = fakeRes();
    handle(fakeReq(UPDATE_MANIFEST_PATH), b.res);
    expect(b.captured.status).toBe(503);
  });
});
