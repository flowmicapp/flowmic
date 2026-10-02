import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SettingsPage from './SettingsPage.vue';
import { S, S_BY_LOCALE } from '../lib/strings';
import { UI_LOCALES } from '../lib/strings/locale';

async function renderSettings(platform: string): Promise<string> {
  return renderToString(createSSRApp(SettingsPage, { platform }));
}

describe('SettingsPage autostart setting by host platform', () => {
  it('keeps the existing Windows setting and hint', async () => {
    const html = await renderSettings('windows');
    expect(html).toContain(S.set_prefs_autostart);
    expect(html).toContain(S.set_prefs_autostart_hint);
  });

  it('shows the setting with its macOS-specific hint on macOS', async () => {
    const html = await renderSettings('darwin');
    expect(html).toContain(S.set_prefs_autostart);
    expect(html).toContain(S.dev_set_prefs_autostart_hint_macos);
    expect(html).not.toContain(S.set_prefs_autostart_hint);
  });

  it('hides the unsupported setting on Linux', async () => {
    const html = await renderSettings('linux');
    expect(html).not.toContain(S.set_prefs_autostart);
  });

  it('has landed copy (no DEV placeholder) for the macOS hint in every desktop locale', () => {
    for (const locale of UI_LOCALES) {
      expect(S_BY_LOCALE[locale].dev_set_prefs_autostart_hint_macos, locale).not.toContain('DEV:');
    }
  });
});
