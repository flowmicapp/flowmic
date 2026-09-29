// EMB-13 page probe: everything the rig reads from inside the page, in one
// clock (performance.now()). It observes; it never drives the widget and never
// writes to a field. Loaded by index.html before the SDK tag so the layout-shift
// observer and the marks cover first paint.
(() => {
  const marks = [];
  window.__marks = marks;
  window.__mark = (name, detail) => marks.push({ name, at: performance.now(), detail: detail === undefined ? null : detail });

  // When the browser hands the page a microphone stream. The rig aligns presses to the
  // fake device's audio loop from this instant, and the SDK may re-acquire between runs.
  try {
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => orig(c).then((stream) => { window.__mark('gum', {}); return stream; });
  } catch (_) { /* no mediaDevices: nothing to time */ }

  // Layout shift (design 4.3: "layout shift caused by us = 0"). Shifts within
  // 500 ms of a pointer press are excluded by the browser (hadRecentInput), which
  // is the platform's own rule for shifts a visitor caused.
  window.__cls = 0;
  window.__shifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__cls += e.value;
        const box = (r) => [r.x, r.y, r.width, r.height].map((v) => Math.round(v));
        window.__shifts.push({ at: e.startTime, value: e.value, sources: (e.sources || []).map((s) => ({ node: s.node ? `${s.node.nodeName}#${s.node.id || ''}` : 'gone', from: box(s.previousRect), to: box(s.currentRect) })) });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (_) { /* engines without the entry type report cls = 0 and the rig says so */ }

  // Where every host element is, in document coordinates. The layout-shift entry cannot name a
  // node inside the widget's shadow tree, so "the host page did not move" is asserted directly:
  // the rig compares these rects at load with the rects at the end of the scenario.
  window.__hostRects = () => {
    const out = {};
    for (const sel of ['h1', '#row', '.cell', '#f-input', '#f-textarea', '#f-ce', '#react-root', '#f-password', '#f-off', '#below']) {
      document.querySelectorAll(sel).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        out[`${sel}[${i}]`] = [r.left + scrollX, r.top + scrollY, r.width, r.height].map((v) => Math.round(v * 10) / 10);
      });
    }
    return out;
  };
  // The baseline is taken by the rig once the page has settled (window.__baseRects = __hostRects()): a
  // React mount that lands after `load` under CPU load must not be counted as movement caused by the widget.

  // Host-side field events, as a form library would see them.
  for (const type of ['input', 'change']) {
    document.addEventListener(type, (e) => {
      const t = e.target;
      if (t && t.id) window.__mark(type, { id: t.id, inputType: e.inputType || null, trusted: e.isTrusted });
    }, true);
  }

  // Which control a press landed on. composedPath()[0] is the real element even
  // inside the widget's open shadow root.
  document.addEventListener('pointerdown', (e) => {
    const n = e.composedPath()[0];
    const k = (n && n.dataset && n.dataset.flowmicMic) || (n && n.id) || (n && n.tagName) || null;
    window.__mark('pointerdown', { k, defaultPrevented: false });
  }, true);
  document.addEventListener('pointerdown', (e) => {
    // Re-read after the widget's own handlers ran (bubble phase, document is
    // last): was the press default cancelled, i.e. did it keep the caret?
    const n = e.composedPath()[0];
    const k = (n && n.dataset && n.dataset.flowmicMic) || (n && n.id) || null;
    if (k) window.__mark('pointerdown:after', { k, defaultPrevented: e.defaultPrevented });
  }, false);

  // Widget state and the live gray text, sampled. The widget exposes the state
  // as data-state on its panel root; the interim line is a plain element.
  let lastState = null;
  let lastInterim = '';
  setInterval(() => {
    const host = document.querySelector('flowmic-voice');
    const sr = host && host.shadowRoot;
    if (!sr) return;
    const root = sr.querySelector('[data-flowmic-mic="root"]');
    const state = root ? root.dataset.state || null : null;
    if (state !== lastState) { lastState = state; window.__mark('state', { state }); }
    const el = sr.querySelector('[data-flowmic-mic="interim"]');
    const interim = el ? el.textContent || '' : '';
    if (interim !== lastInterim) { lastInterim = interim; if (interim) window.__mark('interim', { text: interim }); }
  }, 10);
})();
