// Card IMG-COPY (owner P0, 2026-08-25) — what the timeline's copy button copies.
//
// 🔴 BYTES, NOT CALLS. "we called ClipboardItem" proves nothing; every image
// case below compares the planned payload against the source picture byte for
// byte. The false-success case (an un-captioned picture with no preview used to
// writeText('') and tick) gets its own test, and so does the rendered result —
// no button is offered for such a row, while a text row keeps its button
// (positive control).
//
// 🔴 REVERSE CONTROL (seen red, recorded in the commit): with the
// `row.full_image === true` branch deleted from planRowCopy, two cases fail —
//   AssertionError: expected "spy" to be called with arguments: [ 'pic' ]
//   (the original was never read from disk; the thumbnail bytes would have
//   been copied under a row that has the original)
//   AssertionError: expected { kind: 'none', reason: 'no-image' } to match
//   object { kind: 'image', … }  (a JPEG original with no thumbnail: nothing copied)
// — 2 failed / 11 passed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineRow } from '../lib/types';
import type { RetentionFacts } from '../lib/timeline-store';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- hoisted before imports
  const { reactive, ref } = require('vue') as typeof import('vue');
  return {
    entries: ref<TimelineRow[]>([]),
    timelineFailure: ref<null>(null),
    timelineQuery: ref(''),
    timelineRetention: ref<RetentionFacts>({ kept: 0, cutoff: null, cutoffs: { text: null, images: null } }),
    timelineStorageFailed: ref(false),
    mobileNames: reactive<Record<string, string>>({}),
    mobileMachines: reactive<Record<string, string | null>>({}),
    timeline: {
      edit: vi.fn(),
      remove: vi.fn(),
      reInject: vi.fn(),
      refresh: vi.fn(),
      search: vi.fn(),
      clearSearch: vi.fn(),
      clearFailure: vi.fn(),
      textOf: vi.fn(),
      allRows: vi.fn(() => [] as TimelineRow[]),
    },
    rowImage: vi.fn(async () => null as string | null),
  };
});

vi.mock('./store', () => ({
  entries: h.entries,
  timelineFailure: h.timelineFailure,
  timelineQuery: h.timelineQuery,
  timelineRetention: h.timelineRetention,
  timelineStorageFailed: h.timelineStorageFailed,
  mobileNames: h.mobileNames,
  mobileMachines: h.mobileMachines,
  timeline: h.timeline,
  rowImage: h.rowImage,
}));

const { createSSRApp } = await import('vue');
const { renderToString } = await import('vue/server-renderer');
const TimelinePage = (await import('./TimelinePage.vue')).default;
const { S } = await import('../lib/strings');
const { b64Bytes, canCopyRow, dataUrlBytes, performRowCopy, planRowCopy } = await import('./timeline-copy');

function row(over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id: 'r1',
    mode: 'realtime',
    status: 'injected',
    edited: false,
    source_text: null,
    output_text: 'hello from the sidecar',
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-30T10:00:00.000Z',
    entry_type: 'transcript',
    control_kind: null,
    control_outcome: null,
    thumb_b64: null,
    full_image: false,
    target: null,
    channel: 'lan',
    device_label: null,
    mobile_id: null,
    ...over,
  } as TimelineRow;
}

/** A tiny but REAL PNG (1×1, from the PNG spec's smallest valid file), so the
 *  original and the thumbnail are two different byte strings a test can tell
 *  apart — and so a decoder given the plan would accept it. */
const ORIGINAL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
/** The "thumbnail": a different byte string on purpose (one byte flipped in the
 *  IDAT), so `source: 'thumb'` and `source: 'original'` can never be confused by
 *  a test that only checks length. */
const THUMB_PNG = (() => {
  const t = new Uint8Array(ORIGINAL_PNG);
  t[45] = (t[45] ?? 0) ^ 0xff;
  return t;
})();
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const dataUrl = (bytes: Uint8Array, mime = 'image/png'): string => `data:${mime};base64,${b64(bytes)}`;

afterEach(() => {
  h.rowImage.mockReset();
  h.rowImage.mockResolvedValue(null);
  h.timeline.textOf.mockReset();
  h.entries.value = [];
});

describe('planRowCopy — bytes', () => {
  it('🔴 an image row with an original copies the ORIGINAL, byte for byte — never the thumbnail', async () => {
    const rowImage = vi.fn(async (id: string) => (id === 'pic' ? dataUrl(ORIGINAL_PNG) : null));
    const plan = await planRowCopy(row({ id: 'pic', entry_type: 'image', full_image: true, thumb_b64: b64(THUMB_PNG), output_text: '' }), {
      rowImage,
      textOf: () => '',
    });
    expect(rowImage).toHaveBeenCalledWith('pic');
    expect(plan.kind).toBe('image');
    if (plan.kind !== 'image') throw new Error('unreachable');
    expect(plan.source).toBe('original');
    expect(plan.mime).toBe('image/png');
    expect(Array.from(plan.bytes)).toEqual(Array.from(ORIGINAL_PNG));
    expect(Array.from(plan.bytes)).not.toEqual(Array.from(THUMB_PNG));
  });

  it('no original ⇒ the thumbnail, byte for byte, and SAID to be the thumbnail', async () => {
    const plan = await planRowCopy(row({ entry_type: 'image', full_image: false, thumb_b64: b64(THUMB_PNG), output_text: '' }), {
      rowImage: async () => null,
      textOf: () => '',
    });
    expect(plan.kind).toBe('image');
    if (plan.kind !== 'image') throw new Error('unreachable');
    expect(plan.source).toBe('thumb');
    expect(Array.from(plan.bytes)).toEqual(Array.from(THUMB_PNG));
  });

  it('the row claims an original but the disk does not answer ⇒ the thumbnail, not nothing', async () => {
    const plan = await planRowCopy(row({ entry_type: 'image', full_image: true, thumb_b64: b64(THUMB_PNG), output_text: '' }), {
      rowImage: async () => null,
      textOf: () => '',
    });
    expect(plan).toMatchObject({ kind: 'image', source: 'thumb' });
  });

  it('a JPEG original keeps its mime (the clipboard item is typed by the file, not by assumption)', async () => {
    const jpegish = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const plan = await planRowCopy(row({ entry_type: 'image', full_image: true, thumb_b64: null, output_text: '' }), {
      rowImage: async () => dataUrl(jpegish, 'image/jpeg'),
      textOf: () => '',
    });
    expect(plan).toMatchObject({ kind: 'image', source: 'original', mime: 'image/jpeg' });
    if (plan.kind !== 'image') throw new Error('unreachable');
    expect(Array.from(plan.bytes)).toEqual(Array.from(jpegish));
  });

  it('a text row copies its current store text', async () => {
    const plan = await planRowCopy(row({ output_text: 'x' }), { rowImage: async () => null, textOf: () => 'the store text' });
    expect(plan).toEqual({ kind: 'text', text: 'the store text' });
  });
});

describe('🔴 the false-success case: an empty string never reaches the clipboard', () => {
  it('un-captioned image, no preview, no original ⇒ NONE (this used to be writeText("") + a tick)', async () => {
    const plan = await planRowCopy(row({ entry_type: 'image', full_image: false, thumb_b64: null, output_text: '' }), {
      rowImage: async () => null,
      textOf: () => '',
    });
    expect(plan).toEqual({ kind: 'none', reason: 'no-image' });
  });

  it('a text row whose store text is the EMPTY STRING ⇒ NONE — `"" === null` is false and that was the bug', async () => {
    const plan = await planRowCopy(row(), { rowImage: async () => null, textOf: () => '' });
    expect(plan).toEqual({ kind: 'none', reason: 'empty-text' });
  });

  it('a text row that is gone from the store (null) ⇒ NONE, silently is not an option', async () => {
    const plan = await planRowCopy(row(), { rowImage: async () => null, textOf: () => null });
    expect(plan).toEqual({ kind: 'none', reason: 'empty-text' });
  });

  it('canCopyRow: no button for the un-captioned no-preview picture, for an empty text row, or for a control row', () => {
    expect(canCopyRow(row({ entry_type: 'image', full_image: false, thumb_b64: null, output_text: '' }))).toBe(false);
    expect(canCopyRow(row({ output_text: '' }))).toBe(false);
    expect(canCopyRow(row({ entry_type: 'control', output_text: '' }))).toBe(false);
    // Positive controls — the gate is not simply "false".
    expect(canCopyRow(row({ entry_type: 'image', full_image: true, thumb_b64: null, output_text: '' }))).toBe(true);
    expect(canCopyRow(row({ entry_type: 'image', full_image: false, thumb_b64: 'AAAA', output_text: '' }))).toBe(true);
    expect(canCopyRow(row({ output_text: 'words' }))).toBe(true);
  });

  it('【rendered-result】 the page offers NO copy button on such a row, and DOES on a text row', async () => {
    h.entries.value = [
      row({ id: 'empty-pic', entry_type: 'image', full_image: false, thumb_b64: null, output_text: '' }),
      row({ id: 'words', output_text: 'a real sentence' }),
    ];
    const html = await renderToString(createSSRApp(TimelinePage));
    expect(html).toContain('a real sentence'); // positive control: the list rendered
    const copyTitles = (html.match(new RegExp(`title="${S.op_copy}"`, 'g')) ?? []).length;
    expect(copyTitles, 'the text row keeps its copy button').toBe(1);
    expect(html).not.toContain(`title="${S.op_copy_image}"`);
    expect(html).not.toContain(`title="${S.op_copy_image_preview}"`);
  });

  it('【rendered-result】 the title names the original vs. the preview', async () => {
    h.entries.value = [
      row({ id: 'orig', entry_type: 'image', full_image: true, thumb_b64: b64(THUMB_PNG), output_text: '' }),
      row({ id: 'thumb-only', entry_type: 'image', full_image: false, thumb_b64: b64(THUMB_PNG), output_text: '' }),
    ];
    const html = await renderToString(createSSRApp(TimelinePage));
    expect(html).toContain(`title="${S.op_copy_image}"`);
    expect(html).toContain(`title="${S.op_copy_image_preview}"`);
    // The old claim is gone from the user's eyes as well as from the code.
    expect(S.op_copy_image).not.toMatch(/256/);
  });
});

describe('the decoders', () => {
  it('dataUrlBytes round-trips bytes and mime; anything else is null', () => {
    const d = dataUrlBytes(dataUrl(ORIGINAL_PNG));
    expect(d?.mime).toBe('image/png');
    expect(Array.from(d!.bytes)).toEqual(Array.from(ORIGINAL_PNG));
    expect(dataUrlBytes('not a data url')).toBeNull();
    expect(dataUrlBytes('data:image/png;base64,***')).toBeNull();
  });

  it('b64Bytes is exact', () => {
    expect(Array.from(b64Bytes(b64(ORIGINAL_PNG)))).toEqual(Array.from(ORIGINAL_PNG));
  });
});

describe('performRowCopy — which door (addendum ③: the originals on the owner machine are JPEG)', () => {
  function writers() {
    return {
      writeText: vi.fn<(text: string) => Promise<void>>(async () => {}),
      writeImage: vi.fn<(mime: string, bytes: Uint8Array) => Promise<void>>(async () => {}),
      native: vi.fn<(id: string, thumb: string | null) => Promise<{ ok: true } | { ok: false; reason: string }>>(
        async () => ({ ok: true as const }),
      ),
    };
  }

  it('a PNG plan goes through the browser clipboard, byte for byte, under image/png', async () => {
    const w = writers();
    const out = await performRowCopy({ kind: 'image', bytes: ORIGINAL_PNG, mime: 'image/png', source: 'original' }, row({ id: 'p' }), w);
    expect(out).toEqual({ wrote: 'image-browser' });
    expect(w.writeImage).toHaveBeenCalledTimes(1);
    expect(w.writeImage.mock.calls[0]?.[0]).toBe('image/png');
    expect(Array.from(w.writeImage.mock.calls[0]?.[1] ?? [])).toEqual(Array.from(ORIGINAL_PNG));
    expect(w.native).not.toHaveBeenCalled();
  });

  it('🔴 a JPEG original goes through the NATIVE command — never through the browser under a false image/png', async () => {
    const w = writers();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const out = await performRowCopy({ kind: 'image', bytes: jpeg, mime: 'image/jpeg', source: 'original' }, row({ id: 'j', thumb_b64: 'AAAA' }), w);
    expect(out).toEqual({ wrote: 'image-native' });
    expect(w.writeImage).not.toHaveBeenCalled();
    expect(w.native).toHaveBeenCalledWith('j', 'AAAA');
  });

  it('a refused native write is a NO-TICK outcome with its reason', async () => {
    const w = writers();
    w.native.mockResolvedValueOnce({ ok: false, reason: 'no clipboard image write on this platform' } as never);
    const out = await performRowCopy({ kind: 'image', bytes: new Uint8Array([1]), mime: 'image/webp', source: 'original' }, row({ id: 'w' }), w);
    expect(out).toEqual({ wrote: null, reason: 'no clipboard image write on this platform' });
  });

  it('text goes through writeText; `none` writes NOTHING (the P0)', async () => {
    const w = writers();
    expect(await performRowCopy({ kind: 'text', text: 'hi' }, row(), w)).toEqual({ wrote: 'text' });
    expect(w.writeText).toHaveBeenCalledWith('hi');
    const w2 = writers();
    expect(await performRowCopy({ kind: 'none', reason: 'empty-text' }, row(), w2)).toEqual({ wrote: null, reason: 'empty-text' });
    expect(w2.writeText).not.toHaveBeenCalled();
    expect(w2.writeImage).not.toHaveBeenCalled();
    expect(w2.native).not.toHaveBeenCalled();
  });
});
