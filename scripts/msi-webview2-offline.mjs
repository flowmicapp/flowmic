// Card MSI-OFFLINE-WEBVIEW2 — how each of the two Windows MSI variants gets
// its WebView2 runtime, judged from the MSI's own tables.
//
// ── the two variants (owner ruling relayed by MAIN, 2026-10-27) ──────────────
//
//   DIRECT  the normal build (`pnpm --filter @flowmic/desktop tauri:build`):
//           Tauri's default downloadBootstrapper, ~47 MiB. This is the MSI the
//           in-app updater, the download centre and GitHub serve. It MUST NOT
//           embed the ~205 MiB standalone installer (size-creep guard), and it
//           must still provision WebView2 (download-on-install is allowed).
//   STORE   on demand only (scripts/build-windows-store-msi.mjs): the extra
//           config apps/desktop/src-tauri/tauri.store.conf.json selects
//           offlineInstaller. It MUST be offline and silent (rules below).
//
// The variant is always an EXPLICIT argument from the caller (publish.mjs says
// 'direct'; the store build says 'store'). The judge never infers it from the
// file name; when the measured contents disagree with the declared variant,
// the refusal says what the contents look like.
//
// ── the Store rule ───────────────────────────────────────────────────────────
//
// Microsoft Store MSI/EXE requirements (learn.microsoft.com/windows/apps/
// publish/publish-your-app/msi/app-package-requirements, read 2026-10-26):
// "The installer is a standalone installer and is not a downloader stub/web
// installer that downloads bits when run", and "Initiating the install must not
// display an installation user interface (i.e., silent install is required)".
// The Store runs MSIs with `/qn` (…/msi/upload-app-packages, read 2026-10-27).
//
// ── why the store variant needs a gate and not just a config line ───────────
//
// The config is `bundle.windows.webviewInstallMode = offlineInstaller` in
// tauri.store.conf.json. Ways the built MSI can stop matching it without any
// build failing [tauri-bundler source at
// tauri-cli-v2.11.4, crates/tauri-bundler/src/bundle/windows/msi/{mod.rs,main.wxs}]:
//   · the key is removed or misspelled ⇒ Tauri's default, downloadBootstrapper,
//     which adds the custom action DownloadAndInvokeBootstrapper (a PowerShell
//     Invoke-WebRequest to go.microsoft.com) — measured in the 0.3.118 MSI;
//   · embedBootstrapper ⇒ InvokeBootstrapper runs the small bootstrapper, which
//     itself downloads the runtime (Microsoft: "WebView2 Runtime Bootstrapper …
//     downloads and installs the Evergreen Runtime from Microsoft servers");
//   · bundle.windows.minimumWebview2Version set ⇒ UpdateWebView2ViaEdgeUpdate
//     asks EdgeUpdate to update the runtime online during setup;
//   · `silent: false` ⇒ the runtime installer runs without `/silent`.
// Also: Tauri downloads the standalone installer at BUILD time from a
// Microsoft fwlink and checks neither a hash nor a signature (util.rs
// download_webview2_offline_installer). The signature gate therefore pins its
// chain to a Microsoft code-signing root (see MICROSOFT_CODE_SIGNING_ROOTS);
// "any trusted signature" would let a substituted binary through.
//
// Pure: it reads the dark.exe-decompiled .wxs text and the PE list the
// signature gate already extracted. No second decompile.

import { refuseDirectRun } from './module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'node scripts/publish.mjs (via scripts/windows-signature-gate.mjs)');

/** Tauri's Binary-table id for the embedded Evergreen Standalone Installer
 *  (main.wxs `<Binary Id="MicrosoftEdgeWebView2RuntimeInstaller.exe" …/>`). */
export const WEBVIEW2_STANDALONE_BINARY = 'MicrosoftEdgeWebView2RuntimeInstaller.exe';

/** Custom actions Tauri emits for the WebView2 modes that reach the network
 *  during setup. Any of them in a shipped MSI is a refusal. */
export const ONLINE_WEBVIEW2_ACTIONS = Object.freeze([
  'DownloadAndInvokeBootstrapper', // downloadBootstrapper
  'InvokeBootstrapper', // embedBootstrapper — the bootstrapper downloads
  'UpdateWebView2ViaEdgeUpdate', // minimumWebview2Version — EdgeUpdate online
]);

/** Roots of Microsoft's own code-signing chains (SHA1 thumbprints as signtool
 *  prints them). Deliberately NOT "Microsoft Identity Verification Root
 *  Certificate Authority 2020": that root signs third-party Trusted Signing
 *  customers (node.exe's OpenJS Foundation chain ends there), so it would not
 *  prove the file came from Microsoft. Measured value in the drill header. */
export const MICROSOFT_CODE_SIGNING_ROOTS = Object.freeze({
  '8F43288AD272F3103B6FB1428485EA3014C0BCFE': 'Microsoft Root Certificate Authority 2011',
  '3B1EFD3A66EA28B16697394703A72CA340A05BD5': 'Microsoft Root Certificate Authority 2010',
});

const ENTITIES = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
const decode = (s) => s.replace(/&(quot|apos|amp|lt|gt);/g, (_, k) => ENTITIES[k]);

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.]*)="([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

/** Every <CustomAction>, every sequenced <Custom> (with its condition text),
 *  every <Binary>, from a dark.exe-decompiled .wxs. */
export function parseWxs(wxs) {
  const text = String(wxs);
  const customActions = [...text.matchAll(/<CustomAction\b([^>]*?)\/?>/g)].map((m) => attrs(m[1]));
  const sequenced = [...text.matchAll(/<Custom\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Custom>)/g)].map((m) => ({
    ...attrs(m[1]),
    condition: decode((m[2] ?? '').trim()),
  }));
  const binaries = [...text.matchAll(/<Binary\b([^>]*?)\/?>/g)].map((m) => attrs(m[1]));
  const webviewProperty = /<Property\s+Id="INSTALLED_WEBVIEW2_VERSION"[^>]*>([\s\S]*?)<\/Property>/.exec(text);
  const pvSearches = webviewProperty ? [...webviewProperty[1].matchAll(/<RegistrySearch\b[^>]*\bName="pv"/g)].length : 0;
  return { customActions, sequenced, binaries, pvSearches, hasProduct: /<Product\b/.test(text) };
}

const NETWORK = /\bhttps?:\/\/|Invoke-WebRequest|Start-BitsTransfer|DownloadFile|\bcurl(\.exe)?\b|\bwget\b|bitsadmin/i;

/**
 * Judge one MSI. `pes` is the signature gate's extraction ([{ display }]).
 * Returns { ok, problems: string[], notes: string[], installer: display|null }.
 * Every problem names what was found; a .wxs without a <Product> is BLIND,
 * not clean.
 */
export function judgeMsiWebView2Offline({ wxs, pes }) {
  const w = parseWxs(wxs);
  const problems = [];
  const notes = [];
  if (!w.hasProduct) {
    return { ok: false, problems: ['BLIND: the decompiled .wxs has no <Product> — nothing about this MSI was read'], notes, installer: null };
  }

  for (const ca of w.customActions) {
    if (ONLINE_WEBVIEW2_ACTIONS.includes(ca.Id)) {
      problems.push(`custom action ${ca.Id} fetches the WebView2 runtime online during setup (Store rule: no downloads during setup)`);
    } else if (ca.ExeCommand && NETWORK.test(ca.ExeCommand)) {
      problems.push(`custom action ${ca.Id} runs a command that reaches the network: ${ca.ExeCommand.slice(0, 160)}`);
    }
  }
  if (w.binaries.some((b) => /^MicrosoftEdgeWebview2Setup\.exe$/i.test(b.Id ?? ''))) {
    problems.push('the MSI embeds MicrosoftEdgeWebview2Setup.exe (the bootstrapper), which downloads the runtime when run');
  }

  const display = `Binary:${WEBVIEW2_STANDALONE_BINARY}`;
  const asPe = pes.filter((p) => p.display === display);
  if (asPe.length !== 1) {
    problems.push(`expected exactly one ${display} PE inside the MSI, found ${asPe.length} — without it a machine with no WebView2 runtime gets an app that cannot open a window`);
  }
  const invoke = w.customActions.filter((ca) => ca.BinaryKey === WEBVIEW2_STANDALONE_BINARY);
  if (invoke.length !== 1) {
    problems.push(`expected exactly one custom action that runs ${WEBVIEW2_STANDALONE_BINARY}, found ${invoke.length}`);
  } else {
    const ca = invoke[0];
    const cmd = ca.ExeCommand ?? '';
    if (!/(^|\s)\/silent(\s|$)/i.test(cmd) || !/(^|\s)\/install(\s|$)/i.test(cmd)) {
      problems.push(`custom action ${ca.Id} runs the runtime installer with "${cmd}" — it must be "/silent /install" (Store rule: silent install)`);
    }
    const seq = w.sequenced.filter((s) => s.Action === ca.Id);
    if (seq.length !== 1) {
      problems.push(`custom action ${ca.Id} is sequenced ${seq.length} times, expected once`);
    } else if (!/INSTALLED_WEBVIEW2_VERSION/.test(seq[0].condition) || !/\bREMOVE\b/.test(seq[0].condition)) {
      problems.push(`custom action ${ca.Id} runs under "${seq[0].condition}" — it must skip when a runtime is registered (INSTALLED_WEBVIEW2_VERSION) and on uninstall (REMOVE)`);
    } else {
      notes.push(`${ca.Id} runs "${cmd}" only when ${seq[0].condition}`);
    }
  }
  if (w.pvSearches === 0) {
    problems.push('INSTALLED_WEBVIEW2_VERSION has no registry search on the runtime\'s "pv" value, so an installed runtime is never detected');
  }
  return { ok: problems.length === 0, problems, notes, installer: asPe.length === 1 ? display : null };
}

/** Size ceiling for the DIRECT MSI. Measured [dev-pc-a]: 0.3.11 en-US
 *  47,710,208 B (update manifest of 2026-08-20); 0.3.118 en-US 48,963,584 B
 *  and zh-CN 48,959,488 B (2026-10-26) — about 1.2 MB of growth over 107
 *  versions. The same MSI with the embedded runtime installer is 263,999,488 B
 *  (+214,823,632 B for the installer). 128 MiB leaves ~81 MiB of headroom over
 *  today (more than node.exe + the sherpa addon together) while sitting
 *  ~124 MiB below the store variant. It also catches fat shapes the structural
 *  check cannot name, e.g. fixedRuntime (Microsoft: "over 250 MB", installed
 *  through the File table, not the Binary table). Raise it on purpose, with a
 *  new measurement here, never to make a red go away. */
export const DIRECT_MSI_MAX_BYTES = 128 * 1024 * 1024;

export const MSI_VARIANTS = Object.freeze(['direct', 'store']);

/** WebView2 actions the DIRECT variant may use: both make the MSI fetch the
 *  runtime from Microsoft only when none is registered. */
const DIRECT_PROVISIONING_ACTIONS = Object.freeze(['DownloadAndInvokeBootstrapper', 'InvokeBootstrapper']);

/** Judge the DIRECT variant: small, provisions WebView2 on install when
 *  missing, never embeds the standalone installer. `bytes` = the MSI's size. */
export function judgeMsiWebView2Direct({ wxs, pes, bytes }) {
  const w = parseWxs(wxs);
  const problems = [];
  const notes = [];
  if (!w.hasProduct) {
    return { ok: false, problems: ['BLIND: the decompiled .wxs has no <Product> — nothing about this MSI was read'], notes, installer: null };
  }
  const display = `Binary:${WEBVIEW2_STANDALONE_BINARY}`;
  const fat = pes.some((p) => p.display === display) || w.customActions.some((ca) => ca.BinaryKey === WEBVIEW2_STANDALONE_BINARY);
  if (fat) {
    problems.push(`this MSI embeds the WebView2 standalone installer (${display}) — that is the STORE variant's content. ` +
      'The direct MSI (in-app updater, download centre, GitHub) must stay small: build it with plain ' +
      '`pnpm --filter @flowmic/desktop tauri:build`, and keep tauri.store.conf.json out of it');
  }
  if (!Number.isFinite(bytes)) {
    problems.push('BLIND: the MSI size was not measured');
  } else if (bytes > DIRECT_MSI_MAX_BYTES) {
    problems.push(`the MSI is ${bytes} bytes, over the direct-variant ceiling of ${DIRECT_MSI_MAX_BYTES} (128 MiB; today's direct MSI ` +
      'is ~47 MiB, the store variant ~252 MiB) — something large got bundled; see DIRECT_MSI_MAX_BYTES in scripts/msi-webview2-offline.mjs');
  }
  const provisioning = w.customActions.filter((ca) => DIRECT_PROVISIONING_ACTIONS.includes(ca.Id));
  if (provisioning.length !== 1) {
    problems.push(`expected exactly one WebView2 install action (${DIRECT_PROVISIONING_ACTIONS.join(' or ')}), found ${provisioning.length} — ` +
      'without one, a machine with no WebView2 runtime gets an app that cannot open a window');
  } else {
    const seq = w.sequenced.filter((s) => s.Action === provisioning[0].Id);
    if (seq.length !== 1 || !/INSTALLED_WEBVIEW2_VERSION/.test(seq[0].condition) || !/\bREMOVE\b/.test(seq[0].condition)) {
      problems.push(`${provisioning[0].Id} must be sequenced once and skip when a runtime is registered and on uninstall; found ${seq.map((s) => `"${s.condition}"`).join(', ') || 'no sequence row'}`);
    } else {
      notes.push(`${provisioning[0].Id} (download on install) only when ${seq[0].condition}; no embedded runtime installer; ${bytes} bytes ≤ ${DIRECT_MSI_MAX_BYTES}`);
    }
  }
  if (w.pvSearches === 0) {
    problems.push('INSTALLED_WEBVIEW2_VERSION has no registry search on the runtime\'s "pv" value, so an installed runtime is never detected');
  }
  return { ok: problems.length === 0, problems, notes, installer: null };
}

/** One entry point; `variant` is required and never guessed. */
export function judgeMsiWebView2({ variant, wxs, pes, bytes }) {
  if (variant === 'store') return judgeMsiWebView2Offline({ wxs, pes });
  if (variant === 'direct') return judgeMsiWebView2Direct({ wxs, pes, bytes });
  throw new Error(`MSI variant "${variant}" is not one of ${MSI_VARIANTS.join(' / ')} — the caller must say which MSI it is checking`);
}

/** For the signature gate: an OK verdict on the embedded installer also needs
 *  its chain root to be a Microsoft code-signing root. `parsed` is
 *  parseVerifyOutput() output. Returns null when acceptable, else the reason. */
export function microsoftRootProblem(parsed) {
  const root = parsed.chainSha1s?.[0] ?? null;
  if (root && MICROSOFT_CODE_SIGNING_ROOTS[root]) return null;
  return `its signing chain ends at ${root ?? '(no chain)'}, not at a Microsoft code-signing root ` +
    `(${Object.values(MICROSOFT_CODE_SIGNING_ROOTS).join(' / ')}); Tauri downloads this file without checking it, ` +
    'so a validly signed file from anyone else is refused';
}
