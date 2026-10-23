#!/usr/bin/env node
// scripts/eval/speech-quality/gen-audio.mjs — TTS audio bed for the corpus.
//
//   node scripts/eval/speech-quality/gen-audio.mjs            # missing/changed only
//   node scripts/eval/speech-quality/gen-audio.mjs --force    # regenerate all
//   node scripts/eval/speech-quality/gen-audio.mjs --ids en-jar-01,zh-01
//   node scripts/eval/speech-quality/gen-audio.mjs --variants-only
//
// Renders each corpus item with macOS `say` on the Mac mini (`ssh flowmic-mac`)
// straight to WAV 16 kHz mono s16le, pulls the files back as one tar stream,
// and writes them to <main checkout>/.local/eval-audio/ (gitignored: audio is
// NEVER committed). Variants (quiet onset, mild noise) are synthesised here on
// the local side from the base file, so they need no extra tooling on the Mac
// (it has neither sox nor ffmpeg; measured 2026-10-13).
//
// The Mac has FileVault on. This script only runs `say`, `base64`, `tar`,
// `mkdir` and `rm -rf` of its own scratch directory under $HOME. It must never
// reboot the machine or change a setting: a reboot strands it at the unlock
// screen until someone is physically there.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_DIR, loadCorpus, parseArgs, pcmSeconds, readWav, writeWav } from './lib.mjs';

const args = parseArgs();
const host = args.host ?? 'flowmic-mac';
const corpus = loadCorpus();
const outDir = AUDIO_DIR();
mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { items: {} };

const fp = (it) => createHash('sha256').update(`${it.voice}\n${it.speak_text}`).digest('hex').slice(0, 16);
const want = args.ids ? new Set(String(args.ids).split(',')) : null;
// Items with `audio` are recordings (card ML-0: FLEURS), not TTS.
const todo = corpus.items.filter((it) => !it.audio && (!want || want.has(it.id))
  && (args.force || manifest.items[it.id]?.fp !== fp(it) || !existsSync(join(outDir, `${it.id}.wav`))));

/** Minimal ustar reader (regular files only; macOS bsdtar --format ustar). */
function untar(buf) {
  const files = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const cstr = (a, b) => { const s = h.subarray(a, b); const z = s.indexOf(0); return s.toString('utf8', 0, z < 0 ? s.length : z); };
    const name = cstr(0, 100).replace(/^\.\//, '');
    const size = parseInt(cstr(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    if (type === '0') files.push({ name, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const ssh = (cmd, opts = {}) => spawnSync('ssh', ['-o', 'BatchMode=yes', host, cmd], { maxBuffer: 1 << 30, ...opts });

if (!args['variants-only'] && todo.length > 0) {
  const remote = `flowmic-eval-tts-${Date.now()}`;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const lines = ['set -euo pipefail', `D="$HOME/${remote}"`, 'mkdir -p "$D"', 'cd "$D"'];
  for (const it of todo) {
    // Text and voice both travel base64 so no quoting rule (CJK, apostrophes,
    // full-width parentheses in voice names) can bend them on the way.
    lines.push(`printf %s '${b64(it.speak_text)}' | base64 -D > '${it.id}.txt'`);
    lines.push(`V="$(printf %s '${b64(it.voice)}' | base64 -D)"`);
    lines.push(`say -v "$V" -f '${it.id}.txt' -o '${it.id}.wav' --file-format=WAVE --data-format=LEI16@16000`);
  }
  lines.push('echo DONE');
  console.log(`[gen-audio] rendering ${todo.length} item(s) on ${host} ...`);
  const r1 = ssh('bash -s', { input: lines.join('\n') + '\n', encoding: 'utf8' });
  if (r1.status !== 0 || !r1.stdout.includes('DONE')) {
    console.error(r1.stderr || r1.stdout);
    ssh(`rm -rf "$HOME/${remote}"`);
    process.exit(1);
  }
  const r2 = ssh(`cd "$HOME/${remote}" && COPYFILE_DISABLE=1 tar --format ustar -cf - *.wav`);
  ssh(`rm -rf "$HOME/${remote}"`);
  if (r2.status !== 0) { console.error(String(r2.stderr)); process.exit(1); }
  // Unpacked in-process rather than by a local `tar`: Git Bash's GNU tar reads
  // "F:/..." as a remote host spec, and which tar is first on PATH differs per shell.
  for (const f of untar(r2.stdout)) if (/^[\w.-]+\.wav$/.test(f.name)) writeFileSync(join(outDir, f.name), f.data);
  for (const it of todo) {
    const pcm = readWav(join(outDir, `${it.id}.wav`)); // throws unless 16 kHz mono s16le
    manifest.items[it.id] = { fp: fp(it), voice: it.voice, sec: +pcmSeconds(pcm).toFixed(2), generated: new Date().toISOString() };
  }
}

// ── variants ────────────────────────────────────────────────────────────────
// Deterministic PRNG so the "noise" file is the same bytes on every run.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function gauss(r) { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const { onset_silence_sec: onsets, noise_snr_db: snrDb, ids: variantIds } = corpus.variants;
manifest.variants = manifest.variants ?? {};
for (const id of variantIds) {
  if (want && !want.has(id)) continue;
  if (!existsSync(join(outDir, `${id}.wav`))) continue;
  const base = readWav(join(outDir, `${id}.wav`));
  for (const s of onsets.filter((x) => x > 0)) {
    const name = `${id}__onset${s}`;
    writeWav(join(outDir, `${name}.wav`), Buffer.concat([Buffer.alloc(Math.round(s * 16000) * 2), base]));
    manifest.variants[name] = { base: id, kind: 'onset', onset_sec: s, sec: +(pcmSeconds(base) + s).toFixed(2) };
  }
  // Mild white noise at `snrDb` relative to the RMS of the voiced samples.
  const n = base.length / 2;
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) { const v = base.readInt16LE(i * 2); if (Math.abs(v) > 300) { sum += v * v; cnt++; } }
  const noiseRms = Math.sqrt(sum / Math.max(1, cnt)) / 10 ** (snrDb / 20);
  const r = rng(createHash('sha256').update(id).digest().readUInt32LE(0));
  const out = Buffer.alloc(base.length);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(base.readInt16LE(i * 2) + gauss(r) * noiseRms))), i * 2);
  const name = `${id}__noise${snrDb}`;
  writeWav(join(outDir, `${name}.wav`), out);
  manifest.variants[name] = { base: id, kind: 'noise', snr_db: snrDb, sec: +pcmSeconds(base).toFixed(2) };
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const total = Object.values(manifest.items).reduce((a, x) => a + x.sec, 0);
const vtotal = Object.values(manifest.variants).reduce((a, x) => a + x.sec, 0);
console.log(`[gen-audio] ${Object.keys(manifest.items).length} base files = ${(total / 60).toFixed(1)} min; ${Object.keys(manifest.variants).length} variants = ${(vtotal / 60).toFixed(1)} min -> ${outDir}`);
