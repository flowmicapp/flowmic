// NR-297 (2026-10-20) — the IPA half of the store billing-link gate.
//
// The Android store bundle is checked by `store-channel-gate.mjs`. The IPA was
// not checked by anything in this repo (the `release-ios` Makefile header
// records that as a stated debt for the update-notify define). This command
// closes it for ONE question only: does the App Store / TestFlight archive
// still carry the in-app link to the web billing page? Markers, rationale and
// measurement: `store-billing-link-marker.mjs`.
//
// It reads `Payload/<App>.app/Frameworks/App.framework/App` — the AOT snapshot,
// the same entry `build-stamp/verify-built-artifact.mjs` reads for the commit
// stamp (PAYLOAD_ENTRY.ipa) — inflated, because an IPA deflates it.
//
// ⚠️ It does NOT check the update-notify define, signing, or anything the Mac
// line's own scripts check. And it can only refuse what it is shown: a Mac
// script that builds and uploads without calling it is not covered (NR-297
// report names the line).
//
// Usage:  node scripts/ios-store-billing-gate.mjs <file.ipa | dir holding one .ipa>
// Exit 0 = no billing link (and the scan could see the payload). 1 = refused.
// 2 = could not be asked (bad args, no file, not a zip, no App.framework/App).

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAYLOAD_ENTRY } from './build-stamp/verify-built-artifact.mjs';
import {
  STORE_BILLING_LINK_MARKER,
  billingLinkRefusal,
  scanBillingLink,
} from './store-billing-link-marker.mjs';
import { APK_CONTROL_MARKER } from './apk-self-update-marker.mjs';
import { inflateZipEntry, zipEntries } from './store-channel-gate.mjs';

/**
 * @returns {{pass:boolean, exit:0|1|2, lines:string[], scan?:object}}
 */
export function judgeIpa(buf, name) {
  let entries;
  try {
    entries = zipEntries(buf);
  } catch (e) {
    return { pass: false, exit: 2, lines: [`FAIL ${name}: not readable as a zip (${e.message})`] };
  }
  const payload = entries.filter((e) => PAYLOAD_ENTRY.ipa.test(e.name));
  if (payload.length === 0) {
    return {
      pass: false,
      exit: 2,
      lines: [
        `FAIL ${name}: no entry matching ${PAYLOAD_ENTRY.ipa} (${entries.length} entries). ` +
          'Nothing was scanned, so nothing is vouched for.',
      ],
    };
  }
  let bytes;
  try {
    bytes = payload.map((e) => inflateZipEntry(buf, e));
  } catch (e) {
    return {
      pass: false,
      exit: 1,
      lines: [`FAIL ${name}: the Dart payload could not be read (${e.message}) — refusing, not "clean".`],
    };
  }
  const scan = scanBillingLink(bytes);
  if (scan.verdict === 'blind') {
    return {
      pass: false,
      exit: 1,
      scan,
      lines: [
        `FAIL ${name}: the scan is BLIND — control '${APK_CONTROL_MARKER}' absent from ` +
          `${payload.length} payload entr${payload.length === 1 ? 'y' : 'ies'}. Nothing is proven ` +
          'about the billing link either way; re-measure the scan, do not upload.',
      ],
    };
  }
  if (scan.verdict === 'carries-billing-link') {
    return {
      pass: false,
      exit: 1,
      scan,
      lines: [`FAIL ${name} is NOT a publishable store IPA:`, `  · ${billingLinkRefusal(scan.billing, 'release-ios')}`],
    };
  }
  return {
    pass: true,
    exit: 0,
    scan,
    lines: [
      `OK  ${name}: no in-app billing link ('${STORE_BILLING_LINK_MARKER}' 0 hits; ` +
        `control ${scan.control} hit(s) in App.framework/App)`,
    ],
  };
}

function main(argv) {
  const arg = argv[2];
  if (!arg) {
    console.error('usage: node scripts/ios-store-billing-gate.mjs <file.ipa | dir holding one .ipa>');
    return 2;
  }
  if (!existsSync(arg)) {
    console.error(`FAIL ${arg} does not exist — the build did not produce the artifact this check reads.`);
    return 2;
  }
  let file = arg;
  if (statSync(arg).isDirectory()) {
    // Same rule as verify-built-artifact: `flutter build ipa` names the file
    // after the app, so a directory is accepted, and zero or several is a
    // failure rather than a guess.
    const found = readdirSync(arg).filter((n) => n.endsWith('.ipa'));
    if (found.length !== 1) {
      console.error(`FAIL ${arg} holds ${found.length} .ipa files; expected exactly one.`);
      return 2;
    }
    file = resolve(arg, found[0]);
  }
  const v = judgeIpa(readFileSync(file), file.split(/[\\/]/).pop());
  for (const l of v.lines) (v.pass ? console.log : console.error)(l);
  return v.exit;
}

const thisFile = fileURLToPath(import.meta.url);
const argvEntry = process.argv[1] ? resolve(process.argv[1]) : null;
const canon = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
if (argvEntry && normalize(canon(thisFile)) === normalize(canon(argvEntry))) {
  process.exit(main(process.argv));
}
