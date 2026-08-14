// The Node.js runtime FlowMic bundles, PINNED, one entry per platform.
//
// This file is the SSOT for that question. Two consumers read it and nothing
// else answers it:
//   - scripts/generate-notice.mjs — the committed ./NOTICE's legal statement
//     about which runtime we redistribute is generated from these fields.
//   - apps/desktop/scripts/verify-bundle.mjs — the build gate that refuses an
//     artifact whose staged binary disagrees with this declaration.
//
// WHY A COMMITTED DECLARATION INSTEAD OF MEASURING THE BINARY (measured
// defect, 2026-08-05 — not a style preference):
//   generate-notice.mjs used to `execFileSync` the staged
//   apps/desktop/src-tauri/resources/node.exe and bake its `-v` output into the
//   COMMITTED ./NOTICE. That binary is gitignored, and
//   apps/desktop/scripts/build-sidecar.mjs stages it out of `process.execPath`
//   — whatever Node the build machine happens to have installed. So the content
//   of a committed file depended on machine-local state, and it flipped:
//     - one machine:
//       staged node.exe = v22.22.3, 86,969,160 B  ⇒ `--check` EXIT=1
//     - another machine:
//       staged node.exe = v24.15.0, 91,694,408 B  ⇒ `--check` green, and it is
//       that v24 reading which sat in the committed NOTICE
//   Both readings are true. They are readings of different files. Full record:
//   docs/strategy/2026-08-05-local-crosscheck-of-remote-window.md §4.
//
//   The churn was the cheap half. The expensive half is that the vendored
//   license text said Node 24 while this machine's artifacts ship Node 22 — a
//   NOTICE describing a runtime we do not distribute is a false compliance
//   statement, not a stale string.
//
// OWNER RULING: the bundled Node is pinned to the 22 line
//   (docs/decisions/2026-08-05-owner-internal-iteration-mandate.md, item 2).
//
// PROVENANCE OF THE win32-x64 HASH 【实测 2026-08-05, on this machine】:
//   `curl -sS https://nodejs.org/dist/v22.22.3/SHASUMS256.txt` returned, among
//   its lines, exactly:
//     780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b  win-x64/node.exe
//   and `Get-FileHash -Algorithm SHA256` over the staged binary returned the
//   same digest. So the pinned bytes are nodejs.org's own official build — not
//   a local rebuild, not a repack, not a copy of somebody's nvm shim. That is
//   what makes it legitimate to reproduce the upstream LICENSE verbatim for it.
//   The vendored text itself came from
//   https://raw.githubusercontent.com/nodejs/node/v22.22.3/LICENSE and was
//   diffed against C:\nvm4w\nodejs\LICENSE (the LICENSE the v22.22.3
//   distribution itself ships): identical after CRLF normalisation, 2732 lines
//   both ways.
//
// SHAPE — keys are `${process.platform}-${process.arch}`, the same string Node
// answers about itself, so a consumer can look up its own platform without a
// translation table. Only platforms whose binary somebody has actually MEASURED
// belong here. The 0.3.0 task book's card S8 (three-platform portable) adds
// darwin-arm64 and linux-x64 when there is a machine to measure them on — the
// Mac mini for darwin — and each gets its own pinned runtime and, if its
// version differs, its own vendored LICENSE file. Do NOT pre-fill an entry off
// a download page: every field in this file is a reading of a real file, and
// generate-notice.mjs turns those readings into a legal claim.
export const BUNDLED_NODE = {
  'win32-x64': {
    /** As `node -v` answers it, tag form — it is also the GitHub tag the
     *  vendored LICENSE was fetched from, so one string serves both. */
    version: 'v22.22.3',
    sha256: '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b',
    bytes: 86969160,
    /** Filename inside scripts/vendor/. Per-platform because a platform pinned
     *  to a different patch release needs its own verbatim text; sharing one
     *  file across two versions is refused loudly by generate-notice.mjs. */
    licenseFile: 'node-LICENSE.txt',
    /** Repo-relative, POSIX separators. Where build-sidecar.mjs stages it and
     *  where verify-bundle.mjs looks for it — one path, not two that agree. */
    stagedPath: 'apps/desktop/src-tauri/resources/node.exe',
  },

  // PROVENANCE OF THE darwin-arm64 HASH 【实测 2026-08-07, on the Mac mini
  // (FlowMic-app@100.64.7.142), MAC-03】:
  //   ⚠️ darwin CANNOT be verified the same way win32 was, and the difference
  //   matters. nodejs.org's SHASUMS256.txt lists `win-x64/node.exe` DIRECTLY, so
  //   the Windows binary's own digest is published upstream. For darwin it
  //   publishes only the ARCHIVES:
  //     0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207  node-v22.22.3-darwin-arm64.tar.gz
  //     753c1629e168cc788ccc46ab61e0b35549fce08c07f82fcd3bb0d41f7fb01e7b  node-v22.22.3-darwin-arm64.tar.xz
  //   There is no upstream digest for the bare `bin/node` to compare against.
  //   ⇒ The chain was closed by hand instead of asserted, all four steps run on
  //   the Mac mini:
  //     1. curl'd SHASUMS256.txt from nodejs.org (the two lines above).
  //     2. curl'd node-v22.22.3-darwin-arm64.tar.gz; `shasum -a 256 -c` ⇒ `OK`,
  //        i.e. the archive IS the one upstream signed for.
  //     3. extracted `node-v22.22.3-darwin-arm64/bin/node` from THAT verified
  //        archive ⇒ sha256 5d9d3872…, 112,915,776 B.
  //     4. hashed the staged binary ⇒ the SAME digest.
  //   So the pinned bytes trace to nodejs.org's own build through an archive
  //   whose digest upstream publishes. Written out because a reader who only
  //   sees a hash cannot tell step 2 happened, and without step 2 this entry
  //   would be a reading of "whatever was on the build machine" — exactly the
  //   defect the win32 note above says this file exists to end.
  //
  // LICENSE SHARING IS MEASURED, NOT ASSUMED: the `LICENSE` inside the verified
  // darwin tarball hashes to c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4,
  // and `scripts/vendor/node-LICENSE.txt` hashes to the same value (`diff` clean,
  // 2732 lines). Both platforms pin the same v22.22.3, so one verbatim text
  // legitimately serves both — which is what the `licenseFile` note above allows
  // and, deliberately, what it would have refused had the versions differed.
  'darwin-arm64': {
    version: 'v22.22.3',
    sha256: '5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c',
    bytes: 112915776,
    licenseFile: 'node-LICENSE.txt',
    /** 🔴 No `.exe` suffix, and that is load-bearing rather than cosmetic. Until
     *  MAC-03 the macOS build staged a Mach-O executable under the name
     *  `node.exe` (2026-08-06 onboarding findings §3) — it RAN, so nothing
     *  complained. The cost lands later: `bundled_node_beside` looks for a
     *  platform-appropriate name, and a signing/notarisation pass has to reason
     *  about nested executables whose names describe a different OS. One
     *  filename per platform, spelled here once, is the whole fix. */
    stagedPath: 'apps/desktop/src-tauri/resources/node',
  },
};

/** The filename the staged runtime carries on a given platform — derived from
 *  `stagedPath` so it can never disagree with it. `build-sidecar.mjs` (which
 *  writes the file) and the Rust `bundled_node_beside` (which looks for it) must
 *  spell it identically; the Rust side cannot import this module, so its copy is
 *  pinned by a test instead. See node_runtime.rs.
 *
 *  Returns `null` for an undeclared platform rather than guessing a name: a
 *  guess here would be a silent answer to "what are we shipping", and every
 *  other function in this file refuses to do that. */
export function stagedNodeFileName(platformKey = hostPlatformKey()) {
  const pin = BUNDLED_NODE[platformKey];
  if (!pin) return null;
  return pin.stagedPath.split('/').pop();
}

/** The key `BUNDLED_NODE` would be indexed by for the machine running this
 *  process. Split out so the two consumers cannot drift on how the key is
 *  spelled. */
export function hostPlatformKey() {
  return `${process.platform}-${process.arch}`;
}
