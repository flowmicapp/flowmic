// IT-19 drill for scripts/windows-signing.mjs, scripts/windows-signature-gate.mjs
// and their wiring (publish.mjs, adopt-artifact.mjs, tauri.windows.conf.json).
//
// Runs on every OS: everything here is pure (captured signtool output, synthetic
// PE buffers, injected probes) or reads repo text. The half that needs a real
// signtool is scripts/it19-windows-signature-gate-live.test.mjs, which SKIPs
// off Windows. publish.mjs is read as TEXT only (importing it would run Gate 0
// and the upload, see up7-apk-self-update-marker.test.mjs).
//
// §1 FIXTURES ARE REAL OUTPUT, captured on dev-pc-a 2026-10-26 with
// signtool 10.0.26100.0 `verify /pa /v` (blank lines dropped, paths shortened):
//   OURS_TS     a DLL signed with our certificate + Certum RFC 3161 timestamp;
//   OURS_NO_TS  the same DLL signed WITHOUT /tr — note exit 0 and
//               "Successfully verified": the reason the timestamp is read from
//               the text and not from the exit code;
//   NODE        the staged node.exe (OpenJS Foundation, Microsoft timestamp);
//   SELF        a DLL signed with a throwaway self-signed PFX (never imported
//               into any certificate store), timestamped — exit 1;
//   NONE        an unsigned DLL.
//
// Run: node scripts/it19-windows-signature-gate.test.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WINDOWS_SIGNING,
  classifySignFailure,
  classifySignature,
  isFlowMicSignTarget,
  isPeBuffer,
  parseVerifyOutput,
  preflightSigner,
  signingConfig,
  signingMode,
  stripAuthenticode,
} from './windows-signing.mjs';
import {
  MSI_MAIN_EXE,
  PORTABLE_MAIN_EXE,
  judgeEntries,
  runVerifierControls,
  verifyWindowsArtifactsSigned,
} from './windows-signature-gate.mjs';
import { adoptArtifact } from './adopt-artifact.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failedCount = 0;
function assertTrue(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failedCount += 1; console.error(`  ✗ ${msg}`); }
}
const OURS = WINDOWS_SIGNING.thumbprint;

const OURS_TS = `Verifying: F:\\scratch\\ts.dll
Signature Index: 0 (Primary Signature)
Hash of file (sha256): DE80BEA5D5EDECF8018E9533EE31EE489DF50846AAEBC6B40E206DE329FF636F
Signing Certificate Chain:
    Issued to: Certum Trusted Network CA
    Issued by: Certum Trusted Network CA
    Expires:   Mon Dec 31 20:07:37 2029
    SHA1 hash: 07E032E020B72C3F192F0628A2593A19A70F069E
        Issued to: Certum Trusted Network CA 2
        Issued by: Certum Trusted Network CA
        Expires:   Mon Sep 17 14:43:06 2029
        SHA1 hash: 5F14876473A0EC43DF0AE794A2805FC461125D62
            Issued to: Certum Code Signing 2021 CA
            Issued by: Certum Trusted Network CA 2
            Expires:   Sun May 18 13:32:18 2036
            SHA1 hash: 8D57E2B4008BBE461470A69F3492BC5AE362A7A9
                Issued to:
                Issued by: Certum Code Signing 2021 CA
                Expires:   Thu Oct 21 13:27:33 2027
                SHA1 hash: F90EBF76A64D423F6CBFEC4AC020D7FC78224879
The signature is timestamped: Mon Oct 26 13:31:10 2026
Timestamp Verified by:
    Issued to: Certum Trusted Network CA
    Issued by: Certum Trusted Network CA
    Expires:   Mon Dec 31 20:07:37 2029
    SHA1 hash: 07E032E020B72C3F192F0628A2593A19A70F069E
                Issued to: Certum Timestamp 2026
                Issued by: Certum Timestamping 2021 CA
                Expires:   Wed Feb 27 15:34:54 2036
                SHA1 hash: 571468410CA85AF3424EF9164A513610F4D38D98
Successfully verified: F:\\scratch\\ts.dll
Number of files successfully Verified: 1
Number of warnings: 0
Number of errors: 0`;

const OURS_NO_TS = `Verifying: F:\\scratch\\nots.dll
Signature Index: 0 (Primary Signature)
Hash of file (sha256): DE80BEA5D5EDECF8018E9533EE31EE489DF50846AAEBC6B40E206DE329FF636F
Signing Certificate Chain:
    Issued to: Certum Trusted Network CA 2
    Issued by: Certum Trusted Network CA 2
    Expires:   Sat Oct 06 16:39:56 2046
    SHA1 hash: D3DD483E2BBF4C05E8AF10F5FA7626CFD3DC3092
        Issued to: Certum Code Signing 2021 CA
        Issued by: Certum Trusted Network CA 2
        Expires:   Sun May 18 13:32:18 2036
        SHA1 hash: 8D57E2B4008BBE461470A69F3492BC5AE362A7A9
            Issued to:
            Issued by: Certum Code Signing 2021 CA
            Expires:   Thu Oct 21 13:27:33 2027
            SHA1 hash: F90EBF76A64D423F6CBFEC4AC020D7FC78224879
File is not timestamped.
Successfully verified: F:\\scratch\\nots.dll
Number of files successfully Verified: 1
Number of warnings: 0
Number of errors: 0`;

const NODE = `Verifying: resources\\node.exe
Signature Index: 0 (Primary Signature)
Hash of file (sha256): 45E6812B79BD400563AED3B7FF4C0F7F4F4EBB0263DFA652E10E280E27B9FB39
Signing Certificate Chain:
    Issued to: Microsoft Identity Verification Root Certificate Authority 2020
    Issued by: Microsoft Identity Verification Root Certificate Authority 2020
    Expires:   Mon Apr 17 02:44:40 2045
    SHA1 hash: F40042E2E5F7E8EF8189FED15519AECE42C3BFA2
        Issued to: Microsoft ID Verified Code Signing PCA 2021
        Issued by: Microsoft Identity Verification Root Certificate Authority 2020
        Expires:   Wed Apr 02 04:15:20 2036
        SHA1 hash: 8E750F459DAF9A79D6370DB747AD2226866AD818
            Issued to: Microsoft ID Verified CS AOC CA 03
            Issued by: Microsoft ID Verified Code Signing PCA 2021
            Expires:   Thu Mar 27 02:11:32 2031
            SHA1 hash: 06F826F5DDBB0A47AFC6BED6549B936461FFA7D0
                Issued to: OpenJS Foundation
                Issued by: Microsoft ID Verified CS AOC CA 03
                Expires:   Sat May 16 06:41:19 2026
                SHA1 hash: 202AB432C8436205901D966C487534A0FE30BC6C
The signature is timestamped: Wed May 13 17:58:57 2026
Timestamp Verified by:
    Issued to: Microsoft Identity Verification Root Certificate Authority 2020
    Issued by: Microsoft Identity Verification Root Certificate Authority 2020
    Expires:   Mon Apr 17 02:44:40 2045
    SHA1 hash: F40042E2E5F7E8EF8189FED15519AECE42C3BFA2
            Issued to: Microsoft Public RSA Time Stamping Authority
            Issued by: Microsoft Public RSA Timestamping CA 2020
            Expires:   Fri Oct 23 04:46:51 2026
            SHA1 hash: FF73F729152A9059805E5E0832449D996EF60411
Successfully verified: resources\\node.exe
Number of files successfully Verified: 1
Number of warnings: 0
Number of errors: 0`;

const SELF = `Verifying: F:\\scratch\\selfsigned.dll
Signature Index: 0 (Primary Signature)
Hash of file (sha256): DE80BEA5D5EDECF8018E9533EE31EE489DF50846AAEBC6B40E206DE329FF636F
SignTool Error: A certificate chain processed, but terminated in a root
	certificate which is not trusted by the trust provider.
Signing Certificate Chain:
    Issued to: IT19 self-signed test
    Issued by: IT19 self-signed test
    Expires:   Wed Oct 28 13:44:49 2026
    SHA1 hash: 72D3ADBAACA91E9D5E35CF37FC2DC3406D5AEC27
The signature is timestamped: Mon Oct 26 13:44:49 2026
Timestamp Verified by:
    Issued to: Certum Trusted Network CA
    Issued by: Certum Trusted Network CA
    Expires:   Mon Dec 31 20:07:37 2029
    SHA1 hash: 07E032E020B72C3F192F0628A2593A19A70F069E
Number of files successfully Verified: 0
Number of warnings: 0
Number of errors: 1`;

const NONE = `Verifying: resources\\node_modules\\sherpa-onnx-win-x64\\sherpa-onnx-cxx-api.dll
Number of files successfully Verified: 0
Number of warnings: 0
Number of errors: 1
SignTool Error: No signature found.`;

console.log('§1 parseVerifyOutput on real signtool output');
{
  const a = parseVerifyOutput(OURS_TS, 0);
  assertTrue(a.verified && a.timestamped && a.leafSha1 === OURS, 'ours + timestamp: verified, timestamped, leaf = our thumbprint (not the timestamp chain\'s last hash)');
  const b = parseVerifyOutput(OURS_NO_TS, 0);
  assertTrue(b.verified && !b.timestamped && b.leafSha1 === OURS, 'no /tr: signtool says verified AND exit 0, parser says NOT timestamped');
  const c = parseVerifyOutput(NODE, 0);
  assertTrue(c.verified && c.timestamped && c.leafSha1 === '202AB432C8436205901D966C487534A0FE30BC6C', 'node.exe: OpenJS leaf, Microsoft timestamp');
  const d = parseVerifyOutput(SELF, 1);
  assertTrue(!d.verified && d.timestamped && d.leafSha1 === '72D3ADBAACA91E9D5E35CF37FC2DC3406D5AEC27', 'self-signed: not verified even though it is timestamped');
  const e = parseVerifyOutput(NONE, 1);
  assertTrue(e.noSignature && !e.verified && e.leafSha1 === null, 'unsigned: noSignature');
  const crlf = parseVerifyOutput(OURS_TS.replace(/\n/g, '\r\n\r\n'), 0);
  assertTrue(crlf.timestamped && crlf.leafSha1 === OURS, 'the doubled CRLF shape PowerShell shows parses the same');
}

console.log('§2 classifySignature — every verdict, and the order between them');
{
  const v = (t, x) => classifySignature(parseVerifyOutput(t, x), { requireThumbprint: OURS });
  const any = (t, x) => classifySignature(parseVerifyOutput(t, x));
  assertTrue(v(OURS_TS, 0) === 'ok', 'ours + timestamp ⇒ ok where ours is required');
  assertTrue(v(OURS_NO_TS, 0) === 'untimestamped', 'REVERSE: untimestamped ⇒ refused even though signtool exit 0');
  assertTrue(v(SELF, 1) === 'untrusted', 'REVERSE: self-signed ⇒ untrusted');
  assertTrue(v(NONE, 1) === 'unsigned', 'REVERSE: no signature ⇒ unsigned');
  assertTrue(v(NODE, 0) === 'wrong-signer', 'REVERSE: a valid third-party signature on a file that must be ours ⇒ wrong-signer');
  assertTrue(any(NODE, 0) === 'ok', 'the same node.exe where any trusted signer is allowed ⇒ ok');
  assertTrue(any(OURS_NO_TS, 0) === 'untimestamped', 'untimestamped is refused for third-party files too');
}

console.log('§3 PE detection and the negative-control manufacturer');
function syntheticPe({ withCert }) {
  const buf = Buffer.alloc(0x400);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'latin1');
  const opt = 0x80 + 4 + 20;
  buf.writeUInt16LE(0x20b, opt); // PE32+
  const sec = opt + 112 + 4 * 8;
  if (withCert) {
    buf.writeUInt32LE(0x300, sec);
    buf.writeUInt32LE(0x100, sec + 4);
    buf.fill(0xab, 0x300);
  }
  return buf;
}
{
  const pe = syntheticPe({ withCert: true });
  assertTrue(isPeBuffer(pe), 'MZ + PE\\0\\0 at e_lfanew ⇒ PE');
  assertTrue(!isPeBuffer(Buffer.from('\0\0\x01\0icon-bytes-not-a-pe'.padEnd(80, '\0'), 'latin1')), 'an .ico (the MSI ProductIcon) ⇒ not PE');
  const mzOnly = Buffer.from(pe); mzOnly.write('XX', 0x80, 'latin1');
  assertTrue(!isPeBuffer(mzOnly), 'MZ without the PE signature ⇒ not PE (extension and MZ alone are not enough)');
  const stripped = stripAuthenticode(pe);
  const sec = 0x80 + 4 + 20 + 112 + 32;
  assertTrue(stripped.length === 0x300 && stripped.readUInt32LE(sec) === 0 && stripped.readUInt32LE(sec + 4) === 0,
    'stripAuthenticode zeroes the security directory and cuts the certificate table');
}

console.log('§4 the verifier controls decide BLIND before any artifact verdict');
{
  const scratch = mkdtempSync(join(tmpdir(), 'it19-controls-'));
  try {
    const fakeSigntool = join(scratch, 'signtool.exe');
    writeFileSync(fakeSigntool, syntheticPe({ withCert: true }));
    const exitOf = (t) => (t === NONE || t === SELF ? 1 : 0);
    const answers = (pos, neg) => (_st, file) => {
      const t = file === fakeSigntool ? pos : neg;
      return parseVerifyOutput(t, exitOf(t));
    };
    assertTrue(runVerifierControls(fakeSigntool, scratch, answers(OURS_TS, NONE)).ok, 'positive ok + negative unsigned ⇒ controls pass');
    assertTrue(!runVerifierControls(fakeSigntool, scratch, answers(NONE, NONE)).ok, 'REVERSE: a verifier that sees nothing as signed ⇒ BLIND');
    assertTrue(!runVerifierControls(fakeSigntool, scratch, answers(OURS_TS, OURS_TS)).ok, 'REVERSE: a verifier that calls a stripped file signed ⇒ BLIND');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const rows = judgeEntries(
    [{ path: 'a', display: 'File:flowmic-desktop.exe', requireOurs: true }, { path: 'b', display: 'File:node.exe', requireOurs: false }],
    { signtool: 'st', config: signingConfig({}), verify: (_s, p) => parseVerifyOutput(NODE, 0) },
  );
  assertTrue(rows[0].verdict === 'wrong-signer' && rows[1].verdict === 'ok', 'judgeEntries applies "must be ours" per entry');
  const lines = [];
  const off = verifyWindowsArtifactsSigned({ msis: ['x.msi'], scratchRoot: tmpdir(), fail: (m) => lines.push(m), ok: () => {}, platform: 'linux' });
  assertTrue(off === false && /only be signature-checked on Windows/.test(lines[0]), 'off Windows the gate REFUSES (cannot verify ≠ verified)');
}

console.log('§5 signer configuration, opt-out and preflight branches');
{
  assertTrue(signingMode({}) === 'sign' && signingMode({ FLOWMIC_WINDOWS_SIGN: 'on' }) === 'sign', 'unset/on ⇒ sign');
  assertTrue(signingMode({ FLOWMIC_WINDOWS_SIGN: 'OFF' }) === 'off', 'off ⇒ unsigned build');
  let threw = false; try { signingMode({ FLOWMIC_WINDOWS_SIGN: 'of' }); } catch { threw = true; }
  assertTrue(threw, 'a typo is refused, not read as either answer');
  assertTrue(signingConfig({}).timestampUrls[0] === 'http://time.certum.pl', 'Certum\'s RFC 3161 authority is tried first');
  threw = false; try { signingConfig({ FLOWMIC_SIGN_TIMESTAMP_URLS: ' , ' }); } catch { threw = true; }
  assertTrue(threw, 'an empty timestamp list is refused — there is no sign-without-timestamp path');
  const cfg = signingConfig({});
  const probe = (o) => ({ signtool: () => ({ path: 'st', how: 'x' }), keyHost: () => true, cert: () => ({ state: 'present', hasPrivateKey: true, notAfter: '2027-10-21T05:27:33Z' }), key: () => ({ state: 'ok', keySpec: '1', ms: 12 }), ...o });
  const pf = (o) => preflightSigner(cfg, { platform: 'win32', probe: probe(o) });
  assertTrue(pf({}).ok, 'all present ⇒ ready');
  assertTrue(pf({ signtool: () => null }).problem === 'no-signtool', 'no signtool ⇒ named');
  const host = pf({ keyHost: () => false });
  assertTrue(host.problem === 'key-host-not-running' && /log in/.test(host.message) && /FLOWMIC_WINDOWS_SIGN=off/.test(host.message),
    'SimplySign not running ⇒ tells the user to log in, and names the opt-out');
  assertTrue(pf({ cert: () => ({ state: 'absent' }) }).problem === 'cert-missing', 'certificate absent ⇒ cert-missing');
  assertTrue(pf({ cert: () => ({ state: 'present', hasPrivateKey: false }) }).problem === 'no-private-key', 'no private key ⇒ named separately');
  assertTrue(pf({ cert: () => ({ state: 'present', hasPrivateKey: true, notAfter: '2020-01-01T00:00:00Z' }) }).problem === 'cert-expired', 'expired ⇒ named');
  // [measured 2026-10-27, dev-pc-a] SimplySign Desktop running, session expired:
  // the certificate is listed with HasPrivateKey = True (the cert() answer below
  // is exactly what certificateState read), and the old preflight said "signer
  // ready". Opening the key never answered within 20 s (180 s tried). The bare
  // CryptAcquireContext answered 0x80090001 after ~60 s. Both shapes must refuse.
  const stale = { keyHost: () => true, cert: () => ({ state: 'present', hasPrivateKey: true, notAfter: '2027-10-21T05:27:33Z' }) };
  const timedOut = pf({ ...stale, key: () => ({ state: 'timeout', ms: 20000 }) });
  assertTrue(timedOut.ok === false && timedOut.problem === 'key-unreachable' && /log in/.test(timedOut.message) && /FLOWMIC_WINDOWS_SIGN=off/.test(timedOut.message),
    'REVERSE: cert listed with HasPrivateKey but the key does not answer ⇒ refused (key-unreachable), says log in, names the opt-out');
  const refused = pf({ ...stale, key: () => ({ state: 'refused', code: '0x80090001', ms: 60189 }) });
  assertTrue(refused.ok === false && refused.problem === 'key-unreachable' && /0x80090001/.test(refused.message),
    'REVERSE: cert listed with HasPrivateKey but the key open fails ⇒ refused, with the provider\'s code');
  assertTrue(pf({ key: () => ({ state: 'unknown', detail: 'Add-Type failed' }) }).problem === 'key-probe-unknown', 'a probe that cannot run refuses (cannot tell ≠ ready)');
  assertTrue(pf({ key: () => ({ state: 'absent' }) }).problem === 'cert-missing', 'certificate gone by the time the key is probed ⇒ cert-missing');
  let keyAsked = false;
  pf({ cert: () => ({ state: 'present', hasPrivateKey: false }), key: () => { keyAsked = true; return { state: 'ok', ms: 1 }; } });
  assertTrue(!keyAsked, 'the key is not probed when the store already says there is no private key (cheaper answers first)');
  assertTrue(/private key opened/.test(pf({}).message) && /nothing signed/.test(pf({}).message), 'the ready line says the key was opened and that nothing was signed');
  assertTrue(signingConfig({}).keyProbeTimeoutMs === 20000 && signingConfig({ FLOWMIC_SIGN_KEY_PROBE_TIMEOUT_MS: '45000' }).keyProbeTimeoutMs === 45000,
    'key-probe timeout defaults to 20 s and FLOWMIC_SIGN_KEY_PROBE_TIMEOUT_MS overrides it');
  threw = false; try { signingConfig({ FLOWMIC_SIGN_KEY_PROBE_TIMEOUT_MS: '20s' }); } catch { threw = true; }
  assertTrue(threw, 'a key-probe timeout that is not whole milliseconds is refused');
  assertTrue(preflightSigner(cfg, { platform: 'darwin', probe: probe({}) }).problem === 'not-windows', 'non-Windows host ⇒ not-windows');
  assertTrue(classifySignFailure('SignTool Error: The specified timestamp server either could not be reached or returned an invalid response.') === 'timestamp', 'TSA failure ⇒ try the next URL');
  assertTrue(classifySignFailure('SignTool Error: No certificates were found that met all the given criteria.') === 'key', 'certificate/key failure ⇒ stop, it is not the URL');
  assertTrue(isFlowMicSignTarget('C:\\t\\release\\flowmic-desktop.exe') && isFlowMicSignTarget('bundle/msi/FlowMic_0.3.118_x64_en-US.msi'),
    'the product exe and the MSIs are signable');
  assertTrue(!isFlowMicSignTarget('target\\release\\wix\\x64\\wix\\WixUIExtension.dll') && !isFlowMicSignTarget('wix/WixUtilExtension.dll'),
    'REVERSE: the two WiX build-tool copies Tauri hands to signCommand are declined');
}

console.log('§6 wiring: tauri.windows.conf.json');
{
  const base = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const win = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.windows.conf.json'), 'utf8'));
  const desktop = join(ROOT, 'apps', 'desktop');
  assertTrue(win.build.beforeBuildCommand === `node ../../scripts/sign-windows.mjs --check && ${base.build.beforeBuildCommand}`,
    'the Windows beforeBuildCommand is the signer preflight followed by the base command, verbatim (a drifted copy would silently skip the frontend build)');
  assertTrue(/sign-windows\.mjs --resources src-tauri\/resources$/.test(win.build.beforeBundleCommand), 'beforeBundleCommand signs src-tauri/resources');
  assertTrue(base.bundle.resources.every((r) => r.startsWith('resources/')), 'every bundled resource lives under resources/, so that one directory covers them all');
  const hookScript = win.build.beforeBundleCommand.split(' ')[1];
  assertTrue(resolve(desktop, hookScript) === join(ROOT, 'scripts', 'sign-windows.mjs'), 'hooks run in apps/desktop (measured) and their path resolves to the script');
  const sc = win.bundle.windows.signCommand;
  assertTrue(sc.cmd === 'node' && sc.args.includes('%1'), 'signCommand passes Tauri\'s %1');
  assertTrue(resolve(desktop, 'src-tauri', sc.args[0]) === join(ROOT, 'scripts', 'sign-windows.mjs'),
    'signCommand runs in apps/desktop/src-tauri (measured: "../../" failed with Cannot find module) and its path resolves to the script');
  assertTrue(!('signCommand' in (base.bundle.windows ?? {})), 'the base config has no signCommand, so macOS/Linux builds never see one');
  const chain = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).scripts['tauri:build'];
  const tb = chain.indexOf('tauri build --features app');
  const after = chain.indexOf('node ../../scripts/sign-windows.mjs --after-tauri-build');
  const vb = chain.indexOf('node scripts/verify-bundle.mjs');
  assertTrue(tb !== -1 && after > tb && after < vb,
    'tauri:build re-signs the exe AFTER `tauri build` (Tauri restores the unsigned binary once bundling ends, measured) and before verify-bundle');
}

console.log('§7 wiring: publish.mjs (as text) and adopt-artifact.mjs');
{
  const src = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8');
  const g1 = src.indexOf('msis: msis.map((f) => join(BUNDLE, f))');
  const clean = src.indexOf('── clean + recreate');
  const stageMsi = src.indexOf('const staged = msis.map((f) => stage(join(BUNDLE, f), OUT));');
  const g2 = src.indexOf("trees: [{ dir: PORTABLE, label: 'FlowMic-portable', mainExe: PORTABLE_MAIN_EXE }]");
  const pack = src.indexOf('publishPortableArchive({ root: ROOT');
  const linuxBranch = src.indexOf("if (process.platform === 'linux') {");
  assertTrue(g1 > linuxBranch && g1 < clean && clean < stageMsi, 'the MSI/exe/resources gate runs on the Windows branch, before publish/ is cleared and before any MSI is staged');
  assertTrue(g2 > stageMsi && g2 < pack, 'the portable tree is gated after it is assembled and before it is zipped');
  assertTrue((src.match(/\)\) process\.exit\(1\);/g) ?? []).length >= 2 && /verifyWindowsArtifactsSigned\(\{[\s\S]*?\}\)\) process\.exit\(1\)/.test(src), 'both gate calls exit on refusal');
  assertTrue(MSI_MAIN_EXE === 'flowmic-desktop.exe' && PORTABLE_MAIN_EXE === 'FlowMic.exe', 'main exe names match what Tauri and publish.mjs produce');

  const scratch = mkdtempSync(join(tmpdir(), 'it19-adopt-'));
  try {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fixture zip, not a real archive')]);
    const src9 = join(scratch, 'FlowMic-9.9.9-portable-windows-x64.zip');
    writeFileSync(src9, zip);
    const hash = (await import('node:crypto')).createHash('sha256').update(zip).digest('hex');
    let refused = '';
    try {
      adoptArtifact({ sourcePath: src9, attestedSha256: hash, version: '9.9.9', outDir: join(scratch, 'out'), dryRun: true,
        verifyWindowsZip: ({ fail }) => { fail('FlowMic.exe — it has no Authenticode signature'); return false; } });
    } catch (e) { refused = e.message; }
    assertTrue(/not a fully signed Windows bundle/.test(refused) && /no Authenticode signature/.test(refused), 'REVERSE: adopt refuses a Windows zip the signature gate rejects, quoting why');
    let calls = 0;
    const r = adoptArtifact({ sourcePath: src9, attestedSha256: hash, version: '9.9.9', outDir: join(scratch, 'out'), dryRun: true,
      verifyWindowsZip: () => { calls += 1; return true; } });
    assertTrue(r.dryRun && calls === 1, 'adopt asks the gate exactly once and proceeds when it passes');
    const mac = join(scratch, 'FlowMic-9.9.9-portable-macos-arm64.zip');
    writeFileSync(mac, zip);
    calls = 0;
    adoptArtifact({ sourcePath: mac, attestedSha256: hash, version: '9.9.9', outDir: join(scratch, 'out'), dryRun: true, verifyWindowsZip: () => { calls += 1; return false; } });
    assertTrue(calls === 0, 'a macOS zip is not sent through the Windows gate (non-Windows artifacts unaffected)');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failedCount} failed`);
process.exit(failedCount === 0 ? 0 : 1);
