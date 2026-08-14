export * from './events';
export * from './protocol-schemas';
export * from './error-codes';
// 0.2.66/0.2.67 — the ONE list of UI languages (docs/rebuild/17-UI-LOCALE-GLOSSARY.md).
// Every surface's locale enum, picker, endonym map and parity loop derives from it.
export * from './locales';
// Card F2 — the single source of truth for 「这份 inject:result 是谁作出的」("who made
// this inject:result verdict") (both ends read it). Deliberately placed right after
// error-codes: it is a **total projection** of that table, and the compile-time
// `satisfies Record<ErrorCode,…>` guarantees that adding a new code without declaring
// its authorship goes red immediately.
export * from './inject-verdict-authorship';
// Q2 (owner 2026-08-12) — the ENUMERATED reason a restricted account is shown.
// Placed beside the authorship projection above rather than with the schemas:
// like that file it is a table the ENDS share so a user-visible string cannot be
// invented at either end. It is deliberately NOT part of `ERROR_CODES` — see
// its header for why five codes would have been the wrong shape.
export * from './restriction-reasons';
export * from './engine-presets';
export * from './types';
export * from './constants';
export * from './format-timeline';
export * from './timeline-payload';
export * from './dictionary-packs';
// './schema-negotiation' was deleted on 2026-07-31 (stage-5 cleanup). Its
// interpretServerAck() handled the「new client -> old server」direction of
// handshake version negotiation and had zero callers on any end — no client in
// this repo has ever read `schema_ver` back off an ack, so its own header
// comment ("a new client degrades instead of crashing against an old server")
// described behaviour nothing performed. The direction that IS live stays live:
// server-core auth/middleware.ts negotiateSchemaVer() folds a missing/invalid
// client schema_ver to legacy=1 and never rejects. If a client ever needs to
// branch on the server's version, build it against a real call site.
export * from './scenario';
export * from './scenario-consent';
export * from './stt-polish';
export * from './stt-refine';
