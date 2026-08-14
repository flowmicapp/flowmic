#!/usr/bin/env node
// mac-sign-notarize.mjs — sign, notarize, staple and verify the macOS .app.
//
// Runs ON the Mac (darwin only). Typical invocation:
//   node scripts/mac-sign-notarize.mjs --app <path/to/FlowMic.app>
//
// Credentials:
//   - Notary: APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD read from an env
//     file (default: <repo>/.local/apple-notary.env, then ~/.local/apple-notary.env).
//     Values are passed to notarytool via argv, never logged. Single-user
//     machine: brief `ps` exposure is accepted and documented here.
//   - Keychain: codesign needs the private key in the login keychain. In an
//     SSH session that keychain is locked. If ~/.local/mac-login.env exists
//     with FLOWMIC_MAC_LOGIN_PASSWORD, the script unlocks it itself;
//     otherwise it fails EARLY (before touching the .app) with the exact
//     unlock commands, because a half-signed bundle is worse than none.
//
// The bundled node sidecar (Contents/Resources/resources/node) ships with a
// valid OpenJS Foundation Developer ID signature, hardened runtime and the
// JIT entitlements it needs. Notarization accepts nested code signed by a
// different team, so we deliberately DO NOT re-sign it: replacing a valid
// signature can only remove information. The preflight below still verifies
// every nested Mach-O carries the runtime flag, so a future sidecar that
// arrives unsigned fails loudly here instead of inside Apple's notary log.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir, platform } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  // Redaction is BY VALUE, not by index. The first version redacted argv
  // indices and was off by one: it hid the literal string '--password' and
  // printed the password itself — measured on this pipeline's first real run
  // (2026-08-07; the app-specific password reached the log and was rotated).
  // An index is a claim about an array layout that nothing pins; the secret's
  // own value is the thing that must never appear, so match on that.
  const secrets = (opts.redactValues ?? []).filter(Boolean);
  const shown = args.map((a) => (secrets.includes(a) ? '<redacted>' : a)).join(' ');
  if (!opts.quiet) console.log(`  $ ${cmd} ${shown}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r;
}

function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    console.error(r.stdout || '');
    console.error(r.stderr || '');
    fail(`${cmd} exited ${r.status}${opts.why ? ` — ${opts.why}` : ''}`);
  }
  return r;
}

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv.splice(i, 1), true) : false;
}
function opt(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined) fail(`${name} needs a value`);
  argv.splice(i, 2);
  return v;
}

const SKIP_NOTARIZE = flag('--skip-notarize');
const IDENTITY_ARG = opt('--identity');
const NOTARY_ENV_ARG = opt('--notary-env');
const UNLOCK_ENV_ARG = opt('--unlock-env');
const APP = opt('--app');
if (!APP || argv.length) fail('usage: mac-sign-notarize.mjs --app <FlowMic.app> [--identity <sha1>] [--notary-env <file>] [--unlock-env <file>] [--skip-notarize]');
if (platform() !== 'darwin') fail('this script only runs on macOS');
if (!existsSync(join(APP, 'Contents', 'Info.plist'))) fail(`${APP} is not an .app bundle (no Contents/Info.plist)`);

// ---- 1. resolve signing identity ------------------------------------------
console.log('\n[1/7] signing identity');
let identity = IDENTITY_ARG;
{
  const r = must('security', ['find-identity', '-v', '-p', 'codesigning'], { quiet: true });
  const devIds = [...r.stdout.matchAll(/\b([0-9A-F]{40})\b\s+"(Developer ID Application[^"]*)"/g)];
  if (!identity) {
    if (devIds.length !== 1) fail(`found ${devIds.length} "Developer ID Application" identities; pass --identity <sha1>`);
    identity = devIds[0][1];
    console.log(`  using: ${devIds[0][2]} (${identity.slice(0, 8)}…)`);
  } else if (!r.stdout.includes(identity)) {
    fail(`identity ${identity} not present in the keychain`);
  }
}

// ---- 2. keychain must be usable, proven BEFORE touching the .app -----------
console.log('\n[2/7] keychain private-key access');
const LOGIN_KC = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
const unlockEnvPath = UNLOCK_ENV_ARG ?? join(homedir(), '.local', 'mac-login.env');
if (existsSync(unlockEnvPath)) {
  const pw = parseEnvFile(unlockEnvPath).FLOWMIC_MAC_LOGIN_PASSWORD;
  if (!pw) fail(`${unlockEnvPath} exists but has no FLOWMIC_MAC_LOGIN_PASSWORD`);
  must('security', ['unlock-keychain', '-p', pw, LOGIN_KC], { redactValues: [pw], why: 'wrong login password?' });
  // Allow codesign to use the key without a GUI prompt. Idempotent.
  must('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', pw, LOGIN_KC], { redactValues: [pw], quiet: true });
  console.log('  keychain unlocked via ' + unlockEnvPath);
}
{
  const probe = join(tmpdir(), `cs-probe-${process.pid}`);
  copyFileSync('/bin/ls', probe);
  const r = run('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, probe], { quiet: true });
  rmSync(probe, { force: true });
  if (r.status !== 0) {
    fail(`codesign cannot use the private key (${(r.stderr || '').trim()}).\n` +
      `The login keychain is locked in this session. Either:\n` +
      `  a) put FLOWMIC_MAC_LOGIN_PASSWORD=<login password> into ~/.local/mac-login.env (chmod 600), or\n` +
      `  b) run on the Mac:  security unlock-keychain ${LOGIN_KC}\n` +
      `                      security set-key-partition-list -S apple-tool:,apple:,codesign: -s ${LOGIN_KC}`);
  }
  console.log('  private key usable (probe signed OK)');
}

// ---- 3. preflight: every nested Mach-O must carry hardened runtime ---------
console.log('\n[3/7] nested Mach-O preflight');
const mainBinary = join(APP, 'Contents', 'MacOS');
{
  const list = must('find', [APP, '-type', 'f'], { quiet: true }).stdout.trim().split('\n');
  for (const f of list) {
    const t = run('file', ['-b', f], { quiet: true }).stdout;
    if (!/Mach-O/.test(t)) continue;
    if (f.startsWith(mainBinary)) { console.log(`  main:   ${basename(f)} (signed below)`); continue; }
    const d = run('codesign', ['-dv', f], { quiet: true });
    const flags = (d.stderr.match(/flags=\S+/) ?? [''])[0];
    if (d.status !== 0 || !/\(.*runtime.*\)/.test(flags)) {
      fail(`nested binary lacks a hardened-runtime signature: ${f} (${flags || 'unsigned'})\n` +
        `Sign it at build time or extend this script deliberately — do not let notarization discover it.`);
    }
    console.log(`  nested: ${f.slice(APP.length + 1)} ${flags} — left as-is`);
  }
}

// ---- 4. sign the bundle ----------------------------------------------------
console.log('\n[4/7] codesign the .app');
must('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, APP],
  { why: 'signing the bundle failed' });
must('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP], { why: 'signature does not verify' });
console.log('  signed + verified (strict, deep)');

// ---- 5. notarize -----------------------------------------------------------
const version = must('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(APP, 'Contents', 'Info.plist')], { quiet: true }).stdout.trim();
const arch = process.arch === 'arm64' ? 'arm64' : process.arch;
const outZip = join(dirname(APP), `FlowMic-${version}-macos-${arch}.zip`);
if (SKIP_NOTARIZE) {
  console.log('\n[5/7] notarization SKIPPED by flag — the artefact will NOT pass Gatekeeper on other machines');
} else {
  console.log('\n[5/7] notarize');
  const envPath = NOTARY_ENV_ARG
    ?? [join(REPO, '.local', 'apple-notary.env'), join(homedir(), '.local', 'apple-notary.env')].find(existsSync);
  if (!envPath) fail('no apple-notary.env found (looked in repo .local/ and ~/.local/)');
  const env = parseEnvFile(envPath);
  for (const k of ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD']) if (!env[k]) fail(`${envPath} is missing ${k}`);

  const submitZip = join(tmpdir(), `flowmic-notarize-${process.pid}.zip`);
  must('ditto', ['-c', '-k', '--keepParent', APP, submitZip]);
  const creds = ['--apple-id', env.APPLE_ID, '--team-id', env.APPLE_TEAM_ID, '--password', env.APPLE_APP_PASSWORD];
  const sub = must('xcrun', ['notarytool', 'submit', submitZip, '--wait', ...creds],
    { redactValues: [env.APPLE_APP_PASSWORD], why: 'submission failed before a verdict' });
  rmSync(submitZip, { force: true });
  console.log(sub.stdout.split('\n').filter(l => /id:|status:/.test(l)).map(l => '  ' + l.trim()).join('\n'));
  const status = (sub.stdout.match(/status: (\w+)/g) ?? []).at(-1);
  if (status !== 'status: Accepted') {
    const id = sub.stdout.match(/id: ([0-9a-f-]{36})/)?.[1];
    if (id) {
      const log = run('xcrun', ['notarytool', 'log', id, ...creds], { redactValues: [env.APPLE_APP_PASSWORD], quiet: true });
      console.error(log.stdout);
    }
    fail(`notarization verdict was "${status}" — the log above names each offending file`);
  }

  console.log('\n[6/7] staple + assess');
  must('xcrun', ['stapler', 'staple', APP], { why: 'stapling failed after Accepted — retry once, CDN lag is common' });
  must('xcrun', ['stapler', 'validate', APP]);
  const sp = must('spctl', ['--assess', '--type', 'execute', '-vv', APP], { why: 'Gatekeeper rejected the stapled app' });
  if (!/Notarized Developer ID/.test(sp.stderr + sp.stdout)) fail('spctl accepted but source is not "Notarized Developer ID"');
  console.log('  Gatekeeper: accepted, source=Notarized Developer ID');
}

// ---- 7. distributable ------------------------------------------------------
console.log('\n[7/7] distributable zip');
rmSync(outZip, { force: true });
must('ditto', ['-c', '-k', '--keepParent', APP, outZip]);
const sha = createHash('sha256').update(readFileSync(outZip)).digest('hex');
console.log(`\nARTEFACT ${outZip}`);
console.log(`  size   ${(statSync(outZip).size / 1048576).toFixed(1)} MB`);
console.log(`  sha256 ${sha}`);
console.log(SKIP_NOTARIZE
  ? 'DONE (signed only — NOT notarized, do not distribute)'
  : 'DONE (signed + notarized + stapled)');
