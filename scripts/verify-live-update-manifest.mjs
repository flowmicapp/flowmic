// scripts/verify-live-update-manifest.mjs — does the PUBLIC update endpoint
// advertise this round?
//
// SPEC-REF:
//   docs/decisions/2026-08-10-owner-seven-rulings-after-0261.md ① (companion gate)
//   docs/strategy/2026-08-10-device-line-window-handoff-report.md §8-1 (measured confirmation)
//
// WHAT THIS GATE IS FOR. On 2026-08-10, 0.2.61 shipped with every gate green —
// relay /api/health, three APK byte gates, download-center /latest, artifact
// sha256 byte-for-byte — while the public /api/updates/latest still advertised
// 0.2.59 for every platform. Every green gate measured "is the package right";
// none measured "will the update service tell anyone it exists". Clients asking
// "is there an update" were told they already had the latest. The warning that
// would have caught it existed as a print statement nobody read (「写了，没人接」).
//
// So this gate asks exactly that one question, and its shape — per the ruling —
// is "you may not believe you are done", NOT "we generate it for you":
//   · it READS the public endpoint and compares; it writes and deploys NOTHING
//     (production deploys belong to the device line — docs/FLEET.md);
//   · for every platform that shipped an artifact this round (./publish is the
//     evidence), the live manifest must advertise exactly this round's version;
//   · any other answer — stale, missing platform, no manifest at all, or an
//     endpoint we could not ask — exits non-zero, with a message naming the
//     one action that fixes that specific state.
//
// Run standalone:  node scripts/verify-live-update-manifest.mjs
//   (re-run after deploying the manifest until it is green — that loop is the
//   intended workflow, not a failure mode)
// Also invoked by scripts/publish.mjs at the very end of every run that
// uploaded artifacts to the LAN download center, so a publish run physically
// cannot end green while the live face still advertises the previous version.
//
// The judgment itself lives in scripts/update-manifest-lib.mjs
// (gateShippedPlatformsLive) — pure, so the drill drives the real function
// against a loopback server instead of re-deriving it here.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify,
  fetchLiveManifest,
  gateShippedPlatformsLive,
  isRoundArtifactName,
  resolveLiveManifestUrl,
} from './update-manifest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'publish');

/** Same reference face as publish.mjs / build-update-manifest.mjs — the root
 *  package.json version-sync compares every other face against. */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

if (!existsSync(OUT)) {
  console.error('✗ no ./publish — nothing on this machine claims to have shipped anything.');
  console.error('  This gate compares "what shipped this round" with "what the live endpoint');
  console.error('  advertises", and without ./publish there is no first half. Run');
  console.error('  node scripts/publish.mjs first.');
  process.exit(1);
}

// ./publish is the evidence of what shipped — the same directory the download
// center was fed from, filtered by the same predicate the manifest builder
// uses. Deriving "shipped platforms" from anything else (memory, flags, a
// previously written manifest file) would be a second answer to one question.
const names = readdirSync(OUT).filter((f) => isRoundArtifactName(f, VERSION));
if (names.length === 0) {
  console.error(`✗ ./publish has no ${VERSION} artifacts — nothing shipped this round on this machine,`);
  console.error('  so there is nothing for the live manifest to be measured against. Run');
  console.error('  node scripts/publish.mjs first.');
  process.exit(1);
}

const shipped = [...new Set(names.map((n) => classify(n)?.platform).filter(Boolean))].sort();
if (shipped.length === 0) {
  // Round artifacts exist but none classify — the builder would refuse these
  // by name; here it just means there is no platform claim to check.
  console.error(`✗ ./publish has ${VERSION} artifacts but none classify to a platform — the manifest`);
  console.error('  builder will refuse them by name; fix that first (node scripts/build-update-manifest.mjs).');
  process.exit(1);
}

const url = resolveLiveManifestUrl();
console.log(`shipped this round (from ./publish): ${shipped.join(', ')}  @ ${VERSION}`);
console.log(`asking: GET ${url}`);

const fetched = await fetchLiveManifest({ url });
const { failures, okLines } = gateShippedPlatformsLive({ shipped, version: VERSION, fetched, url });

for (const line of okLines) console.log(`✓ ${line}`);
for (const line of failures) console.error(`✗ ${line}`);

if (failures.length > 0) {
  console.error('\n✗ the live update endpoint does not advertise this round — the release is NOT done.');
  process.exit(1);
}
console.log(`\n✓ live update manifest advertises ${VERSION} for every platform that shipped this round`);
