// verify/lint/node-version-pin.mjs
// Lint 13/13 — `.node-version` must agree with the bundled-Node declaration.
//
// WHY THIS FILE EXISTS (measured 2026-08-07, first responsible party):
// `apps/desktop/scripts/build-sidecar.mjs` stages the Node that RUNS it as the
// runtime we ship. CI's runner had v22.23.2, so CI staged v22.23.2 while
// `scripts/vendor/bundled-node.mjs` declares v22.22.3 — and `it27-publish-node-pin`
// caught it on the byte count (86,997,320 vs 86,969,160). The build script now
// refuses a mismatch outright, which turns that into a build failure rather than a
// silently different artifact; this lint closes the other half.
//
// The other half: to make CI build with the declared runtime, `.node-version`
// exists for `actions/setup-node`. That file is a COPY of a number that already
// has an owner, and this repo's whole version discipline exists because copies of
// version numbers drift (CLAUDE.md: "a number that changes on every commit, written into a contract file, is a truth whose shelf life is measured in hours"). So the copy is pinned to its source here rather than
// trusted to a comment asking people to remember.
//
// 🔴 WHY NOT DELETE `.node-version` AND HAVE CI READ THE DECLARATION DIRECTLY:
// `actions/setup-node` reads a file, not a JS module — it cannot import an .mjs
// that exports an object keyed by platform. The copy is forced by the tool; what
// is not forced is letting it rot.
//
// 🔴 IF YOU ARE READING THIS ON A MAC OR ON LINUX, START HERE (MAC-lint-1).
// This gate says `win32-x64` on every platform, and that is correct, not a
// missing platform branch. It compares two things that are BOTH about CI's
// runner: `.node-version` (read only by `actions/setup-node`) and the pin for
// the platform that runner builds on. Neither of them describes the machine
// running this lint. A mac reader was measured on 2026-08-10 concluding the
// opposite and filing it as a defect — the sentence it printed was true, it
// simply answered a different question than the one being asked, so the PASS
// detail below now names whose pin it checked.
//
// ⚠️ Do NOT "fix" this by keying off `process.platform`: that would make the
// gate check a pin CI never uses, i.e. it would go green while the runner built
// with a Node we do not ship — the exact defect this file was created for.
// The darwin/linux pins are not unguarded; `verify-bundle.mjs` checks them
// per-platform by EXECUTING the staged binary (measured on the Mac mini the
// same day: `IS the pinned darwin-arm64 runtime`).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT as root } from './_util.mjs';

export default async function nodeVersionPin() {
  const file = join(root, '.node-version');
  if (!existsSync(file)) {
    return {
      status: 'FAIL',
      detail: '.node-version is missing — CI pins the runner to it (see .github/workflows/verify.yml)',
    };
  }
  const declaredMod = await import(
    `file:///${join(root, 'scripts', 'vendor', 'bundled-node.mjs').replace(/\\/g, '/')}`
  );
  // The Windows pin is the reference: it is the platform CI runs on and the one
  // the MSI ships. A mac/linux runner would need its own file, and would then
  // need its own line here — deliberately not pre-invented for a runner that
  // does not exist (the same posture verify.yml's header takes about platforms).
  const declared = declaredMod.BUNDLED_NODE['win32-x64'];
  if (!declared?.version) {
    return { status: 'FAIL', detail: 'scripts/vendor/bundled-node.mjs declares no win32-x64 pin' };
  }
  const want = declared.version.replace(/^v/, '');
  const got = readFileSync(file, 'utf8').trim();
  if (got !== want) {
    return {
      status: 'FAIL',
      detail:
        `.node-version=${got} but the declared bundled runtime is v${want} ` +
        '(scripts/vendor/bundled-node.mjs). CI would build with a Node we do not ship, ' +
        'and NOTICE reproduces the DECLARED build\'s LICENSE. Regenerate the file from the declaration.',
    };
  }
  // Naming CI explicitly is the whole point: the old wording ("matches the
  // declared win32-x64 pin") is true on a mac too, and was read there as this
  // gate having checked the wrong platform. See the MAC-lint-1 note above.
  return {
    status: 'PASS',
    detail: `.node-version=${got} matches the declared win32-x64 pin (CI's runner, not this machine)`,
  };
}
