// IT-19 live drill: the signature gate against REAL signtool verdicts on real
// files, without our certificate and without signing anything.
//
// Fixtures are copies of signtool.exe itself (Microsoft-signed, timestamped)
// and a copy with its certificate table cut off (unsigned). That is enough to
// drive every gate branch that does not need our certificate: a third-party
// signature on the product exe (wrong-signer), an unsigned PE in the tree, and
// a clean tree. The verdicts that need our certificate or a self-signed one
// are drilled from captured output in it19-windows-signature-gate.test.mjs,
// and were measured end to end on a real MSI (card IT-19 report).
//
// EXIT CODES (scripts/run-script-tests.mjs): 0 PASS, 1 FAIL, 2 SKIP off Windows
// or without signtool — this file verifies nothing there, and says so.
//
// Run: node scripts/it19-windows-signature-gate-live.test.mjs

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findSigntool, stripAuthenticode } from './windows-signing.mjs';
import { PORTABLE_MAIN_EXE, runVerifierControls, verifyWindowsArtifactsSigned } from './windows-signature-gate.mjs';

if (process.platform !== 'win32') {
  console.log(`SKIP: Authenticode verification needs Windows signtool; this host is ${process.platform}`);
  process.exit(2);
}
const st = findSigntool();
if (!st) {
  console.log('SKIP: signtool.exe not found (Windows SDK signing tools not installed)');
  process.exit(2);
}

let passed = 0;
let failedCount = 0;
function assertTrue(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failedCount += 1; console.error(`  ✗ ${msg}`); }
}

const root = mkdtempSync(join(tmpdir(), 'it19-live-'));
try {
  const gate = (trees) => {
    const fails = [];
    const good = verifyWindowsArtifactsSigned({ trees, scratchRoot: join(root, 'scratch'), fail: (m) => fails.push(m), ok: () => {} });
    return { good, fails };
  };
  const tree = (name, files) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [rel, make] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      make(join(dir, rel));
    }
    return dir;
  };
  const signed = (p) => copyFileSync(st.path, p);
  const unsigned = (p) => writeFileSync(p, stripAuthenticode(readFileSync(st.path)));
  const notPe = (p) => writeFileSync(p, 'console.log("not a PE");');

  console.log(`signtool: ${st.path} (${st.how})`);
  const controls = runVerifierControls(st.path, join(root, 'controls'));
  assertTrue(controls.ok, `real verifier controls pass — ${controls.line}`);

  const clean = gate([{ dir: tree('clean', { 'helper.exe': signed, 'addon.js': notPe }), label: 'clean' }]);
  assertTrue(clean.good && clean.fails.length === 0, 'a tree whose only PE is validly signed + timestamped passes; a .js beside it is not a PE');

  const withUnsigned = gate([{ dir: tree('unsigned', { 'helper.exe': signed, 'lib/inner.dll': unsigned }), label: 'unsigned' }]);
  assertTrue(!withUnsigned.good && withUnsigned.fails.some((m) => /lib\/inner\.dll — it has no Authenticode signature/.test(m)),
    'REVERSE: one unsigned PE nested in the tree refuses the whole tree, by name');

  const thirdPartyMain = gate([{ dir: tree('main', { [PORTABLE_MAIN_EXE]: signed }), label: 'portable', mainExe: PORTABLE_MAIN_EXE }]);
  assertTrue(!thirdPartyMain.good && thirdPartyMain.fails.some((m) => /FlowMic\.exe — it is validly signed, but not with our certificate/.test(m)),
    'REVERSE: a FlowMic.exe carrying someone else\'s valid signature is refused (wrong-signer, real Microsoft chain)');

  const noMain = gate([{ dir: tree('nomain', { 'helper.exe': signed }), label: 'portable', mainExe: PORTABLE_MAIN_EXE }]);
  assertTrue(!noMain.good && noMain.fails.some((m) => /FlowMic\.exe is not a PE file/.test(m)),
    'REVERSE: a portable tree without its exe is refused as BLIND, not passed as "nothing unsigned"');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failedCount} failed`);
process.exit(failedCount === 0 ? 0 : 1);
