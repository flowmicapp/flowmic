// Exercise the production gate against both checkout shapes. The fixture pins
// the current literal values, then changes wiring / data separately. No live sibling
// checkout is mutated. scripts/run-script-tests.mjs discovers this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../verify/lint/_util.mjs';
import run from '../verify/lint/spoken-langs-mirror.mjs';

const local = path.join(ROOT, '.local');
fs.mkdirSync(local, { recursive: true });
const fixture = fs.mkdtempSync(path.join(local, 'spoken-langs-'));
const micFile = 'apps/mic/src/session/spokenLangs.ts';
const coreFile = 'packages/core/src/account/spokenLangs.ts';
const rootFile = 'packages/core/src/index.ts';
const islandFile = 'packages/core/src/island/index.ts';
const put = (file, text) => {
  const abs = path.join(fixture, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const originalEnv = process.env.FLOWMIC_WEB_CLIENT_REPO;
try {
  // A fixture table is intentional here: the production gate compares it to
  // the real Dart registry, so a registry change must update this fixture too.
  const literals = `export const SPOKEN_LANG_TAGS = ['en', 'zh', 'fr', 'es', 'de', 'ja', 'ko', 'ru'] as const;
export const SPOKEN_LANG_ENDONYMS = {
  en: 'English',
  zh: '中文',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
};`;
  process.env.FLOWMIC_WEB_CLIENT_REPO = fixture;
  put(micFile, literals);
  assert.equal((await run()).status, 'PASS', 'legacy mic definitions remain supported');
  const names = 'SPOKEN_LANG_TAGS, SPOKEN_LANG_ENDONYMS';
  const mic = `export { ${names} } from '@flowmic/web-core';`;
  const root = "export * from './island/index.js';";
  const island = `export { ${names} } from '../account/spokenLangs.js';`;
  put(micFile, mic); put(rootFile, root); put(islandFile, island); put(coreFile, literals);
  const linked = await run();
  assert.equal(linked.status, 'PASS', linked.detail);
  assert.ok(linked.detail.includes(coreFile), linked.detail);
  for (const [file, good, broken] of [
    [micFile, mic, mic.replace('SPOKEN_LANG_ENDONYMS', 'UNRELATED')],
    [micFile, mic, `/* ${mic} */`],
    [micFile, mic, mic.replace('export {', 'export type {')],
    [rootFile, root, `/* ${root} */`],
    [islandFile, island, island.replace('../account/spokenLangs.js', '../account/unused.js')],
    [islandFile, island, island.replace('SPOKEN_LANG_TAGS,', 'type SPOKEN_LANG_TAGS,')],
    [coreFile, literals, literals.replace("'English'", "'Not English'")],
    [coreFile, literals, literals.replace("'en', 'zh'", "'zh', 'en'")],
  ]) {
    put(file, broken);
    const rejected = await run();
    assert.equal(rejected.status, 'FAIL', `${file}: ${rejected.detail}`);
    put(file, good);
    assert.equal((await run()).status, 'PASS', `restored ${file}`);
  }
  console.log('PASS legacy definitions, reachable core tables, disconnected/type-only barrels, tag order and endonym drift');
} finally {
  if (originalEnv === undefined) delete process.env.FLOWMIC_WEB_CLIENT_REPO;
  else process.env.FLOWMIC_WEB_CLIENT_REPO = originalEnv;
  if (!path.resolve(fixture).startsWith(path.resolve(local) + path.sep)) throw new Error('unsafe fixture cleanup path');
  fs.rmSync(fixture, { recursive: true, force: true });
}
