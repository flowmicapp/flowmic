// A tiny LAN download page for the Android build (owner 2026-07-27).
//
// The phone cannot install from the PC's filesystem, and pushing with `adb
// install` replaces the app without letting the owner see the normal install
// flow. So: serve `publish/` over HTTP, open the URL on the phone, tap the APK.
//
// It binds 0.0.0.0 and PRINTS EVERY CANDIDATE ADDRESS with a note about which
// ones a phone can actually reach. That matters here: this machine has a
// `100.64.7.78` that looks like a LAN address but belongs to the WSL virtual
// switch — an internal-only network that happens to reuse the same subnet
// number as the office WiFi. Printing a URL the phone can never load is exactly
// the kind of confident-but-wrong answer this project treats as a defect, so
// each address is labelled rather than guessed at.
//
// Usage:  node scripts/serve-apk.mjs [port]
//
// ── RV-77 retirement-evaluation conclusion: KEEP (window B4 review, 2026-08-01) ─
// This repo has had an intranet download center since 0.2.31 (`scripts/publish-download-center.mjs`,
// http://100.64.7.68/p/flowmic, phone scans a QR to install the APK; publish.mjs
// chains it by default at the end).
// But that path requires the publisher to be **on 100.64.7.0/24 right now** (403
// cannot be bypassed; see that script's health preflight); the downloader must
// be able to reach the fixed host 100.64.7.68. This script serves the scene
// that path cannot reach: when the dev machine is not on that network right now
// (off-site / switched to a different LAN / VPN not connected), the already-
// verified artifacts in `./publish/` (publish.mjs already checked the version
// with aapt and wrote the sha256 sidecar) still need to get onto a phone —
// serve-apk only requires the phone and this machine to be **on any one network
// together right now**, and the addresses it prints were never a fixed site.
// ⇒ the two are not two implementations of the same thing; they are each
// scene's own answer — "a stable distribution station is available" vs. "that
// station cannot be reached". Deleting the latter would leave the offline /
// off-site path with no substitute at all.
// Keeping it means finishing the two named fixes on the ledger (must not leave
// the old "long-running service with no lifecycle owner" and "guess the version
// from the filename" holes in place):
//   ① on port conflict, no longer an uncaught exception stack — `server.on('error', …)`
//      finds the occupant's start time and command line, and says clearly
//      "is this one of ours"; see findPortOwner();
//   ② the page reads each APK's own declared versionName via `aapt dump badging`
//      (instead of guessing from the filename); logic carried over from
//      scripts/publish.mjs's findAapt/verifyApkVersion (prefer carrying over
//      rewriting); see apkSelfReportedVersion().

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'publish');
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const PORT = Number(process.argv[2] ?? 8088);

// The version is read PER REQUEST, never hardcoded and never cached — the
// 0.1.0-that-shipped-four-versions trap (CLAUDE.md version-number discipline) has a second
// mouth: a long-running server that read the number ONCE at startup.
//
// owner 2026-07-30 found exactly that: this page was serving
// FlowMic-0.2.15-release.apk under the heading 「FlowMic 0.2.10」, because the
// process had been up since five versions earlier. A number that names the
// wrong version is worse than no number — it is the same lie the discipline
// exists to prevent, just told by an old process instead of a hardcoded string.
function sourceVersion() {
  return JSON.parse(readFileSync(PKG, 'utf8')).version;
}

/** Versions that appear in the artefact FILENAMES actually being served. */
function servedVersions(files) {
  const seen = new Set();
  for (const f of files) {
    const m = /(\d+\.\d+\.\d+)/.exec(f.name);
    if (m) seen.add(m[1]);
  }
  return [...seen];
}

// ── RV-77 fix ②: aapt ground truth, not a filename guess ──────────────────
// Same lookup as scripts/publish.mjs findAapt() — a dev-machine tool (Android
// SDK build-tools), not a package dependency, so a clean box may legitimately
// not have one. Copied rather than imported: this script has zero dependency
// on publish.mjs today and the function is ~15 lines, small enough that a
// shared-module refactor would cost more reading than it saves (Token discipline:
// prefer carrying over rewriting — "carrying" here means copy-the-logic, not necessarily share-the-file).
function findAapt() {
  const sdkRoots = [];
  for (const envVar of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[envVar]) sdkRoots.push(process.env[envVar]);
  }
  if (process.env.LOCALAPPDATA) sdkRoots.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  for (const sdkRoot of sdkRoots) {
    const buildTools = join(sdkRoot, 'build-tools');
    if (!existsSync(buildTools)) continue;
    let versions;
    try {
      versions = readdirSync(buildTools);
    } catch {
      continue;
    }
    versions.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    }).reverse();
    for (const v of versions) {
      for (const bin of ['aapt.exe', 'aapt2.exe']) {
        const p = join(buildTools, v, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const AAPT = findAapt(); // resolved once at startup — every page load reuses this
const apkVersionCache = new Map(); // path -> { mtimeMs, size, version|null, note }

// What THIS specific file self-reports via `aapt dump badging`, cached by
// mtime+size so a page reload doesn't re-shell out per request. Never throws:
// a failure here must degrade to an honest note on the page, not crash the
// dev server that a phone is mid-download from.
function apkSelfReportedVersion(path) {
  const st = statSync(path);
  const cached = apkVersionCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let result;
  if (!AAPT) {
    result = { mtimeMs: st.mtimeMs, size: st.size, version: null, note: 'aapt/aapt2 not found, cannot verify' };
  } else {
    try {
      const badging = execFileSync(AAPT, ['dump', 'badging', path], { encoding: 'utf8' });
      const m = badging.match(/versionName='([^']*)'/);
      result = m
        ? { mtimeMs: st.mtimeMs, size: st.size, version: m[1], note: null }
        : { mtimeMs: st.mtimeMs, size: st.size, version: null, note: 'aapt output has no versionName=' };
    } catch (e) {
      result = { mtimeMs: st.mtimeMs, size: st.size, version: null, note: `aapt read failed: ${e.message}` };
    }
  }
  apkVersionCache.set(path, result);
  return result;
}

// ── RV-77 fix ①: name the occupant instead of an uncaught-exception stack ──
// Windows-only (netstat + CIM) — matches this project's current dev
// environment (CLAUDE.md environment facts: Windows 11). Best-effort: any failure here
// (netstat missing, CIM query denied, unparsable output) must fall back to
// "couldn't identify it", never crash the diagnostic path itself.
function findPortOwner(port) {
  let pid;
  try {
    const netstatOut = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    const line = netstatOut
      .split('\n')
      .find((l) => new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`).test(l));
    if (!line) return null;
    const fields = line.trim().split(/\s+/);
    pid = fields[fields.length - 1];
    if (!/^\d+$/.test(pid)) return null;
  } catch {
    return null;
  }
  try {
    const psOut = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object CommandLine,CreationDate | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8' }).trim();
    if (!psOut) return { pid, startedAt: null, commandLine: null };
    const info = JSON.parse(psOut);
    // `powershell.exe` (Windows PowerShell 5.1, distinct from pwsh/PS7) renders
    // a [datetime] via ConvertTo-Json as the legacy `/Date(ms)/` wire format
    // rather than ISO-8601 — turn it back into something a human reads at a
    // glance instead of printing the wire format verbatim.
    const raw = info.CreationDate ?? null;
    const wireDate = typeof raw === 'string' ? raw.match(/^\/Date\((\d+)\)\/$/) : null;
    const startedAt = wireDate ? new Date(Number(wireDate[1])).toISOString() : raw;
    return { pid, startedAt, commandLine: info.CommandLine ?? null };
  } catch {
    return { pid, startedAt: null, commandLine: null };
  }
}

if (!existsSync(ROOT)) {
  console.error(`✗ no ${ROOT} — run \`node scripts/publish.mjs\` first`);
  process.exit(1);
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);

function listFiles() {
  return readdirSync(ROOT)
    .filter((f) => /\.(apk|msi)$/i.test(f))
    .map((f) => ({ name: f, size: statSync(join(ROOT, f)).size }))
    .sort((a, b) => (a.name.endsWith('.apk') ? -1 : 1) - (b.name.endsWith('.apk') ? -1 : 1));
}

function page() {
  const files = listFiles();
  const version = sourceVersion();
  const served = servedVersions(files);
  // The heading names what is IN publish/, because that is what a tap actually
  // downloads. When the source tree has moved on (a bump without a rebuild) or
  // the folder holds a mix, the page SAYS SO instead of picking one number and
  // sounding certain.
  const heading = served.length === 1 ? served[0] : served.join(' / ') || version;
  const drift =
    served.length === 0
      ? ''
      : served.length > 1
        ? `<div class="w">⚠ publish/ holds artifacts of more than one version: ${served.join(', ')}. Confirm which one to install.</div>`
        : served[0] !== version
          ? `<div class="w">⚠ these artifacts are ${served[0]}, but the source tree is already ${version} — the version was bumped but the package has not been rebuilt.</div>`
          : '';
  const rows = files
    .map((f) => {
      // Ground truth for .apk entries: what the archive itself declares, via
      // aapt — not the filename `served` above is parsed from. A rename or a
      // copy-paste mistake would still fool `served`; it cannot fool this.
      let selfReport = '';
      if (/\.apk$/i.test(f.name)) {
        const r = apkSelfReportedVersion(join(ROOT, f.name));
        selfReport = r.version
          ? `<span class="v">self-reports ${r.version}${r.version !== version ? ' ⚠' : ''}</span>`
          : `<span class="v">self-report failed: ${r.note}</span>`;
      }
      return `<li><a href="/${encodeURIComponent(f.name)}">${f.name}</a>
        ${selfReport}
        <span class="s">${mb(f.size)} MB</span></li>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowMic download</title>
<style>
 body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:28px 20px;
      background:#0f1017;color:#e8e9f0}
 h1{font-size:19px;margin:0 0 4px} p{color:#9aa0b4;font-size:13.5px;margin:0 0 20px}
 ul{list-style:none;padding:0;margin:0}
 li{background:#1a1c26;border:1px solid #272a38;border-radius:12px;
    padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
 a{color:#8b8cf0;text-decoration:none;font-weight:600;word-break:break-all;flex:1}
 .v{color:#6b7186;font-size:11.5px;white-space:nowrap;font-family:ui-monospace,monospace}
 .s{color:#6b7186;font-size:12px;white-space:nowrap}
 .n{margin-top:22px;color:#6b7186;font-size:12.5px;line-height:1.7}
 .w{background:rgba(248,113,113,.16);border:1px solid rgba(248,113,113,.55);
    border-radius:10px;padding:11px 13px;margin:0 0 16px;color:#fff1f2;font-size:13px}
</style>
<h1>FlowMic ${heading}</h1>
<p>Tap a filename to download. Android will prompt 「未知来源」 at install; allow once.</p>
${drift}
<ul>${rows}</ul>
<div class="n">APK signature differs from an already-installed debug build; if it conflicts, uninstall the old one first then install.<br>
A previously installed official build can be overwritten directly.</div>`;
}

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
    return;
  }
  const name = path.replace(/^\/+/, '');
  // Serve only the artifacts listed above — never an arbitrary path.
  const allowed = listFiles().some((f) => f.name === name);
  if (!allowed) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const file = join(ROOT, name);
  const type = extname(name).toLowerCase() === '.apk'
    ? 'application/vnd.android.package-archive'
    : 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': statSync(file).size,
    'content-disposition': `attachment; filename="${name}"`,
  });
  createReadStream(file).pipe(res);
  // Log-side self-report: same aapt ground truth the page shows, so a scroll
  // back through this terminal's history answers "what did I actually just
  // hand out" without having to reload the page after the fact.
  const versionNote = /\.apk$/i.test(name)
    ? (() => {
        const r = apkSelfReportedVersion(file);
        return r.version ? ` (aapt versionName=${r.version})` : ` (aapt: ${r.note})`;
      })()
    : '';
  console.log(`→ ${name}${versionNote} to ${req.socket.remoteAddress}`);
});

// Registered BEFORE listen() — an unhandled 'error' on a server with no
// listener crashes the process with a bare Node stack trace, which is
// exactly the "现在是 node 未捕获异常栈,读不出「是自己人占的」" gap RV-77
// named. EADDRINUSE gets a real answer instead: who, since when, running what.
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`✗ port ${PORT} is already in use — refuse to fail silently`);
  const owner = findPortOwner(PORT);
  if (!owner) {
    console.error('  cannot identify the occupant (netstat/CIM query failed, or no permission).');
  } else {
    console.error(`  PID ${owner.pid}, started at ${owner.startedAt ?? 'unknown'}`);
    console.error(`  command line: ${owner.commandLine ?? 'unknown'}`);
    if (/serve-apk\.mjs/i.test(owner.commandLine ?? '')) {
      console.error('  → this is an old instance of THIS script (may have been sitting all day, serving an old version).');
      console.error(`     kill it first: powershell -Command "Stop-Process -Id ${owner.pid} -Force"`);
    } else {
      console.error('  → not this script — pick another port: node scripts/serve-apk.mjs <port>');
    }
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`serving ${ROOT} on port ${PORT}\n`);
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const note = /WSL|Default Switch|mihomo/i.test(iface)
        ? '  ← virtual adapter, a phone CANNOT reach this'
        : /^169\.254\./.test(a.address)
          ? '  ← link-local (no DHCP lease), unusable'
          : '';
      console.log(`  http://${a.address}:${PORT}/   [${iface}]${note}`);
    }
  }
  console.log(`\n  http://127.0.0.1:${PORT}/   ← use this on the phone after:`);
  console.log(`      adb reverse tcp:${PORT} tcp:${PORT}`);
  // Startup self-report for whatever is staged RIGHT NOW — the same ground
  // truth the page/log show per request, surfaced once up front so "which
  // version am I about to hand out" doesn't require a browser at all.
  for (const f of listFiles().filter((f) => /\.apk$/i.test(f.name))) {
    const r = apkSelfReportedVersion(join(ROOT, f.name));
    console.log(r.version ? `  · ${f.name} self-reports versionName=${r.version}` : `  · ${f.name} self-report failed: ${r.note}`);
  }
});
