#!/usr/bin/env node
// scripts/eval/speech-quality/fleurs-fetch.mjs — real-voice items for card ML-0.
//
//   node scripts/eval/speech-quality/fleurs-fetch.mjs --n 10            # fr es de ja ko ru
//   node scripts/eval/speech-quality/fleurs-fetch.mjs --langs fr,de --n 10
//
// Source: Google FLEURS (https://huggingface.co/datasets/google/fleurs),
// license CC-BY-4.0. Attribution: Conneau et al., "FLEURS: Few-shot Learning
// Evaluation of Universal Representations of Speech", 2022.
//
// Downloads ONLY what is needed: the split's TSV (transcripts, ~1 MB) and the
// first N distinct sentences of the split's audio archive, read as a stream and
// abandoned as soon as N files are in hand (the full test archive is ~350 MB per
// language). Nothing from the download is executed: the archive is parsed in
// this process (a minimal ustar reader), the raw WAVs land in their own
// directory `.local/eval-audio/fleurs/raw/<config>/`, and the local `ffmpeg`
// re-encodes each one to 16 kHz mono s16le as `.local/eval-audio/fleurs/<id>.wav`
// with the paths passed as arguments. Audio is NEVER committed (.local/ is
// gitignored).
//
// Writes `.local/eval-audio/fleurs/fleurs-items.json`: one entry per file with
// the FLEURS id, raw transcription (case and punctuation kept), speaker gender
// and duration. corpus-ml.json carries the same facts per item (`source`,
// `reference`), so the corpus does not depend on this file once written; three
// transcript artefacts were cleaned there and are marked `reference_note`.
// Which ten files come back depends only on the archive's order, which is
// fixed for a given dataset revision.

import { spawnSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { get } from 'node:https';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_DIR, parseArgs, pcmSeconds, readWav } from './lib.mjs';

const CONFIGS = { fr: 'fr_fr', es: 'es_419', de: 'de_de', ja: 'ja_jp', ko: 'ko_kr', ru: 'ru_ru' };
const args = parseArgs();
const n = Number(args.n ?? 10);
const langs = String(args.langs ?? Object.keys(CONFIGS).join(',')).split(',');
const base = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data';
const outDir = join(AUDIO_DIR(), 'fleurs');
mkdirSync(outDir, { recursive: true });
const indexPath = join(outDir, 'fleurs-items.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { license: 'CC-BY-4.0', source: 'https://huggingface.co/datasets/google/fleurs', items: {} };

function fetchFollow(url, cb, hops = 0) {
  return get(url, { headers: { 'user-agent': 'flowmic-eval/1' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
      res.resume();
      fetchFollow(new URL(res.headers.location, url).href, cb, hops + 1);
      return;
    }
    if (res.statusCode !== 200) { res.resume(); cb(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
    cb(null, res);
  });
}
const fetchText = (url) => new Promise((ok, no) => fetchFollow(url, (e, res) => {
  if (e) return no(e);
  const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => ok(Buffer.concat(parts).toString('utf8'))); res.on('error', no);
}));

/** Stream the gzip'd tar and keep the first files `want(name)` accepts, up to `limit`. */
function takeFromTar(url, want, limit) {
  return new Promise((ok, no) => {
    const got = [];
    let req = null, buf = Buffer.alloc(0), done = false;
    const finish = () => { if (done) return; done = true; try { req?.destroy(); } catch {} ok(got); };
    req = fetchFollow(url, (e, res) => {
      if (e) return no(e);
      const gz = createGunzip();
      res.pipe(gz);
      gz.on('error', (err) => (done ? null : no(err)));
      gz.on('data', (chunk) => {
        if (done) return;
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 512) break;
          const h = buf.subarray(0, 512);
          if (h.every((b) => b === 0)) { finish(); return; }
          const cstr = (a, b) => { const s = h.subarray(a, b); const z = s.indexOf(0); return s.toString('utf8', 0, z < 0 ? s.length : z); };
          const prefix = cstr(345, 500);
          const name = (prefix ? `${prefix}/` : '') + cstr(0, 100);
          const size = parseInt(cstr(124, 136).trim() || '0', 8);
          const total = 512 + Math.ceil(size / 512) * 512;
          if (buf.length < total) break;
          const type = String.fromCharCode(h[156] || 48);
          const leaf = name.split('/').pop();
          if (type === '0' && want(leaf)) got.push({ name: leaf, data: Buffer.from(buf.subarray(512, 512 + size)) });
          buf = buf.subarray(total);
          if (got.length >= limit) { finish(); return; }
        }
      });
      gz.on('end', finish);
    });
    req.on('error', (err) => (done ? null : no(err)));
  });
}

for (const lang of langs) {
  const cfg = CONFIGS[lang];
  if (!cfg) throw new Error(`unknown lang ${lang}`);
  const tsv = await fetchText(`${base}/${cfg}/test.tsv`);
  const rows = new Map();
  for (const line of tsv.split('\n')) {
    const c = line.split('\t');
    if (c.length < 7) continue;
    rows.set(c[1], { fleurs_id: c[0], file: c[1], raw: c[2], normalized: c[3], samples: Number(c[5]), gender: c[6].trim() });
  }
  const seenIds = new Set();
  const want = (leaf) => {
    const r = rows.get(leaf);
    if (!r || seenIds.has(r.fleurs_id)) return false;
    seenIds.add(r.fleurs_id);
    return true;
  };
  console.log(`[fleurs] ${lang} (${cfg}): ${rows.size} transcripts; streaming the archive for ${n} distinct sentences ...`);
  const files = await takeFromTar(`${base}/${cfg}/audio/test.tar.gz`, want, n);
  const rawDir = join(outDir, 'raw', cfg);
  mkdirSync(rawDir, { recursive: true });
  files.forEach((f, i) => {
    const id = `${lang}-fl-${String(i + 1).padStart(2, '0')}`;
    const rawPath = join(rawDir, f.name);
    writeFileSync(rawPath, f.data);
    const out = join(outDir, `${id}.wav`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', rawPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed on ${rawPath}: ${r.stderr}`);
    const sec = +pcmSeconds(readWav(out)).toFixed(2);
    const row = rows.get(f.name);
    index.items[id] = { lang, config: cfg, fleurs_id: row.fleurs_id, source_file: f.name, raw_transcription: row.raw, normalized: row.normalized, gender: row.gender, sec };
    console.log(`  ${id} ${sec}s ${row.raw.slice(0, 70)}`);
  });
}
writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`[fleurs] wrote ${indexPath}`);
