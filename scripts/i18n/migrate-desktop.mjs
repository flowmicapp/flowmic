#!/usr/bin/env node
// scripts/i18n/migrate-desktop.mjs
//
// The ONE-TIME source rewrite for the desktop-webview migration: turn each
// shard's four per-locale blocks into a KEY CONTRACT, with the strings gone to
// i18n/desktop/ and every comment still standing beside the key it explains.
//
// 🔴 THE COMMENTS ARE THE POINT. This catalogue carries ~500 lines of reasoning
// inside the objects being deleted — 「这张绿脸与时间线的 ✓ 说的是同一个状态」,
// 「`cloud_expires` 已删除，它渲染的是 Cloud Key 的 exp 却挂在订阅那一行」, the
// three-paragraph account of why the capsule may not say 「未投递」. That half of
// the catalogue is worth more than the strings, and a migration that quietly
// dropped it would be a net loss no test could see. So:
//   · comments inside the AUTHORED block stay exactly where they are, in order,
//     against the same key;
//   · comments inside a TRANSLATION's block are carried across with a `[ja]`
//     tag — they are notes about that language's rendering and have nowhere
//     else to live once the block is data;
//   · everything outside the object literal (file header, imports, derived
//     tables) is untouched, byte for byte.
//
//
// 🔴 THIS PAIR HAS ALREADY RUN, AND ITS INPUT NO LONGER EXISTS. The shards now
// declare key contracts (`export const NAV_KEYS = [...]`) instead of four
// per-locale blocks, so `parseCatalogue(src, 'NAV_STRINGS')` throws 「not
// found」 — that is the migration having happened, not a defect. Kept, and kept
// runnable-looking, for two reasons that are worth the confusion this note
// exists to prevent: it is the record of HOW the data files were produced (the
// only answer to 「where did i18n/desktop/en.json come from」), and its parser
// is imported by migrate-desktop.mjs and snapshot-desktop-rendered.mjs.
// Same shape and same decision as scripts/i18n/extract-mobile-strings.mjs.
//
// Idempotent: a shard that already declares `*_KEYS` is skipped.
//
// Usage:
//   node scripts/i18n/migrate-desktop.mjs --dry     # report only
//   node scripts/i18n/migrate-desktop.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, SHARD_DIR, SHARDS, parseCatalogue, parseObject } from './extract-desktop-strings.mjs';

/** `NAV_STRINGS` -> `NAV_KEYS`. */
function keysName(constName) {
  return constName.replace(/_STRINGS$/, '_KEYS');
}

/** Re-indent a comment captured at 4 spaces (inside a locale block) to the 2
 *  spaces of the key list. Block comments keep their internal alignment. */
function reindent(text, from = '    ', to = '  ') {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.startsWith(from) ? to + line.slice(from.length) : line))
    .join('\n');
}

function rewriteShard(file, constName) {
  const abs = path.join(SHARD_DIR, `${file}.ts`);
  const src = readFileSync(abs, 'utf8');
  const keysConst = keysName(constName);
  if (src.includes(`export const ${keysConst} =`)) return { file, skipped: true };

  const cat = parseCatalogue(src, constName);
  const localeBlocks = cat.items.filter((it) => it.kind === 'entry');
  const blocks = new Map(localeBlocks.map((it) => [it.key, it]));
  // The block the comments live in is the FIRST one, read from the file rather
  // than named here: this catalogue was authored in Chinese and every shard
  // puts that block first, which is a fact of the source and not a rule about
  // languages. Naming it would have been one more hand-rolled locale list.
  const authored = localeBlocks[0].key;

  // The authored block, verbatim, minus the values.
  const lines = [];
  const authoredObj = parseObject(src, blocks.get(authored).valueStart);
  for (const item of authoredObj.items) {
    if (item.kind === 'comment') lines.push(`  ${reindent(item.text)}`);
    else lines.push(`  '${item.key}',`);
  }

  // Notes recorded against a translation's block.
  const notes = [];
  for (const loc of localeBlocks.slice(1).map((b) => b.key)) {
    const obj = parseObject(src, blocks.get(loc).valueStart);
    for (const item of obj.items) {
      if (item.kind !== 'comment') continue;
      notes.push(
        item.text
          .split('\n')
          .map((l, i) => (i === 0 ? `// [${loc}] ${l.replace(/^\/\/\s?/, '')}` : `// ${l.trim().replace(/^\/\/\s?/, '')}`))
          .join('\n'),
      );
    }
  }

  const notesBlock = notes.length
    ? '\n// Notes that were recorded against a TRANSLATION rather than against the\n' +
      '// key itself. Carried across verbatim (only the language tag is new): they\n' +
      '// explain a rendering choice in one language, and the block they lived in\n' +
      '// is now a data file that cannot hold them.\n' +
      `${notes.join('\n')}\n`
    : '';

  const replacement =
    `export const ${keysConst} = [\n${lines.join('\n')}\n] as const;\n` +
    notesBlock +
    `\nexport const ${constName} = shardCatalogue(${keysConst});`;

  const out = src.slice(0, cat.start) + replacement + src.slice(cat.end);
  return { file, src, out, abs, keys: authoredObj.items.filter((i) => i.kind === 'entry').length, notes: notes.length };
}

function main() {
  const dry = process.argv.includes('--dry');
  let keys = 0;
  let notes = 0;
  for (const [file, constName] of SHARDS) {
    const r = rewriteShard(file, constName);
    if (r.skipped) {
      console.log(`  = ${file}.ts already migrated`);
      continue;
    }
    keys += r.keys;
    notes += r.notes;
    console.log(`  ${dry ? '·' : '✓'} ${file}.ts — ${r.keys} key(s), ${r.notes} translation note(s)`);
    if (!dry) writeFileSync(r.abs, r.out);
  }
  console.log(`${dry ? 'would rewrite' : 'rewrote'}: ${keys} key(s), ${notes} note(s) carried across`);
  console.log('next: add the `shardCatalogue` import by hand where it is missing, then');
  console.log('      node scripts/i18n/gen-desktop-ts.mjs');
}

void ROOT;
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
