import { describe, expect, it } from 'vitest';
import { injectProvenanceTooltip } from './inject-provenance';

describe('injectProvenanceTooltip (T-7)', () => {
  it('returns null when status is not injected', () => {
    expect(
      injectProvenanceTooltip('cached', {
        window_title: 'WeChat',
        process_name: 'WeChat',
        injected_at: '2026-07-25T10:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('returns null when target or injected_at is missing (never fabricates)', () => {
    expect(injectProvenanceTooltip('injected', null)).toBeNull();
    expect(
      injectProvenanceTooltip('injected', {
        window_title: 'WeChat',
        process_name: 'WeChat',
      }),
    ).toBeNull();
    expect(
      injectProvenanceTooltip('injected', {
        window_title: 'WeChat',
        process_name: 'WeChat',
        injected_at: '',
      }),
    ).toBeNull();
    expect(
      injectProvenanceTooltip('injected', {
        window_title: '',
        process_name: '',
        injected_at: '2026-07-25T10:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('formats "Injected into {title} · {time}" (注入到 {title} · {time}) from real fields', () => {
    const tip = injectProvenanceTooltip('injected', {
      window_title: 'Outlook',
      process_name: 'OUTLOOK',
      injected_at: '2026-07-25T10:00:00.000Z',
    });
    expect(tip).toMatch(/^注入到 Outlook · /);
  });

  it('falls back to process_name when window_title is empty', () => {
    const tip = injectProvenanceTooltip('injected', {
      window_title: '',
      process_name: 'WeChat',
      injected_at: '2026-07-25T10:00:00.000Z',
    });
    expect(tip).toMatch(/^注入到 WeChat · /);
  });
});
