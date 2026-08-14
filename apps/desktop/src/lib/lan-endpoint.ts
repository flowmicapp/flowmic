// GA-21 — which LAN address the phone is told to dial.
//
// SPEC-REF: REDESIGN §5.2 (multi-NIC dropdown, 多网卡下拉); 07 §5 (LAN IP selection, LAN IP 选择);
//   docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-21.
//
// The server ranks this host's addresses and calls the first one `primary`. That
// ranking is a GUESS about which NIC the phone shares, and on the owner's network
// it guesses wrong: the tablet can reach 100.64.7.x, which is not RFC1918, so it
// never ranks first — every QR and every announced endpoint pointed at an address
// the tablet could not reach, and LAN pairing was broken out of the box.
//
// So the guess becomes a DEFAULT and the human gets the override. Two rules keep
// that honest:
//   • nothing is hidden — every address the host has is offered, because a
//     heuristic that hides the one you need is a silent failure;
//   • the choice is DEVICE-LOCAL (localStorage). Which cable this machine is
//     reachable on is a property of this machine's wiring, not of the account —
//     it must never enter the synced settings store.

/** One address as `/api/network` ranked it (mirrors the server's LanCandidate). */
export interface LanCandidate {
  address: string;
  /** True for a legal-but-non-RFC1918 private range (172.77.x, CGNAT, …). The UI
   *  LABELS these rather than demoting them: the whole defect was a heuristic
   *  quietly deciding such an address could not be the right one. */
  nonStandardPrivate: boolean;
}

/** Device-local, deliberately NOT a synced settings key (see file header). */
export const LAN_HOST_KEY = 'flowmic.pairing.lan_host';

/** Strip an `http://host:port` down to its host, '' when unparseable. */
export function hostOf(endpoint: string): string {
  const e = endpoint.trim();
  if (!e) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `http://${e}`).hostname;
  } catch {
    return '';
  }
}

/**
 * Rewrite [endpoint]'s host to [selected], keeping scheme and port.
 *
 * Returns [endpoint] untouched when nothing is selected, when the selection is
 * already the host, or when the endpoint cannot be parsed — a picker that
 * silently produced a malformed URL would be worse than no picker.
 */
export function applySelectedHost(endpoint: string, selected: string | null): string {
  const e = endpoint.trim();
  if (!e || !selected) return endpoint;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `http://${e}`);
    if (u.hostname === selected) return endpoint;
    u.hostname = selected;
    // Keep the original textual shape (no trailing slash the caller did not have).
    return u.toString().replace(/\/$/, '');
  } catch {
    return endpoint;
  }
}

/**
 * The address the picker should show as chosen: the stored selection when it is
 * still one of this host's addresses, otherwise the server's default (the first
 * candidate). A stored address that has since disappeared — the cable was
 * unplugged, the VPN is down — must NOT be advertised: the phone would be told
 * to dial something that no longer exists.
 */
export function resolveSelected(
  candidates: readonly LanCandidate[],
  stored: string | null,
): string | null {
  if (candidates.length === 0) return null;
  if (stored && candidates.some((c) => c.address === stored)) return stored;
  return candidates[0]?.address ?? null;
}

export function loadSelectedHost(): string | null {
  try {
    return localStorage.getItem(LAN_HOST_KEY);
  } catch {
    return null; // private mode / storage disabled → fall back to the default
  }
}

export function saveSelectedHost(host: string | null): void {
  try {
    if (host) localStorage.setItem(LAN_HOST_KEY, host);
    else localStorage.removeItem(LAN_HOST_KEY);
  } catch {
    // A machine that cannot persist the choice still honours it for this run.
  }
}
