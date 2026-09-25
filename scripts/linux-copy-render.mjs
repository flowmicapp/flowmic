// pnpm verify:linux-copy-render owns a real desktop Vite app and its browser.
// One-time browser setup: pnpm exec playwright install chromium
// No DOM/CSS fixtures or string-length limits. Linux CI also installs CJK fonts.
// FLOWMIC_PLAYWRIGHT_MODULE may name an existing Playwright installation (file URL).
// FLOWMIC_CHROMIUM optionally selects an installed browser; missing dependencies fail.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readUiLocales } from './i18n/locale-registry.mjs';
const { chromium } = await import(process.env.FLOWMIC_PLAYWRIGHT_MODULE || 'playwright');
const config = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url)));
// Own an ephemeral server by default: no manual prerequisite or shared dev port.
const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
let server;
let browser;
let origin = process.env.FLOWMIC_RENDER_URL;
const output = '.local/linux-copy-render';
mkdirSync(output, { recursive: true });
const failures = [];
try {
  if (!origin) {
    server = await createServer({ root: desktop,
      server: { host: '127.0.0.1', port: 0, strictPort: false, open: false } });
    await server.listen();
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  }
  browser = await chromium.launch({ executablePath: process.env.FLOWMIC_CHROMIUM || undefined });
  for (const surface of ['main', 'capsule']) {
    const window = config.app.windows.find(w => w.label === surface);
    const page = await browser.newPage({ viewport: {
      width: window.minWidth || window.width, height: window.minHeight || window.height,
    } });
    page.on('pageerror', error => failures.push(`${surface}: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') failures.push(`${surface}: console: ${message.text()}`);
    });
    await page.addInitScript(() => {
      localStorage.setItem('flowmic.ui.locale', 'en');
      localStorage.setItem('flowmic.ui.locale.prompt', 'settled');
    });
    await page.goto(`${origin}/${surface === 'capsule' ? 'capsule.html' : ''}`);
    await page.waitForSelector(surface === 'capsule' ? '#capsule .wrap' : '.app-shell .sidenav');
    if (surface === 'main') await page.locator('.sidenav .navitem').nth(1).click();
    let widest = { locale: '', width: 0 };
    let negativeCaught = false;
    for (const code of ['INJECT_WAYLAND_UNSUPPORTED', 'INJECT_DISPLAY_UNAVAILABLE', 'INJECT_SUBMISSION_UNCERTAIN']) {
      for (const { code: locale } of readUiLocales()) {
        const expectedReason = await page.evaluate(async ({ locale, surface, code }) => {
          const { setLocale, INJECT_FAIL_REASON } = await import('/src/lib/strings.ts');
          setLocale(locale);
          const verdict = { ok: false, mode: 'cached', error: code,
            row_id: 'req:render-wayland', channel: 'lan' };
          if (surface === 'capsule') {
            const { onInjectResult, state } = await import('/src/capsule/controller.ts');
            onInjectResult(verdict);
            state.form = 'inject_failed';
          } else {
            const { timeline } = await import('/src/main-window/store.ts');
            timeline.onHistoryUpdated({ id: verdict.row_id, mode: 'realtime', status: 'cached',
              output_text: 'Linux render acceptance', source_text: null,
              created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, 'lan');
            timeline.onInjectResult(verdict);
            window.dispatchEvent(new CustomEvent('flowmic:ui-navigate', { detail: { page: 'timeline' } }));
          }
          return INJECT_FAIL_REASON[code];
        }, { locale, surface, code });
        const reason = page.locator(surface === 'capsule' ? '.failsub' : '.hrow .meta span.st-y').first();
        await reason.waitFor({ timeout: 5000 }).catch(async error => {
          await page.screenshot({ path: `${output}/${surface}-missing.png` });
          console.error(await page.locator('body').innerText());
          throw error;
        });
        const measure = () => reason.evaluate(el => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const textRects = [...range.getClientRects()];
          const bounds = el.closest('.crow, .body').getBoundingClientRect();
          const own = el.getBoundingClientRect();
          const overflow = getComputedStyle(el).overflowX;
          const inside = (r, b) => r.left >= b.left - 1 && r.right <= b.right + 1
            && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
          const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
          return { text: el.textContent, width: range.getBoundingClientRect().width,
            containerWidth: bounds.width, ownWidth: own.width, tooltip: el.getAttribute('title'),
            fits: !!el.textContent && textRects.every(r => inside(r, bounds) && inside(r, viewport)
              && (overflow === 'visible' || inside(r, own))) };
        });
        const result = await measure();
        assert.ok(expectedReason && result.text.includes(expectedReason),
          `${surface}/${locale}/${code}: the named localized reason must reach the screen`);
        if (result.width > widest.width) widest = { locale, width: result.width };
        console.log(`${surface}/${locale}/${code}: ${result.fits ? 'PASS' : 'FAIL'} rendered width=${result.width}, slot=${result.ownWidth}, container=${result.containerWidth}, tooltip=${result.tooltip !== null}`);
        await page.screenshot({ path: `${output}/${surface}-${locale}-${code}.png` });
        if (!result.fits) failures.push(`${surface}/${locale}/${code}: clipped or overflowing text`);
        if (locale === 'ja') {
          await reason.evaluate(el => { el.textContent = 'W'.repeat(2000); });
          const negative = await measure();
          negativeCaught = false;
          try { assert.ok(negative.fits, 'rendered text must fit'); }
          catch { negativeCaught = true; }
          console.log(`${surface}/${code}: unbreakable-word negative control ${negativeCaught ? 'RED as required' : 'BLIND'}`);
          assert.ok(negativeCaught, `${surface}/${code}: negative control was not detected`);
          // Restore even if the next locale has identical copy: Vue need not
          // rewrite an unchanged text node after our deliberate DOM mutation.
          await reason.evaluate((el, text) => { el.textContent = text; }, result.text);
        }
        if (surface === 'main') {
          // Probe natural wrapping separately from the unbreakable-word control.
          // All nine real reasons are tripled, so the longest real locale is
          // included without guessing which font/language wins on this host.
          await reason.evaluate((el, text) => { el.textContent = [text, text, text].join(' '); }, expectedReason);
          const wrapped = await measure();
          console.log(`${surface}/${locale}/${code}: breakable real sentence x3 ${wrapped.fits ? 'FITS' : 'CLIPPED'} width=${wrapped.width}, container=${wrapped.containerWidth}`);
          await page.screenshot({ path: `${output}/${surface}-${locale}-${code}-breakable.png` });
          // This is an experiment, not a demand that wrapping must overflow.
          // FITS establishes readability only for this measured sentence size.
          await reason.evaluate((el, text) => { el.textContent = text; }, result.text);
        }
      }
    }
    console.log(`${surface}: widest rendered locale=${widest.locale} width=${widest.width}`);
    assert.ok(negativeCaught, `${surface}: overlong negative control was not detected`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server?.close();
}
assert.deepEqual(failures, [], 'All rendered reason lines must remain fully readable');
