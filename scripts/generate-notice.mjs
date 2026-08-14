#!/usr/bin/env node
// Third-party NOTICE generator (card L4).
//
//   node scripts/generate-notice.mjs             generate/overwrite ./NOTICE + apps/desktop/public/NOTICE
//   node scripts/generate-notice.mjs --check      compare only, do not write; drift ⇒ exit 1 (publish.mjs uses this as its gate)
//
// WHY THIS EXISTS (measured defect, not a guess):
//   apps/desktop/scripts/build-sidecar.mjs bundles apps/server-core's whole
//   production dependency closure into one server.js via esbuild, with
//   `legalComments: 'none'` — which actively deletes whatever MIT header
//   comments those packages carry. That line is the bug this file's sibling
//   fix (build-sidecar.mjs's legalComments flip) partially addresses — but
//   NOT completely: a throwaway test build with `legalComments: 'eof'`
//   (scratch, discarded) showed esbuild only captures comments that already
//   look like a license banner in the SOURCE FILES it touches. Result,
//   grepped from that test bundle:
//     - socket.io  → 1 line  ("Copyright (c) 2014-present Guillermo Rauch…")
//     - ws         → 1 line  ("Copyright (c) 2011 Einar Otto Stangvik…")
//     - zod        → 0 lines (ships no such banner in its source at all)
//   None of those are the FULL MIT license text (the permission grant + the
//   warranty disclaimer are never in a source-code comment to begin with).
//   So `legalComments` is flipped back on in build-sidecar.mjs as a harmless
//   defense-in-depth measure (it costs nothing; minify is already off for
//   stack-trace readability), but it is NOT the compliance mechanism. THIS
//   script is: it reads each bundled dependency's actual LICENSE file off
//   disk and reproduces it in full, which is the only way to satisfy "ship
//   the license text" for a dependency (zod) that carries no such text in
//   its code at all.
//
// SCOPE — four sections, matched 1:1 to
//   docs/strategy/2026-08-04-third-party-license-matrix.md §6.2:
//   1. The sidecar's bundled npm production dependencies (MIT, ~19 packages
//      — resolved from apps/server-core's dependency graph, not hardcoded,
//      so a future `pnpm add` in that package cannot silently fall out of
//      this NOTICE without at least changing the generated file's diff).
//   2. Node.js (bundled as node.exe with both the MSI and the portable
//      one-click bundle) — MIT core + ~18-20 embedded third-party notices.
//      Which runtime, and therefore which license text, comes from the
//      committed declaration in scripts/vendor/bundled-node.mjs; this script
//      NEVER executes the staged binary (see that file's header for the
//      measured defect that rule exists for). The license text is vendored
//      locally rather than fetched at generation time: a NOTICE generator that
//      needs network access to produce a deterministic file is itself a defect
//      waiting to happen on an offline build box.
//   3. sherpa-onnx-node / sherpa-onnx-win-x64 (Apache-2.0) — upstream ships
//      NEITHER package with a LICENSE/NOTICE file, and the upstream repo
//      itself has no NOTICE file (confirmed 404 by the license audit), so
//      Apache-2.0 §4(a)'s "include a copy of the License" falls to us.
//      Recorded HONESTLY as NOT currently present in any artifact FlowMic
//      ships today (verified below, in the section text itself) — this is
//      forward-looking, not a correction of a live gap.
//   4. The SenseVoice ASR model (downloaded at runtime, never bundled) —
//      recorded as what it actually is: a custom, non-OSI "FunASR Model
//      Open Source License Agreement", NOT Apache-2.0, with an attribution
//      duty and a denigration-forfeiture clause. Flagged for owner sign-off.
//      Do not "fix" this by relabeling it Apache-2.0 — that would be the
//      exact false statement this file exists to prevent.
//   Plus one negative record: WebView2 is NOT included, because FlowMic
//   does not redistribute it (tauri.conf.json sets no `webviewInstallMode`,
//   so Tauri 2 defaults to `downloadBootstrapper` — no Microsoft binary
//   ships in our package). Written down so nobody adds a redistribution
//   notice later for something we still are not shipping.
//
// WIRING — how this cannot be forgotten:
//   - scripts/publish.mjs runs `generate-notice.mjs --check` as a gate
//     before it assembles anything (fails the publish, no bypass, same
//     posture as its `verify:delivery` gate).
//   - apps/desktop/scripts/build-sidecar.mjs copies the committed ./NOTICE
//     into apps/desktop/public/NOTICE (a static asset vite already knows to
//     carry into dist/, which Tauri already embeds into the exe — no
//     tauri.conf.json / Rust / capabilities change needed) and refuses to
//     stage the sidecar if ./NOTICE is missing entirely.
//   - apps/desktop/scripts/verify-bundle.mjs asserts the embedded copy
//     actually made it into dist/ after the frontend build.
//
// The generated ./NOTICE is a COMMITTED file (like pnpm-lock.yaml), not a
// gitignored build output — scripts/opensource-export.mjs copies git-tracked
// files verbatim into the open-source export tree, so an untracked NOTICE
// would silently never reach that tree. Re-run this script and commit the
// diff whenever apps/server-core's dependencies change, or whenever
// scripts/vendor/bundled-node.mjs pins a different runtime. Nothing about
// THIS machine can change the output: two checkouts of the same commit
// generate the same bytes, which is the whole point of the declaration.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_NODE } from './vendor/bundled-node.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_CORE_DIR = join(ROOT, 'apps', 'server-core');
const NOTICE_PATH = join(ROOT, 'NOTICE');
const DESKTOP_PUBLIC_NOTICE = join(ROOT, 'apps', 'desktop', 'public', 'NOTICE');

const VENDOR = join(ROOT, 'scripts', 'vendor');
// There is deliberately no NODE_LICENSE_VERSION / NODE_LICENSE_FILE constant
// here any more, and this script no longer touches the staged node.exe at all.
// Both the version and the vendored license filename come from
// scripts/vendor/bundled-node.mjs, per platform. The version used to be a
// hand-maintained string compared against `node.exe -v` with a warn-on-drift
// message; that design's failure mode was not "someone ignores the warning",
// it was that the version actually WRITTEN into the committed NOTICE came from
// executing a gitignored binary, so the committed file said whatever the build
// machine had installed. Enforcement moved to the other end, where it can be
// hard without being annoying: apps/desktop/scripts/verify-bundle.mjs fails the
// build when the staged binary is not the declared one.
const SHERPA_LICENSE_FILE = join(VENDOR, 'sherpa-onnx-LICENSE-apache-2.0.txt');
const FUNASR_LICENSE_FILE = join(VENDOR, 'funasr-MODEL_LICENSE.txt');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');

const req = createRequire(import.meta.url);

// ── ① resolve the sidecar's bundled npm production dependency closure ──────
// Mirrors what esbuild actually pulls into server.js: everything reachable
// from apps/server-core's OWN "dependencies" (never devDependencies —
// esbuild never sees those), recursing into each dependency's own
// "dependencies" the same way, via real Node module resolution (so this
// tracks whatever pnpm actually installed, not a hand-maintained list).
//
// Two exclusions, both explained rather than silently applied:
//   - `@flowmic/protocol` is FlowMic's OWN workspace package (Apache-2.0 by
//     owner's ruling), not a third party — skipped from the notice list,
//     but still walked INTO for its own deps (zod).
//   - `@types/*` and `undici-types` are TypeScript ambient declaration
//     packages: pure .d.ts, never `require`d or `import`ed by anything at
//     runtime, so esbuild's bundler never touches their code and they never
//     reach server.js. Listing them here would be padding the NOTICE with
//     packages nothing was ever obligated to attribute.
const SKIP_SELF = new Set(['@flowmic/protocol']);
const isTypesOnly = (name) => name.startsWith('@types/') || name === 'undici-types';

function resolvePkgJson(specifier, fromDir) {
  try {
    return req.resolve(`${specifier}/package.json`, { paths: [fromDir] });
  } catch (e) {
    // Some packages (e.g. @flowmic/protocol, which has a strict `exports`
    // map) refuse the `./package.json` subpath outright. Fall back to
    // resolving the package's actual entry point and walking up from there
    // to the nearest package.json — still the real installed package, just
    // reached a different way.
    if (e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e;
    // Walk up from the resolved entry file looking for the package's REAL
    // top-level package.json — not one of the minimal `{"type":"commonjs"}`
    // stub package.json files some dual ESM/CJS packages (engine.io-parser,
    // socket.io-parser, ...) drop inside a `build/cjs/` subdirectory purely
    // to set module type. A stub has no matching `name`, so it is skipped.
    let dir = dirname(req.resolve(specifier, { paths: [fromDir] }));
    for (;;) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const j = JSON.parse(readFileSync(candidate, 'utf8'));
        // Require BOTH name and version to match/exist: a stub carries a
        // `name` (for editor tooling) but never a `version`, which is what
        // distinguishes it from the package's real root manifest.
        if (j.name === specifier && j.version) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) throw e; // hit filesystem root — give up with the original error
      dir = parent;
    }
  }
}

function findLicenseFile(pkgDir) {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'license', 'license.md', 'license.txt'];
  for (const c of candidates) {
    const p = join(pkgDir, c);
    if (existsSync(p)) return p;
  }
  return null;
}

function collectDeps(pkgJsonPath, visited, out, missing) {
  const dir = dirname(pkgJsonPath);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const id = `${pkg.name}@${pkg.version}`;
  if (visited.has(id)) return;
  visited.add(id);
  if (!SKIP_SELF.has(pkg.name)) {
    const licenseFile = findLicenseFile(dir);
    out.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? '(package.json declares none)',
      licenseFile,
      licenseText: licenseFile ? readFileSync(licenseFile, 'utf8') : null,
    });
    if (!licenseFile) missing.push(id);
  }
  for (const depName of Object.keys(pkg.dependencies ?? {})) {
    if (isTypesOnly(depName)) continue;
    try {
      collectDeps(resolvePkgJson(depName, dir), visited, out, missing);
    } catch (e) {
      missing.push(`${depName} (required by ${id}, could not resolve: ${e.code ?? e.message})`);
    }
  }
}

function collectSidecarDeps() {
  const serverPkgPath = join(SERVER_CORE_DIR, 'package.json');
  const serverPkg = JSON.parse(readFileSync(serverPkgPath, 'utf8'));
  const visited = new Set([`${serverPkg.name}@${serverPkg.version}`]); // don't list server-core itself, it's FlowMic
  const out = [];
  const missing = [];
  for (const depName of Object.keys(serverPkg.dependencies ?? {})) {
    if (SKIP_SELF.has(depName)) {
      // still walk into it for its own deps (zod), just don't list it
      collectDeps(resolvePkgJson(depName, SERVER_CORE_DIR), visited, out, missing);
      continue;
    }
    collectDeps(resolvePkgJson(depName, SERVER_CORE_DIR), visited, out, missing);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { deps: out, missing };
}

// ── ② compose the NOTICE text ───────────────────────────────────────────────
const BAR = '='.repeat(78);
function section(title, body) {
  return `${BAR}\n${title}\n${BAR}\n\n${body.trim()}\n`;
}

/** Group the per-platform pins by the vendored LICENSE file each one cites, so
 *  the text is reproduced once per distinct file rather than once per platform.
 *  Refuses to let two different Node versions share one vendored file: the text
 *  is fetched for a specific tag, and quietly reusing it for another version
 *  would put a provenance URL in the NOTICE that does not describe the bytes
 *  below it — the exact class of false statement this generator exists to
 *  prevent. A platform pinned to a different patch release vendors its own. */
function nodeLicenseSources() {
  const byFile = new Map();
  for (const [platform, d] of Object.entries(BUNDLED_NODE)) {
    const cur = byFile.get(d.licenseFile);
    if (!cur) {
      byFile.set(d.licenseFile, { file: d.licenseFile, version: d.version, platforms: [platform] });
      continue;
    }
    if (cur.version !== d.version) {
      throw new Error(
        `generate-notice: scripts/vendor/${d.licenseFile} is claimed by two different Node versions ` +
          `(${cur.platforms.join(', ')} -> ${cur.version}; ${platform} -> ${d.version}). ` +
          `Vendor a separate LICENSE file for ${d.version} and point that platform's licenseFile at it.`,
      );
    }
    cur.platforms.push(platform);
  }
  return [...byFile.values()];
}

const groupDigits = (n) => n.toLocaleString('en-US');

function buildNotice() {
  const { deps, missing } = collectSidecarDeps();
  if (missing.length) {
    throw new Error(
      `generate-notice: ${missing.length} sidecar dependency issue(s) — refusing to write a NOTICE ` +
        `that would silently omit a license:\n` + missing.map((m) => `  - ${m}`).join('\n'),
    );
  }
  const nonMit = deps.filter((d) => !/^MIT$/i.test(String(d.license)));
  if (nonMit.length) {
    throw new Error(
      `generate-notice: ${nonMit.length} sidecar dependency declares a NON-MIT license — ` +
        `this generator's per-dependency section assumes MIT and needs a human to look at these ` +
        `before they can be folded in silently:\n` +
        nonMit.map((d) => `  - ${d.name}@${d.version} -> ${d.license}`).join('\n'),
    );
  }

  const header = `FlowMic — third-party NOTICE
Generated by scripts/generate-notice.mjs. Do not hand-edit; re-run the
generator and commit the diff instead (it will tell you if a dependency's
license changed under it).

FlowMic itself is licensed AGPL-3.0-only (see ./LICENSE), except for
packages/protocol, which the owner carved out as Apache-2.0 (see
packages/protocol/LICENSE). Everything below is attribution for OTHER
projects' code/binaries that FlowMic bundles, links against, or — for the
SenseVoice model — points a downloader at.
`;

  const sidecarDepsBody = deps
    .map((d) => `--- ${d.name}@${d.version} (MIT) ---\n\n${d.licenseText.trim()}\n`)
    .join('\n');
  const sidecarSection = section(
    `1. Node.js sidecar bundled dependencies (${deps.length} packages, all MIT)\n` +
      'Bundled by apps/desktop/scripts/build-sidecar.mjs (esbuild) into a single\n' +
      'server.js shipped with both the MSI installer and the FlowMic-portable\n' +
      'bundle. Resolved from apps/server-core\'s production dependency graph — see\n' +
      'this file\'s own header for how and why (esbuild legalComments cannot do\n' +
      'this reliably; zod ships no license banner in its source at all).',
    sidecarDepsBody,
  );

  const pinnedRuntimes = Object.entries(BUNDLED_NODE)
    .map(
      ([platform, d]) =>
        `  ${platform}: ${d.version}\n` +
        `    sha256 ${d.sha256}\n` +
        `    ${groupDigits(d.bytes)} bytes, staged at ${d.stagedPath}`,
    )
    .join('\n');
  const nodeLicenseBodies = nodeLicenseSources()
    .map(
      (s) =>
        `Vendored verbatim for ${s.version} (${s.platforms.join(', ')}) from\n` +
        `https://raw.githubusercontent.com/nodejs/node/${s.version}/LICENSE\n` +
        `(scripts/vendor/${s.file}):\n\n` +
        readFileSync(join(VENDOR, s.file), 'utf8').trim(),
    )
    .join('\n\n');
  const nodeSection = section(
    '2. Node.js runtime (node.exe, bundled with both the MSI installer and\n' +
      'the FlowMic-portable one-click bundle)',
    `Pinned runtime, per platform (owner ruling 2026-08-05: the bundled Node stays\n` +
      `on the 22 line):\n\n${pinnedRuntimes}\n\n` +
      `Those values are declared in scripts/vendor/bundled-node.mjs and read from\n` +
      `there. This generator does NOT execute the staged binary: ./NOTICE is a\n` +
      `committed file, and a committed file whose content depends on what a build\n` +
      `machine happens to have installed says different things in two checkouts of\n` +
      `the same commit (it did — see that file's header). The reciprocal half, so\n` +
      `that this is a description and not a hope, lives in\n` +
      `apps/desktop/scripts/verify-bundle.mjs: it runs the staged binary, and fails\n` +
      `the build if its version, size or sha256 is not the declared one.\n\n` +
      'Node.js core is MIT-licensed; the same LICENSE file bundles the licenses of\n' +
      '~18-20 embedded third-party components (V8, ICU, OpenSSL, zlib, c-ares,\n' +
      'llhttp, libuv, undici, corepack, Acorn, LIEF, SWC, Punycode.js, and others) —\n' +
      'all permissive (MIT/BSD/Apache-2.0/zlib/Unicode-3.0/public-domain), no GPL/\n' +
      `LGPL component.\n\n` +
      nodeLicenseBodies,
  );

  const sherpaSection = section(
    "3. sherpa-onnx-node / sherpa-onnx-win-x64 (Apache-2.0) — the built-in\n" +
      'local STT engine\'s ("sherpa-local", 7th engine) native inference binary',
    `STATUS (verified 2026-08-04): NOT included in any artifact FlowMic currently\n` +
      `ships.\n` +
      `  - apps/desktop/src-tauri/tauri.conf.json bundle.resources lists exactly\n` +
      `    resources/server.js, resources/package.json, resources/node.exe — no\n` +
      `    sherpa binaries.\n` +
      `  - scripts/publish.mjs's portable-bundle stage copies the same three\n` +
      `    files and nothing sherpa-related.\n` +
      `  - apps/server-core/Dockerfile's runtime stage installs only socket.io by\n` +
      `    default; sherpa-onnx-node is NOT installed unless a self-hoster opts in\n` +
      `    manually (the Dockerfile says so in its own header comment).\n` +
      `\`sherpa-onnx-node\` is a real optionalDependency of apps/server-core\n` +
      `though (package.json, pnpm-lock.yaml), so anyone building the open-source\n` +
      `tree from source with \`pnpm install\` does pull it from the public npm\n` +
      `registry — this section exists for that case, and in case the native-\n` +
      `binary staging gap above ever gets closed in a later round.\n\n` +
      `LICENSE: Apache-2.0. Neither the sherpa-onnx-node nor the\n` +
      `sherpa-onnx-win-x64 npm package ships a LICENSE or NOTICE file, and the\n` +
      `upstream k2-fsa/sherpa-onnx repository has no NOTICE file either (confirmed\n` +
      `404 by the license audit,\n` +
      `docs/strategy/2026-08-04-third-party-license-matrix.md §3.3). Apache-2.0\n` +
      `§4(a) still requires a copy of the license text to travel with any\n` +
      `distribution of the Work; vendored verbatim below from\n` +
      `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/LICENSE\n` +
      `(scripts/vendor/sherpa-onnx-LICENSE-apache-2.0.txt).\n\n` +
      `Copyright: the k2-fsa contributors. Project:\n` +
      `https://github.com/k2-fsa/sherpa-onnx\n\n` +
      `Also embedded inside the sherpa-onnx-win-x64 native binary: Microsoft's\n` +
      `ONNX Runtime (onnxruntime.dll), MIT-licensed — not independently verified\n` +
      `against the exact bundled build (matrix §3.3), but the project overall is\n` +
      `public and MIT, so the risk is assessed as low.\n\n` +
      readFileSync(SHERPA_LICENSE_FILE, 'utf8').trim(),
  );

  const senseVoiceSection = section(
    '4. SenseVoice ASR model (used by the built-in "sherpa-local" engine) — NOT\n' +
      'Apache-2.0, OWNER SIGN-OFF REQUIRED',
    `STATUS: NOT bundled or redistributed by FlowMic. Downloaded on demand, by the\n` +
      `end user's own client, the first time the built-in local recognition engine\n` +
      `is enabled (see apps/server-core/src/stt/sherpa/model-manifest.ts and\n` +
      `model-downloader.ts). Sources: Hugging Face (csukuangfj/sherpa-onnx-sense-\n` +
      `voice-zh-en-ja-ko-yue-2024-07-17), a China mirror (hf-mirror.com) of the\n` +
      `same repo, and a GitHub release tarball fallback.\n\n` +
      `🔴 THIS IS NOT APACHE-2.0, and it is NOT an OSI-approved open-source\n` +
      `license, even though sherpa-onnx (the inference ENGINE, §3 above) is\n` +
      `genuinely Apache-2.0 — the engine's code license and the model WEIGHTS'\n` +
      `license are two separate things that happen to travel together. The model\n` +
      `is Alibaba Group / FunASR's SenseVoice-small, distributed under a custom\n` +
      `"FunASR Model Open Source License Agreement" (v1.1), which:\n` +
      `  - permits free use, copying, modification, and sharing;\n` +
      `  - REQUIRES attribution — source and author information must be kept,\n` +
      `    and the model's name must be retained;\n` +
      `  - carries a non-standard behavioral clause: "unjustified denigration,\n` +
      `    malicious smearing, or baseless insults" against FunASR triggers\n` +
      `    "automatic forfeiture of all licenses granted";\n` +
      `  - disclaims all warranty; has no copyleft/share-alike requirement.\n\n` +
      `🔴 OWNER SIGN-OFF REQUIRED: the forfeiture clause has not been legally\n` +
      `reviewed for enforceability or for its practical effect on a public\n` +
      `product that will be reviewed/criticized by users and press. Do not\n` +
      `describe this model as Apache-2.0 or "open source" in any UI/marketing\n` +
      `copy until an owner has looked at this section.\n\n` +
      `Upstream model card: https://huggingface.co/FunAudioLLM/SenseVoiceSmall\n` +
      `Full license text, vendored verbatim (bilingual, as published) from\n` +
      `https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE\n` +
      `(scripts/vendor/funasr-MODEL_LICENSE.txt):\n\n` +
      readFileSync(FUNASR_LICENSE_FILE, 'utf8').trim(),
  );

  const webview2Section = section(
    '5. Microsoft Edge WebView2 Runtime — deliberately NOT included here',
    `FlowMic's apps/desktop/src-tauri/tauri.conf.json sets no \`webviewInstallMode\`\n` +
      `under \`bundle.windows.wix\`/\`nsis\`, so Tauri 2 uses its default,\n` +
      `\`downloadBootstrapper\`: the installer carries only Microsoft's small\n` +
      `bootstrapper executable, which fetches the real WebView2 Runtime from\n` +
      `Microsoft's own servers at install time (or reuses the Evergreen runtime\n` +
      `already present on most Windows 10 1803+ / Windows 11 machines). FlowMic\n` +
      `does not embed, ship, or redistribute the WebView2 binary itself, so no\n` +
      `Microsoft redistribution notice belongs here. If a future change switches\n` +
      `to \`offlineInstaller\` or \`fixedVersion\` (which DO embed the runtime),\n` +
      `this section must be revisited — see\n` +
      `docs/strategy/2026-08-04-third-party-license-matrix.md §5.4.`,
  );

  return [header, sidecarSection, nodeSection, sherpaSection, senseVoiceSection, webview2Section].join('\n');
}

// ── ③ write or check ────────────────────────────────────────────────────────
function main() {
  const generated = buildNotice();

  if (CHECK) {
    if (!existsSync(NOTICE_PATH)) {
      console.error('✗ ./NOTICE does not exist — run `node scripts/generate-notice.mjs` and commit it.');
      process.exit(1);
    }
    const committed = readFileSync(NOTICE_PATH, 'utf8');
    if (committed !== generated) {
      console.error(
        '✗ ./NOTICE is STALE relative to the current dependency graph / vendored\n' +
          '  license texts. Run `node scripts/generate-notice.mjs`, review the diff,\n' +
          '  and commit it before publishing.',
      );
      process.exit(1);
    }
    if (!existsSync(DESKTOP_PUBLIC_NOTICE) || readFileSync(DESKTOP_PUBLIC_NOTICE, 'utf8') !== committed) {
      console.error(
        '✗ apps/desktop/public/NOTICE is missing or does not match ./NOTICE — run\n' +
          '  `node apps/desktop/scripts/build-sidecar.mjs` (it stages this copy) or\n' +
          '  `node scripts/generate-notice.mjs` to refresh both.',
      );
      process.exit(1);
    }
    console.log(`✓ ./NOTICE is current (${generated.split('\n').length} lines) and apps/desktop/public/NOTICE matches it.`);
    return;
  }

  writeFileSync(NOTICE_PATH, generated);
  mkdirSync(dirname(DESKTOP_PUBLIC_NOTICE), { recursive: true });
  writeFileSync(DESKTOP_PUBLIC_NOTICE, generated);
  console.log(`✓ wrote ${NOTICE_PATH} (${generated.length} bytes, ${generated.split('\n').length} lines)`);
  console.log(`✓ wrote ${DESKTOP_PUBLIC_NOTICE} (copy for the desktop frontend to fetch('/NOTICE'))`);
  console.log('  review the diff and commit ./NOTICE (apps/desktop/public/NOTICE is gitignored — regenerated at build time).');
}

main();
