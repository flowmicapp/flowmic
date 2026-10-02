// Observes the rendered capsule in either open shadow root; never inserts text.
(() => {
  const marks = [];
  window.__wv7 = { marks, shifts: [], clsSupported: PerformanceObserver.supportedEntryTypes.includes('layout-shift') };
  const mark = (name, data = {}) => marks.push({ name, at: performance.now(), ...data });
  window.__wv7.timeOrigin = performance.timeOrigin;
  // Reused capture has no new attachment; retain the earlier mark as evidence.
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (this instanceof MediaStreamAudioSourceNode &&
        ((typeof AudioWorkletNode !== 'undefined' && dest instanceof AudioWorkletNode) || dest instanceof ScriptProcessorNode)) mark('capture-begin');
    return connect.call(this, dest, ...rest);
  };
  const packet = (data) => {
    if (typeof data !== 'string' || !data.startsWith('42')) return null;
    try { return JSON.parse(data.slice(data.indexOf('['))); } catch { return null; }
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(Target, args) {
      const socket = new Target(...args);
      socket.addEventListener('message', (e) => {
        const p = packet(e.data);
        if (p?.[0] === 'stt:interim') mark('wire-interim', { chars: p[1]?.text?.length ?? 0 });
        if (p?.[0] === 'stt:final') mark('wire-final');
      });
      return socket;
    },
  });
  const send = NativeSocket.prototype.send;
  NativeSocket.prototype.send = function (data) {
      const p = packet(data);
      if (p?.[0] === 'audio:chunk') {
        const bytes = atob(p[1]?.data_b64 ?? '');
        let sum = 0;
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          const unsigned = bytes.charCodeAt(i) | (bytes.charCodeAt(i + 1) << 8);
          const sample = unsigned > 32767 ? unsigned - 65536 : unsigned;
          sum += (sample / 32768) ** 2;
        }
        mark('chunk-send', { seq: p[1]?.seq, capturedEpoch: p[1]?.ts_ms, loud: bytes.length > 0 && Math.sqrt(sum / (bytes.length / 2)) > 0.01 });
      }
      return send.call(this, data);
  };
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => { mark('gum-call'); return original(c).then((s) => {
      mark('gum');
      // A second, read-only tap on the SAME real stream gives speech onset in
      // the page clock. The relay's level packet closes a 300 ms window and
      // cannot be treated as the moment the visitor began speaking.
      const audio = new AudioContext();
      const analyser = audio.createAnalyser(); analyser.fftSize = 512;
      audio.createMediaStreamSource(s).connect(analyser);
      const values = new Float32Array(analyser.fftSize);
      let loud = false;
      const tick = () => {
        if (!s.active) { void audio.close(); return; }
        analyser.getFloatTimeDomainData(values);
        const rms = Math.sqrt(values.reduce((n, v) => n + v * v, 0) / values.length);
        const nowLoud = rms > 0.01; // -40 dBFS, same threshold as the relay observation
        if (nowLoud && !loud) mark('audio-onset');
        loud = nowLoud;
        requestAnimationFrame(tick);
      };
      void audio.resume(); requestAnimationFrame(tick);
      return s;
    }); };
  }
  window.__wv7.read = () => {
    const host = document.querySelector('flowmic-voice, [data-flowmic-demo="voice"]');
    const root = host?.shadowRoot;
    const cap = root?.querySelector('[data-flowmic-mic="capsule"]');
    const field = document.querySelector('.hti-box, .db-box, #f-input');
    const button = document.querySelector('.hti-press, .db-mic') ?? root?.querySelector('[data-flowmic-mic="icon"]');
    const rect = (e) => e?.getBoundingClientRect().toJSON() ?? null;
    const visible = !!cap && !cap.hidden && cap.getBoundingClientRect().width > 0 && getComputedStyle(cap).visibility !== 'hidden' && Number(getComputedStyle(cap).opacity) > 0;
    const br = button?.getBoundingClientRect();
    const svg = button?.querySelector('svg');
    const svgStyle = svg ? getComputedStyle(svg) : null;
    const errorNode = root?.querySelector('[data-flowmic-mic="error"]');
    const errorVisible = !!errorNode && errorNode.getBoundingClientRect().width > 0 && getComputedStyle(errorNode).visibility !== 'hidden' && Number(getComputedStyle(errorNode).opacity) > 0;
    const errorVoice = visible && ['fault', 'expired', 'linkDown', 'localExpired', 'heardNothing', 'sentenceFailed', 'uncertain', 'blocked', 'noMic', 'micFailed', 'failed'].includes(cap.dataset.voice);
    const hit = br ? (button.getRootNode().elementFromPoint(br.x + br.width / 2, br.y + br.height / 2)) : null;
    return { visible, voice: visible ? cap.dataset.voice : null, word: visible ? root.querySelector('[data-flowmic-mic="capsule-word"]')?.textContent : '',
      interim: visible ? root.querySelector('[data-flowmic-mic="interim"]')?.textContent : '', value: field?.value ?? '',
      capsule: visible ? rect(cap) : null, field: rect(field), button: rect(button), side: cap?.dataset.side, viewport: { width: innerWidth, height: innerHeight },
      pointerEvents: cap ? getComputedStyle(cap).pointerEvents : null, pressHitsButton: !!button && (hit === button || button.contains(hit)),
      error: errorVisible ? errorNode.textContent : errorVoice ? root.querySelector('[data-flowmic-mic="capsule-word"]')?.textContent || cap.dataset.voice : '',
      buttonVisible: !!br && br.width > 0 && br.height > 0 && getComputedStyle(button).visibility !== 'hidden' && Number(getComputedStyle(button).opacity) > 0,
      pressed: button?.getAttribute('aria-pressed'), busy: button?.getAttribute('aria-busy'), svgVisual: svgStyle ? [svgStyle.opacity, svgStyle.transform].join('|') : null,
      nativeActive: button?.matches(':active'), active: document.activeElement?.className,
    };
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setTimeout(() => mark('escape-dispatched', { prevented: e.defaultPrevented }), 0);
  }, true);
  for (const type of ['pointerdown', 'pointerup', 'keydown', 'keyup']) document.addEventListener(type, (e) => {
    const n = e.composedPath()[0]; mark(type, { pointerType: e.pointerType, key: e.key, control: n.closest?.('button')?.className ?? n.dataset?.flowmicMic ?? n.tagName });
  }, true);
  document.addEventListener('input', (e) => mark('input', { value: e.target.value }), true);
  if (window.__wv7.clsSupported) new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__wv7.shifts.push({ at: e.startTime, value: e.value, recent: e.hadRecentInput,
      sources: e.sources.map((s) => ({ node: s.node?.className ?? null, from: s.previousRect.toJSON(), to: s.currentRect.toJSON() })) });
  }).observe({ type: 'layout-shift', buffered: true });
  let prev = '';
  function sample() {
    const s = window.__wv7.read();
    const key = JSON.stringify([s.visible, s.voice, s.word, s.interim, s.value, s.error, s.buttonVisible, s.pressed, s.busy, s.svgVisual, s.nativeActive]);
    if (key !== prev) { prev = key; mark('render', s); }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();
