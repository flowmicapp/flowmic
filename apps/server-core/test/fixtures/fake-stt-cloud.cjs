// Fixture standing in for the private `@flowmic/stt-cloud` package.
//
// CJS on purpose: server-core loads the real package with a SYNCHRONOUS
// `createRequire(...)` (the switch it feeds is synchronous), so the real
// package must be requireable too — `packages/stt-cloud/tsup.config.ts` emits
// CJS for exactly this reason. If that ever regresses to ESM-only, production
// throws ERR_REQUIRE_ESM and this fixture would no longer represent it.
//
// It records the `host` it was handed so the test can prove server-core passes
// its OWN error classes across the boundary (class identity, not shape — see
// packages/stt-cloud/src/host.ts).
const calls = [];

module.exports.calls = calls;
module.exports.createEngine = function createEngine(id, cfg, host) {
  calls.push({ id, cfg, host });
  return {
    id,
    state: 'closed',
    push() {},
    async flush() {},
    async close() {},
    async open() {},
    // Handed back so the test can assert identity of what it received.
    __host: host,
  };
};
