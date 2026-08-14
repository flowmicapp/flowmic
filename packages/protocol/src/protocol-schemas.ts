// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3 (protocol events)
//   F-701 (no unknown events), F-702 (zod schemas for every event payload)
//
// Single source of truth for socket.io payload validation, shared between
// server and clients via the @flowmic/protocol package. Adding, removing, or
// renaming any schema below MUST be mirrored in `events.ts`.
//
// The §3.x payload schemas live in one module per protocol domain so no module
// approaches the F-801 file-size cap; this file stays the single entry point —
// it re-exports every schema and owns the one authoritative EVENT_SCHEMAS
// registry, assembled from each module's sub-map so the
// `satisfies Record<EventName, ...>` exhaustiveness check stays atomic.
import { z } from 'zod';
import type { EventName } from './events';
import * as Auth from './protocol-schemas-auth';         // §3.1 + §3.2
import * as Audio from './protocol-schemas-audio';       // §3.3
import * as Compose from './protocol-schemas-compose';   // §3.4
import * as Inject from './protocol-schemas-inject';     // §3.5
import * as Focus from './protocol-schemas-focus';       // §3.5 (F-3113)
import * as Sync from './protocol-schemas-sync';         // §3.6 + §3.7
import * as Timeline from './protocol-schemas-timeline'; // §3.8 split (F-801)
export * from './protocol-schemas-auth';     // re-export for consumers
export * from './protocol-schemas-audio';    // re-export for consumers
export * from './protocol-schemas-compose';  // re-export for consumers
export * from './protocol-schemas-inject';   // re-export for consumers
export * from './protocol-schemas-focus';    // re-export for consumers
export * from './protocol-schemas-sync';     // re-export for consumers
export * from './protocol-schemas-timeline'; // re-export for consumers

// ─── registry: event-name → schema ────────────────────────────────────
export const EVENT_SCHEMAS = {
  ...Auth.AUTH_EVENT_SCHEMAS,         // §3.1 + §3.2
  ...Audio.AUDIO_EVENT_SCHEMAS,       // §3.3
  ...Compose.COMPOSE_EVENT_SCHEMAS,   // §3.4
  ...Inject.INJECT_EVENT_SCHEMAS,     // §3.5
  ...Focus.FOCUS_EVENT_SCHEMAS,       // §3.5 (F-3113 focus-target mirror)
  ...Sync.SYNC_EVENT_SCHEMAS,         // §3.6 + §3.7
  ...Timeline.TIMELINE_EVENT_SCHEMAS, // §3.8 (v2.0 — A-49)
} as const satisfies Record<EventName, z.ZodTypeAny>;

export type EventSchemaOf<E extends EventName> = (typeof EVENT_SCHEMAS)[E];
export type EventPayload<E extends EventName> = z.infer<EventSchemaOf<E>>;

// `parseEvent` (the THROWING variant of safeParseEvent) was removed on
// 2026-07-31 in the stage-5 dead-export sweep. It had zero production callers —
// every handler on every end validates with safeParseEvent — and it was worse
// than merely unused: a throw from inside a socket.on() callback unwinds into
// socket.io, not into any handler's catch, so the first call site would have
// turned a malformed frame into a crash. The one test that exercised it now
// asserts the same round-trip through safeParseEvent.
export type SafeParseEventResult<E extends EventName> =
  | { success: true; data: EventPayload<E> }
  | { success: false; error: z.ZodError };

export function safeParseEvent<E extends EventName>(
  name: E,
  payload: unknown,
): SafeParseEventResult<E> {
  const r = EVENT_SCHEMAS[name].safeParse(payload);
  return r.success
    ? { success: true, data: r.data as EventPayload<E> }
    : { success: false, error: r.error };
}
