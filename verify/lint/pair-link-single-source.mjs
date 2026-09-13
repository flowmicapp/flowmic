// verify/lint/pair-link-single-source.mjs
// Successor to `pair-https-host-mirror` (XC-1-FIX / card DOM-1), which compared
// two hand-written copies of the https pairing prefix and failed when they
// disagreed.
//
// ── WHAT CHANGED, AND WHAT THAT COSTS ──────────────────────────────────────
// There is no second copy left to compare. `apps/mobile/tool/gen_protocol.mjs`
// now emits `FlowMicPairLink.httpsPrefix` into the gitignored
// `apps/mobile/lib/generated/flowmic_protocol.g.dart` from `PAIR_HTTPS_HOST` +
// `PAIR_HTTPS_PATH`, and `apps/mobile/lib/src/ui/scan_payload.dart` declares
// `kPairLinkPrefixHttps` to BE that value. Equality is by construction, so the
// comparison this lint used to run can no longer fail — and a check that cannot
// fail is worse than no check, because it reads like coverage.
//
// Two of the old lint's jobs did not move into the generator and are done here:
//
//   1. FAIL if `PAIR_HTTPS_HOST` / `PAIR_HTTPS_PATH` are not plain string
//      literals. Without them this scan would hunt for the empty string and
//      pass while covering zero — the exact shape the old header warned about.
//      (The generator throws on the same condition, but that verdict arrives in
//      `verify:mobile-tests`, minutes later in the gate. This is the cheap one.)
//   2. FAIL if anything under `apps/mobile/lib` hand-types the prefix again.
//      This is strictly MORE than the old lint covered: it compared exactly one
//      Dart constant, and its own header listed "a third copy that renamed the
//      constant" among the things it could not see.
//
// The PATH SHAPE check (leading slash, no trailing one) moved INTO the
// generator, because the generator is now the thing that concatenates. It fires
// at `make gen`, i.e. before anything compiles the mobile app.
//
// ── 🔴 WHAT THIS LINT DOES *NOT* PROVE ─────────────────────────────────────
//   · Freshness. `flowmic_protocol.g.dart` is gitignored and rebuilt by
//     `make gen`, which every mobile target depends on (apps/mobile/Makefile).
//     Editing `constants.ts` without re-running the generator is INVISIBLE to
//     `pnpm verify:lint` — `i18n-generated-fresh` does not watch this artefact.
//     It becomes visible the moment anything compiles or tests the app.
//   · A prefix typed in the MIDDLE of a longer literal, or split across two
//     adjacent string literals. The needle must be immediately preceded by a
//     quote, which is the shape a re-typed prefix constant actually has.
//   · `apps/mobile/test` is deliberately NOT scanned. Those files spell real
//     scanned links on purpose: they are what makes a change to
//     `PAIR_HTTPS_PATH` show up as a failing test rather than as a value that
//     silently followed itself. Generating them too would remove the only
//     reverse control this seam has.
//   · Comments and docs that mention the same URL for a different question, and
//     `DEFAULT_CORS_ORIGIN`-style uses of the bare host, which are a different
//     value answering a different question (welding them would be one value
//     answering two).

import path from 'node:path';
import { ROOT, readText, walk, lineOf } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'pair-link-single-source';

const PROTOCOL_FILE = 'packages/protocol/src/constants.ts';
const MOBILE_LIB = 'apps/mobile/lib';
// The generated artefact is where the prefix is SUPPOSED to be spelled out.
const GENERATED_DIR = 'apps/mobile/lib/generated';

const PROTO_HOST_RE = /^[ \t]*export[ \t]+const[ \t]+PAIR_HTTPS_HOST[ \t]*=[ \t]*'([^']+)'[ \t]*;/m;
const PROTO_PATH_RE = /^[ \t]*export[ \t]+const[ \t]+PAIR_HTTPS_PATH[ \t]*=[ \t]*'([^']+)'[ \t]*;/m;

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

export default async function run() {
  const protoText = await readText(path.join(ROOT, PROTOCOL_FILE));
  if (protoText === null) {
    return {
      status: 'FAIL',
      detail: `${PROTOCOL_FILE} is missing — it declares PAIR_HTTPS_HOST/PAIR_HTTPS_PATH, the pair link this scan is built from`,
    };
  }
  const hostHit = PROTO_HOST_RE.exec(protoText);
  if (!hostHit) {
    return {
      status: 'FAIL',
      detail:
        `PAIR_HTTPS_HOST is no longer declared as a plain string literal in ${PROTOCOL_FILE}. ` +
        'Renamed, moved, or computed — this scan would now hunt for a prefix built from nothing ' +
        'and pass while covering zero. Update verify/lint/pair-link-single-source.mjs ' +
        '(and apps/mobile/tool/gen_protocol.mjs, which parses the same declaration).',
    };
  }
  const pathHit = PROTO_PATH_RE.exec(protoText);
  if (!pathHit) {
    return {
      status: 'FAIL',
      detail:
        `PAIR_HTTPS_PATH is not declared as a plain string literal in ${PROTOCOL_FILE}. ` +
        'Renamed, moved, or computed — this scan would now cover only half a prefix, and it is ' +
        'the half that has never changed. Update verify/lint/pair-link-single-source.mjs ' +
        '(and apps/mobile/tool/gen_protocol.mjs, which parses the same declaration).',
    };
  }

  const prefix = `https://${hostHit[1]}${pathHit[1]}`;
  // Immediately preceded by a quote = the start of a hand-typed string literal.
  // A backtick (doc comments quote this URL constantly) is not a quote here.
  const needle = new RegExp(`['"]${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');

  const libAbs = path.join(ROOT, MOBILE_LIB);
  const files = (await walk(libAbs)).filter(
    (abs) => abs.endsWith('.dart') && !rel(abs).startsWith(`${GENERATED_DIR}/`),
  );
  if (files.length === 0) {
    return {
      status: 'FAIL',
      detail: `${MOBILE_LIB} yielded zero .dart files — the scan covered nothing`,
    };
  }

  const hits = [];
  for (const abs of files) {
    const text = await readText(abs);
    if (text === null) continue;
    needle.lastIndex = 0;
    let m;
    while ((m = needle.exec(text)) !== null) {
      hits.push(`${rel(abs)}:${lineOf(text, m.index)}`);
    }
  }

  if (hits.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${hits.length} hand-typed pairing-link literal '${prefix}' under ${MOBILE_LIB}: ` +
        `${hits.join(', ')} — the prefix has ONE Dart spelling, ` +
        '`kPairLinkPrefixHttps` (src/ui/scan_payload.dart), which is generated from ' +
        `${PROTOCOL_FILE} by apps/mobile/tool/gen_protocol.mjs. A re-typed copy keeps working ` +
        'until the day the host or the path moves, and then it refuses every QR it is handed ' +
        'while its own tests stay green.',
    };
  }

  return {
    status: 'PASS',
    detail:
      `${files.length} .dart file(s) under ${MOBILE_LIB} hand-type '${prefix}' zero times; ` +
      `the one spelling is generated from ${PROTOCOL_FILE} ` +
      '(PAIR_HTTPS_HOST + PAIR_HTTPS_PATH) into lib/generated/flowmic_protocol.g.dart',
  };
}
