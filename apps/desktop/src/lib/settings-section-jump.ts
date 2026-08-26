// Card LLM-NOTICE (2026-08-25) — 「jump straight to this settings SECTION」 from
// outside the settings page.
//
// `navigateMain('settings')` (lib/bridge.ts) already switches the PAGE; it has
// no notion of a section, and SettingsPage's `scrollTo` is private to that
// component. This is the same-window DOM handshake between the two, in the
// exact shape `UI_NAVIGATE_DOM` already uses: a CustomEvent the page listens
// for while mounted. It is dispatched AFTER the page switch so the target
// element exists when the page reads the event.
//
// Not a second navigation funnel: the page switch still goes through
// `navigateMain` — this only carries the extra word (which section).

import { navigateMain } from './bridge';

export const SETTINGS_SECTION_DOM = 'flowmic:settings-section';

/** The section ids SettingsPage renders as `#set-<id>` (its `Sec` union). Only
 *  the two the first-run card jumps to are exported here; a caller that needs
 *  another adds it to this list rather than passing a bare string, so a typo
 *  cannot become a jump to nowhere. */
export type JumpableSettingsSection = 'stt' | 'llm';

export function jumpToSettingsSection(section: JumpableSettingsSection): void {
  navigateMain('settings');
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_DOM, { detail: { section } }));
}

/** The page side: read the section out of the event, or null for anything
 *  off-contract (never a scroll to an id nobody rendered). */
export function sectionFromEvent(ev: Event): JumpableSettingsSection | null {
  const section = (ev as CustomEvent<{ section?: unknown }>).detail?.section;
  return section === 'stt' || section === 'llm' ? section : null;
}
