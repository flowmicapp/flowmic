// NR-107 — which shared libraries a stock Ubuntu 22.04 desktop already has, and
// which ones a FlowMic user has to install. ONE file, read by the Linux runtime
// dependency gate (scripts/linux-runtime-deps-gate.mjs). The .deb `Depends`
// and the portable launcher's check list (apps/desktop/linux-launcher/) are
// checked AGAINST this file; they are not allowed to be a second opinion.
//
// SOURCE OF THE STOCK LIST [measured 2026-09-25, WSL Ubuntu-22.04 on dev-pc-a]:
//   1. Package set: the official desktop image manifest
//      https://releases.ubuntu.com/22.04/ubuntu-22.04.5-desktop-amd64.manifest
//      (1,861 packages). That manifest is the live image; the installer removes
//      only its own packages (ubiquity and friends), none of which provide a
//      library below.
//   2. soname -> package: `dpkg -S '*/<soname>'` in the 22.04 build distro, for
//      every DT_NEEDED entry of the 0.3.95 Linux payload (flowmic-desktop, the
//      bundled node, the sherpa-onnx native addon) plus the tray library that
//      the app dlopens at runtime.
//   3. A soname is "stock" only when that package is in the manifest.
//   Measured result: libwebkit2gtk-4.1.so.0, libjavascriptcoregtk-4.1.so.0 and
//   libsoup-3.0.so.0 are NOT in the manifest (the image ships the 4.0 / soup 2.4
//   generation instead) — which is exactly the owner's 2026-09-25 report
//   ("error while loading shared libraries: libwebkit2gtk-4.1.so.0").
//
// When a new DT_NEEDED soname appears the gate goes red and names it. Classify it
// here — in STOCK if its package is in the manifest, otherwise in NEEDS_INSTALL
// with the apt package that provides it — and then add it to the .deb depends
// (apps/desktop/src-tauri/tauri.linux.conf.json) and the launcher list.

export const STOCK_SOURCE =
  'https://releases.ubuntu.com/22.04/ubuntu-22.04.5-desktop-amd64.manifest + dpkg -S in Ubuntu 22.04 (2026-09-25)';

/** soname -> providing package, for libraries present on a stock Ubuntu 22.04 desktop. */
export const STOCK_UBUNTU_2204_DESKTOP = new Map([
  ['ld-linux-x86-64.so.2', 'libc6'],
  ['libc.so.6', 'libc6'],
  ['libdl.so.2', 'libc6'],
  ['libm.so.6', 'libc6'],
  ['libpthread.so.0', 'libc6'],
  ['librt.so.1', 'libc6'],
  ['libgcc_s.so.1', 'libgcc-s1'],
  ['libstdc++.so.6', 'libstdc++6'],
  ['libssl.so.3', 'libssl3'],
  ['libcrypto.so.3', 'libssl3'],
  ['libdbus-1.so.3', 'libdbus-1-3'],
  ['libglib-2.0.so.0', 'libglib2.0-0'],
  ['libgobject-2.0.so.0', 'libglib2.0-0'],
  ['libgio-2.0.so.0', 'libglib2.0-0'],
  ['libcairo.so.2', 'libcairo2'],
  ['libgdk_pixbuf-2.0.so.0', 'libgdk-pixbuf-2.0-0'],
  ['libgtk-3.so.0', 'libgtk-3-0'],
  ['libgdk-3.so.0', 'libgtk-3-0'],
  ['libayatana-appindicator3.so.1', 'libayatana-appindicator3-1'],
  ['libappindicator3.so.1', 'libayatana-appindicator3-1'],
]);

/** soname -> apt package, for libraries a stock Ubuntu 22.04 desktop does NOT have. */
export const NEEDS_INSTALL = new Map([
  ['libwebkit2gtk-4.1.so.0', 'libwebkit2gtk-4.1-0'],
  ['libjavascriptcoregtk-4.1.so.0', 'libjavascriptcoregtk-4.1-0'],
  ['libsoup-3.0.so.0', 'libsoup-3.0-0'],
]);

/** The only libraries the portable launcher itself may link against: it has to
 *  start on a machine that is missing everything else, or it cannot say so. */
export const LAUNCHER_ALLOWED_NEEDED = new Set(['libc.so.6', 'ld-linux-x86-64.so.2']);
