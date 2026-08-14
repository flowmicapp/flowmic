// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5.4 (unknown fields kept verbatim:
//     「读到不认识的字段（含未来版本的字段）保留原样，再次导出时原样写回」("an unrecognized field — including a future version's field —
//     encountered while reading is kept as-is, and written back unchanged on the next export"))
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §2-6 (missing fields must be forward-compatible)
//
// The side table that makes §5.4 true.
//
// ── WHY IT IS A SIDE TABLE AND NOT A FIELD ON THE ROW ───────────────────────
//
// `TimelineRow` is a closed contract with a hand-written normaliser at its one
// boundary (lib/timeline-normalize.ts), and everything it holds is something the
// PC's own timeline needs to RENDER. A bag of fields nobody can render — a
// future version's keys, plus the `source_ext` members this build's row-minting
// entry point cannot carry (`target`) — is not part of that contract, and
// widening the contract to hold them would put unrenderable data in front of
// every reader of every row.
//
// So it lives beside the rows, keyed by the row's ADDRESS (`channel:id`, the
// same key the store uses — an id alone names two rows once both servers are in
// one list, RV-01).
//
// ── WHY IT CANNOT GROW WITHOUT BOUND ────────────────────────────────────────
// [[PreservedFields.prune]] is called with the live row addresses on every save,
// so an entry outlives its row by at most one operation. Rows are themselves
// bounded (timeline-retention.ts), so this table is bounded by them.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// 🔴 It is NOT a second copy of anything the row holds. Every key it stores is a
// key the row does not have; on export the LIVE row wins for everything it can
// answer and this table only fills the gaps (lib/portable/fpr.ts `rowToEntry`).
// Two answers to one question is the defect this comment exists to prevent.

import type { ReportingKvStore } from '../types';
import type { Preserved } from './fpr';

/** localStorage key. Device-local, never the wire. */
export const PRESERVED_KEY = 'flowmic.portable.preserved';

/** Address → the fields this build could not hold. */
export class PreservedFields {
  private readonly rows = new Map<string, Preserved>();

  /** 🔴 The store is REQUIRED (doc 13 §7 F1 ②: a DI default must be the real
   *  thing or throw — a friendly in-memory default here would make §5.4 pass
   *  every test and lose every field on the next launch).
   *
   *  A REPORTING store, not a plain one, for the reason that interface exists
   *  (types.ts): localStorage runs out of quota, the write is refused, and a
   *  seam that swallowed the answer would let a future re-export silently drop
   *  every field this file preserved. [[prune]] hands the refusal up. */
  constructor(private readonly kv: ReportingKvStore) {
    try {
      const raw = kv.get(PRESERVED_KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return;
      for (const [addr, v] of Object.entries(parsed as Record<string, unknown>)) {
        const p = narrow(v);
        if (p !== null) this.rows.set(addr, p);
      }
    } catch {
      // Corrupt storage degrades to empty, exactly like the row cache: the
      // consequence is that a future version's fields are lost on the next
      // export, which is the pre-§5.4 behaviour and not a broken timeline.
    }
  }

  get(address: string): Preserved | null {
    return this.rows.get(address) ?? null;
  }

  /** Remember what a just-imported line carried. Nothing is stored when there is
   *  nothing to preserve — an empty bag on every row would triple this table for
   *  no field kept. */
  remember(address: string, p: Preserved): void {
    const top = Object.keys(p.top).length > 0;
    const ext = Object.keys(p.ext).length > 0;
    if (!top && !ext) return;
    this.rows.set(address, { top: p.top, ext: p.ext });
  }

  /** Drop entries whose row is gone, then write. Returns whether the write
   *  landed — the caller states a refusal rather than assuming (owner
   *  2026-07-31 ③, the same rule TimelineStore.persist follows). */
  prune(liveAddresses: ReadonlySet<string>): boolean {
    for (const addr of [...this.rows.keys()]) {
      if (!liveAddresses.has(addr)) this.rows.delete(addr);
    }
    return this.save();
  }

  private save(): boolean {
    try {
      const obj: Record<string, Preserved> = {};
      for (const [k, v] of this.rows) obj[k] = v;
      return this.kv.set(PRESERVED_KEY, JSON.stringify(obj));
    } catch {
      return false;
    }
  }
}

function narrow(v: unknown): Preserved | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const top = o.top !== null && typeof o.top === 'object' ? (o.top as Record<string, unknown>) : {};
  const ext = o.ext !== null && typeof o.ext === 'object' ? (o.ext as Record<string, unknown>) : {};
  if (Object.keys(top).length === 0 && Object.keys(ext).length === 0) return null;
  return { top, ext };
}
