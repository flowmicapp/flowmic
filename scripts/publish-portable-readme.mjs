// scripts/publish-portable-readme.mjs
//
// The two shipped README texts scripts/publish.mjs writes — the portable
// bundle's own README.txt and the publish/ release-folder README.txt — moved
// out VERBATIM into their own file. This is a structural split under this
// repo's own file-size-cap precedent (verify/lint/file-size.mjs): a coherent
// family (two self-contained text templates, not logic) moved whole to a new
// file rather than trimmed, so publish.mjs came back under its 800-line cap
// without deleting any of the text a user reads or any of the "what this
// round fixed" history recorded in the release-folder README.
//
// English translation (owner ruling 2026-09-09,
// docs/decisions/2026-09-09-owner-portable-release-english-only.md) is what
// pushed publish.mjs over the cap in the first place — English needs more
// lines than Chinese for the same sentence, the same "translation bloat"
// shape verify/lint/file-size.mjs's TRANSLATION_BLOAT_BASELINE already
// documents for the 2026-08-14 mass translation. The fix there is the same
// fix here: a structural split, not a debt pin, because these two templates
// are a genuinely separable, self-contained unit (pure string building, zero
// side effects, zero dependency on anything else in publish.mjs) rather than
// logic that has to stay beside its caller.
//
// Both exports are pure: given the same inputs they return the same string,
// with no filesystem or process access. publish.mjs still owns the
// writeFileSync calls, the `ok(...)` receipts, and the stale-version
// self-check that reads these files back off disk.

/**
 * The README.txt shipped INSIDE the portable bundle folder
 * (publish/FlowMic-portable/README.txt) — the one a user actually opens
 * after unzipping. English-only per the 2026-09-09 ruling; carries every
 * fact the pre-ruling Chinese 使用说明.txt carried (nothing dropped, nothing
 * added — see that ruling's Situation for what this file replaces).
 *
 * @param {string} version
 * @returns {string}
 */
export function portableReadmeText(version) {
  return `FlowMic ${version} - Portable Edition (no install required)

How to use it: copy this whole folder to wherever you want to keep it, then
double-click FlowMic.exe. That's the entire process.

  Warning: don't run this by double-clicking it straight out of the publish
  folder (publish/). That folder is the staging area for the next release.
  The next release will overwrite the same files, and Windows won't let it
  overwrite a program that's currently running, so the release fails partway
  through. Copy this folder out first and run it from there; that way the two
  never collide.

  - No need to install Node.js: the node.exe in this folder is the runtime it
    uses.
  - No console window: FlowMic.exe is a windowed-subsystem program, and its
    built-in server starts with CREATE_NO_WINDOW, so nothing in this chain
    ever opens a console.
  - The server ships together with the client: resources/server.js is that
    server, and FlowMic.exe starts and stops it itself (it exits together
    with the app, leaving no orphaned process behind).
  - Only one copy runs at a time: double-clicking again won't open a second
    FlowMic or start a second server.

What's in this folder
  FlowMic.exe            The main program (double-click this)
  node.exe               The bundled Node.js runtime
  resources/server.js    The local server
  resources/node_modules Native modules for the local recognition engine
                         (sherpa-onnx)
                         Note: offline local recognition also needs a model
                            file (about 228 MB) that is not bundled and does
                            not download automatically by default. To enable
                            it, set the environment variable
                            FLOWMIC_SHERPA_AUTO_DOWNLOAD=1 and start the app
                            once (the download is integrity-checked, and it
                            won't be enabled if that check fails). Without
                            the model, local recognition is unavailable;
                            cloud recognition and your own custom engine are
                            not affected.

Where your data lives
  %APPDATA%\\FlowMic\\      The database (flowmic.sqlite), standalone.secret,
                          instance.lock. Your actual messages and
                          transcripts are here
  %LOCALAPPDATA%\\FlowMic\\ Pairing credentials and state: credentials.bin,
                          credentials-cloud.bin, cloud.bin,
                          typed-ledger.json; diagnostic logs:
                          window-forensics.log, server.log
                          Note: credentials live here, not under %APPDATA%,
                             so it's easy to miss when uninstalling
  This shares the same data as the MSI-installed version, so don't run both
     at once (and you actually can't: the single-instance lock blocks
     whichever one starts second).

Requirements
  The WebView2 runtime that ships with Windows 10/11. Windows 11 already has
  it; if yours doesn't, install the Microsoft Edge WebView2 Runtime once.

Uninstalling
  Delete this folder and the program is gone, but two things live outside
  this folder, and deleting the folder won't remove them:

  1. Pairing credentials / cloud session / diagnostic logs (all under
     %LOCALAPPDATA%\\FlowMic\\, see above).
     If you have the FlowMic source tree, one command clears these along
     with the autostart entry (it does not touch the database; see that
     script's --help):
       node scripts/uninstall-cleanup.mjs --yes
     Without the source tree, delete these files by hand (it's harmless if
     a file doesn't exist, ignore the error):
       del "%LOCALAPPDATA%\\FlowMic\\credentials.bin"
       del "%LOCALAPPDATA%\\FlowMic\\credentials-cloud.bin"
       del "%LOCALAPPDATA%\\FlowMic\\cloud.bin"
       del "%LOCALAPPDATA%\\FlowMic\\typed-ledger.json"
       del "%LOCALAPPDATA%\\FlowMic\\typed-ledger-cloud.json"
       del "%LOCALAPPDATA%\\FlowMic\\window-forensics.log"
       del "%LOCALAPPDATA%\\FlowMic\\server.log"

  2. If you ever turned on "start with Windows": Task Manager's "Startup
     apps" tab (or Settings > Apps > Startup) will still list FlowMic;
     deleting the folder doesn't remove that entry, so turn it off there by
     hand.

  To also clear the database (your message history), delete
  %APPDATA%\\FlowMic\\ by hand. Neither this file nor the command above
  does that step for you.
`;
}

/**
 * The README.txt written into ./publish itself (the release folder) —
 * describes the four kinds of artifact it contains, the RV-73 run-area vs.
 * release-area distinction, and the round's changelog-style notes. Also
 * English-only per the 2026-09-09 ruling.
 *
 * @param {{version: string, head: string, mainAsset: string,
 *          nodeVersion: string, filesBlock: string}} args
 *   `filesBlock` is the pre-formatted `#   <name>\n#     SHA256 <hash>` lines
 *   for every staged artifact — built by the caller (it needs the `staged`
 *   list, which this pure module has no business holding).
 * @returns {string}
 */
export function releaseFolderReadmeText({ version, head, mainAsset, nodeVersion, filesBlock }) {
  return `# FlowMic ${version} release folder (publish/)
#
# The version number goes up by one every round (owner's 2026-07-27 rule), so
# it now *is* the identity: the ${version} here is exactly the number the
# installed app will show. The SHA256 hashes are still listed below. The
# version answers "which release"; the SHA256 answers "was it swapped for
# something else", and those are two different questions.
#
#   Built from : ${head || '(git not available)'}
#   Frontend asset: ${mainAsset}
#   Node       : ${nodeVersion} (bundled with the portable edition)
#
# ── The four things in this folder ──────────────────────────────────────
#
#   FlowMic-portable/      * The portable edition (unpacked form): no install,
#                            no separate Node install, no console window, the
#                            server is bundled in. See its own README.txt for
#                            details.
#   *-portable-*.zip         The same portable edition packaged for
#                            distribution (unzip it and you get the folder
#                            above). This is what the download center and the
#                            in-app update feed ship. A folder can't be
#                            uploaded, but a zip can.
#   *.msi                  The installer (one build each for en-US / zh-CN).
#   *.apk                  The Android build (may be missing if this round
#                            didn't rebuild it).
#
# ── Warning: this folder is the release area, not the run area (RV-73, owner ruling 2026-07-31) ──
#
#   Don't launch FlowMic directly from inside publish/. Every release
#   overwrites the files in this folder, and Windows won't let it overwrite a
#   program that's currently running. This used to be exactly why a release
#   would fail with EBUSY whenever FlowMic was open: the run copy and the
#   release copy lived in the same folder. The fix was to keep them separate.
#
#   To update your local running copy (install the portable build above into
#   your run directory):
#
#       node scripts/install-local.mjs          # defaults to %LOCALAPPDATA%\\Programs\\FlowMic\\
#       node scripts/install-local.mjs --help   # pick a different directory / preview first
#
#   If it finds FlowMic still running, it stops entirely and tells you what to
#   close first. It never writes a half-finished update.
#
${filesBlock}
#
# Warning: MSI install trap (measured): installing over the same version
#   number does not replace the binary. msiexec /i, and even
#   REINSTALLMODE=vamus, both leave the old exe in place. When switching
#   builds, uninstall first and then install, or use the SHA256 hashes above
#   to confirm which version you actually have installed. The portable
#   edition doesn't have this problem (unzip to use, delete to remove).
#
# ── What this round fixed (owner feedback, 2026-07-27) ───────────────────
#
#  - PC-side timeline was entirely blank (the web version was fine; the PC
#    version was missing even the title and filter bar).
#    Root cause: the PC's local cache (flowmic.history.cache) held a
#    "server-raw-row" shape written by an older build. It carried
#    status:'injected' with no target field at all. The null-check for
#    target used "=== null", which didn't catch undefined, so rendering threw
#    a TypeError; a throw anywhere in the Vue tree blanks the whole component
#    subtree, which is why the title and filter bar vanished together. The
#    web version starts from a fresh profile with no such cache, which is why
#    it looked like "only the PC side is broken".
#    Fix: the null-check now uses "== null" with per-field guards; more
#    importantly, both the cache boundary and the incoming-data boundary now
#    normalize through one function (timeline-store normalizeCachedRow), so a
#    bad shape can't get in at all, instead of relying on every call site to
#    guard itself.
#
#  - Closed the same class of risk everywhere else (per owner: "check whether
#    anything else has the same kind of problem").
#    The six localStorage caches on the settings page used to be raw
#    \`JSON.parse(raw) as T\` casts (parsing can succeed while the shape is
#    still wrong (including a literal null) and that would go straight to
#    the template); all six are now narrowed field by field. The raw cast on
#    the pairing_code snapshot got the same treatment (a missing endpoint
#    field used to blank the whole devices page). One watcher on the devices
#    page evaluated with \`immediate\` before lanUp/cloudUp were even declared,
#    which threw a ReferenceError on every mount in production (Vue silently
#    swallowed it), so LAN/cloud channel changes stopped triggering a
#    recheck. It's now placed after its dependencies.
#
#  - No silent failures (a hard rule): both the main window and the capsule
#    now have error boundaries. Previously a render throw wrote nothing to
#    the log and showed no message, so a blank screen looked identical to
#    "there's genuinely no data"; now it's written to the diagnostic log and
#    surfaced as a banner at the top of the window.
#
#  - The settings page's tab-switching behavior didn't match the web version.
#    Root cause: it wasn't actually switching panels. It was a scroll
#    anchor plus a scroll-spy, so every frame of the smooth-scroll after a
#    click re-triggered the spy and reset the highlight to whatever section
#    it was passing through; and the last section (About) was too short to
#    ever reach the trigger line, so clicking it would bounce back to
#    Preferences. Both effects depend on window height, which is why the wide
#    web version and the narrow PC version behaved differently. Fix: suppress
#    the spy while a click-triggered scroll is in flight, treat scrolling to
#    the bottom as reaching the last section, and skip the whole thing while
#    the settings page is display:none (all three pages share one scroll
#    container, so scrolling any other page used to change this highlight
#    too).
#
#  - The three pages sharing one scroll container also meant scroll position
#    leaked between pages (scroll to the bottom of settings, switch to the
#    timeline, and the timeline would open already scrolled halfway down).
#    Switching pages now resets scroll position.
#
#  - Single instance (per owner's requirement that "only one running copy of
#    the server and the PC app may exist at a time").
#    On startup the app claims %APPDATA%\\FlowMic\\instance.lock (an
#    exclusively-opened file lock; Windows releases it automatically if the
#    process disappears, so a crash can't lock you out). If it can't get the
#    lock, it writes one line to the diagnostic log and exits. You will
#    never see a second tray icon, a second capsule, or a second UI adopting
#    the first one's server.
#
# When installing for the owner, always take the files from this folder,
# never from the build/ or target/ output directories (a lesson learned the
# hard way, recorded in book 13 §4).
# But "taken from this folder" is not the same as "run from this folder";
# see the RV-73 section above.
`;
}
