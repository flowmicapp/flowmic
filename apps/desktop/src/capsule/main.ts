// WP-R2-2 capsule HUD window bootstrap (transparent, non-activating).
//
// V2-07.8a: the capsule is a SEPARATE WebView2 window, so it needs the same
// appearance wiring as the main window — locale hydrate + first-frame
// data-theme — plus the UI_PREFS_SYNC listener: when the settings page (main
// window) flips language or theme, the capsule re-reads the shared
// localStorage and follows immediately.
import { createApp } from 'vue';
import '../styles/tokens.css';
import '../styles/capsule.css';
import CapsuleApp from './CapsuleApp.vue';
import { installErrorBoundary } from '../lib/error-boundary';
import { localKv } from '../lib/storage';
import { hydrateLocale, wireLocaleStore } from '../lib/strings/locale';
import { hydrateTheme, initTheme, matchMediaThemeSource } from '../lib/theme';
import { onChannel, UI_PREFS_SYNC } from '../lib/bridge';

wireLocaleStore(localKv);
hydrateLocale();
initTheme({ kv: localKv, system: matchMediaThemeSource(), root: document.documentElement });
void onChannel(UI_PREFS_SYNC, () => {
  hydrateLocale();
  hydrateTheme();
});

const app = createApp(CapsuleApp);
// The capsule needs this MORE than the main window, not less: it is transparent
// and undecorated, so a render throw leaves an invisible rectangle rather than an
// obviously-broken page — the silent failure is total (red line: no silent failure).
installErrorBoundary(app);
app.mount('#capsule');
