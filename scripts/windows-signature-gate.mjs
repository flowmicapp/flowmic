// Card IT-19 — no unsigned, untimestamped or self-signed Windows artifact may
// enter ./publish.
//
// ── what is checked, and why each part ─────────────────────────────────────
//
// The Microsoft Store's MSI/EXE rule (learn.microsoft.com/windows/apps/publish/
// publish-your-app/msi/app-package-requirements) is that the installer AND
// every Portable Executable inside it is signed with a certificate chaining to
// a root in the Microsoft Trusted Root Program. So the unit of judgement is not
// "the MSI" but "every PE that ships":
//
//   · the MSI itself                          — must be OUR certificate;
//   · its File table (what gets installed)    — every PE;
//   · its Binary table (custom-action DLLs    — every PE; WiX embeds one
//     WiX embeds, never installed)              (WixUIWixca, signed by the
//                                               WiX Toolset) and it is still
//                                               a PE inside the installer;
//   · the portable tree before it is zipped   — every PE.
//
// Two MSI variants pass through here, named by the caller (`msiVariant`):
// 'direct' (the normal build, publish.mjs) and 'store' (on demand,
// scripts/build-windows-store-msi.mjs). Every signature rule above applies to
// both. The store variant's Binary table also carries Microsoft's WebView2
// Evergreen Standalone Installer (~215 MB,
// Binary:MicrosoftEdgeWebView2RuntimeInstaller.exe). It keeps Microsoft's own
// signature and is never re-signed (sign-windows.mjs isFlowMicSignTarget
// declines it, and Tauri does not hand it to signCommand — measured in the
// build log), but its chain root must be a Microsoft code-signing root, not
// just any trusted one: Tauri downloads it at build time without a hash or
// signature check. The same decompile is also judged per variant by
// scripts/msi-webview2-offline.mjs (store: offline + silent; direct: no
// embedded installer, under a size ceiling), reported on its own lines.
//
// The product's own exe (flowmic-desktop.exe in the MSI, FlowMic.exe in the
// portable tree) must be signed by OUR certificate; any other PE may carry any
// valid third-party signature (node.exe ships signed by the OpenJS Foundation
// and is pinned byte-for-byte by scripts/vendor/bundled-node.mjs, so it is
// deliberately not re-signed). Every signature, ours or not, must chain to a
// trusted root AND carry a timestamp — `signtool verify /pa` alone exits 0 for
// an untimestamped signature (scripts/windows-signing.mjs header, measured).
//
// PE-ness is decided by bytes (MZ … PE\0\0), not by extension: dark.exe names
// extracted files by their WiX ids, and a `.node` addon is a DLL.
//
// ── controls: a blind verifier must not look like a clean artifact ──────────
//
// Same stance as scripts/apk-self-update-marker.mjs: every run first proves
// the instrument can see. signtool.exe itself (Microsoft-signed, timestamped)
// must verify "ok" — the POSITIVE control; a copy of it with its certificate
// table cut off must verify "unsigned" — the NEGATIVE control. Either one
// wrong ⇒ verdict BLIND, which says nothing about the artifact and refuses.
// Then the artifact side: the MSI scan must find the product exe and at least
// one PE, or the extraction did not do what we think it did.
//
// No bypass flag and no env override, matching publish.mjs Gate 0. The only
// way to build unsigned is FLOWMIC_WINDOWS_SIGN=off (scripts/sign-windows.mjs),
// and this gate is what makes such a build unpublishable.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { refuseDirectRun } from './module-entrypoint-guard.mjs';
import {
  MICROSOFT_CODE_SIGNING_ROOTS,
  MSI_VARIANTS,
  WEBVIEW2_STANDALONE_BINARY,
  judgeMsiWebView2,
  microsoftRootProblem,
} from './msi-webview2-offline.mjs';
import { PORTABLE_DIR_NAME } from './pack-portable.mjs';
import {
  SIGNTOOL_MISSING,
  classifySignature,
  findSigntool,
  listPeFiles,
  signingConfig,
  stripAuthenticode,
  verifyWithSigntool,
} from './windows-signing.mjs';

refuseDirectRun(import.meta.url, 'node scripts/publish.mjs (or import verifyWindowsArtifactsSigned)');

/** The product exe's name in each artifact shape. */
export const MSI_MAIN_EXE = 'flowmic-desktop.exe';
export const PORTABLE_MAIN_EXE = 'FlowMic.exe';

export const WINDOWS_REBUILD_COMMAND =
  'pnpm --filter @flowmic/desktop tauri:build   (with SimplySign Desktop logged in, FLOWMIC_WINDOWS_SIGN unset)';

/** WiX 3's decompiler, which Tauri downloads beside light.exe on every
 *  machine that has built an MSI. It extracts BOTH the File table payload and
 *  the Binary table streams; `msiexec /a` only gives the former. */
export function findDark(env = process.env) {
  const candidates = [
    env.FLOWMIC_WIX_DARK,
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'tauri', 'WixTools314', 'dark.exe'),
    env.WIX && join(env.WIX, 'bin', 'dark.exe'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Decompile `msi` into `outDir`. Returns { wxs, pes }: the decompiled .wxs
 *  text (scripts/msi-webview2-offline.mjs reads its custom actions) and the PE
 *  payload as [{ path, display, name }]; display says which table it came from. */
export function decompileMsi(dark, msi, outDir) {
  mkdirSync(outDir, { recursive: true });
  const wxsPath = join(outDir, 'decompiled.wxs');
  const r = spawnSync(dark, ['-nologo', '-x', outDir, msi, wxsPath], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !existsSync(wxsPath)) {
    throw new Error(`dark.exe could not decompile ${msi} (exit ${r.status}): ${(r.stdout || r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' / ')}`);
  }
  const wxs = readFileSync(wxsPath, 'utf8');
  const names = new Map();
  for (const m of wxs.matchAll(/<File\s+Id="([^"]+)"\s+Name="([^"]+)"/g)) names.set(m[1], m[2]);
  const pes = listPeFiles(outDir).map((p) => {
    const rel = relative(outDir, p).replace(/\\/g, '/');
    const [table, id] = rel.split('/');
    const name = table === 'File' ? (names.get(id) ?? id) : id;
    return { path: p, name, display: `${table}:${name}` };
  });
  return { wxs, pes };
}

export function extractMsiPes(dark, msi, outDir) {
  return decompileMsi(dark, msi, outDir).pes;
}

/** POSITIVE + NEGATIVE control of the verifier itself. */
export function runVerifierControls(signtool, scratchDir, verify = verifyWithSigntool) {
  const positive = classifySignature(verify(signtool, signtool));
  const stripped = join(scratchDir, 'negative-control-unsigned.exe');
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(stripped, stripAuthenticode(readFileSync(signtool)));
  const negative = classifySignature(verify(signtool, stripped));
  rmSync(stripped, { force: true });
  const ok = positive === 'ok' && negative === 'unsigned';
  return {
    ok,
    positive,
    negative,
    line: `controls: positive=${positive} (signtool.exe, expect ok) · negative=${negative} (stripped copy, expect unsigned)`,
  };
}

const ACTIONS = {
  unsigned:
    'it has no Authenticode signature — it was built without signing (FLOWMIC_WINDOWS_SIGN=off, ' +
    '`tauri build --no-sign`, or a bare cargo build).',
  untimestamped:
    'it is signed but NOT timestamped, so it stops verifying the day the certificate expires. ' +
    'Rebuild it through tauri:build, whose signer always timestamps.',
  untrusted:
    'its signature does not verify against a trusted root (self-signed, tampered, or revoked).',
  'wrong-signer':
    'it is validly signed, but not with our certificate, and the product exe and the installer must be.',
  'not-microsoft':
    'it is the embedded WebView2 runtime installer and must be signed by Microsoft itself',
};

export function refusalLine(row, config) {
  const why = ACTIONS[row.verdict] ?? row.verdict;
  const extra = row.verdict === 'wrong-signer' ? ` (leaf ${row.leaf}, expected ${config.thumbprint})`
    : row.verdict === 'not-microsoft' ? ` — ${row.rootProblem}`
    : row.error ? ` [${row.error}]` : '';
  return `${row.label}: ${row.display} — ${why}${extra}`;
}

/** Judge a list of entries. Pure apart from the injected `verify`. */
export function judgeEntries(entries, { signtool, config, verify = verifyWithSigntool }) {
  return entries.map((e) => {
    const parsed = verify(signtool, e.path);
    let verdict = classifySignature(parsed, { requireThumbprint: e.requireOurs ? config.thumbprint : null });
    const rootProblem = verdict === 'ok' && e.requireMicrosoftRoot ? microsoftRootProblem(parsed) : null;
    if (rootProblem) verdict = 'not-microsoft';
    return {
      ...e,
      verdict,
      rootProblem,
      root: parsed.chainSha1s?.[0] ?? null,
      leaf: parsed.leafSha1,
      ours: parsed.leafSha1 === config.thumbprint,
      timestamped: parsed.timestamped,
      error: parsed.error,
    };
  });
}

/**
 * The gate. `msis`: installer paths. `trees`: [{ dir, label, mainExe }] —
 * every PE under `dir`, with `mainExe` (relative) required to be ours.
 * `files`: [{ path, label, requireOurs }]. Reports through fail()/ok() like
 * the other publish gates; returns true only when everything is signed.
 */
export function verifyWindowsArtifactsSigned({
  msis = [],
  // 'direct' (publish.mjs) or 'store' (scripts/build-windows-store-msi.mjs).
  // No default: required whenever `msis` is non-empty.
  msiVariant,
  trees = [],
  files = [],
  scratchRoot,
  fail,
  ok,
  env = process.env,
  platform = process.platform,
  verify = verifyWithSigntool,
  // Injectable for the drill (msi-webview2-offline.test.mjs drives the whole
  // MSI branch from real decompiled tables); production passes nothing.
  decompile = decompileMsi,
  sizeOf = (p) => statSync(p).size,
}) {
  console.log('\n── Windows signatures (IT-19) ──');
  if (platform !== 'win32') {
    fail('Windows artifacts can only be signature-checked on Windows (signtool). Refusing rather than guessing.');
    return false;
  }
  const st = findSigntool(env);
  if (!st) { fail(`cannot verify Windows signatures: ${SIGNTOOL_MISSING}`); return false; }
  // `{}`, not `env`: the signer's FLOWMIC_SIGN_THUMBPRINT override must not be
  // able to tell the GATE that some other certificate counts as ours.
  const config = signingConfig({});
  const scratch = join(scratchRoot, `run-${process.pid}-${Date.now()}`);
  try {
    const controls = runVerifierControls(st.path, scratch, verify);
    if (!controls.ok) {
      fail(`the signature check is BLIND — ${controls.line}. This says NOTHING about the artifacts; ` +
        `fix the verifier (${st.path}) before trusting any verdict.`);
      return false;
    }
    ok(controls.line);

    const groups = [];
    if (msis.length > 0) {
      if (!MSI_VARIANTS.includes(msiVariant)) {
        fail(`msiVariant must be ${MSI_VARIANTS.map((v) => `'${v}'`).join(' or ')} (got ${JSON.stringify(msiVariant)}) — ` +
          'the caller says which Windows MSI it is checking; the gate never guesses it from the file name.');
        return false;
      }
      const dark = findDark(env);
      if (!dark) {
        fail('cannot look inside the MSI: WiX dark.exe not found (%LOCALAPPDATA%\\tauri\\WixTools314\\dark.exe, or set FLOWMIC_WIX_DARK).');
        return false;
      }
      msis.forEach((msi, i) => {
        const label = basename(msi);
        const { wxs, pes: inner } = decompile(dark, msi, join(scratch, `msi-${i}`));
        const main = inner.filter((p) => p.display === `File:${MSI_MAIN_EXE}`);
        if (main.length !== 1) {
          groups.push({ blind: `${label}: expected exactly one File:${MSI_MAIN_EXE} inside, found ${main.length} (of ${inner.length} PE files) — the extraction did not see this MSI's payload` });
          return;
        }
        // How this variant gets WebView2 (scripts/msi-webview2-offline.mjs):
        // store ⇒ offline + silent; direct ⇒ small, no embedded installer.
        // Judged from the same decompile, reported as its own lines.
        const webview = judgeMsiWebView2({ variant: msiVariant, wxs, pes: inner, bytes: sizeOf(msi) });
        groups.push({ label, webview });
        groups.push({ label, entries: [
          { path: msi, display: '(the MSI itself)', requireOurs: true },
          ...inner.map((p) => ({
            ...p,
            requireOurs: p.display === `File:${MSI_MAIN_EXE}`,
            requireMicrosoftRoot: p.display === `Binary:${WEBVIEW2_STANDALONE_BINARY}`,
          })),
        ] });
      });
    }
    for (const t of trees) {
      const pes = listPeFiles(t.dir);
      const mainPath = t.mainExe ? join(t.dir, t.mainExe) : null;
      if (mainPath && !pes.includes(mainPath)) {
        groups.push({ blind: `${t.label}: ${t.mainExe} is not a PE file under ${t.dir}` });
        continue;
      }
      if (pes.length === 0) { groups.push({ blind: `${t.label}: no PE file under ${t.dir}` }); continue; }
      groups.push({ label: t.label, entries: pes.map((p) => ({
        path: p, display: relative(t.dir, p).replace(/\\/g, '/'), requireOurs: p === mainPath,
      })) });
    }
    for (const f of files) {
      if (!existsSync(f.path)) { groups.push({ blind: `${f.label}: ${f.path} does not exist` }); continue; }
      groups.push({ label: f.label, entries: [{ path: f.path, display: basename(f.path), requireOurs: Boolean(f.requireOurs) }] });
    }

    let good = true;
    for (const g of groups) {
      if (g.blind) { fail(g.blind); good = false; continue; }
      if (g.webview) {
        for (const n of g.webview.notes) ok(`${g.label}: ${msiVariant} MSI WebView2 — ${n}`);
        for (const p of g.webview.problems) { fail(`${g.label}: ${msiVariant} MSI WebView2 — ${p}`); good = false; }
        continue;
      }
      for (const row of judgeEntries(g.entries, { signtool: st.path, config, verify })) {
        const r = { ...row, label: g.label };
        const whose = r.ours ? 'our certificate'
          : r.requireMicrosoftRoot ? `Microsoft ${r.leaf}, root ${MICROSOFT_CODE_SIGNING_ROOTS[r.root]}` : `third-party ${r.leaf}`;
        if (r.verdict === 'ok') ok(`${g.label}: ${r.display} — signed, timestamped (${whose})`);
        else { fail(refusalLine(r, config)); good = false; }
      }
    }
    if (!good) {
      fail(`unsigned or untimestamped Windows artifacts are not published. Rebuild with:  ${WINDOWS_REBUILD_COMMAND}`);
    }
    return good;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** For callers that hold a zip (adopt-artifact.mjs): unpack with the same
 *  libarchive archiver pack-portable.mjs proves, then gate the tree. */
export function verifyWindowsPortableZipSigned({ zipPath, archiver, scratchRoot, fail, ok, env = process.env, platform = process.platform }) {
  const dir = join(scratchRoot, `zip-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    if (platform !== 'win32') {
      fail('Windows artifacts can only be signature-checked on Windows (signtool). Refusing rather than guessing.');
      return false;
    }
    const r = spawnSync(archiver, ['-x', '-f', zipPath, '-C', dir], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) { fail(`could not unpack ${zipPath}: ${(r.stderr || '').trim()}`); return false; }
    return verifyWindowsArtifactsSigned({
      trees: [{ dir: join(dir, PORTABLE_DIR_NAME), label: basename(zipPath), mainExe: PORTABLE_MAIN_EXE }],
      scratchRoot, fail, ok, env, platform,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
