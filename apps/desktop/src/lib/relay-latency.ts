import { invokeSafe } from './bridge';

/** One measured door of one relay node. */
export type PathReading = {
  kind: 'published' | 'alternate' | string;
  connect_ms: number | null;
  rtt_ms: number | null;
};

/** One published node as the settings panel paints it. No id, no URL. */
export type NodeLatencyRow = {
  short: string | null;
  selected: boolean;
  paths: PathReading[];
};

function asMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function asPath(v: unknown): PathReading | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = typeof o.kind === 'string' && o.kind.trim() ? o.kind : 'published';
  return { kind, connect_ms: asMs(o.connect_ms), rtt_ms: asMs(o.rtt_ms) };
}

/** Narrow the command's JSON. Unknown keys (an id, a URL) are dropped rather
 *  than forwarded — those are our words, and the panel must not be able to
 *  print them even if a future DTO grows them by accident. */
export function asNodeRows(raw: unknown): NodeLatencyRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const out: NodeLatencyRow[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const paths = Array.isArray(o.paths)
      ? o.paths.map(asPath).filter((p): p is PathReading => p !== null)
      : [];
    if (paths.length === 0) continue;
    const short =
      typeof o.short === 'string' && o.short.trim() ? o.short.trim() : null;
    out.push({ short, selected: o.selected === true, paths });
  }
  return out;
}

/** On-demand. A down bridge returns undefined so the panel stays as it was. */
export async function checkRelayLatency(): Promise<NodeLatencyRow[] | undefined> {
  const raw = await invokeSafe<unknown>('relay_latency_check');
  if (raw === undefined) return undefined;
  return asNodeRows(raw);
}
