// GA-12 — the desktop half of the STT/LLM 「测试连接」("test connection") four-dimension probe.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (four-dimension probe)
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-12
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D3 (one-shot result shown inline, no lingering green light)
//
// Everything except the markup lives here so it is unit-testable in the desktop's
// node-env vitest (no jsdom, no .vue): the transport, the four-dimension → view
// mapping, and the one-shot store.
//
// Two rules this module exists to enforce:
//
//   • NEVER FABRICATE A DIMENSION. `model_echoed: null` renders 「未提供」("not provided"), and an
//     empty `sample_output` renders the reason it is empty (a ws handshake did
//     not transcribe anything, and saying otherwise would be a lie the owner
//     would act on).
//
//   • NEVER LEAVE A GREEN LIGHT. The result is a reading, not a state. It lives
//     in a store created per component instance, is written to no cache, and
//     `reset()` wipes it the moment the settings page stops being displayed or
//     the config under test is edited — a ✓ next to an endpoint the user has
//     since changed is worse than no ✓ at all.

import { reactive } from 'vue';
import { ERROR_CODES, getErrorMessage, type ErrorCode } from '@flowmic/protocol';
import { S } from './strings';

/** Mirrors apps/server-core/src/http/probe-routes.ts (the wire shape). */
export type ProbeKind = 'completion' | 'handshake' | 'transcribe' | 'local-model';

export interface ProbeOk {
  ok: true;
  latency_ms: number;
  sample_output: string;
  model_echoed: string | null;
  probe_kind: ProbeKind;
  byok: boolean;
}
export interface ProbeFail {
  ok: false;
  code: string;
  message: string;
  latency_ms: number;
  probe_kind?: ProbeKind;
}
export type ProbeResult = ProbeOk | ProbeFail;

export const PROBE_LLM_PATH = '/api/probe/llm';
export const PROBE_STT_PATH = '/api/probe/stt';

// ── transport ────────────────────────────────────────────────────────────────

export interface ProbeTransport {
  /** Base url of the local FlowMic server (`http://127.0.0.1:PORT`), or null when
   *  there is none — the sidecar is still starting, or failed. */
  baseUrl(): Promise<string | null>;
  /** Injectable for tests; defaults to the WebView fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Shape-check a parsed body. A server that answers something else is a failure
 *  we SHOW, not one we paper over with defaults. */
function asProbeResult(v: unknown): ProbeResult | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o['ok'] === true) {
    return {
      ok: true,
      latency_ms: typeof o['latency_ms'] === 'number' ? o['latency_ms'] : 0,
      sample_output: typeof o['sample_output'] === 'string' ? o['sample_output'] : '',
      model_echoed: typeof o['model_echoed'] === 'string' ? o['model_echoed'] : null,
      probe_kind: (o['probe_kind'] ?? 'completion') as ProbeKind,
      byok: o['byok'] === true,
    };
  }
  if (o['ok'] === false) {
    return {
      ok: false,
      code: typeof o['code'] === 'string' ? o['code'] : '',
      message: typeof o['message'] === 'string' ? o['message'] : '',
      latency_ms: typeof o['latency_ms'] === 'number' ? o['latency_ms'] : 0,
      ...(typeof o['probe_kind'] === 'string' ? { probe_kind: o['probe_kind'] as ProbeKind } : {}),
    };
  }
  return null;
}

function localFailure(path: string, message: string): ProbeFail {
  return { ok: false, code: path === PROBE_LLM_PATH ? 'LLM_PROBE_FAIL' : 'STT_PROBE_FAIL', message, latency_ms: 0 };
}

/** POST one probe. Every failure mode — no server, transport error, junk body —
 *  becomes a rendered ProbeFail; this never throws and never returns a fake ok. */
export async function runProbe(path: string, body: unknown, t: ProbeTransport): Promise<ProbeResult> {
  const base = await t.baseUrl().catch(() => null);
  if (base === null || base.length === 0) return localFailure(path, S.probe_no_server);
  const doFetch = t.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = asProbeResult(await res.json());
    return parsed ?? localFailure(path, `unexpected probe response (http ${res.status})`);
  } catch (err) {
    return localFailure(path, err instanceof Error ? err.message : String(err));
  }
}

// ── four-dimension → view ────────────────────────────────────────────────────

/** One inline result line. Every field here has a render point in the two
 *  settings components — that is the anti-façade contract for this card. */
export interface ProbeRowView {
  /** What was tested: 「大模型」("large model") or 「zh-CN · funasr」. */
  label: string;
  ok: boolean;
  /** ① latency_ms, already formatted (`128 ms`). */
  latency: string;
  /** ② sample_output, or the honest reason it is empty (see `sampleIsNote`). */
  sample: string;
  sampleIsNote: boolean;
  /** ③ model_echoed, or 「未提供」("not provided") — never blank, never invented. */
  model: string;
  /** ④ the engine-layer BYOK verdict (what a real session would be billed as). */
  byok: string;
  /** zh headline: 「连接正常」("connection normal") or the protocol ERROR_CODES copy for `code`. */
  headline: string;
  /** Collapsible raw error — empty when there is nothing raw to show. */
  detail: string;
}

function headlineFor(code: string): string {
  if (Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
    return getErrorMessage(code as ErrorCode, 'zh-CN');
  }
  return code.length > 0 ? code : S.probe_note_empty;
}

/** The caption under an EMPTY sample — the card's 「做不到真转写就不要假装」("if you can't produce a real transcript, don't fake it"). */
export function emptySampleNote(kind: ProbeKind | undefined): string {
  switch (kind) {
    case 'handshake': return S.probe_note_handshake;
    case 'local-model': return S.probe_note_local;
    case 'transcribe': return S.probe_note_silent;
    default: return S.probe_note_empty;
  }
}

/** True when the LLM settings box has something to dial. Empty endpoint must
 *  short-circuit before `runProbe` — the server answers `LLM_INVALID_MODEL`
 *  for a missing endpoint, which would tell the user the *engine* is wrong. */
export function isLlmEndpointConfigured(endpoint: string): boolean {
  return endpoint.trim().length > 0;
}

/** Config-missing face with a catalogue sentence as the headline (not a bare
 *  machine code). Used by ConnDiag REQ-12-12 and available to settings. */
export function configMissingRow(label: string, message: string, code: string): ProbeRowView {
  return {
    label,
    ok: false,
    latency: '0 ms',
    sample: S.probe_none,
    sampleIsNote: true,
    model: S.probe_none,
    byok: '',
    headline: message,
    detail: code,
  };
}

/** Among per-language STT probes, surface a failure if any; else the first OK.
 *  ConnDiag shows ONE STT line even when several routings exist. */
export function pickSttDiagResult(results: readonly ProbeResult[]): ProbeResult {
  if (results.length === 0) {
    return { ok: false, code: 'STT_CONFIG_MISSING', message: S.probe_no_routing, latency_ms: 0 };
  }
  return results.find((r) => !r.ok) ?? results[0]!;
}

export function toRowView(label: string, r: ProbeResult): ProbeRowView {
  const latency = `${Math.max(0, Math.round(r.latency_ms))} ms`;
  if (!r.ok) {
    return {
      label, ok: false, latency,
      // Nothing was obtained — say so, in the same slot, rather than leaving a
      // blank the eye reads as「empty answer」.
      sample: S.probe_none, sampleIsNote: true,
      model: S.probe_none, byok: '',
      headline: headlineFor(r.code),
      // The code travels with the raw text: the headline is deliberately plain
      // language, and the owner still needs the machine truth to act on.
      detail: r.code.length > 0 ? `${r.code}: ${r.message}` : r.message,
    };
  }
  const hasSample = r.sample_output.length > 0;
  return {
    label, ok: true, latency,
    sample: hasSample ? r.sample_output : emptySampleNote(r.probe_kind),
    sampleIsNote: !hasSample,
    model: r.model_echoed === null || r.model_echoed.length === 0 ? S.probe_none : r.model_echoed,
    byok: r.byok ? S.probe_byok : S.probe_managed,
    headline: S.probe_ok,
    detail: '',
  };
}

// ── the one-shot store ───────────────────────────────────────────────────────

export interface ProbeState {
  running: boolean;
  rows: ProbeRowView[];
  /** Which row's raw error is expanded (index), or -1. */
  expanded: number;
}

export interface ProbeStore {
  state: ProbeState;
  /** Run the probe(s). Concurrent clicks are ignored (the button is also
   *  disabled) so one reading can never be overwritten mid-flight by another. */
  run(): Promise<void>;
  toggle(index: number): void;
  /** Wipe the reading. Called on config edits and when the page is hidden. */
  reset(): void;
}

export function createProbeStore(runner: () => Promise<ProbeRowView[]>): ProbeStore {
  const state = reactive<ProbeState>({ running: false, rows: [], expanded: -1 });
  return {
    state,
    async run(): Promise<void> {
      if (state.running) return;
      state.running = true;
      state.rows = [];
      state.expanded = -1;
      try {
        state.rows = await runner();
      } finally {
        state.running = false;
      }
    },
    toggle(index): void {
      state.expanded = state.expanded === index ? -1 : index;
    },
    reset(): void {
      state.rows = [];
      state.expanded = -1;
    },
  };
}

// ── "the page stopped being displayed" ───────────────────────────────────────
//
// The main window swaps pages with `v-show`, so a settings section is NEVER
// unmounted and component-local state would survive a trip to the timeline and
// back — exactly the resident-green-light failure D3 forbids. `display:none`
// collapses the element's box to zero, which an IntersectionObserver reports;
// merely scrolling the section out of view keeps a non-zero box, so the reading
// survives scrolling (as it should) and dies on navigation (as it must).

export interface HiddenWatcher { disconnect(): void }

export type ObserverCtor = new (cb: (entries: Array<{ boundingClientRect: { width: number; height: number } }>) => void) => {
  observe(el: Element): void;
  disconnect(): void;
};

/** True iff the element currently has no layout box at all. */
export function isCollapsed(rect: { width: number; height: number }): boolean {
  return rect.width === 0 && rect.height === 0;
}

export function watchHidden(el: Element, onHidden: () => void, Ctor?: ObserverCtor): HiddenWatcher {
  const Impl = Ctor ?? (globalThis as { IntersectionObserver?: ObserverCtor }).IntersectionObserver;
  if (!Impl) return { disconnect: () => {} }; // no observer (vite preview / test) → no auto-clear
  const io = new Impl((entries) => {
    const last = entries[entries.length - 1];
    if (last && isCollapsed(last.boundingClientRect)) onHidden();
  });
  io.observe(el);
  return io;
}
