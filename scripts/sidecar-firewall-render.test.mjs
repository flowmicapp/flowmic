// NR-117: mount the actual DevicesPage through the desktop app on each target.
// Browser plugin not available; use the repository's Playwright/Vite workflow.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.FLOWMIC_PLAYWRIGHT_MODULE || 'playwright');
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const output = fileURLToPath(new URL('../.local/linux-copy-render/', import.meta.url));
mkdirSync(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('../apps/desktop/', import.meta.url)),
  // Test pages set this runtime value before the app loads, so one server can
  // exercise each target platform without rebuilding its define stamp.
  define: { 'globalThis.__FLOWMIC_HOST_PLATFORM__': 'globalThis.__FLOWMIC_RENDER_PLATFORM__' },
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
});
const browser = await chromium.launch({ executablePath: process.env.FLOWMIC_CHROMIUM || undefined });
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const platform of ['linux', 'windows', 'darwin']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(120_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await page.addInitScript((testPlatform) => {
        globalThis.__FLOWMIC_RENDER_PLATFORM__ = testPlatform;
        localStorage.setItem('flowmic.ui.locale', 'en');
        localStorage.setItem('flowmic.ui.locale.prompt', 'settled');
      }, platform);
      // The review measured 33–36 s to reach DOMContentLoaded under a
      // concurrent gate; keep the explicit 120 s bound for slow page loads.
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.app-shell .sidenav');
      assert.equal(new URL(page.url()).origin, origin);
      assert.ok(await page.title());
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('flowmic:ui-navigate',
        { detail: { page: 'devices' } })));
      const card = page.locator('.ch-lan');
      await card.waitFor();
      const fold = card.locator('.fold-toggle');
      await fold.click();
      const expected = await page.evaluate(async () => {
        const { S } = await import('/src/lib/strings.ts');
        return S.sidecar_firewall_note;
      });
      assert.equal(await card.locator('.sc-fw-note').count(), platform === 'windows' ? 1 : 0,
        `${platform}: firewall hint must render only on Windows`);
      if (platform === 'windows') assert.equal(await card.locator('.sc-fw-note').innerText(), expected);
      else assert.ok(!(await card.innerText()).includes(expected));
      assert.equal(await page.locator('vite-error-overlay').count(), 0);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${output}/firewall-${platform}.png` });
      await fold.click();
      assert.equal(await card.locator('.sc-fw-note').count(), 0);
      console.log(`PASS DevicesPage ${platform}: open/close LAN service; Windows-only firewall hint; no console errors`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
