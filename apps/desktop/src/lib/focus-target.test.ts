// GA-25 — the capsule "inject target" (注入目标) decision. The bug this locks down: `state.target`
// used to be written ONLY by inject:result, so the capsule advertised where the
// LAST utterance landed rather than where the next one would go.
//
// B1 (2026-08-11): live path must fall back to process_name when window_title is
// empty — same shape as inject:result display. macOS titles are structurally "".

import { describe, expect, it } from 'vitest';
import { injectableTarget, nextFocusTarget, parseFocusChanged } from './focus-target';

const ev = (window_title: string, process_name = 'notepad') => ({ window_title, process_name });

describe('parseFocusChanged', () => {
  it('collapses junk / missing fields to empty strings (never throws)', () => {
    expect(parseFocusChanged(null)).toEqual({ window_title: '', process_name: '' });
    expect(parseFocusChanged({ window_title: 7 })).toEqual({ window_title: '', process_name: '' });
    expect(parseFocusChanged(ev('无标题 - 记事本'))).toEqual({
      window_title: '无标题 - 记事本',
      process_name: 'notepad',
    });
  });
});

describe('injectableTarget — never fabricate a destination', () => {
  it('a real foreground window shows its title (title wins over process_name)', () => {
    expect(injectableTarget(ev('无标题 - 记事本'))).toBe('无标题 - 记事本');
    expect(injectableTarget(ev('Untitled - Notepad', 'notepad'))).toBe('Untitled - Notepad');
  });

  it('empty title + process_name falls back to the process name (mac live path)', () => {
    expect(injectableTarget({ window_title: '', process_name: 'TextEdit' })).toBe('TextEdit');
  });

  it('empty title + self process is not an injectable target', () => {
    expect(injectableTarget({ window_title: '', process_name: 'flowmic-desktop' })).toBe('');
    expect(injectableTarget({ window_title: '', process_name: 'FlowMic' })).toBe('');
  });

  it('empty title and empty process_name → no target', () => {
    expect(injectableTarget({ window_title: '', process_name: '' })).toBe('');
  });

  it('our OWN window is not an injectable target (even with a title)', () => {
    expect(injectableTarget({ window_title: 'FlowMic', process_name: 'flowmic-desktop' })).toBe('');
    expect(injectableTarget({ window_title: 'FlowMic', process_name: 'FlowMic' })).toBe('');
  });

  it('the shell DESKTOP is not a target, but a File Explorer window is', () => {
    expect(injectableTarget({ window_title: 'Program Manager', process_name: 'explorer' })).toBe('');
    expect(injectableTarget({ window_title: '下载', process_name: 'explorer' })).toBe('下载');
  });
});

describe('nextFocusTarget', () => {
  it('① unlocked: a focus change moves the target', () => {
    expect(nextFocusTarget('无标题 - 记事本', false, ev('Slack | 常规'))).toBe('Slack | 常规');
  });

  it('② locked: the target FREEZES on the locked window (07 §3 — the injection', () => {
    // goes to the window that was foreground at speech start; a drifting display
    // would be a lie. The view paints 🔒 off the same `locked` flag.
    expect(nextFocusTarget('无标题 - 记事本', true, ev('Slack | 常规'))).toBe('无标题 - 记事本');
  });

  it('③ a non-injectable foreground clears to "—" (empty), not a stale target', () => {
    expect(nextFocusTarget('无标题 - 记事本', false, { window_title: '', process_name: '' })).toBe('');
    expect(
      nextFocusTarget('无标题 - 记事本', false, {
        window_title: 'FlowMic',
        process_name: 'flowmic-desktop',
      }),
    ).toBe('');
  });

  it('③b …but a non-injectable foreground during the lock still freezes', () => {
    expect(nextFocusTarget('无标题 - 记事本', true, { window_title: '', process_name: '' })).toBe(
      '无标题 - 记事本',
    );
  });

  it('③c unlocked: empty title + process_name updates the live target', () => {
    expect(nextFocusTarget('—', false, { window_title: '', process_name: 'TextEdit' })).toBe(
      'TextEdit',
    );
  });
});
