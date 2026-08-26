// Card IMG-COPY (owner P0, 2026-08-25) — the capsule strip's picture row: a
// preview you can actually recognise, and a copy button that copies the
// PICTURE through its own native command.
//
// Two layers, same technique as recent.test.ts / capsule-copy.test.ts:
//   · the pure narrowing (`toRecentLine` carries `full_image` → `fullImage`,
//     absent ⇒ false, never guessed true);
//   · the SFC read literally (the button is gated on the picture gate, wired
//     to `copyRowImage`, titled original-vs-preview; the preview is larger than
//     the 16px badge; the command is registered in lib.rs and does not import
//     the injection paste path).
//
// The BYTE promise itself lives where the bytes are: src-tauri/src/shell/
// clipboard_image.rs `the_png_clipboard_entry_is_the_original_file_byte_for_byte`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toRecentLine } from './recent-line';
import type { WireHistoryItem } from '../lib/types';

const capsuleVue = readFileSync(fileURLToPath(new URL('./CapsuleApp.vue', import.meta.url)), 'utf8');
const bridgeClipboard = readFileSync(fileURLToPath(new URL('../lib/bridge-clipboard.ts', import.meta.url)), 'utf8');
const rustCmd = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/shell/clipboard_image.rs', import.meta.url)),
  'utf8',
);
const rustLib = readFileSync(fileURLToPath(new URL('../../src-tauri/src/lib.rs', import.meta.url)), 'utf8');

function item(over: Partial<WireHistoryItem> = {}): WireHistoryItem {
  return {
    id: 'pic-1',
    mode: 'realtime',
    status: 'injected',
    source_text: null,
    output_text: '',
    created_at: '2026-08-25T10:00:00.000Z',
    updated_at: '2026-08-25T10:00:00.000Z',
    entry_type: 'image',
    thumb_b64: 'AAAA',
    ...over,
  } as WireHistoryItem;
}

describe('toRecentLine carries whether the ORIGINAL was kept', () => {
  it('full_image:true ⇒ fullImage:true', () => {
    expect(toRecentLine(item({ full_image: true }), 'lan')?.fullImage).toBe(true);
  });
  it('absent / false / off-contract ⇒ false, never guessed', () => {
    expect(toRecentLine(item(), 'lan')?.fullImage).toBe(false);
    expect(toRecentLine(item({ full_image: false }), 'lan')?.fullImage).toBe(false);
    expect(toRecentLine(item({ full_image: 'yes' as unknown as boolean }), 'lan')?.fullImage).toBe(false);
  });
});

describe('the strip (CapsuleApp.vue, read literally)', () => {
  // The SFC nests `<template v-if>` blocks, so a non-greedy `<template>…</template>`
  // match stops at the first inner one; the markup is everything before <style>.
  const tpl = capsuleVue.slice(capsuleVue.indexOf('<template>'), capsuleVue.indexOf('<style'));
  const css = capsuleVue.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';

  it('the copy-picture button exists, is gated on the picture gate, and calls the picture door', () => {
    expect(tpl).toContain('v-if="canCopyImageLine(l)"');
    expect(tpl).toContain('@click="copyImageLine(l)"');
    expect(capsuleVue).toContain("import { copyRowImage } from '../lib/bridge-clipboard';");
    expect(capsuleVue).toContain('copyRowImage(l.id, l.thumb)');
  });

  it('the title names the ORIGINAL vs. the 256px PREVIEW off fullImage — one fact, not a guess', () => {
    expect(tpl).toContain('l.fullImage ? S.op_copy_image : S.op_copy_image_preview');
  });

  it('the gate omits (never disables) a picture row with neither an original nor a preview', () => {
    expect(capsuleVue).toMatch(/function canCopyImageLine\(l: RecentLine\): boolean \{\s*return l\.entryType === 'image' && \(l\.fullImage \|\| l\.thumb !== null\);/);
    expect(tpl).not.toMatch(/rcopy-img[\s\S]{0,300}:disabled/);
  });

  it('a refused write is never silent: ✗ state + forensic line', () => {
    const fn = capsuleVue.slice(capsuleVue.indexOf('async function copyImageLine'), capsuleVue.indexOf('function canCopyImageLine'));
    expect(fn).toContain("[l.id]: 'error'");
    expect(fn).toContain("appendForensic('capsule', `copy image row ${l.id} FAILED: ${result.reason}`)");
  });

  it('the preview is larger than the 16px badge it replaced', () => {
    const rule = css.match(/\.rimg \{([^}]*)\}/)?.[1] ?? '';
    const w = Number(/width:\s*(\d+)px/.exec(rule)?.[1]);
    const h = Number(/height:\s*(\d+)px/.exec(rule)?.[1]);
    expect(w).toBeGreaterThan(16);
    expect(h).toBeGreaterThan(16);
    expect(css).toContain('.rimg img { width: 100%; height: 100%; object-fit: cover; display: block; }');
  });
});

describe('the door and the command', () => {
  it('bridge-clipboard goes through invokeVerbose (bridge.ts stays the one @tauri-apps importer)', () => {
    expect(bridgeClipboard).toContain("import { invokeVerbose } from './bridge';");
    // Comments stripped: the header NAMES the package in order to say why it is
    // not imported, and a guard that reads its own explanation as a violation
    // is the trap polish-capability-notice.test.ts recorded.
    expect(bridgeClipboard.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('@tauri-apps');
    expect(bridgeClipboard).toContain("invokeVerbose('capsule_copy_image', { id, thumb })");
  });

  it('the Rust command is registered', () => {
    expect(rustLib).toContain('shell::clipboard_image::capsule_copy_image');
  });

  it('🔴 the Rust command does NOT reuse the injection paste path (the 0.3.26/0.3.27 P0 lives there)', () => {
    const code = rustCmd.replace(/\/\/.*$/gm, '');
    for (const forbidden of ['clipboard_paste', 'clipboard_hold', 'clipboard_confirm', 'clipboard_withdraw', 'PASTE_LOCK', 'save_clipboard', 'restore_clipboard']) {
      expect(code, `clipboard_image.rs reaches into ${forbidden}`).not.toContain(forbidden);
    }
    // Positive control: it does write — through the plain forward-write helper.
    expect(code).toContain('write_clipboard_formats(table)');
    expect(code).toContain('row_image::find_in');
  });
});
