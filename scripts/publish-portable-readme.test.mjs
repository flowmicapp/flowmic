// The portable README's speech model note names real things: the screen labels it
// tells the reader to look for must be what the desktop prints, and the download
// hosts must be the ones the privacy policy names. Two strings can each be fine and
// still point at a button that does not exist, and no other gate reads that pair.
//
// Reverse control: changing "Download the model (one time)" in the README template,
// or removing "hf-mirror.com" from it, turns this file red when run by itself:
//   node scripts/publish-portable-readme.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableReadmeText } from './publish-portable-readme.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = portableReadmeText('0.0.0').split(/\s+/).join(' ');
const desktopEn = JSON.parse(readFileSync(join(root, 'i18n/desktop/en.json'), 'utf8')).strings
  ?? JSON.parse(readFileSync(join(root, 'i18n/desktop/en.json'), 'utf8'));

function label(key) {
  const literal = desktopEn[key];
  assert.equal(typeof literal, 'string', `i18n/desktop/en.json has no ${key}`);
  return literal.slice(1, -1); // The catalogue stores JS string literals.
}

for (const key of ['set_nav_stt', 'model_title', 'model_dl', 'nav_settings']) {
  assert.ok(readme.includes(label(key)), `the README must print the screen's own words for ${key}: ${label(key)}`);
}

const policy = readFileSync(join(root, 'docs/legal/privacy-policy.md'), 'utf8');
for (const host of ['huggingface.co', 'hf-mirror.com', 'GitHub']) {
  assert.ok(policy.includes(host), `the privacy policy no longer names ${host}`);
  assert.ok(readme.includes(host), `the README must name ${host}`);
}

// The old note said the environment variable was how you got the model.
assert.ok(!readme.includes('about 228 MB'), 'packs differ in size; one number is not true of them');
assert.ok(readme.includes('never downloads on its own'), 'the README must say nothing is fetched unasked');
console.log('portable README model note: labels and hosts agree');
