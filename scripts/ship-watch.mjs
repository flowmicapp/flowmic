#!/usr/bin/env node
// SC-9 — ship-watch.mjs: the four queues that are NOT allowed to hold the line.
// (docs/strategy/2026-09-17-ship-chain-eight-minute-design.md §3.2 table,
//  §4 R7, §5 row SC-9.)
//
// WHAT THIS IS. A read-mostly poller over four things that finish on somebody
// else's clock — Apple's notary service, Apple's TestFlight processing, GitHub's
// hosted runners, and the LAN download centre's rotation. None of them can be
// made faster by waiting for them, and all four used to be waited for by a
// person: that is where the "25 min Mac + hours of Apple/CI" in §5 went. This
// writes their state into one small text file and gets out of the way.
//
// 🔴 THE ONE RULE (§4 R7). "I could not ask" must never be written as "it is
// fine". Three states exist and no more:
//
//     PENDING  — not finished yet, OR we could not ask. The detail says which:
//                a reading we could not take starts with `unreachable:`.
//     DONE     — the criterion below was met, read out of text the producing
//                machine printed.
//     FAILED   — the queue produced a terminal negative answer.
//
// DONE and FAILED are TERMINAL: once written they are never overwritten, so a
// probe that starts throwing an hour later cannot erase a real answer, and a
// FAILED can never quietly relax back into PENDING. A probe that throws is
// caught, and what it threw is the detail — never a silent skip, never a DONE.
//
// 🔴 EXIT CODES ARE NOT THE EVIDENCE — the printed line is (RELEASE-IRONRULES
// §1-21, and `~/asc-review-state.mjs`'s own header, which records that its exit
// code was wrong twice in the direction that matters). Every probe below reads
// stdout TEXT. An exit code is used only where the producing script's own
// contract says the text and the code come out of one switch.
//
// THE FOUR CRITERIA, each pinned to bytes a real machine prints:
//
//  1. MAC          ssh flowmic-mac 'cat ~/mac-release-<v>.log'   (v without dots)
//                  DONE  = the log's terminal marker MAC_<v>_DONE is present AND
//                          the checks line reads spctl-notarized=1 staple-ok=1.
//                          The line above the marker carries the sha256 and the
//                          zip name `adopt-artifact.mjs --sha256` needs.
//                  FAILED= the checks line reads spctl-notarized=0 or staple-ok=0.
//                  (The design guessed `grep -c "^ARTEFACT "`. The recipe does not
//                  print that; it prints `=== ZIP ARTIFACT (portable name) ===`,
//                  then ls, then `<sha256>  <name>`, then the marker. Read off
//                  ~/mac-release-0378.log on flowmic-mac, 2026-09-18.)
//
//  2. TESTFLIGHT   ssh flowmic-mac 'node ~/asc-build-state.mjs <version>'
//                  DONE  = stdout carries `READY: <v> has a VALID build`.
//                  FAILED= `NO APP RECORD`.
//                  🔴 This is the PROCESSING clock, not the Beta-review clock —
//                  the two questions §1-21 keeps apart. The review answer
//                  (`asc-review-state.mjs`) rides along in the detail and is
//                  NEVER part of the DONE criterion; folding those two together
//                  is how a public link came to serve an older build, twice.
//                  The App Store Connect key lives on the Mac
//                  (~/.local/asc-api-key/), not on this machine — which is why
//                  this is an ssh probe and not a local API call.
//
//  3. PUBLIC_CI    gh run list --repo flowmicapp/flowmic --commit <public sha>
//                  DONE  = all four required workflows completed successfully.
//                  FAILED= any of the four reached a negative conclusion; the
//                          detail names which (§1-13 wants the workflow named).
//                  The public sha is NOT this repo's HEAD — the sync commits a
//                  squashed tree under its own sha. Pass --public-sha, or let it
//                  resolve the newest public commit whose message names this
//                  version (`release <version>` is the standing spelling). No
//                  such commit ⇒ PENDING "no synced commit names <version>",
//                  which is the honest answer for a round that never synced.
//
//  4. DC_ROTATION  GET <entry>/api/v1/projects/flowmic/latest and .../artifacts
//                  DONE  = /latest reports this version AND the site is down to
//                          its three retained versions, this one among them.
//                  This queue has no FAILED: a read either answers or it does
//                  not, and "the site still shows the previous version" is the
//                  ordinary shape of not-yet, not a failure. Said out loud so
//                  nobody reads the absence of FAILED as an absence of checking.
//
// CADENCE. One named constant per queue (§5): Apple 60 s, CI 30 s, DC 15 s. The
// point of three numbers rather than one is that they buy different things — the
// download centre answers in milliseconds and is worth asking often; Apple
// answers in tens of minutes, and asking it every 15 s is only rudeness with a
// log file attached.
//
// Run:
//   node scripts/ship-watch.mjs <round>              background watcher
//   node scripts/ship-watch.mjs <round> --once       one pass per queue, exit
//   node scripts/ship-watch.mjs <round> --adopt      on MAC DONE: adopt + republish
//   node scripts/ship-watch.mjs <round> --max-hours 6
//   node scripts/ship-watch.mjs <round> --version 0.3.89 --public-sha <sha>
//
// <round> keys the directory under .local/ship/ and may be a sha or a version;
// when it looks like a version it is also the default --version.
//
// Exit: 0 = every queue terminal, or --once finished its pass. 1 = timed out
// with queues still PENDING. 2 = bad usage.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

// ── the vocabulary ───────────────────────────────────────────────────────────

export const PENDING = 'PENDING';
export const DONE = 'DONE';
export const FAILED = 'FAILED';
export const STATES = Object.freeze([PENDING, DONE, FAILED]);
/** DONE and FAILED are answers; PENDING is the absence of one. Only answers are
 *  kept across polls. */
export const TERMINAL = Object.freeze([DONE, FAILED]);

export const QUEUES = Object.freeze(['MAC', 'TESTFLIGHT', 'PUBLIC_CI', 'DC_ROTATION']);

/** §5: one cadence per queue, named, because they are three different bets on
 *  how long the far side takes — not one number somebody rounded. */
export const CADENCE_MS = Object.freeze({
  MAC: 60_000,          // Apple notarisation: tens of minutes
  TESTFLIGHT: 60_000,   // Apple build processing: tens of minutes
  PUBLIC_CI: 30_000,    // hosted runners: 3.3–17.4 min per workflow
  DC_ROTATION: 15_000,  // one LAN HTTP GET
});

export const DEFAULT_MAX_HOURS = 6;

/** The four workflows §1-13 requires somebody to look at. `cla` is a fifth
 *  workflow on that repo and is deliberately NOT here: it runs on contributor
 *  pull requests, so requiring it would leave PUBLIC_CI pending forever on a
 *  push that is perfectly green. */
export const REQUIRED_WORKFLOWS = Object.freeze(['verify', 'verify-macos', 'verify-linux', 'flutter']);

/** GitHub's negative conclusions. `skipped` is absent on purpose: a skipped
 *  required workflow is not a failure, it is an unanswered question, and an
 *  unanswered question belongs in PENDING. */
const NEGATIVE_CONCLUSIONS = Object.freeze(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required', 'stale']);

/**
 * Where to ask. The publisher (`publish-download-center.mjs`, excluded from the
 * open-source export) tries the IP first and its domain alias second, because on
 * a machine with a VPN the domain can resolve out through an interface the site
 * does not recognise and answer 403.
 *
 * 🔴 Only the IP is repeated here; the domain alias deliberately is not. That
 * hostname is one of the strings `oss-absent-sweep` forbids in anything that
 * ships, and this file ships (the LAN range itself is handled tree-wide by the
 * `office-lan-range` redaction, so the address below survives the export as a
 * placeholder). Losing the second entry costs the fallback the publisher has —
 * and `DOWNLOAD_CENTER_URL` already covers the case where somebody needs to
 * point this somewhere else, which is how the publisher spells the same escape.
 * A watcher that cannot reach the site says `unreachable:` and stays PENDING,
 * which is the correct answer to "is the rotation done" when we could not look.
 */
const DC_ENTRIES = process.env.DOWNLOAD_CENTER_URL
  ? [process.env.DOWNLOAD_CENTER_URL]
  : ['http://100.64.7.68'];
const DC_PROJECT = 'flowmic';
const DC_CHANNEL = 'release';
/** The site keeps three versions per channel. Rotation is "done" when it is back
 *  down to that, not merely when the upload landed. */
export const DC_RETAINED_VERSIONS = 3;

const MAC_HOST = 'flowmic-mac';

// ── the status file ──────────────────────────────────────────────────────────

export function statusPath(round, root = REPO_ROOT) {
  return join(root, '.local', 'ship', round, 'external.status');
}

/** `<QUEUE> <STATE> <since ISO> <detail>` — three fixed tokens, then prose. The
 *  detail is forced onto one line: a status file whose rows can wrap is a status
 *  file nothing can parse, and the first thing to parse it will be the next
 *  person, under time pressure, with grep. */
export function formatLine({ queue, state, since, detail }) {
  const flat = String(detail ?? '').replace(/\s+/g, ' ').trim();
  return `${queue} ${state} ${since} ${flat}`.trimEnd();
}

export function parseStatusFile(text) {
  const rows = new Map();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const [, queue, state, since, detail] = m;
    if (!QUEUES.includes(queue) || !STATES.includes(state)) continue;
    rows.set(queue, { queue, state, since, detail: detail ?? '' });
  }
  return rows;
}

/** Whole-file rewrite from the in-memory rows, in the fixed QUEUES order. Doing
 *  it this way — rather than appending, or patching one line in place — is what
 *  makes the file idempotent: the same readings written twice produce the same
 *  bytes, and a half-written previous run cannot leave behind a row that nothing
 *  ever overwrites. */
export function renderStatusFile(rows, { round, version, startedAt, fixtures = null } = {}) {
  const head = [
    `# ship-watch ${round ?? '?'} version=${version ?? '?'} started=${startedAt ?? '?'}`,
    '# <QUEUE> <PENDING|DONE|FAILED> <since ISO> <detail>   (DONE/FAILED are terminal)',
  ];
  if (fixtures) {
    head.push(`# FIXTURES ${fixtures} — these readings came from a fixture directory, NOT from the real queues`);
  }
  const body = QUEUES.map((q) => {
    const r = rows.get(q);
    return r
      ? formatLine(r)
      : formatLine({ queue: q, state: PENDING, since: startedAt ?? new Date(0).toISOString(), detail: 'not polled yet' });
  });
  return `${[...head, ...body].join('\n')}\n`;
}

export function readStatusFile(round, root = REPO_ROOT) {
  try {
    return parseStatusFile(readFileSync(statusPath(round, root), 'utf8'));
  } catch {
    return new Map();
  }
}

export function writeStatusFile(round, rows, meta, root = REPO_ROOT) {
  const p = statusPath(round, root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, renderStatusFile(rows, meta), 'utf8');
  return p;
}

/**
 * Fold one reading into the row that is already there.
 *
 * 🔴 The whole of §4 R7 is three lines long and they are all here:
 *   · a terminal row is never replaced — an answer, once given, stands;
 *   · an unchanged state keeps its ORIGINAL `since`, so the file says how long
 *     this has been pending rather than how long ago it was last polled. The
 *     second number is worthless and looks exactly like the first;
 *   · anything that is not one of the three states is treated as a thrown probe,
 *     not as a new state. Fail closed: an unknown word must never become DONE by
 *     passing through a comparison nobody wrote.
 */
export function mergeReading(prev, reading, nowIso) {
  const queue = reading.queue;
  let { state, detail } = reading;
  if (!STATES.includes(state)) {
    state = PENDING;
    detail = `unreachable: probe returned an unknown state ${JSON.stringify(reading.state)}`;
  }
  if (prev && TERMINAL.includes(prev.state)) {
    return { row: { ...prev }, changed: false, kept: true };
  }
  if (prev && prev.state === state) {
    return { row: { queue, state, since: prev.since, detail }, changed: prev.detail !== detail, kept: false };
  }
  return { row: { queue, state, since: nowIso, detail }, changed: true, kept: false };
}

// ── running a probe without ever letting it lie ──────────────────────────────

/**
 * Every probe goes through here, and nothing else calls a probe directly.
 *
 * A probe that throws produces PENDING carrying what it threw, prefixed
 * `unreachable:` so the line ITSELF distinguishes the two kinds of PENDING —
 * "not finished yet" and "we could not ask". The design called the second one
 * UNKNOWN; the card fixes the file at three states, so it lives inside PENDING
 * with a marker rather than being folded into it invisibly. What matters is the
 * property both spellings protect: a question we could not ask NEVER reads as a
 * question that came back fine.
 */
export async function runProbe(queue, probe, ctx) {
  try {
    if (typeof probe !== 'function') throw new Error(`no probe registered for ${queue}`);
    const out = await probe(ctx);
    if (!out || typeof out !== 'object') throw new Error(`probe produced ${typeof out}, not a reading`);
    return { queue, state: out.state, detail: out.detail ?? '', extra: out.extra };
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    return { queue, state: PENDING, detail: `unreachable: ${msg}` };
  }
}

// ── small helpers the probes share ───────────────────────────────────────────

/** The recipe names its log by the version with the dots taken out: 0.3.78 ⇒
 *  mac-release-0378.log (read off flowmic-mac, not inferred). */
export function macLogName(version) {
  return `mac-release-${String(version).replace(/\./g, '')}.log`;
}

export function macDoneMarker(version) {
  return `MAC_${String(version).replace(/\./g, '')}_DONE`;
}

/**
 * Read the mac recipe's own log. On DONE this also returns the zip name and the
 * sha256 the PRODUCING machine printed — the only two facts adopt-artifact.mjs
 * accepts, and it accepts them precisely because they came from there.
 *
 * 🔴 The marker alone is not the criterion. A marker says the script reached its
 * last line; `spctl-notarized=1 staple-ok=1` says Apple accepted the bundle.
 * Those are different sentences and only the second one is what "notarised"
 * means, so a log with the marker and no checks line stays PENDING.
 */
export function parseMacLog(text, version) {
  const marker = macDoneMarker(version);
  const lines = String(text).split(/\r?\n/);
  const checks = [...lines].reverse().find((l) => l.includes('spctl-notarized=') && l.includes('staple-ok='));
  if (checks && (/spctl-notarized=0/.test(checks) || /staple-ok=0/.test(checks))) {
    return { state: FAILED, detail: `mac recipe reports ${checks.trim()} — the zip is not notarised/stapled` };
  }
  if (!String(text).includes(marker)) {
    const nonEmpty = lines.filter((l) => l.trim());
    const tail = nonEmpty.length ? nonEmpty[nonEmpty.length - 1].slice(0, 90) : '(empty log)';
    return { state: PENDING, detail: `no ${marker} in ${macLogName(version)} yet; last line: ${tail}` };
  }
  if (!checks) {
    return { state: PENDING, detail: `${marker} present but no spctl/staple line — reaching the last line is not the same fact as Apple accepting the bundle` };
  }
  const zip = String(text).match(/^([0-9a-f]{64})\s+(FlowMic-\S+\.zip)\s*$/m);
  return {
    state: DONE,
    detail: `${checks.trim()}; ${zip ? `${zip[2]} sha256=${zip[1].slice(0, 12)}...` : 'zip line not parsed'}`,
    extra: zip ? { zipName: zip[2], sha256: zip[1] } : null,
  };
}

/** asc-build-state.mjs prints its verdict as prose, and that prose is the
 *  evidence (§1-21). `READY:` / `NOT READY:` are the two lines it ends on. */
export function parseBuildState(stdout, version) {
  const text = String(stdout ?? '');
  const lines = text.split(/\r?\n/);
  if (/NO APP RECORD/.test(text)) return { state: FAILED, detail: 'App Store Connect has no app record for app.flowmic.ios' };
  const ready = lines.find((l) => l.startsWith('READY:'));
  if (ready) return { state: DONE, detail: ready.trim() };
  const notReady = lines.find((l) => l.startsWith('NOT READY:'));
  if (notReady) return { state: PENDING, detail: notReady.trim() };
  const noPre = lines.find((l) => /has NO pre-release version record yet/.test(l));
  if (noPre) return { state: PENDING, detail: `${noPre.trim()} — nothing was uploaded for ${version}` };
  const last = lines.filter((l) => l.trim()).pop() ?? '(no output)';
  return { state: PENDING, detail: `unreachable: asc-build-state printed no verdict line; last: ${last.slice(0, 120)}` };
}

/** Reduce `gh run list --json` rows to one reading. Only the newest run per
 *  workflow counts: a re-run that went green must not stay red because its first
 *  attempt is still in the list. */
export function summariseRuns(runs, sha) {
  const byWorkflow = new Map();
  for (const r of runs ?? []) {
    const name = r.workflowName ?? r.name;
    if (!REQUIRED_WORKFLOWS.includes(name)) continue;
    const prev = byWorkflow.get(name);
    if (!prev || String(r.createdAt ?? '') > String(prev.createdAt ?? '')) byWorkflow.set(name, r);
  }
  const short = String(sha).slice(0, 12);
  const bad = [...byWorkflow.values()].filter((r) => NEGATIVE_CONCLUSIONS.includes(String(r.conclusion)));
  if (bad.length > 0) {
    return { state: FAILED, detail: `${short}: ${bad.map((r) => `${r.workflowName ?? r.name}=${r.conclusion}`).join(', ')}` };
  }
  const green = [...byWorkflow.values()].filter((r) => r.status === 'completed' && r.conclusion === 'success').map((r) => r.workflowName ?? r.name);
  const missing = REQUIRED_WORKFLOWS.filter((w) => !green.includes(w));
  if (missing.length === 0) return { state: DONE, detail: `${short}: all ${REQUIRED_WORKFLOWS.length} required workflows succeeded` };
  return { state: PENDING, detail: `${short}: ${green.length}/${REQUIRED_WORKFLOWS.length} green, waiting on ${missing.join(', ')}` };
}

/** The site has answered `/latest` in three shapes across its versions; accept
 *  all three rather than picking one and calling a shape change an outage. Same
 *  reading the download-centre publisher takes at the end of an upload. */
export function latestVersionOf(json, channel = DC_CHANNEL) {
  return json?.version ?? json?.channels?.[channel]?.version ?? json?.latest_versions?.[channel] ?? null;
}

export function rotationReading(latestJson, artifacts, version) {
  const latest = latestVersionOf(latestJson);
  const versions = [...new Set((artifacts ?? []).map((a) => a?.version).filter(Boolean))];
  if (latest !== version) {
    return {
      state: PENDING,
      detail: `/latest reports ${JSON.stringify(latest)}, not ${version}${versions.length ? ` (site holds ${versions.join(', ')})` : ''}`,
    };
  }
  if (versions.length > DC_RETAINED_VERSIONS) {
    return {
      state: PENDING,
      detail: `/latest=${version} but ${versions.length} versions are still on the site (${versions.join(', ')}) — rotation down to ${DC_RETAINED_VERSIONS} has not finished`,
    };
  }
  return { state: DONE, detail: `/latest=${version}; ${versions.length} version(s) retained (${versions.join(', ') || 'listing empty'})` };
}

// ── the real probes ──────────────────────────────────────────────────────────

export const NO_NODE = '__NO_NODE__';

/**
 * Run one of the Mac's own .mjs helpers over ssh.
 *
 * 🔴 MEASURED 2026-09-18, and it cost this card its first real run: a plain
 * `ssh flowmic-mac 'node ~/asc-build-state.mjs 0.3.89'` answers
 * `zsh:1: command not found: node`. **Nothing is on PATH on that machine** in a
 * non-interactive shell — scripts/mac-verify.sh's §1 says so in as many words
 * ("On this machine NOTHING is on PATH... the only node on the machine is the
 * runtime we stage into the app bundle"). Both staged copies exist and both are
 * v22.22.3; this tries them in the order mac-verify.sh does.
 *
 * The glob is resolved through `ls ... 2>/dev/null` rather than written as a
 * shell glob: that host runs zsh, and an unmatched zsh glob ABORTS the command
 * instead of expanding to nothing — a failure that would arrive here as an empty
 * stdout, which is the shape "we could not ask" and "there is no build" share.
 *
 * `__NO_NODE__` is echoed when no runtime is found, so "no interpreter" is a
 * NAMED throw rather than an empty reading the parser would have to guess about.
 *
 * 🔴 AND IT IS AN `if/else`, NOT `[ -x "$N" ] && "$N" … || echo __NO_NODE__`.
 * That first spelling was written, run for real, and was wrong in the way this
 * whole file is about: `A && B || C` runs C whenever B FAILS, and
 * `asc-build-state.mjs` exits 3 on `NOT READY` and 2 when there is no
 * pre-release record — its normal answers. So a perfectly good reading came back
 * with `__NO_NODE__` stapled to it and was reported as "no node on the Mac",
 * which is a sentence about our ssh setup rather than about Apple. §1-21 again,
 * one level down: an exit code was allowed to speak, and it said the wrong thing.
 */
export function macNodeCommand(script, ...args) {
  const argv = args.map((a) => String(a)).join(' ');
  return [
    'N=$(command -v node || true);',
    '[ -z "$N" ] && N=$(ls -d ~/.local/node-*/bin/node 2>/dev/null | head -1);',
    '[ -z "$N" ] && N=~/flowmic-app/apps/desktop/src-tauri/resources/node;',
    `if [ -x "$N" ]; then "$N" ${script} ${argv} 2>&1; else echo ${NO_NODE}; fi`,
  ].join(' ');
}

function ssh(command, { timeoutMs = 45_000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', MAC_HOST, command], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  });
  if (r.error) throw new Error(`ssh ${MAC_HOST}: ${r.error.message}`);
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

export const REAL_PROBES = Object.freeze({
  async MAC({ version }) {
    const log = `~/${macLogName(version)}`;
    const r = ssh(`test -f ${log} && cat ${log} || echo __NO_LOG__`);
    if (r.stdout.includes('__NO_LOG__') || r.stdout.trim() === '') {
      // An ssh that could not connect and a Mac that has no log for this version
      // are different sentences; only the second one is a reading.
      if (!r.stdout.includes('__NO_LOG__')) {
        throw new Error(`ssh exit ${r.status}, no output: ${(r.stderr || '').trim().slice(0, 140) || '(no stderr)'}`);
      }
      return { state: PENDING, detail: `no ${macLogName(version)} on ${MAC_HOST} — the mac recipe has not run for ${version}` };
    }
    return parseMacLog(r.stdout, version);
  },

  async TESTFLIGHT({ version }) {
    const r = ssh(macNodeCommand('~/asc-build-state.mjs', version), { timeoutMs: 90_000 });
    if (r.stdout.includes(NO_NODE)) throw new Error(`no node on ${MAC_HOST} at any of the staged locations — see macNodeCommand`);
    if (!r.stdout.trim()) throw new Error(`asc-build-state produced no output (ssh exit ${r.status}): ${(r.stderr || '').trim().slice(0, 140) || '(no stderr)'}`);
    const reading = parseBuildState(r.stdout, version);
    // The Beta-review answer rides along and is NEVER the criterion (§1-21: two
    // clocks). It is here because the person reading this file is about to ask.
    let review = '';
    try {
      const rv = ssh(macNodeCommand('~/asc-review-state.mjs', version), { timeoutMs: 90_000 });
      const line = rv.stdout.split(/\r?\n/).find((l) => /^(QUOTABLE|PENDING|NOT-SUBMITTED|NOT-QUOTABLE|UNKNOWN)\b/.test(l));
      if (line) review = ` | beta review: ${line.trim()}`;
    } catch { /* decoration: failing to fetch the review answer changes no state */ }
    return { ...reading, detail: `${reading.detail}${review}` };
  },

  async PUBLIC_CI({ version, publicSha }) {
    const sha = publicSha ?? resolvePublicSha(version);
    if (!sha) {
      return { state: PENDING, detail: `no synced commit names ${version} in the last 30 public commits — the public repo has not been synced for this round` };
    }
    const r = spawnSync('gh', ['run', 'list', '--repo', 'flowmicapp/flowmic', '--commit', sha, '--limit', '20',
      '--json', 'workflowName,name,status,conclusion,createdAt'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (r.error) throw new Error(`gh: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`gh run list exit ${r.status}: ${(r.stderr || '').trim().slice(0, 140)}`);
    let runs;
    try { runs = JSON.parse(r.stdout); } catch (e) { throw new Error(`gh run list output is not JSON: ${e.message}`); }
    if (!Array.isArray(runs) || runs.length === 0) {
      return { state: PENDING, detail: `${String(sha).slice(0, 12)}: no workflow runs yet` };
    }
    return summariseRuns(runs, sha);
  },

  async DC_ROTATION({ version }) {
    let lastErr = null;
    for (const entry of DC_ENTRIES) {
      try {
        const latest = await (await fetch(`${entry}/api/v1/projects/${DC_PROJECT}/latest`, { signal: AbortSignal.timeout(12_000) })).json();
        const listed = await (await fetch(`${entry}/api/v1/projects/${DC_PROJECT}/artifacts`, { signal: AbortSignal.timeout(12_000) })).json();
        return rotationReading(latest, Array.isArray(listed) ? listed : listed?.artifacts, version);
      } catch (e) { lastErr = e; }
    }
    throw new Error(`download centre unreachable at ${DC_ENTRIES.join(' / ')}: ${lastErr?.message ?? lastErr}`);
  },
});

/** The public repo's sha for this round. The sync squashes the tree into one new
 *  commit, so this repo's HEAD is never it; `release <version>` is the standing
 *  message spelling (that is what `gh run list` shows as the run title for the
 *  0.3.85 sync). Nothing is inferred when no commit names the version — the
 *  answer to "which sha" is then genuinely "there isn't one". */
export function resolvePublicSha(version, run = null) {
  const exec = run ?? ((args) => spawnSync('gh', args, { encoding: 'utf8', timeout: 45_000, windowsHide: true }));
  const r = exec(['api', 'repos/flowmicapp/flowmic/commits?per_page=30', '--jq', '.[] | .sha + " " + (.commit.message | split("\n")[0])']);
  if (r.error || r.status !== 0) throw new Error(`gh api commits: ${r.error?.message ?? (r.stderr || '').trim().slice(0, 140)}`);
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const [sha, ...rest] = line.trim().split(/\s+/);
    if (!sha) continue;
    if (rest.join(' ').includes(version)) return sha;
  }
  return null;
}

// ── fixtures (drills only, and they say so on every line they write) ─────────
//
// 🔴 This is the one seam by which a reading can come from somewhere other than
// the real queue, so it is loud rather than convenient: the status file grows a
// FIXTURES header, the console says it, and --adopt refuses outright. An
// injection point a later reader cannot SEE in the output is how a test harness
// becomes a way to fake a green release.

export function fixtureProbes(dir) {
  const read = (name) => readFileSync(join(dir, name), 'utf8');
  return {
    async MAC({ version }) { return parseMacLog(read('mac.log'), version); },
    async TESTFLIGHT({ version }) { return parseBuildState(read('testflight.txt'), version); },
    async PUBLIC_CI({ version }) {
      const fx = JSON.parse(read('runs.json'));
      if (!fx.runs) return { state: PENDING, detail: `no synced commit names ${version}` };
      return summariseRuns(fx.runs, fx.sha ?? 'fixturesha00');
    },
    async DC_ROTATION({ version }) {
      return rotationReading(JSON.parse(read('dc-latest.json')), JSON.parse(read('dc-artifacts.json')), version);
    },
  };
}

// ── one pass ─────────────────────────────────────────────────────────────────

export async function pollOnce({ round, version, publicSha, probes, rows, now = () => new Date(), only = null }) {
  const nowIso = now().toISOString();
  const queues = only ?? QUEUES;
  const readings = await Promise.all(queues.map((q) => runProbe(q, probes[q], { version, publicSha, round })));
  const changes = [];
  for (const reading of readings) {
    const prev = rows.get(reading.queue);
    const { row, changed, kept } = mergeReading(prev, reading, nowIso);
    if (reading.extra) row.extra = reading.extra;
    else if (prev?.extra) row.extra = prev.extra;
    if (prev?.adopted) row.adopted = prev.adopted;
    rows.set(reading.queue, row);
    if (changed) changes.push(row);
    else if (kept) changes.push({ ...row, kept: true });
  }
  return { rows, changes, readings };
}

export function allTerminal(rows) {
  return QUEUES.every((q) => TERMINAL.includes(rows.get(q)?.state));
}

/**
 * The final line, one fixed shape, so it can be grepped out of a log the way
 * ship.mjs's SHIP line can.
 *
 * 🔴 CORRECTED after the first real run (2026-09-18): the verdict used to be
 * `timedOut ? TIMEOUT : (any FAILED ? FAILED : SETTLED)`, which printed
 *
 *     SHIP-WATCH 0.3.89 0.3.89 SETTLED after=3s MAC=PENDING,TESTFLIGHT=PENDING,…
 *
 * for a `--once` pass on which NOTHING had settled. SETTLED had come to mean
 * "the loop stopped", and the loop also stops because it was only ever asked for
 * one pass. Four PENDING rows sat right beside the word and did not contradict
 * it, because nothing compared them to it. That is this repo's first shape — one
 * value answering two questions — landing on the single line somebody greps when
 * they do not have time to read the file. SETTLED now requires what it says.
 */
export function summaryLine({ round, version, rows, elapsedMs, timedOut }) {
  const list = QUEUES.map((q) => `${q}=${rows.get(q)?.state ?? PENDING}`).join(',');
  const verdict = timedOut ? 'TIMEOUT'
    : QUEUES.some((q) => rows.get(q)?.state === FAILED) ? 'FAILED'
      : allTerminal(rows) ? 'SETTLED'
        : 'PENDING';
  return `SHIP-WATCH ${round} ${version} ${verdict} after=${Math.round(elapsedMs / 1000)}s ${list}`;
}

// ── adoption (off by default; an action, not an observation) ─────────────────
//
// §3.2: "mac zip 到 ⇒ 自动 adopt + 补发". It sits behind --adopt because this
// tool's job is to KNOW, and adopting writes into ./publish and uploads to the
// download centre. A watcher that quietly publishes is a watcher nobody can
// leave running.
//
// 🔴 It does not guess where the zip is. adopt-artifact.mjs exists because bytes
// from another machine need a hash carried out of band; guessing their PATH on
// that machine would be the same mistake one level up. Exactly one match, or a
// named refusal.
export function adoptPlan({ extra, publishDir }) {
  if (!extra?.zipName || !extra?.sha256) {
    return { ok: false, why: 'the mac log carried no `<sha256>  <zip>` line — nothing to adopt with, and a locally recomputed hash attests nothing (adopt-artifact.mjs header)' };
  }
  return {
    ok: true,
    find: `find ~ -maxdepth 8 -name ${extra.zipName} -type f`,
    local: join(publishDir, extra.zipName),
    adopt: ['scripts/adopt-artifact.mjs', join(publishDir, extra.zipName), '--sha256', extra.sha256, '--platform', 'macos-arm64'],
    republish: ['scripts/publish-download-center.mjs'],
  };
}

async function runAdopt(row, { root, log }) {
  const plan = adoptPlan({ extra: row.extra, publishDir: join(root, 'publish') });
  if (!plan.ok) { log(`  adopt: refused — ${plan.why}`); return false; }
  const found = ssh(plan.find).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (found.length !== 1) {
    log(`  adopt: refused — ${found.length} file(s) named ${row.extra.zipName} on ${MAC_HOST}; exactly one is the only unambiguous answer`);
    return false;
  }
  const scp = spawnSync('scp', [`${MAC_HOST}:${found[0]}`, plan.local], { encoding: 'utf8', timeout: 20 * 60_000, windowsHide: true });
  if (scp.status !== 0) { log(`  adopt: scp failed (${scp.status}): ${(scp.stderr || '').trim().slice(0, 200)}`); return false; }
  for (const argv of [plan.adopt, plan.republish]) {
    const r = spawnSync(process.execPath, [join(root, ...argv[0].split('/')), ...argv.slice(1)], {
      cwd: root, encoding: 'utf8', timeout: 30 * 60_000, windowsHide: true,
    });
    log(`  adopt: ${argv[0]} exit=${r.status}`);
    if (r.stdout) log(r.stdout.trim().split('\n').slice(-6).join('\n'));
    if (r.status !== 0) return false;
  }
  return true;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const known = new Set(['--once', '--adopt', '--max-hours', '--version', '--public-sha', '--fixtures']);
  const positional = [];
  const opts = { once: false, adopt: false, maxHours: DEFAULT_MAX_HOURS, version: null, publicSha: null, fixtures: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    if (!known.has(a)) throw new Error(`unknown option ${a} — known: ${[...known].join(' ')}`);
    if (a === '--once') { opts.once = true; continue; }
    if (a === '--adopt') { opts.adopt = true; continue; }
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
    i += 1;
    if (a === '--max-hours') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--max-hours needs a positive number, got ${v}`);
      opts.maxHours = n;
    } else if (a === '--version') opts.version = v;
    else if (a === '--public-sha') opts.publicSha = v;
    else if (a === '--fixtures') opts.fixtures = v;
  }
  if (positional.length !== 1) {
    throw new Error('usage: node scripts/ship-watch.mjs <round> [--once] [--adopt] [--max-hours N] [--version x.y.z] [--public-sha sha]');
  }
  opts.round = positional[0];
  return opts;
}

const looksLikeVersion = (s) => /^\d+\.\d+\.\d+$/.test(String(s));

export async function main(argv = process.argv.slice(2), { root = REPO_ROOT, log = console.log, sleep = null } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`ship-watch: ${e.message}`); return 2; }

  const version = opts.version
    ?? (looksLikeVersion(opts.round) ? opts.round : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);

  if (opts.fixtures && opts.adopt) {
    console.error('ship-watch: --adopt refuses to run against --fixtures. Adoption uploads bytes; a fixture reading is not evidence about any bytes.');
    return 2;
  }
  const probes = opts.fixtures ? fixtureProbes(opts.fixtures) : REAL_PROBES;
  if (opts.fixtures) log(`FIXTURES ${opts.fixtures} — every line below is a fixture reading, not a real queue`);

  const startedAt = new Date().toISOString();
  const rows = readStatusFile(opts.round, root);
  const meta = { round: opts.round, version, startedAt, fixtures: opts.fixtures };
  // The file exists with four rows BEFORE the first probe: for its first minute,
  // a watcher that has written nothing is indistinguishable from a watcher that
  // never started.
  writeStatusFile(opts.round, rows, meta, root);

  log(`ship-watch ${opts.round} (version ${version}) -> ${statusPath(opts.round, root)}`);
  log(`cadence: ${QUEUES.map((q) => `${q} ${CADENCE_MS[q] / 1000}s`).join(', ')}${opts.once ? '  [--once: one pass]' : `  [up to ${opts.maxHours}h]`}`);

  const t0 = Date.now();
  const nextDue = Object.fromEntries(QUEUES.map((q) => [q, 0]));
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let timedOut = false;

  for (;;) {
    const due = opts.once
      ? [...QUEUES]
      : QUEUES.filter((q) => !TERMINAL.includes(rows.get(q)?.state) && Date.now() >= nextDue[q]);
    if (due.length > 0) {
      const { changes } = await pollOnce({ round: opts.round, version, publicSha: opts.publicSha, probes, rows, only: due });
      for (const q of due) nextDue[q] = Date.now() + CADENCE_MS[q];
      writeStatusFile(opts.round, rows, meta, root);
      for (const c of changes) if (!c.kept) log(`  ${formatLine(c)}`);

      const mac = rows.get('MAC');
      if (opts.adopt && mac?.state === DONE && !mac.adopted) {
        mac.adopted = true;
        const ok = await runAdopt(mac, { root, log });
        log(`  adopt: ${ok ? 'artifact adopted and the download centre re-published' : 'not adopted — see above'}`);
      }
    }
    if (opts.once) break;
    if (allTerminal(rows)) break;
    if (Date.now() - t0 >= opts.maxHours * 3_600_000) { timedOut = true; break; }
    const waiting = QUEUES.filter((q) => !TERMINAL.includes(rows.get(q)?.state));
    const sleepMs = Math.max(1_000, Math.min(...waiting.map((q) => nextDue[q] - Date.now())));
    await wait(sleepMs);
  }

  writeStatusFile(opts.round, rows, meta, root);
  for (const q of QUEUES) log(formatLine(rows.get(q)));
  const line = summaryLine({ round: opts.round, version, rows, elapsedMs: Date.now() - t0, timedOut });
  log(line);
  return timedOut ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
