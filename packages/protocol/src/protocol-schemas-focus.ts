// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject / control table —
//     `focus:state` row)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (F-3113 focus-target mirror:
//     payload, change-only, ≥500 ms throttle, gating, never persisted)
//   F-701 (no unknown events), F-702 (zod schemas for every event payload),
//   F-3113 (the one socket name v2r2 batch1 added — whitelist 54 → 55)
//
// Own module rather than an addition to protocol-schemas-inject.ts: the
// domain split established one module per protocol concern with a
// `*_EVENT_SCHEMAS` sub-map spread into the single EVENT_SCHEMAS registry in
// protocol-schemas.ts. That entry point also re-exports every symbol here, so
// the public @flowmic/protocol surface grows by exactly the two names below.

import { z } from 'zod';

// ─── focus-target mirror (§3.5) ───────────────────────────────────────
// Payload is verbatim §3.5: `{ window_title: string, process_name: string }`.
//
// Both fields are plain strings, deliberately unconstrained beyond their type:
//   - `window_title` may legitimately be empty (a foreground window with no
//     caption is a real Win32 state), so a min(1) refinement would reject a
//     truthful observation.
//   - `process_name` carries the desktop `FocusTarget.app_name` VERBATIM —
//     the executable basename with the platform extension already stripped by
//     `current_app_name_inner` in apps/desktop/src-tauri/src/focus/tracker.rs.
//     The canonical value is `explorer`, never `explorer.exe`.
//
// The transport carries no timestamp: this event is transient state, never a
// record. §3.5 forbids persisting it to any table, so nothing downstream
// needs an ordering key beyond arrival order on the one PC connection.
export const FocusStateSchema = z.object({
  window_title: z.string(),
  process_name: z.string(),
});

// Sub-map spread into protocol-schemas.ts's EVENT_SCHEMAS registry so that
// file only needs one spread line per split-out module.
export const FOCUS_EVENT_SCHEMAS = {
  // §3.5
  'focus:state': FocusStateSchema,
} as const;
