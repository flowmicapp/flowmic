import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// WP-R2-2 dual-window frontend. Two HTML entries → two WebView2 windows:
//   index.html   → the bordered main window (timeline + settings)
//   capsule.html → the transparent, non-activating capsule HUD
// Fixed dev port 1420 matches tauri.conf.json build.devUrl; `dist/` is the
// frontendDist the Tauri bundler embeds. Both windows share the WebView2
// environment (the occlusion launch arg is env-level in tauri.conf.json).
// OSS-DEFAULTS (0.3.0): the deployment's extra private CIDRs, stamped in at
// BUILD time. `@flowmic/protocol` readAdditionalPrivateCidrs() reads this global
// first and `process.env` second — a WebView2 page has no `process.env`, so the
// Node path it uses on the server cannot work here.
//
// Default '' ⇒ the overlay is EMPTY in a stock build, which is the whole point
// of the card: no office LAN of anybody's is compiled into a public artifact.
// The owner's own desktop build keeps its old classification by having
// FLOWMIC_ADDITIONAL_PRIVATE_CIDRS set in the shell that runs `vite build`.
const ADDITIONAL_PRIVATE_CIDRS = process.env.FLOWMIC_ADDITIONAL_PRIVATE_CIDRS ?? '';

// MAC-08: stamp the *target* OS so the device page can tell the truth about
// plaintext credential storage on non-Windows. Prefer TAURI_ENV_PLATFORM (set
// by `tauri build` / `tauri dev` for the guest OS — correct under
// cross-compile); fall back to Node's process.platform for bare vite/vitest.
function resolveHostPlatformStamp(): string {
  const fromTauri = (process.env.TAURI_ENV_PLATFORM ?? '').toLowerCase();
  if (fromTauri === 'windows' || fromTauri === 'darwin' || fromTauri === 'linux') {
    return fromTauri;
  }
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}
const HOST_PLATFORM = resolveHostPlatformStamp();

export default defineConfig({
  plugins: [vue()],
  define: {
    'globalThis.__FLOWMIC_ADDITIONAL_PRIVATE_CIDRS__': JSON.stringify(ADDITIONAL_PRIVATE_CIDRS),
    'globalThis.__FLOWMIC_HOST_PLATFORM__': JSON.stringify(HOST_PLATFORM),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // Tauri targets an evergreen WebView2 — no legacy transpile needed.
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        capsule: fileURLToPath(new URL('./capsule.html', import.meta.url)),
      },
    },
  },
});
