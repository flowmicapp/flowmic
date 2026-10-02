// Local-only replacement at the existing cloud adapter hook. No network code.
// Labels depend exclusively on RECEIVED PCM, never press time or room metadata.
const { EventEmitter } = require('node:events');
function detector() {
  let pending = Buffer.alloc(0), frames = 0;
  const counts = [0, 0], order = [];
  return {
    push(bytes) {
      pending = Buffer.concat([pending, Buffer.from(bytes)]);
      while (pending.length >= 640) {
        const frame = pending.subarray(0, 640); pending = pending.subarray(640); frames++;
        [700, 1300].forEach((hz, index) => {
          let re = 0, im = 0;
          for (let i = 0; i < 320; i++) {
            const x = frame.readInt16LE(i * 2) / 32768, angle = 2 * Math.PI * hz * i / 16000;
            re += x * Math.cos(angle); im += x * Math.sin(angle);
          }
          if (2 * Math.hypot(re, im) / 320 > .12) counts[index]++;
          if (counts[index] >= (index === 0 ? 30 : 5) && !order.includes(index)) order.push(index);
        });
      }
    },
    read() { return { text: order.map((i) => ['First', 'tail'][i]).join(' '), counts: [...counts], duration_ms: frames * 20 }; },
  };
}
module.exports.detector = detector;
module.exports.createEngine = (id) => {
  const engine = new EventEmitter(), audio = detector();
  Object.assign(engine, { id, state: 'closed', interimShape: 'cumulative', finalsOnlyAtFlush: true,
    async open() { engine.state = 'open'; engine.emit('state', 'open'); },
    push(bytes) {
      audio.push(bytes);
      const row = audio.read();
      if (row.text) engine.emit('interim', { kind: 'interim', text: row.text, confidence: 1, language: 'en' });
    },
    async flush() {
      const row = audio.read();
      console.log('cold-fixture', JSON.stringify(row));
      engine.emit('final', { kind: 'final', text: row.text, confidence: 1, language: 'en', duration_ms: row.duration_ms });
    },
    async close() { engine.state = 'closed'; engine.emit('state', 'closed'); },
  });
  return engine;
};
