import { join } from 'node:path';
import { placement } from './emb13-wv7-lib.mjs';

const controls = { home: '.hti-press', try: '.db-mic', sdk: '[data-flowmic-mic="icon"]' };
const fields = { home: '.hti-box', try: '.db-box', sdk: '#f-input' };
const read = (page) => page.evaluate(() => window.__wv7.read());
const wait = (page, voice) => page.waitForFunction((v) => window.__wv7.read().voice === v, voice, { timeout: 15000 });
const verdict = (ok) => ok ? 'PASS' : 'FAIL';

export async function keyboard(s, surface, state) {
  const { page, wire } = s;
  const r = { checks: {}, evidence: [] };
  await page.locator(fields[surface]).focus();
  const w0 = wire.length;
  await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  r.checks.hostKeysStayWithHost = verdict(!wire.slice(w0).some((e) => e.event === 'audio:start'));
  if (r.checks.hostKeysStayWithHost === 'FAIL') return r;
  for (const key of ['Space', 'Enter']) {
    await page.locator(controls[surface]).first().focus();
    await page.keyboard.press(key);
    const didStart = await wait(page, 'listening').then(() => true, () => false);
    if (!didStart) { r.checks[key] = 'FAIL'; return r; }
    const started = await read(page);
    await page.locator('[data-flowmic-mic="capsule-stop"]').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const ended = await read(page);
    r.checks[key] = verdict(started.voice === 'listening' && ended.voice === 'cancelled' && ended.value === started.value);
    const path = join(state.runDir, `${surface}-keyboard-${key}.png`); await page.screenshot({ path });
    r.evidence.push({ key, started, ended, path });
    await page.waitForTimeout(1700);
  }
  return r;
}

export async function capsulePlacement(s, surface, state) {
  const { page } = s;
  await page.locator(controls[surface]).first().click(); await wait(page, 'listening'); await page.waitForTimeout(180);
  const normal = await read(page), viewport = page.viewportSize();
  const below = placement(normal);
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(normal.field.bottom + 12) });
  await page.waitForTimeout(250);
  const cramped = await read(page), above = placement(cramped);
  const path = join(state.runDir, `${surface}-placement-above.png`); await page.screenshot({ path });
  await page.setViewportSize(viewport);
  await page.locator('[data-flowmic-mic="capsule-stop"]').focus(); await page.keyboard.press('Escape');
  return { checks: { below: below.verdict, cramped: above.verdict }, normal, cramped, below, above, path };
}

// Same running product state at both widths and themes. No state text is authored
// by the rig. Each image is accompanied by the state read at capture time.
export async function matrixShot(page, surface, state, name) {
  const images = [];
  for (const width of [1280, 360]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      // The Acme page is a rig-owned host, so its colours follow the test theme.
      if (document.querySelector('#f-input')) document.body.style.colorScheme = theme;
    }, theme);
    await page.locator(controls[surface]).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(80);
    const seen = await read(page);
    const path = join(state.runDir, `${surface}-${name}-${width}-${theme}.png`);
    await page.screenshot({ path });
    images.push({ width, theme, name, seen, path });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return images;
}
