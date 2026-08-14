// WP-R2-2 main window bootstrap — the bordered timeline + settings window.
//
// V2-07.8a appearance wiring, BEFORE createApp so the first frame is right:
//   ① locale: hydrate the EXPLICIT stored choice (never the OS — red line);
//   ② theme: initTheme stamps data-theme on <html> before mount, so a dark
//      user never sees a light flash;
//   ③ UI_PREFS_SYNC: the other window (capsule / a later surface) changed a
//      pref → re-read the shared localStorage. Tauri broadcasts to every
//      window including the emitter; rehydrating is idempotent.
import { createApp } from 'vue';
import '../styles/tokens.css';
import '../styles/main.css';
import App from './App.vue';
import { installErrorBoundary } from '../lib/error-boundary';
import { localKv } from '../lib/storage';
import { getLocale, hydrateLocale, wireLocaleStore } from '../lib/strings/locale';
import { hydrateTheme, initTheme, matchMediaThemeSource } from '../lib/theme';
import { onChannel, reportSelfFocus, reportUiLocale, UI_PREFS_SYNC } from '../lib/bridge';
import { wireSelfFocusReporter } from '../lib/self-focus';

wireLocaleStore(localKv);
hydrateLocale();
// U6 — mirror the effective locale into the Rust shell (tray / exit dialog /
// autostart errors live there and cannot read localStorage). Boot mirror here
// (idempotent; migrates a choice stored before the Rust side existed), change
// mirror in the UI_PREFS_SYNC handler below. Main window only — it always
// exists (created hidden), so one reporter is enough.
reportUiLocale(getLocale());
initTheme({ kv: localKv, system: matchMediaThemeSource(), root: document.documentElement });
void onChannel(UI_PREFS_SYNC, () => {
  hydrateLocale();
  hydrateTheme();
  reportUiLocale(getLocale());
});

// 🔴 owner 2026-08-02 (F1a): injection must work into FlowMic's own input boxes
// too. Tell Rust whether THIS window has a typeable focus, so a sentence spoken
// while the user is in FlowMic's own search box lands there instead of coming
// back "not injected · cached."
//
// BEFORE `createApp`, like the locale/theme wiring above it and for a related reason:
// the reporter seeds itself on wire-up, and a window reloaded while an input was
// focused must not spend its first frames claiming it has none.
//
// ⚠️ MAIN WINDOW ONLY — the capsule is WS_EX_NOACTIVATE and can never be the OS
// foreground, so a report from it would be discarded by the Rust cross-check every
// time. See lib/self-focus.ts.
//
// The teardown is dropped on purpose: this window's lifetime IS the process's, and
// storing a handle nobody calls would be a control that changes nothing.
wireSelfFocusReporter(document, window, reportSelfFocus);

const app = createApp(App);
// No silent failures (owner 2026-07-27): without this, one throw inside a render blanks
// the page with no message and nothing in the log — which is exactly how the
// timeline came to look empty instead of broken. See lib/error-boundary.ts.
installErrorBoundary(app);
app.mount('#app');
