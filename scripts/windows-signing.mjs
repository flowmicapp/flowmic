// Card IT-19 — Authenticode signing for the Windows artifacts: the ONE place
// that knows which certificate we sign with, where signtool lives, how to ask
// "is the private key reachable right now", and how to read signtool's verdict.
//
// Two callers share it, deliberately:
//   · scripts/sign-windows.mjs            — the command Tauri's build hooks run
//                                           (apps/desktop/src-tauri/tauri.windows.conf.json);
//   · scripts/windows-signature-gate.mjs  — the publish-side gate that refuses
//                                           an unsigned / untimestamped artifact.
// One answer to "what does a valid signature look like", asked twice, rather
// than a signer and a checker that each carry their own idea of it.
//
// ── facts this file rests on [measured 2026-10-26, dev-pc-a] ─────────
//
//   · The certificate is a Certum individual code-signing certificate in
//     CurrentUser\My, issuer "Certum Code Signing 2021 CA", chaining to
//     "Certum Trusted Network CA" (in the Windows root store). Its private key
//     is non-exportable and lives in "SimplySign KSP", which only answers while
//     SimplySign Desktop (SimplySignDesktop.exe) is running and logged in.
//   · `signtool verify /pa` EXITS 0 FOR AN UNTIMESTAMPED SIGNATURE. Measured on
//     a scratch DLL signed without /tr: "File is not timestamped." followed by
//     "Successfully verified", exit 0. So the exit code answers "is the
//     signature valid today" and NOT "will it still be valid after the
//     certificate expires" — the timestamp has to be read from the text.
//     (node.exe from the official Node build shows why that matters: its
//     OpenJS Foundation leaf expired on 2026-05-16, and it verifies only
//     because it carries a Microsoft RFC 3161 timestamp from before that.)
//   · The leaf's subject is a CJK personal name and reaches us as an empty
//     "Issued to:" line through signtool's console code page, so the signer is
//     identified by its SHA1 thumbprint, never by name.
//   · One timestamped signature against http://time.certum.pl took ~5 s.
//   · [measured 2026-10-27, dev-pc-a] The store entry OUTLIVES the login
//     session. With SimplySign Desktop running (its window open, autostarted
//     the day before) but its session expired, the certificate was still in
//     CurrentUser\My with HasPrivateKey = True and a key-provider entry naming
//     "SimplySign CSP" (CAPI, PROV_RSA_FULL) — so a metadata-only preflight said
//     "signer ready" while every signtool sign failed with "No certificates were
//     found that met all the given criteria", ~4 minutes into the build.
//     Opening the key itself is what tells the two apart: CryptAcquireContext
//     on that container and NCryptOpenKey through CNG, both with the silent
//     flag, each blocked ~60 s and then returned 0x80090001 (NTE_BAD_UID);
//     CryptAcquireCertificatePrivateKey (what privateKeyState() calls) did not
//     answer within 180 s. No extra window appeared while they waited. The
//     same probe opened a local software key (an expired localhost cert) in
//     7 ms, ~0.35 s wall including PowerShell start-up and Add-Type.
//
// No secret lives here: a thumbprint is printed by every `signtool verify /v`
// of every file we sign.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { refuseDirectRun } from './module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'node scripts/sign-windows.mjs <file>... | --resources <dir> | --check');

/** The signing identity and timestamp authorities. Change it here and nowhere
 *  else; the env overrides exist for the negative-path proof (point the
 *  thumbprint at one that is not installed) and for a future certificate
 *  renewal tried before it is committed. */
export const WINDOWS_SIGNING = Object.freeze({
  thumbprint: 'F90EBF76A64D423F6CBFEC4AC020D7FC78224879',
  issuer: 'Certum Code Signing 2021 CA',
  keyHostProcess: 'SimplySignDesktop.exe',
  keyHostName: 'SimplySign Desktop',
  // Certum's own RFC 3161 authority first; the others are public RFC 3161
  // authorities used only when Certum's does not answer. A timestamp from any
  // of them is as good as Certum's for Authenticode — the TSA is independent of
  // the code-signing CA. What is never acceptable is no timestamp at all.
  timestampUrls: Object.freeze([
    'http://time.certum.pl',
    'http://timestamp.digicert.com',
    'http://timestamp.sectigo.com',
  ]),
  description: 'FlowMic',
  // How long the preflight waits for the private key to answer before it
  // refuses. A dead SimplySign session answers only after ~60 s (measured,
  // see the header), so waiting for that answer would cost a minute per
  // refused build. A live one is assumed to answer within a few seconds: on
  // 2026-10-26 a whole sign, timestamp included, took ~5 s. That assumption is
  // NOT measured for the acquire step alone. If a logged-in session ever
  // exceeds this, FLOWMIC_SIGN_KEY_PROBE_TIMEOUT_MS raises it.
  keyProbeTimeoutMs: 20000,
});

/** The explicit opt-out. Unset or `on` = sign (and fail if signing cannot
 *  happen); `off` = build unsigned, loudly. Any other value is refused: a typo
 *  must not be read as either answer. */
export const SIGN_OPT_OUT_ENV = 'FLOWMIC_WINDOWS_SIGN';

export function signingMode(env = process.env) {
  const raw = (env[SIGN_OPT_OUT_ENV] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'on') return 'sign';
  if (raw === 'off') return 'off';
  throw new Error(`${SIGN_OPT_OUT_ENV}=${env[SIGN_OPT_OUT_ENV]} is not understood — use "off" to build unsigned, or unset it to sign.`);
}

export function signingConfig(env = process.env) {
  const thumbprint = (env.FLOWMIC_SIGN_THUMBPRINT ?? WINDOWS_SIGNING.thumbprint).replace(/\s+/g, '').toUpperCase();
  const urls = env.FLOWMIC_SIGN_TIMESTAMP_URLS
    ? env.FLOWMIC_SIGN_TIMESTAMP_URLS.split(',').map((s) => s.trim()).filter(Boolean)
    : [...WINDOWS_SIGNING.timestampUrls];
  if (!/^[0-9A-F]{40}$/.test(thumbprint)) throw new Error(`signing thumbprint "${thumbprint}" is not a 40-hex SHA1 thumbprint`);
  if (urls.length === 0) throw new Error('no timestamp URL configured — refusing to sign without a timestamp');
  const rawTimeout = env.FLOWMIC_SIGN_KEY_PROBE_TIMEOUT_MS;
  const keyProbeTimeoutMs = rawTimeout === undefined || rawTimeout === '' ? WINDOWS_SIGNING.keyProbeTimeoutMs : Number(rawTimeout);
  if (!Number.isInteger(keyProbeTimeoutMs) || keyProbeTimeoutMs < 1000) {
    throw new Error(`FLOWMIC_SIGN_KEY_PROBE_TIMEOUT_MS=${rawTimeout} is not a whole number of milliseconds of at least 1000`);
  }
  return { ...WINDOWS_SIGNING, thumbprint, timestampUrls: urls, keyProbeTimeoutMs };
}

/** The banner every hook prints when the opt-out is on, so an unsigned build
 *  can never look like a signed one in a build log. */
export function unsignedBanner(what) {
  return (
    `[sign-windows] ⚠ ${SIGN_OPT_OUT_ENV}=off — NOT signing ${what}.\n` +
    '[sign-windows]   This build is UNSIGNED by request. publish.mjs refuses to stage unsigned Windows\n' +
    '[sign-windows]   artifacts, so it cannot become a release; it is for local testing only.'
  );
}

// ── signtool ────────────────────────────────────────────────────────────────

function versionKey(name) {
  const parts = name.split('.').map((p) => Number.parseInt(p, 10));
  return parts.every((n) => Number.isFinite(n)) ? parts : null;
}

/** Newest x64 signtool under the Windows 10/11 SDK, by numeric SDK version,
 *  then the unversioned bin\x64 layout, then PATH. FLOWMIC_SIGNTOOL wins. */
export function findSigntool(env = process.env) {
  if (env.FLOWMIC_SIGNTOOL) {
    return existsSync(env.FLOWMIC_SIGNTOOL)
      ? { path: env.FLOWMIC_SIGNTOOL, how: 'FLOWMIC_SIGNTOOL' }
      : null;
  }
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const bin = join(pf86, 'Windows Kits', '10', 'bin');
  if (existsSync(bin)) {
    const versions = readdirSync(bin)
      .map((name) => ({ name, key: versionKey(name) }))
      .filter((v) => v.key && existsSync(join(bin, v.name, 'x64', 'signtool.exe')))
      .sort((a, b) => {
        for (let i = 0; i < Math.max(a.key.length, b.key.length); i += 1) {
          const d = (a.key[i] ?? 0) - (b.key[i] ?? 0);
          if (d !== 0) return d;
        }
        return 0;
      });
    if (versions.length > 0) {
      const v = versions[versions.length - 1];
      return { path: join(bin, v.name, 'x64', 'signtool.exe'), how: `Windows Kits ${v.name}` };
    }
    if (existsSync(join(bin, 'x64', 'signtool.exe'))) return { path: join(bin, 'x64', 'signtool.exe'), how: 'Windows Kits bin\\x64' };
  }
  const where = spawnSync('where', ['signtool.exe'], { encoding: 'utf8', windowsHide: true });
  const first = where.status === 0 ? where.stdout.split(/\r?\n/).find((l) => l.trim()) : null;
  return first ? { path: first.trim(), how: 'PATH' } : null;
}

export const SIGNTOOL_MISSING =
  'signtool.exe not found. Install the Windows 10/11 SDK "Signing Tools for Desktop Apps"\n' +
  '  (it lands in C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<version>\\x64), or set FLOWMIC_SIGNTOOL\n' +
  '  to its absolute path.';

// ── PE files ────────────────────────────────────────────────────────────────

/** True when `buf` starts like a Portable Executable: "MZ", then "PE\0\0" at
 *  e_lfanew. Decided by bytes, not extension — MSI-extracted files are named by
 *  their WiX ids, and a `.node` addon is a DLL. */
export function isPeBuffer(buf) {
  if (!buf || buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return false;
  const lfanew = buf.readUInt32LE(0x3c);
  if (lfanew + 4 > buf.length) return false;
  return buf[lfanew] === 0x50 && buf[lfanew + 1] === 0x45 && buf[lfanew + 2] === 0 && buf[lfanew + 3] === 0;
}

export function isPeFile(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    return isPeBuffer(head.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/** Every PE file under `dir`, recursively, as absolute paths, sorted. */
export function listPeFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size >= 0x40 && isPeFile(p)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** A copy of a PE with its Authenticode certificate table removed (security
 *  data directory zeroed, trailing table cut off). Used to manufacture the
 *  negative control the gate needs on every run: a file we KNOW is unsigned. */
export function stripAuthenticode(buf) {
  if (!isPeBuffer(buf)) throw new Error('not a PE file');
  const lfanew = buf.readUInt32LE(0x3c);
  const opt = lfanew + 4 + 20;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const sec = dirs + 4 * 8;
  const offset = buf.readUInt32LE(sec);
  const out = Buffer.from(offset > 0 && offset <= buf.length ? buf.subarray(0, offset) : buf);
  out.writeUInt32LE(0, sec);
  out.writeUInt32LE(0, sec + 4);
  return out;
}

// ── reading signtool's verdict ──────────────────────────────────────────────

/** Parse `signtool verify /pa /v` output. Pure, so the drill can feed it the
 *  real outputs captured on this machine (see windows-signature-gate.test.mjs). */
export function parseVerifyOutput(text, exitCode) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const noSignature = lines.some((l) => /No signature found/i.test(l));
  const timestamped = lines.some((l) => /^The signature is timestamped:/i.test(l));
  const notTimestamped = lines.some((l) => /^File is not timestamped/i.test(l));
  const chainStart = lines.findIndex((l) => /^Signing Certificate Chain:/i.test(l));
  let chainSha1s = [];
  if (chainStart !== -1) {
    for (let i = chainStart + 1; i < lines.length; i += 1) {
      const l = lines[i];
      if (/^(The signature is timestamped|File is not timestamped|Timestamp Verified by|Successfully verified|SignTool Error|Number of)/i.test(l)) break;
      const m = l.match(/^SHA1 hash:\s*([0-9A-F]{40})$/i);
      if (m) chainSha1s.push(m[1].toUpperCase());
    }
  }
  const errors = lines.filter((l) => /^SignTool Error:/i.test(l));
  return {
    exitCode,
    verified: exitCode === 0 && lines.some((l) => /^Successfully verified/i.test(l)),
    noSignature,
    timestamped: timestamped && !notTimestamped,
    leafSha1: chainSha1s.length > 0 ? chainSha1s[chainSha1s.length - 1] : null,
    chainSha1s,
    error: errors.join(' | ') || null,
  };
}

/** One verdict per file. Order matters: "unsigned" and "untrusted" are about
 *  the signature existing and chaining; "untimestamped" is only reachable for
 *  a signature that verified; "wrong-signer" only for one that is otherwise
 *  perfect but is not ours where ours is required. */
export function classifySignature(parsed, { requireThumbprint = null } = {}) {
  if (parsed.noSignature) return 'unsigned';
  if (!parsed.verified) return 'untrusted';
  if (!parsed.timestamped) return 'untimestamped';
  if (requireThumbprint && parsed.leafSha1 !== requireThumbprint.toUpperCase()) return 'wrong-signer';
  return 'ok';
}

export function verifyWithSigntool(signtool, file) {
  const r = spawnSync(signtool, ['verify', '/pa', '/v', file], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`could not run signtool: ${r.error.message}`);
  return parseVerifyOutput(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, r.status);
}

// ── is the key reachable right now ──────────────────────────────────────────

function keyHostRunning(processName) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${processName}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.toLowerCase().includes(`"${processName.toLowerCase()}"`);
}

function certificateState(thumbprint) {
  // Read-only: the store is opened ReadOnly and never written.
  //
  // 🔴 Through .NET's X509Store, NOT the `Cert:` drive. [measured 2026-10-26,
  // dev-pc-a] The first version used `Get-Item Cert:\CurrentUser\My\<t>`
  // and answered ABSENT for a certificate that was present: Windows PowerShell
  // spawned from node inherits PSModulePath from the PowerShell 7 that started
  // node, loads the wrong Microsoft.PowerShell.Security, gets no `Cert:` drive,
  // and -ErrorAction SilentlyContinue turned "no drive" into "no certificate".
  // (Launched from pwsh directly it worked — pwsh rewrites PSModulePath for
  // powershell.exe, node does not.) Every build would then have been refused
  // with "log in to SimplySign" while SimplySign was logged in.
  // PSModulePath is also dropped from the child's env so 5.1 computes its own.
  const script =
    "$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser'); " +
    "$s.Open('ReadOnly'); " +
    `$m = $s.Certificates.Find('FindByThumbprint', '${thumbprint}', $false); ` +
    "if ($m.Count -eq 0) { 'ABSENT' } else { $c = $m[0]; 'PRESENT|' + $c.HasPrivateKey + '|' + $c.NotAfter.ToUniversalTime().ToString('o') + '|' + $c.Issuer }; " +
    '$s.Close()';
  const env = { ...process.env };
  delete env.PSModulePath;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env });
  if (r.status !== 0) return { state: 'unknown', detail: (r.stderr || r.stdout || '').trim() };
  const out = r.stdout.trim();
  if (out === 'ABSENT') return { state: 'absent' };
  const [, hasKey, notAfter, issuer] = out.split('|');
  return { state: 'present', hasPrivateKey: hasKey === 'True', notAfter, issuer };
}

// The key-acquire step signtool itself goes through before it can sign:
// CryptAcquireCertificatePrivateKey on the certificate, which follows the
// certificate's own key-provider entry (CAPI CSP or CNG KSP, whichever it
// names). Flags: CRYPT_ACQUIRE_SILENT_FLAG (0x40) — never raise UI from a build
// hook — and CRYPT_ACQUIRE_ALLOW_NCRYPT_KEY_FLAG (0x10000) so a future KSP-backed
// certificate is opened the same way. The handle is released straight away.
// NOTHING IS SIGNED: no hash is ever handed to the key, so the probe leaves no
// signature anywhere and nothing that could be replayed.
const KEY_PROBE_CSHARP =
  'using System; using System.Diagnostics; using System.Runtime.InteropServices; ' +
  'public static class FlowMicKeyProbe { ' +
  '[DllImport("crypt32.dll", SetLastError=true)] static extern bool CryptAcquireCertificatePrivateKey(IntPtr cert, uint flags, IntPtr reserved, out IntPtr key, out uint spec, out bool free); ' +
  '[DllImport("advapi32.dll")] static extern bool CryptReleaseContext(IntPtr h, uint f); ' +
  '[DllImport("ncrypt.dll")] static extern int NCryptFreeObject(IntPtr h); ' +
  'public static string Open(IntPtr cert) { ' +
  'var sw = Stopwatch.StartNew(); IntPtr h; uint spec; bool free; ' +
  'bool ok = CryptAcquireCertificatePrivateKey(cert, 0x40u | 0x10000u, IntPtr.Zero, out h, out spec, out free); ' +
  'int err = Marshal.GetLastWin32Error(); long ms = sw.ElapsedMilliseconds; ' +
  'if (!ok) return "FAIL|0x" + err.ToString("X8") + "|" + ms; ' +
  'if (free) { if (spec == 0xFFFFFFFFu) NCryptFreeObject(h); else CryptReleaseContext(h, 0); } ' +
  'return "OK|" + spec + "|" + ms; } }';

/** Can the certificate's private key be opened RIGHT NOW? The store entry
 *  (certificateState) survives an expired SimplySign session; this does not.
 *  Returns { state: 'ok' | 'refused' | 'timeout' | 'absent' | 'unknown', … }.
 *  The PowerShell child is our own and is the only process killed on timeout. */
function privateKeyState(thumbprint, timeoutMs) {
  const script =
    `Add-Type -TypeDefinition '${KEY_PROBE_CSHARP}'; ` +
    "$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser'); " +
    "$s.Open('ReadOnly'); " +
    `$m = $s.Certificates.Find('FindByThumbprint', '${thumbprint}', $false); ` +
    "if ($m.Count -eq 0) { 'ABSENT' } else { 'KEY|' + [FlowMicKeyProbe]::Open($m[0].Handle) }; " +
    '$s.Close()';
  const env = { ...process.env };
  delete env.PSModulePath; // same pitfall as certificateState()
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, env, timeout: timeoutMs,
  });
  if (r.error?.code === 'ETIMEDOUT') return { state: 'timeout', ms: timeoutMs };
  if (r.error) return { state: 'unknown', detail: r.error.message };
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || !/^(ABSENT|KEY\|)/m.test(out)) return { state: 'unknown', detail: (r.stderr || out || `exit ${r.status}`).trim() };
  if (/^ABSENT$/m.test(out)) return { state: 'absent' };
  const [, verdict, a, ms] = out.match(/^KEY\|(OK|FAIL)\|([^|]+)\|(\d+)/m) ?? [];
  if (verdict === 'OK') return { state: 'ok', keySpec: a, ms: Number(ms) };
  if (verdict === 'FAIL') return { state: 'refused', code: a, ms: Number(ms) };
  return { state: 'unknown', detail: out };
}

/** Everything that can be known WITHOUT making a signature. Returns
 *  { ok, problem, message }. `probe` is injectable so the drill can walk every
 *  branch without touching the machine's real state. */
export function preflightSigner(config, { platform = process.platform, env = process.env, probe = null } = {}) {
  const p = probe ?? {
    signtool: () => findSigntool(env),
    keyHost: () => keyHostRunning(config.keyHostProcess),
    cert: () => certificateState(config.thumbprint),
    key: () => privateKeyState(config.thumbprint, config.keyProbeTimeoutMs),
  };
  if (platform !== 'win32') {
    return { ok: false, problem: 'not-windows', message: 'Authenticode signing runs only on Windows; this host is ' + platform + '.' };
  }
  const st = p.signtool();
  if (!st) return { ok: false, problem: 'no-signtool', message: SIGNTOOL_MISSING };
  const host = p.keyHost();
  const login =
    `Open ${config.keyHostName} (C:\\Program Files\\Certum\\SimplySign Desktop), log in with the\n` +
    '  owner\'s SimplySign account, wait until it says the card is connected, then re-run the build.\n' +
    `  Building unsigned on purpose (local testing only)? set ${SIGN_OPT_OUT_ENV}=off — publish will refuse the result.`;
  if (host === false) {
    return { ok: false, problem: 'key-host-not-running', signtool: st,
      message: `${config.keyHostName} is not running (${config.keyHostProcess}), so the code-signing private key is unreachable.\n  ${login}` };
  }
  const cert = p.cert();
  if (cert.state === 'absent') {
    return { ok: false, problem: 'cert-missing', signtool: st,
      message: `the code-signing certificate ${config.thumbprint} is not in CurrentUser\\My.\n` +
        '  SimplySign Desktop is what registers it there; if it is logged in and this still fails, the thumbprint\n' +
        `  in scripts/windows-signing.mjs (or FLOWMIC_SIGN_THUMBPRINT) is not the installed certificate. ${login}` };
  }
  if (cert.state === 'present' && !cert.hasPrivateKey) {
    return { ok: false, problem: 'no-private-key', signtool: st,
      message: `certificate ${config.thumbprint} is present but has no reachable private key.\n  ${login}` };
  }
  if (cert.state === 'unknown') {
    return { ok: false, problem: 'cert-unknown', signtool: st,
      message: `could not read CurrentUser\\My for ${config.thumbprint}: ${cert.detail}` };
  }
  if (cert.notAfter && Date.parse(cert.notAfter) < Date.now()) {
    return { ok: false, problem: 'cert-expired', signtool: st,
      message: `certificate ${config.thumbprint} expired on ${cert.notAfter}; a renewed certificate must replace WINDOWS_SIGNING.thumbprint in scripts/windows-signing.mjs.` };
  }
  // The certificate entry above outlives the SimplySign login session (header,
  // measured 2026-10-27) — only opening the key says whether signtool will get it.
  const key = p.key();
  const stale = `the certificate is still listed in CurrentUser\\My, but that entry outlives the ${config.keyHostName} login session,\n` +
    '  and signtool would fail with "No certificates were found that met all the given criteria" after the compile.';
  if (key.state === 'refused') {
    return { ok: false, problem: 'key-unreachable', signtool: st,
      message: `the private key of certificate ${config.thumbprint} refused to open (${key.code} after ${(key.ms / 1000).toFixed(1)} s):\n  ${stale}\n  ${login}` };
  }
  if (key.state === 'timeout') {
    return { ok: false, problem: 'key-unreachable', signtool: st,
      message: `the private key of certificate ${config.thumbprint} did not answer within ${(key.ms / 1000).toFixed(0)} s:\n  ${stale}\n  ${login}\n` +
        '  (A logged-in session that is merely slow can be given longer with FLOWMIC_SIGN_KEY_PROBE_TIMEOUT_MS.)' };
  }
  if (key.state === 'absent') {
    return { ok: false, problem: 'cert-missing', signtool: st,
      message: `the code-signing certificate ${config.thumbprint} disappeared from CurrentUser\\My while its key was being probed. ${login}` };
  }
  if (key.state !== 'ok') {
    return { ok: false, problem: 'key-probe-unknown', signtool: st,
      message: `could not probe the private key of ${config.thumbprint}: ${key.detail}\n  ${login}` };
  }
  return { ok: true, problem: null, signtool: st, cert, key,
    message: `signer ready: ${config.thumbprint} via ${st.how}; private key opened in ${key.ms} ms (nothing signed)` };
}

// ── signing ─────────────────────────────────────────────────────────────────

/** What our identity may sign when Tauri hands us a single file (%1): the
 *  product exe and its installers, nothing else.
 *
 *  🔴 [measured 2026-10-26, tauri-cli 2.11.4, `tauri bundle -vv`] Tauri calls
 *  signCommand for FIVE files, not three: flowmic-desktop.exe, both MSIs, AND
 *  `target/release/wix/x64/wix/WixUtilExtension.dll` + `WixUIExtension.dll` —
 *  its private copies of WiX build-tool assemblies that light.exe loads at
 *  build time and that never ship (neither is in the MSI's File or Binary
 *  table). Signing them would put the owner's name on third-party build tools,
 *  so they are declined here (exit 0: Tauri only reads the exit status, and
 *  leaving them as they are is the correct outcome). The first measured run
 *  did sign both copies before this rule existed; they were deleted. */
export function isFlowMicSignTarget(file) {
  const name = String(file).split(/[\\/]/).pop();
  return /^flowmic-desktop\.exe$/i.test(name) || /^FlowMic\.exe$/i.test(name) || /^FlowMic_.+\.msi$/i.test(name);
}

/** Is a signtool sign failure about the timestamp authority (try the next
 *  one) or about the key/certificate (stop — no other URL will help)? */
export function classifySignFailure(text) {
  if (/timestamp/i.test(text)) return 'timestamp';
  if (/No certificates were found|SignerSign\(\) failed|0x8009|keyset|private key|smart card|NTE_/i.test(text)) return 'key';
  return 'other';
}

/** Sign one file with a timestamp, trying each timestamp URL in turn. Never
 *  signs without /tr. Returns { ok, url, attempts }. After a reported success
 *  the file is re-verified here: our signer, chained, timestamped — anything
 *  less is a failure even if signtool said "Successfully signed". */
export function signFile(signtool, file, config) {
  const attempts = [];
  for (const url of config.timestampUrls) {
    const args = ['sign', '/sha1', config.thumbprint, '/fd', 'sha256', '/tr', url, '/td', 'sha256', '/d', config.description, file];
    const r = spawnSync(signtool, args, { encoding: 'utf8', windowsHide: true });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
    if (r.error) return { ok: false, kind: 'other', attempts: [...attempts, { url, text: r.error.message }] };
    if (r.status === 0) {
      const v = verifyWithSigntool(signtool, file);
      const verdict = classifySignature(v, { requireThumbprint: config.thumbprint });
      if (verdict === 'ok') return { ok: true, url, attempts };
      attempts.push({ url, text: `signtool reported success but the result verifies as "${verdict}"` });
      if (verdict === 'untimestamped') continue;
      return { ok: false, kind: 'other', attempts };
    }
    const kind = classifySignFailure(text);
    attempts.push({ url, text });
    if (kind !== 'timestamp') return { ok: false, kind, attempts };
  }
  return { ok: false, kind: 'timestamp', attempts };
}
