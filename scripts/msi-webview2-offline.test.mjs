// Drill for scripts/msi-webview2-offline.mjs and its wiring into
// scripts/windows-signature-gate.mjs, the store build
// (scripts/build-windows-store-msi.mjs) and the update-path readers
// (card MSI-OFFLINE-WEBVIEW2: a small DIRECT MSI and an on-demand STORE MSI).
//
// Runs on every OS: the decompile and signtool are injected; the fixtures are
// REAL output captured on dev-pc-a 2026-10-26 (tauri-cli 2.11.4, WiX 3.14
// dark.exe -x, signtool 10.0.26100.0), trimmed to the elements the judge reads:
//   BEFORE_WXS  FlowMic_0.3.118_x64_en-US.msi built with the default
//               downloadBootstrapper (IT-19's signed build; 48,963,584 B) —
//               carries DownloadAndInvokeBootstrapper, a PowerShell
//               Invoke-WebRequest. This is the DIRECT variant's shape;
//   AFTER_WXS   the same MSI rebuilt with offlineInstaller (263,999,488 B) —
//               the STORE variant's shape: InvokeStandalone
//               on Binary MicrosoftEdgeWebView2RuntimeInstaller.exe (214,823,632
//               bytes), "/silent /install", NOT(REMOVE OR INSTALLED_WEBVIEW2_VERSION);
//   INSTALLER   `signtool verify /pa /v` of that Binary stream: leaf
//               "Microsoft Corporation" 4028CAD6…, root Microsoft Root
//               Certificate Authority 2011 8F43288A…, Microsoft timestamp.
// The other shapes (embedBootstrapper, minimumWebview2Version, silent:false)
// are those fixtures edited exactly as tauri-bundler's main.wxs would emit them
// (tauri-cli-v2.11.4, crates/tauri-bundler/src/bundle/windows/msi/main.wxs).
//
// Run: node scripts/msi-webview2-offline.test.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECT_MSI_MAX_BYTES,
  MICROSOFT_CODE_SIGNING_ROOTS,
  WEBVIEW2_STANDALONE_BINARY,
  judgeMsiWebView2,
  judgeMsiWebView2Direct,
  judgeMsiWebView2Offline,
  microsoftRootProblem,
} from './msi-webview2-offline.mjs';
import { judgeEntries, verifyWindowsArtifactsSigned } from './windows-signature-gate.mjs';
import { WINDOWS_SIGNING, parseVerifyOutput, signingConfig } from './windows-signing.mjs';
import { isStoreMsiName, storeMsiName } from './pack-portable.mjs';
import { isRoundArtifactName } from './update-manifest-lib.mjs';
import { STORE_CONFIG, storeBuildChain, storeLanguages } from './build-windows-store-msi.mjs';

const DIRECT_BYTES = 48963584; // measured, FlowMic_0.3.118_x64_en-US.msi (direct)
const STORE_BYTES = 263999488; // measured, the same MSI with offlineInstaller

let passed = 0;
let failedCount = 0;
function assertTrue(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failedCount += 1; console.error(`  ✗ ${msg}`); }
}

const WEBVIEW_PROPERTY = `<Property Id="INSTALLED_WEBVIEW2_VERSION">
  <RegistrySearch Id="Webview2VersionSystemx64" Root="HKLM" Key="SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" Name="pv" Type="raw" Win64="yes" />
  <RegistrySearch Id="Webview2VersionUser" Root="HKCU" Key="SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" Name="pv" Type="raw" Win64="yes" />
  <RegistrySearch Id="Webview2VersionSystemx86" Root="HKLM" Key="SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" Name="pv" Type="raw" Win64="yes" />
</Property>`;
const COMMON_ACTIONS = `<CustomAction Id="LaunchApplication" FileKey="Path" ExeCommand="[LAUNCHAPPARGS]" Return="asyncNoWait" />
<CustomAction Id="SetARPNOMODIFY" Property="ARPNOMODIFY" Value="1" />
<CustomAction Id="SetARPINSTALLLOCATION" Property="ARPINSTALLLOCATION" Value="[INSTALLDIR]" />`;
const COMMON_SEQ = `<Custom Action="SetARPINSTALLLOCATION" After="CostFinalize" />
<Custom Action="SetARPNOMODIFY" After="InstallValidate" />
<Custom Action="LaunchApplication" After="InstallFinalize">AUTOLAUNCHAPP AND NOT Installed</Custom>`;
const wrap = (body) => `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
<Product Id="*" Name="FlowMic" Language="1033" Version="0.3.118" Manufacturer="flowmic">
<Package Compressed="yes" InstallerVersion="450" Languages="0" Manufacturer="flowmic" Platform="x64" />
<Property Id="ALLUSERS" Value="1" />
${WEBVIEW_PROPERTY}
${COMMON_ACTIONS}
${body}
</Product>
</Wix>`;

const BEFORE_WXS = wrap(`<CustomAction Id="DownloadAndInvokeBootstrapper" Directory="INSTALLDIR" ExeCommand="powershell.exe -NoProfile -windowstyle hidden try [\\{] [\\[]Net.ServicePointManager[\\]]::SecurityProtocol = [\\[]Net.SecurityProtocolType[\\]]::Tls12 [\\}] catch [\\{][\\}]; Invoke-WebRequest -Uri &quot;https://go.microsoft.com/fwlink/p/?LinkId=2124703&quot; -OutFile &quot;$env:TEMP\\MicrosoftEdgeWebview2Setup.exe&quot; ; Start-Process -FilePath &quot;$env:TEMP\\MicrosoftEdgeWebview2Setup.exe&quot; -ArgumentList ('/silent', '/install') -Wait" Execute="deferred" />
<InstallExecuteSequence>
${COMMON_SEQ}
<Custom Action="DownloadAndInvokeBootstrapper" Before="InstallFinalize">NOT(REMOVE OR INSTALLED_WEBVIEW2_VERSION)</Custom>
</InstallExecuteSequence>`);

const standalone = ({ cmd = '/silent /install', cond = 'NOT(REMOVE OR INSTALLED_WEBVIEW2_VERSION)', extra = '' } = {}) => wrap(
  `<CustomAction Id="InvokeStandalone" BinaryKey="MicrosoftEdgeWebView2RuntimeInstaller.exe" ExeCommand="${cmd}" Execute="deferred" />
${extra}
<InstallExecuteSequence>
${COMMON_SEQ}
<Custom Action="InvokeStandalone" Before="InstallFinalize">${cond}</Custom>
</InstallExecuteSequence>
<Binary Id="MicrosoftEdgeWebView2RuntimeInstaller.exe" SourceFile="x\\Binary\\MicrosoftEdgeWebView2RuntimeInstaller.exe" />`);
const AFTER_WXS = standalone();

const PES_AFTER = [
  { path: 'p/installer', display: `Binary:${WEBVIEW2_STANDALONE_BINARY}`, name: WEBVIEW2_STANDALONE_BINARY },
  { path: 'p/wixca', display: 'Binary:WixUIWixca', name: 'WixUIWixca' },
  { path: 'p/main', display: 'File:flowmic-desktop.exe', name: 'flowmic-desktop.exe' },
  { path: 'p/node', display: 'File:node.exe', name: 'node.exe' },
];
const PES_BEFORE = PES_AFTER.filter((p) => !p.display.startsWith('Binary:Microsoft'));

const INSTALLER = `Verifying: F:\\scratch\\Binary\\MicrosoftEdgeWebView2RuntimeInstaller.exe
Signature Index: 0 (Primary Signature)
Hash of file (sha256): C245F07F27DDDE24CD4B367282E9B59A37006DFFD3E5FB552E772823263752AD
Signing Certificate Chain:
    Issued to: Microsoft Root Certificate Authority 2011
    Issued by: Microsoft Root Certificate Authority 2011
    Expires:   Sun Mar 23 06:13:04 2036
    SHA1 hash: 8F43288AD272F3103B6FB1428485EA3014C0BCFE
        Issued to: Microsoft Code Signing PCA 2024
        Issued by: Microsoft Root Certificate Authority 2011
        Expires:   Sun Mar 23 06:13:04 2036
        SHA1 hash: 5039C8DC9ACE1CE039587E43486DE073FA459222
            Issued to: Microsoft Corporation
            Issued by: Microsoft Code Signing PCA 2024
            Expires:   Fri Apr 16 03:00:11 2027
            SHA1 hash: 4028CAD637509D4744B17EC5B42AED8D7A31E6AF
The signature is timestamped: Thu Oct 22 15:27:50 2026
Timestamp Verified by:
    Issued to: Microsoft Root Certificate Authority 2010
    Issued by: Microsoft Root Certificate Authority 2010
    Expires:   Sun Jun 24 06:04:01 2035
    SHA1 hash: 3B1EFD3A66EA28B16697394703A72CA340A05BD5
            Issued to: Microsoft Time-Stamp Service
            Issued by: Microsoft Time-Stamp PCA 2010
            Expires:   Tue May 18 03:40:07 2027
            SHA1 hash: B7BFD8923B6DB1A1BED9C4DE5D5C212AFBD22FFF
Successfully verified: F:\\scratch\\Binary\\MicrosoftEdgeWebView2RuntimeInstaller.exe
Number of files successfully Verified: 1
Number of warnings: 0
Number of errors: 0`;

// A valid, timestamped signature from a NON-Microsoft publisher (node.exe's
// OpenJS Foundation chain, captured in it19-windows-signature-gate.test.mjs) —
// what a substituted installer from anyone with a code-signing certificate
// would look like to signtool.
const THIRD_PARTY = `Signing Certificate Chain:
    Issued to: Microsoft Identity Verification Root Certificate Authority 2020
    SHA1 hash: F40042E2E5F7E8EF8189FED15519AECE42C3BFA2
        Issued to: Microsoft ID Verified Code Signing PCA 2021
        SHA1 hash: 8E750F459DAF9A79D6370DB747AD2226866AD818
            Issued to: OpenJS Foundation
            SHA1 hash: 202AB432C8436205901D966C487534A0FE30BC6C
The signature is timestamped: Wed May 13 17:58:57 2026
Successfully verified: resources\\node.exe`;

const OURS = `Signing Certificate Chain:
    Issued to: Certum Trusted Network CA
    SHA1 hash: 07E032E020B72C3F192F0628A2593A19A70F069E
        Issued to:
        SHA1 hash: ${WINDOWS_SIGNING.thumbprint}
The signature is timestamped: Mon Oct 26 13:31:10 2026
Successfully verified: x`;

console.log('§1 judgeMsiWebView2Offline on the real before/after tables');
{
  const after = judgeMsiWebView2Offline({ wxs: AFTER_WXS, pes: PES_AFTER });
  assertTrue(after.ok && after.problems.length === 0, 'POSITIVE: the offlineInstaller MSI passes');
  assertTrue(after.installer === `Binary:${WEBVIEW2_STANDALONE_BINARY}`, 'it names the embedded installer, so the signature gate can single it out');
  assertTrue(after.notes.some((n) => /InvokeStandalone runs "\/silent \/install" only when NOT\(REMOVE OR INSTALLED_WEBVIEW2_VERSION\)/.test(n)),
    'it reports the measured command and condition, not just "ok"');

  const before = judgeMsiWebView2Offline({ wxs: BEFORE_WXS, pes: PES_BEFORE });
  assertTrue(!before.ok && before.problems.some((p) => /DownloadAndInvokeBootstrapper fetches the WebView2 runtime online/.test(p)),
    'REVERSE: the downloadBootstrapper MSI (0.3.118 as shipped) is refused, naming the action');
  assertTrue(before.problems.some((p) => /expected exactly one Binary:MicrosoftEdgeWebView2RuntimeInstaller\.exe PE/.test(p)),
    'REVERSE: and the missing embedded installer is named separately');
}

console.log('§2 every other Tauri mode or option that reaches the network or shows UI');
{
  const embed = wrap(`<Binary Id="MicrosoftEdgeWebview2Setup.exe" SourceFile="x" />
<CustomAction Id="InvokeBootstrapper" BinaryKey="MicrosoftEdgeWebview2Setup.exe" Execute="deferred" ExeCommand="/silent /install" Return="check" />
<InstallExecuteSequence><Custom Action="InvokeBootstrapper" Before="InstallFinalize">NOT(REMOVE OR INSTALLED_WEBVIEW2_VERSION)</Custom></InstallExecuteSequence>`);
  const e = judgeMsiWebView2Offline({ wxs: embed, pes: [...PES_BEFORE, { path: 'b', display: 'Binary:MicrosoftEdgeWebview2Setup.exe' }] });
  assertTrue(!e.ok && e.problems.some((p) => /InvokeBootstrapper fetches/.test(p)) && e.problems.some((p) => /embeds MicrosoftEdgeWebview2Setup\.exe/.test(p)),
    'REVERSE: embedBootstrapper is refused — the embedded bootstrapper still downloads');

  const edge = standalone({ extra: '<CustomAction Id="UpdateWebView2ViaEdgeUpdate" Execute="deferred" Property="EDGEUPDATE_PATH" Return="check" Impersonate="no" ExeCommand="/install appguid={F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}&amp;needsadmin=true" />' });
  const u = judgeMsiWebView2Offline({ wxs: edge, pes: PES_AFTER });
  assertTrue(!u.ok && u.problems.some((p) => /UpdateWebView2ViaEdgeUpdate/.test(p)), 'REVERSE: minimumWebview2Version (EdgeUpdate online update during setup) is refused');

  const loud = judgeMsiWebView2Offline({ wxs: standalone({ cmd: ' /install' }), pes: PES_AFTER });
  assertTrue(!loud.ok && loud.problems.some((p) => /must be "\/silent \/install"/.test(p)), 'REVERSE: silent:false (runtime installer without /silent) is refused');

  const always = judgeMsiWebView2Offline({ wxs: standalone({ cond: 'NOT REMOVE' }), pes: PES_AFTER });
  assertTrue(!always.ok && always.problems.some((p) => /must skip when a runtime is registered/.test(p)),
    'REVERSE: running the installer even when a runtime is already registered is refused');

  const fetcher = standalone({ extra: '<CustomAction Id="FetchExtra" Directory="INSTALLDIR" ExeCommand="powershell.exe Invoke-WebRequest -Uri https://example.invalid/vc_redist.exe" Execute="deferred" />' });
  const f = judgeMsiWebView2Offline({ wxs: fetcher, pes: PES_AFTER });
  assertTrue(!f.ok && f.problems.some((p) => /FetchExtra runs a command that reaches the network/.test(p)),
    'REVERSE: any other custom action that downloads (e.g. a VC++ runtime) is refused too');

  const noPv = judgeMsiWebView2Offline({ wxs: AFTER_WXS.replace(/ Name="pv"/g, ''), pes: PES_AFTER });
  assertTrue(!noPv.ok && noPv.problems.some((p) => /no registry search on the runtime's "pv"/.test(p)), 'REVERSE: no runtime detection ⇒ refused');

  const blind = judgeMsiWebView2Offline({ wxs: '', pes: PES_AFTER });
  assertTrue(!blind.ok && /^BLIND/.test(blind.problems[0]), 'an empty decompile is BLIND, never "nothing online found"');
}

console.log('§3 the embedded installer must be Microsoft-signed, not just validly signed');
{
  const ms = parseVerifyOutput(INSTALLER, 0);
  assertTrue(ms.chainSha1s[0] === '8F43288AD272F3103B6FB1428485EA3014C0BCFE' && MICROSOFT_CODE_SIGNING_ROOTS[ms.chainSha1s[0]] === 'Microsoft Root Certificate Authority 2011',
    'the real installer chain ends at Microsoft Root CA 2011 (leaf Microsoft Corporation)');
  assertTrue(microsoftRootProblem(ms) === null, 'POSITIVE: the real installer chain is accepted');
  assertTrue(/not at a Microsoft code-signing root/.test(microsoftRootProblem(parseVerifyOutput(THIRD_PARTY, 0)) ?? ''),
    'REVERSE: a valid third-party chain (Identity Verification Root 2020, OpenJS leaf) is not Microsoft');
  const config = signingConfig({});
  const verifyBy = (map) => (_st, p) => { const t = map[p]; return parseVerifyOutput(t, 0); };
  const rows = judgeEntries([
    { path: 'p/installer', display: `Binary:${WEBVIEW2_STANDALONE_BINARY}`, requireOurs: false, requireMicrosoftRoot: true },
    { path: 'p/node', display: 'File:node.exe', requireOurs: false },
  ], { signtool: 'st', config, verify: verifyBy({ 'p/installer': INSTALLER, 'p/node': THIRD_PARTY }) });
  assertTrue(rows[0].verdict === 'ok' && rows[1].verdict === 'ok', 'POSITIVE: Microsoft installer ok; node.exe (no root pin) still ok — no existing rule tightened');
  const swapped = judgeEntries([{ path: 'p/installer', display: `Binary:${WEBVIEW2_STANDALONE_BINARY}`, requireOurs: false, requireMicrosoftRoot: true }],
    { signtool: 'st', config, verify: verifyBy({ 'p/installer': THIRD_PARTY }) });
  assertTrue(swapped[0].verdict === 'not-microsoft', 'REVERSE: the installer slot carrying a non-Microsoft signature ⇒ not-microsoft');
}

console.log('§4 wiring: the whole MSI branch of verifyWindowsArtifactsSigned');
{
  const scratch = mkdtempSync(join(tmpdir(), 'msi-offline-'));
  try {
    // A synthetic PE stands in for signtool.exe and dark.exe (they are only
    // located and, for signtool, copied for the negative control; verify and
    // decompile are injected).
    const pe = Buffer.alloc(0x400);
    pe.write('MZ', 0, 'latin1'); pe.writeUInt32LE(0x80, 0x3c); pe.write('PE\0\0', 0x80, 'latin1'); pe.writeUInt16LE(0x20b, 0x80 + 24);
    const st = join(scratch, 'signtool.exe');
    const dark = join(scratch, 'dark.exe');
    writeFileSync(st, pe); writeFileSync(dark, pe);
    const env = { FLOWMIC_SIGNTOOL: st, FLOWMIC_WIX_DARK: dark };
    const outputs = {
      [st]: OURS, 'x.msi': OURS, 'p/main': OURS, 'p/installer': INSTALLER, 'p/wixca': THIRD_PARTY, 'p/node': THIRD_PARTY,
    };
    const run = ({ wxs, pes, variant, bytes, installer = INSTALLER, node = THIRD_PARTY }) => {
      const lines = { ok: [], fail: [] };
      const map = { ...outputs, 'p/installer': installer, 'p/node': node };
      const args = {
        msis: ['x.msi'], scratchRoot: scratch, env, platform: 'win32',
        fail: (m) => lines.fail.push(m), ok: (m) => lines.ok.push(m),
        verify: (_s, p) => (map[p] ? parseVerifyOutput(map[p], 0) : parseVerifyOutput('SignTool Error: No signature found.', 1)),
        decompile: () => ({ wxs, pes }),
        sizeOf: () => bytes,
      };
      if (variant !== undefined) args.msiVariant = variant;
      const good = verifyWindowsArtifactsSigned(args);
      return { good, ...lines };
    };
    // STORE variant
    const a = run({ wxs: AFTER_WXS, pes: PES_AFTER, variant: 'store', bytes: STORE_BYTES });
    assertTrue(a.good && a.fail.length === 0, 'POSITIVE (store): the offlineInstaller MSI passes the gate end to end');
    assertTrue(a.ok.some((l) => /Binary:MicrosoftEdgeWebView2RuntimeInstaller\.exe — signed, timestamped \(Microsoft 4028CAD6.*Root Certificate Authority 2011\)/.test(l)),
      'the embedded installer is CHECKED (its own ok line), not skipped');
    assertTrue(a.ok.some((l) => /store MSI WebView2 — InvokeStandalone runs/.test(l)), 'the variant verdict has its own line, naming the variant');
    const b = run({ wxs: BEFORE_WXS, pes: PES_BEFORE, variant: 'store', bytes: DIRECT_BYTES });
    assertTrue(!b.good && b.fail.some((l) => /x\.msi: store MSI WebView2 — custom action DownloadAndInvokeBootstrapper/.test(l)),
      'REVERSE (store): a downloading MSI offered as the store variant is refused, even with every PE signed');
    const c = run({ wxs: AFTER_WXS, pes: PES_AFTER, variant: 'store', bytes: STORE_BYTES, installer: THIRD_PARTY });
    assertTrue(!c.good && c.fail.some((l) => /Binary:MicrosoftEdgeWebView2RuntimeInstaller\.exe — it is the embedded WebView2 runtime installer and must be signed by Microsoft/.test(l)),
      'REVERSE: a validly signed non-Microsoft installer in that slot is refused');
    const d = run({ wxs: AFTER_WXS, pes: PES_AFTER, variant: 'store', bytes: STORE_BYTES, installer: 'SignTool Error: No signature found.' });
    assertTrue(!d.good && d.fail.some((l) => /MicrosoftEdgeWebView2RuntimeInstaller\.exe — it has no Authenticode signature/.test(l)),
      'REVERSE: an unsigned installer in that slot is refused');
    // DIRECT variant
    const e = run({ wxs: BEFORE_WXS, pes: PES_BEFORE, variant: 'direct', bytes: DIRECT_BYTES });
    assertTrue(e.good && e.fail.length === 0 && e.ok.some((l) => /direct MSI WebView2 — DownloadAndInvokeBootstrapper \(download on install\)/.test(l)),
      'POSITIVE (direct): the downloadBootstrapper MSI passes, the bootstrapper is allowed');
    const f = run({ wxs: AFTER_WXS, pes: PES_AFTER, variant: 'direct', bytes: STORE_BYTES });
    assertTrue(!f.good && f.fail.some((l) => /x\.msi: direct MSI WebView2 — this MSI embeds the WebView2 standalone installer/.test(l)) &&
      f.fail.some((l) => /over the direct-variant ceiling/.test(l)),
    'REVERSE (direct): a fat MSI (store content) offered as the direct variant is refused, by content AND by size');
    const g = run({ wxs: BEFORE_WXS, pes: PES_BEFORE, variant: 'direct', bytes: DIRECT_BYTES, node: 'SignTool Error: No signature found.' });
    assertTrue(!g.good && g.fail.some((l) => /File:node\.exe — it has no Authenticode signature/.test(l)),
      'REVERSE: the IT-19 signature rules still apply to the direct variant (an unsigned PE is refused)');
    // no variant
    const h = run({ wxs: BEFORE_WXS, pes: PES_BEFORE, bytes: DIRECT_BYTES });
    assertTrue(!h.good && h.fail.some((l) => /msiVariant must be 'direct' or 'store'/.test(l)),
      'REVERSE: an MSI check without an explicit variant is refused, never guessed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('§5 the direct-variant judge on its own');
{
  const ok = judgeMsiWebView2Direct({ wxs: BEFORE_WXS, pes: PES_BEFORE, bytes: DIRECT_BYTES });
  assertTrue(ok.ok, 'POSITIVE: the measured direct MSI (48,963,584 B, bootstrapper) passes');
  const big = judgeMsiWebView2Direct({ wxs: BEFORE_WXS, pes: PES_BEFORE, bytes: DIRECT_MSI_MAX_BYTES + 1 });
  assertTrue(!big.ok && big.problems.length === 1 && /over the direct-variant ceiling of 134217728/.test(big.problems[0]),
    'REVERSE: one byte over the ceiling is refused on size alone (e.g. fixedRuntime, which ships through the File table)');
  assertTrue(DIRECT_MSI_MAX_BYTES > DIRECT_BYTES * 2 && DIRECT_MSI_MAX_BYTES < STORE_BYTES / 1.5,
    'the ceiling sits well above the measured direct MSI and well below the measured store MSI');
  const skip = judgeMsiWebView2Direct({ wxs: wrap('<InstallExecuteSequence></InstallExecuteSequence>'), pes: PES_BEFORE, bytes: DIRECT_BYTES });
  assertTrue(!skip.ok && skip.problems.some((p) => /expected exactly one WebView2 install action/.test(p)),
    'REVERSE: a direct MSI that never provisions WebView2 (webviewInstallMode skip) is refused');
  const blind = judgeMsiWebView2Direct({ wxs: '', pes: PES_BEFORE, bytes: DIRECT_BYTES });
  assertTrue(!blind.ok && /^BLIND/.test(blind.problems[0]), 'an empty decompile is BLIND for the direct variant too');
  let threw = false; try { judgeMsiWebView2({ variant: 'fat', wxs: BEFORE_WXS, pes: PES_BEFORE, bytes: 1 }); } catch { threw = true; }
  assertTrue(threw, 'an unknown variant name throws');
}

console.log('§6 the two configs, the opt-in, and the update-path readers');
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const conf = (n) => JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'src-tauri', n), 'utf8'));
  const win = conf('tauri.windows.conf.json');
  const base = conf('tauri.conf.json');
  const store = conf('tauri.store.conf.json');
  const layers = [base, win].map((c) => c.bundle?.windows ?? {});
  assertTrue(layers.every((w) => !('webviewInstallMode' in w) && !('minimumWebview2Version' in w)),
    'the auto-merged configs (tauri.conf.json, tauri.windows.conf.json) set no install mode ⇒ the plain build is Tauri\'s default downloadBootstrapper');
  const mode = store.bundle?.windows?.webviewInstallMode;
  assertTrue(mode?.type === 'offlineInstaller' && mode?.silent === true && !('minimumWebview2Version' in store.bundle.windows),
    'tauri.store.conf.json selects offlineInstaller, silent');
  assertTrue(JSON.stringify(storeLanguages(store)) === '["en-US"]', 'the store variant is built in en-US only (see build-windows-store-msi.mjs header)');
  assertTrue(STORE_CONFIG.endsWith(join('src-tauri', 'tauri.store.conf.json')), 'the store script points at that file');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).scripts;
  assertTrue(!pkg['tauri:build'].includes('tauri.store.conf') && !pkg['tauri:build'].includes('--config'),
    'the plain tauri:build never merges the store config');
  assertTrue(pkg['tauri:build:store'] === 'node ../../scripts/build-windows-store-msi.mjs', 'the opt-in is its own package script');
  const chain = storeBuildChain(pkg['tauri:build'], 'C:/x/tauri.store.conf.json');
  assertTrue(chain === pkg['tauri:build'].replace('tauri build --features app', 'tauri build --features app --config "C:/x/tauri.store.conf.json"'),
    'the store chain is the plain chain with only --config added (one chain, cannot drift)');
  const shipSrc = readFileSync(join(ROOT, 'scripts', 'ship.mjs'), 'utf8');
  assertTrue(!/tauri:build:store|build-windows-store-msi|tauri\.store\.conf/.test(shipSrc), 'pnpm ship never builds the store variant');

  const v = '0.3.118';
  const name = storeMsiName(v, 'en-US');
  assertTrue(name === 'FlowMic_0.3.118_x64_en-US_store.msi' && isStoreMsiName(name), 'store file name is versioned and recognised');
  assertTrue(!isStoreMsiName('FlowMic_0.3.118_x64_en-US.msi'), 'the direct MSI name is not a store name');
  assertTrue(isRoundArtifactName('FlowMic_0.3.118_x64_en-US.msi', v) && !isRoundArtifactName(name, v),
    'REVERSE: the update manifest takes the direct MSI and refuses the store MSI even if it sits in ./publish');
  // The download centre's filter is drilled in it07-it11-publish-download-center-flags.test.mjs
  // (that module is not part of the public export, so this kept test must not import it).
  const gh = readFileSync(join(ROOT, 'scripts', 'publish-github-release.mjs'), 'utf8');
  assertTrue(/&& !isStoreMsiName\(f\)\);/.test(gh), 'publish-github-release.mjs filters out *_store.msi when it lists ./publish (read as text: importing it would run it)');
  const pub = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8');
  assertTrue(/msis: msis\.map\(\(f\) => join\(BUNDLE, f\)\),[\s\S]{0,400}msiVariant: 'direct',/.test(pub), 'publish.mjs gates the bundle MSIs as the DIRECT variant');
}

console.log(`\n${passed} passed, ${failedCount} failed`);
process.exit(failedCount === 0 ? 0 : 1);
