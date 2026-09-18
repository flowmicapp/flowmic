// scripts/ship-split-state.mjs — the two functions that answer "which targets
// are now on different versions" after a partly-failed round.
//
// Split out of scripts/ship.mjs on 2026-09-18 VERBATIM (bodies unchanged, only
// the `spawnSync` import is now local) because that file hit its 800-line cap
// while the ruling-① gate was being moved to the node that can honestly answer
// it. This family comes out whole: it is the only one in ship.mjs that talks to
// the network, and nothing else in the file calls it except the failure branch.
// ship.mjs re-exports both names, so this split is a fact about where the lines
// live and not a change to that file's surface.

import { spawnSync } from 'node:child_process';


// ── split state ──────────────────────────────────────────────────────────────
//
// §2.4: already-finished deploys are NOT rolled back. What the operator gets
// instead is the names of the targets that are now on different versions. Three
// states, never two (§4 R7): a version we could not read is UNKNOWN and is never
// folded in with the ones we did read.
export function splitStateLine(readings) {
  const known = readings.filter((r) => r.version);
  const versions = [...new Set(known.map((r) => r.version))];
  const unknown = readings.filter((r) => !r.version);
  if (versions.length <= 1 && unknown.length === 0) {
    return `SPLIT-STATE none — every target answered ${versions[0] ?? '(nothing probed)'}`;
  }
  const parts = versions.map((v) => `${v}: ${known.filter((r) => r.version === v).map((r) => r.name).join('+')}`);
  for (const u of unknown) parts.push(`UNKNOWN: ${u.name} (${u.reason})`);
  return `SPLIT-STATE ${parts.join(' | ')}`;
}

/** Read each live target's own answer. PowerShell on Windows on purpose: this
 *  machine's curl and /dev/tcp both answer for addresses that are not there
 *  when mihomo is up (CLAUDE.md, measured), and a probe that invents an answer
 *  is worse than one that says UNKNOWN. */
export async function probeVersions(names, { platform = process.platform } = {}) {
  const ENDPOINTS = {
    DEPLOY_NY: { url: 'https://srvny.flowmic.app/api/health', pick: (b) => JSON.parse(b).version },
    DEPLOY_JP: { url: 'https://srvjp.flowmic.app/api/health', pick: (b) => JSON.parse(b).version },
    DEPLOY_SITE: { url: 'https://flowmic.app/', pick: (b) => /name="flowmic-build"\s+content="flowmic-web-build@([0-9a-f]{40})/.exec(b)?.[1]?.slice(0, 12) },
  };
  const out = [];
  for (const name of names) {
    const ep = ENDPOINTS[name];
    if (!ep) { out.push({ name, version: null, reason: 'no version endpoint this script may read without re-deriving the deploy script\'s own assertion' }); continue; }
    try {
      const r = platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri '${ep.url}').Content`], { encoding: 'utf8', windowsHide: true })
        : spawnSync('curl', ['-fsS', '--max-time', '15', ep.url], { encoding: 'utf8' });
      const v = r.status === 0 ? ep.pick(String(r.stdout || '')) : null;
      out.push(v ? { name, version: v } : { name, version: null, reason: `probe exited ${r.status}` });
    } catch (e) {
      out.push({ name, version: null, reason: String(e.message || e) });
    }
  }
  return out;
}
