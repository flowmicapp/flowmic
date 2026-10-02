import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coldContextOptions, judgeCold, markedSpeech, speechTime } from './emb13-cold-lib.mjs';

export async function coldFirstWord(browser, surface, state, config) {
  const result = { surface, checks: {}, behaviours: [], audioMs: 0 };
  const row = { surface, config, freshContext: true, cacheDisabled: true, touchContext: config.touch };
  if (config.secondPress && config.gesture !== 'tap') throw new Error('second-press requires tap');
  const ctx = await browser.newContext(coldContextOptions(config));
  let page, wire = [];
  try {
    // Ordered as one init script: mic replacement precedes the normal probe.
    await ctx.addInitScript({ content: `window.__coldConfig=${JSON.stringify(config)};window.__coldSpeechTime=${speechTime.toString()};\n${readFileSync(new URL('./emb13-cold-mic.js', import.meta.url), 'utf8')}` });
    row.deliveries = await state.instrument(ctx, config); // routing also disables HTTP cache
    page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    wire = state.wireProbe(page);
    row.pageErrors = []; page.on('pageerror', (e) => row.pageErrors.push(e.message));
    await page.goto(surface === 'sdk' ? state.site.origin : state.website.origin + (surface === 'try' ? '/try' : '/'), { waitUntil: 'domcontentloaded' });
    const decline = page.getByRole('button', { name: 'Decline', exact: true });
    if (await decline.isVisible()) await decline.click();
    const button = page.locator({ home: '.hti-press', try: '.db-mic', sdk: '[data-flowmic-mic="icon"]' }[surface]).first();
    await button.waitFor({ state: 'visible' });
    await page.evaluate((pcm) => window.__coldMic.prepare(pcm), config.secondPress ? [0, 1].map((i) => markedSpeech(readFileSync(state.cfg.wav), i)) : markedSpeech(readFileSync(state.cfg.wav), config.quietRelease ? 0 : undefined));
    // Gives the permitted idle entry prefetch a chance on WV-PRESS, without
    // warming by hover/focus or waiting for a runtime/challenge/room.
    const settleEnd = Date.now() + config.settleMs;
    while (!row.deliveries.some((d) => d.kind === 'entry' && d.method === 'GET' && d.delivered) && Date.now() < settleEnd) await page.waitForTimeout(20);
    await page.waitForTimeout(50); // Entry evaluation, without waiting for the heavy runtime.
    if (surface === 'sdk') await page.locator('#f-input').focus();
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const tap = async () => {
      if (!config.touch) return button.click();
      await button.scrollIntoViewIfNeeded();
      const current = await button.boundingBox();
      return page.touchscreen.tap(current.x + current.width / 2, current.y + current.height / 2);
    };
    const touch = (type) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    });
    row.inputMethod = config.touch ? (config.gesture === 'hold' ? 'cdp-touch' : 'touchscreen.tap') : 'mouse';
    if (config.gesture === 'hold') {
      if (config.touch) await touch('touchStart');
      else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
    } else await tap();
    await page.waitForFunction(() => window.__coldMic.press !== null);
    if (config.secondPress) {
      await page.waitForTimeout(config.speechMs + 750);
      await tap(); row.firstStopAt = await page.evaluate(() => performance.now());
      await page.waitForTimeout(100);
      await tap();
      await page.waitForTimeout(config.speechMs + 750);
      await tap(); row.secondStopAt = await page.evaluate(() => performance.now());
    } else {
      let quietStopPoint;
      if (config.quietRelease && config.gesture === 'tap') {
        // Resolve the moving mobile target during the silent pause, not after
        // its deadline: locator scrolling/actionability can cost several frames.
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve,
          Math.max(0, window.__coldMic.speechAt + 700 - performance.now()))));
        await button.scrollIntoViewIfNeeded();
        const current = await button.boundingBox();
        quietStopPoint = { x: current.x + current.width / 2, y: current.y + current.height / 2 };
      }
      if (config.quietRelease) await page.evaluate((pause) => new Promise((resolve) => setTimeout(resolve,
        Math.max(0, window.__coldMic.speechAt + 700 + pause - performance.now()))), config.quietPauseMs);
      else await page.waitForTimeout(config.speechMs + 6800);
      if (config.gesture === 'hold') {
        if (config.touch) await touch('touchEnd'); else await page.mouse.up();
        row.releaseAt = await page.evaluate(() => performance.now());
      } else if (quietStopPoint) {
        if (config.touch) await page.touchscreen.tap(quietStopPoint.x, quietStopPoint.y);
        else await page.mouse.click(quietStopPoint.x, quietStopPoint.y);
      } else await tap();
      if (config.quietRelease) row.stopAt = await page.evaluate((gesture) => {
        const mic = window.__coldMic;
        return window.__wv7.marks.find((m) => m.name === (gesture === 'hold' ? 'pointerup' : 'pointerdown') && m.at > mic.speechAt + 700)?.at;
      }, config.gesture);
    }
    const timeout = config.challengeMs + config.entryMs + config.runtimeMs + config.roomMs + config.joinMs + 15000;
    await page.waitForFunction(() => window.__wv7.read().value.trim().length > 0, null, { timeout }).catch(() => {});
    await page.waitForTimeout(config.secondPress || config.quietRelease ? 5000 : 500);
    Object.assign(row, await page.evaluate(() => {
      const mic = window.__coldMic, marks = window.__wv7.marks;
      return { segments: mic.segments, press: mic.press, speechAt: mic.speechAt, clockErrorMs: mic.clockErrorMs, gumCalls: mic.calls,
        observedSpeechAt: Number.isFinite(mic.onsetAudioSeconds) ? mic.speechAt + (mic.onsetAudioSeconds - mic.audioWhen) * 1000 : null,
        onsetAudioSeconds: mic.onsetAudioSeconds, onsetObservedAt: mic.onsetObservedAt,
        sampleRate: mic.sampleRate, timeOrigin: performance.timeOrigin, marks,
        final: window.__wv7.read().value, finalState: window.__wv7.read(), observationMs: performance.now() - mic.press,
        startPresses: marks.filter((m) => m.name === 'pointerdown' && m.at >= mic.press - 20 && m.at < mic.press + 1000).length };
    }));
    row.heard = wire.filter((f) => f.event === 'stt:final').map((f) => f.text ?? '').join(' ');
    row.receiptsOk = wire.some((f) => f.event === 'inject:result' && f.ok === true)
      && !wire.some((f) => f.event === 'inject:result' && !f.ok);
    row.screenshot = join(state.runDir, `${surface}-${state.scenario}-${config.gesture}.png`);
    await page.screenshot({ path: row.screenshot });
  } catch (e) { row.error = String(e.stack); }
  finally {
    row.wire = wire;
    result.audioMs = wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0);
    Object.assign(row, judgeCold(row));
    result.checks[state.scenario] = row.verdict;
    result.behaviours.push(row);
    console.log(`WV7 ${state.scenario} ${config.gesture} ${surface}: ${row.verdict}; ${JSON.stringify(row.checks)}`);
    await ctx.close();
  }
  return result;
}
