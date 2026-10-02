// Init script. No product state is changed; only getUserMedia's source is fake.
(() => {
  const cfg = window.__coldConfig;
  const audio = new AudioContext({ sampleRate: 16000 });
  const bus = audio.createMediaStreamDestination();
  const silent = audio.createConstantSource(); silent.offset.value = 0;
  silent.connect(bus); silent.start();
  const state = window.__coldMic = { calls: [], press: null, speechAt: null, clockErrorMs: null, segments: [], downs: 0 };
  state.prepare = async (samples) => {
    state.buffers = (cfg.secondPress ? samples : [samples]).map((part) => {
      const buffer = audio.createBuffer(1, part.length, 16000);
      buffer.copyToChannel(Float32Array.from(part), 0);
      return buffer;
    });
    // Independent source-side sample clock, before any getUserMedia call.
    const moduleUrl = URL.createObjectURL(new Blob([`registerProcessor('cold-onset', class extends AudioWorkletProcessor {
      process(inputs) {
        const xs = inputs[0]?.[0];
        if (xs) for (let i = 0; i < xs.length; i++) if (Math.abs(xs[i]) > .02) {
          this.lastSound = currentFrame + i;
          if (!this.seen) { this.seen = true; this.port.postMessage((currentFrame + i) / sampleRate); }
        }
        if (this.seen && !this.ended && currentFrame - this.lastSound > sampleRate * .032) {
          this.ended = true; this.port.postMessage({ end: (this.lastSound + 1) / sampleRate });
        }
        return true;
      }
    });`], { type: 'text/javascript' }));
    try { await audio.audioWorklet.addModule(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
    const mute = audio.createGain(); mute.gain.value = 0;
    state.mute = mute; mute.connect(audio.destination);
    await audio.resume();
    if (audio.state !== 'running') throw new Error('fixture AudioContext is suspended');
  };
  navigator.mediaDevices.getUserMedia = async () => {
    state.calls.push(performance.now());
    return bus.stream.clone(); // Never reset/replay on microphone acquisition.
  };
  document.addEventListener('pointerdown', (event) => {
    if (!event.composedPath().some((n) => n.matches?.('.hti-press, .db-mic, [data-flowmic-mic="icon"]'))) return;
    const down = state.downs++;
    if (down !== 0 && !(cfg.secondPress && down === 2)) return;
    const press = performance.now();
    const clockBefore = performance.now(), audioNow = audio.currentTime, clockAfter = performance.now();
    const when = window.__coldSpeechTime(press, clockAfter, audioNow, cfg.speechMs);
    const segment = { press, speechAt: clockAfter + (when - audioNow) * 1000 };
    state.segments.push(segment);
    const monitor = state.mute ? new AudioWorkletNode(audio, 'cold-onset') : undefined;
    if (monitor) {
      monitor.port.onmessage = (e) => {
        if (typeof e.data === 'object') {
          segment.observedSpeechEndAt = segment.speechAt + (e.data.end - when) * 1000;
          return;
        }
        segment.observedSpeechAt = segment.speechAt + (e.data - when) * 1000;
        if (down === 0) { state.onsetAudioSeconds = e.data; state.onsetObservedAt = performance.now(); }
      };
      monitor.connect(state.mute);
    }
    const source = audio.createBufferSource(); source.buffer = state.buffers?.[down === 2 ? 1 : 0];
    source.connect(bus); source.connect(monitor); source.start(when);
    if (down !== 0) return;
    state.press = press;
    state.speechAt = clockAfter + (when - audioNow) * 1000;
    // Mapping uncertainty: one render quantum + clock sampling interval.
    state.clockErrorMs = 128 / audio.sampleRate * 1000 + clockAfter - clockBefore;
    state.audioWhen = when;
    state.sampleRate = audio.sampleRate;
  }, true);
})();
