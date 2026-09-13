// SPEC-REF:
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §3.1 (gate 4:
//     per-network caps) and its closing note 「ip_bucket 存 IPv4 /32、IPv6 /64 的
//     哈希，不存明文」
//   docs/legal/privacy-policy.md (the site keeps no visitor IP address)
//   ../http/trusted-proxy.ts `clientIpFromRequest` — the ONE place the address
//     itself is derived; this module only narrows and hashes what it produced.
//   *** HUMAN-AUDIT SENSITIVE (privacy) ***
//
// 「Which network is this visitor on」 — as a value that can be counted and
// compared, and that nobody can read an address back out of.
//
// ── WHY A PREFIX AND NOT THE ADDRESS ───────────────────────────────────────
// IPv4 gets its whole /32 because that IS the unit a household or an office
// shares. IPv6 gets only its /64 because a single device is routinely handed
// many addresses inside one — counting the full address there would give every
// visitor an unlimited supply of fresh 「networks」, i.e. the cap would exist and
// do nothing, which is worse than no cap because it would be believed.
//
// ── 🔴 THE SALT IS WHAT MAKES THE HASH MEAN ANYTHING ───────────────────────
// The IPv4 space is 2^32 wide. An UNSALTED sha256 of an address is therefore
// reversible by anyone with a laptop and an afternoon: the digest would be a
// stored IP wearing a disguise, and the privacy policy's 「we do not keep your
// address」 would be false in a way no reader could check. FLOWMIC_TRIAL_IP_SALT
// is a deployment secret; when it is missing the boot log SAYS SO, once, rather
// than pretending the column is anonymous. It is not a hard failure because the
// alternative — refusing to boot — takes down transcription for everybody over a
// value that only matters on the site-demo path.

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { log } from '../log';

/** Length of the stored digest. 32 hex characters is 128 bits of the sha256 —
 *  far past any collision concern for a per-day counter, and short enough that
 *  a log line carrying one stays readable. */
export const IP_BUCKET_HEX_LENGTH = 32;

/**
 * The /32 (IPv4) or /64 (IPv6) prefix of `ip`, as a string.
 *
 * An address this process could not parse comes back as the literal
 * `'(unknown)'` — one bucket that every unparseable caller shares. That is the
 * strict direction: they are counted TOGETHER, so an attacker cannot escape the
 * per-network cap by arriving with something we cannot read. It is never an
 * empty string, because an empty bucket key would silently merge with any other
 * empty one for a different reason.
 */
export function ipPrefix(ip: string): string {
  const raw = typeof ip === 'string' ? ip.trim().toLowerCase() : '';
  const kind = isIP(raw);
  if (kind === 4) return raw;
  if (kind === 6) {
    // `isIP` accepted it, so it is a well-formed address; expand once so that
    // `2001:db8::1` and `2001:0db8:0000:0000::1` cannot land in two buckets.
    const [head] = raw.split('%'); // drop any zone id — it is local, not a network
    const groups = expandV6(head ?? raw);
    return groups === null ? '(unknown)' : groups.slice(0, 4).join(':');
  }
  return '(unknown)';
}

/** Full 8-group expansion of an IPv6 literal, or null if it does not have the
 *  shape `isIP` promised. IPv4-mapped tails (`::ffff:1.2.3.4`) keep their tail
 *  verbatim: it lands inside the first four groups either way. */
function expandV6(addr: string): string[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = (halves[0] ?? '').split(':').filter((g) => g !== '');
  const right = halves.length === 2 ? (halves[1] ?? '').split(':').filter((g) => g !== '') : [];
  if (halves.length === 1) return left.length === 8 ? left.map(pad) : null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left.map(pad), ...Array(fill).fill('0000'), ...right.map(pad)];
}

function pad(group: string): string {
  return group.length >= 4 ? group : '0'.repeat(4 - group.length) + group;
}

/** The stored bucket key for one address. Pure — the salt is passed in so a test
 *  can prove two addresses in one /64 collapse without touching the process env. */
export function ipBucketOf(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ipPrefix(ip)}`).digest('hex').slice(0, IP_BUCKET_HEX_LENGTH);
}

/**
 * Resolve the process-wide salt, announcing the outcome in BOTH directions —
 * the rule auth/captcha.ts states: an absence that could mean 「off」 or 「this
 * build has no switch」 is worse than a line that says which.
 */
export function resolveIpBucketSalt(env: NodeJS.ProcessEnv = process.env): string {
  const salt = (env.FLOWMIC_TRIAL_IP_SALT ?? '').trim();
  if (salt === '') {
    log.warn(
      'trial: FLOWMIC_TRIAL_IP_SALT is not set — site-demo IP buckets are an UNSALTED hash, which is reversible for IPv4',
      { env: 'FLOWMIC_TRIAL_IP_SALT' },
    );
    return '';
  }
  return salt;
}
