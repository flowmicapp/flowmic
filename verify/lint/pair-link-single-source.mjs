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
// -- THE CUSTOM-SCHEME HALF, ADDED 2026-09-15 (card H-14) -------------------
// This lint covered ONLY the https spelling, while the header above says "the
// prefix" as if there were one. There are two: `https://flowmic.app/go/pair`
// and `flowmic://pair` -- the same query with a different scheme+host -- and the
// second one had NO single source at all. Measured: the desktop builder typed it
// inline, `apps/mobile/lib/src/ui/scan_payload.dart` declared a second copy, and
// `PairEntry.parse` (apps/mobile/lib/src/signaling/wire_payloads.dart) typed a
// THIRD rather than importing the constant from the file it already imports from.
//
// 🔴 THE GUARD'S NAME SAID 「single source」 WHILE HALF OF ITS SUBJECT HAD NONE.
// That is the shape this repo keeps paying for: a green check that reads as
// coverage of a question it was never asked. `PAIR_CUSTOM_SCHEME` +
// `PAIR_CUSTOM_HOST` now live in packages/protocol/src/constants.ts, the
// generator emits `FlowMicPairLink.customPrefix`, and BOTH spellings are scanned
// here by the same rule -- including the declaration site itself, which is now
// generated and therefore excluded with every other generated file.
//
// ⚠️ What the custom half does NOT get, and the https half does: an OS
// declaration to check against. Only `flowmic://login` is declared to Android
// and iOS; `flowmic://pair` arrives by camera or paste. So there is no
// applink-declarations equivalent for it, and its absence is deliberate (see
// the constants.ts block).
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
const PROTO_SCHEME_RE = /^[ \t]*export[ \t]+const[ \t]+PAIR_CUSTOM_SCHEME[ \t]*=[ \t]*'([^']+)'[ \t]*;/m;
const PROTO_CHOST_RE = /^[ \t]*export[ \t]+const[ \t]+PAIR_CUSTOM_HOST[ \t]*=[ \t]*'([^']+)'[ \t]*;/m;

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

export default async function run() {
  const protoText = await readText(path.join(ROOT, PROTOCOL_FILE));
  if (protoText === null) {
    return {
      status: 'FAIL',
      detail: `${PROTOCOL_FILE} is missing — it declares PAIR_HTTPS_HOST/PAIR_HTTPS_PATH and PAIR_CUSTOM_SCHEME/PAIR_CUSTOM_HOST, the two pair links this scan is built from`,
    };
  }

  // Every declaration this scan is built from. A missing one is a FAIL and not
  // a narrower scan: a prefix built from the empty string matches nothing and
  // PASSES while covering zero, which is precisely what this file's header says
  // it must never do.
  const DECLS = [
    {
      re: PROTO_HOST_RE,
      constName: 'PAIR_HTTPS_HOST',
      consequence: 'this scan would now hunt for a prefix built from nothing and pass while covering zero.',
    },
    {
      re: PROTO_PATH_RE,
      constName: 'PAIR_HTTPS_PATH',
      consequence: 'this scan would now cover only half a prefix, and it is the half that has never changed.',
    },
    {
      re: PROTO_SCHEME_RE,
      constName: 'PAIR_CUSTOM_SCHEME',
      consequence: 'the custom-scheme half of this scan would be built from nothing — the half that had no single source at all until card H-14.',
    },
    {
      re: PROTO_CHOST_RE,
      constName: 'PAIR_CUSTOM_HOST',
      consequence: 'the custom-scheme half of this scan would cover only `flowmic://`, which is also the login link — one needle answering two questions.',
    },
  ];
  const values = {};
  for (const d of DECLS) {
    const hit = d.re.exec(protoText);
    if (!hit) {
      return {
        status: 'FAIL',
        detail:
          `${d.constName} is no longer declared as a plain string literal in ${PROTOCOL_FILE}. ` +
          `Renamed, moved, or computed — ${d.consequence} ` +
          'Update verify/lint/pair-link-single-source.mjs ' +
          '(and apps/mobile/tool/gen_protocol.mjs, which parses the same declaration).',
      };
    }
    values[d.constName] = hit[1];
  }

  // The two spellings of ONE link. Both are scanned by the same rule; the
  // `owner` field is what the failure tells the reader to import instead, and
  // it differs, so it cannot be a single string.
  const PREFIXES = [
    {
      prefix: `https://${values.PAIR_HTTPS_HOST}${values.PAIR_HTTPS_PATH}`,
      owner: '`kPairLinkPrefixHttps` (src/ui/scan_payload.dart)',
      from: 'PAIR_HTTPS_HOST + PAIR_HTTPS_PATH',
    },
    {
      prefix: `${values.PAIR_CUSTOM_SCHEME}://${values.PAIR_CUSTOM_HOST}`,
      owner: '`kPairLinkPrefix` (src/ui/scan_payload.dart)',
      from: 'PAIR_CUSTOM_SCHEME + PAIR_CUSTOM_HOST',
    },
  ];

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

  // Read each file once, not once per needle.
  const texts = [];
  for (const abs of files) {
    const text = await readText(abs);
    if (text !== null) texts.push({ abs, text });
  }

  for (const p of PREFIXES) {
    // Immediately preceded by a quote = the start of a hand-typed string literal.
    // A backtick (doc comments quote these URLs constantly) is not a quote here.
    const needle = new RegExp(`['"]${p.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    const hits = [];
    for (const { abs, text } of texts) {
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
          `${hits.length} hand-typed pairing-link literal '${p.prefix}' under ${MOBILE_LIB}: ` +
          `${hits.join(', ')} — that prefix has ONE Dart spelling, ` +
          `${p.owner}, which is generated from ${PROTOCOL_FILE} (${p.from}) by ` +
          'apps/mobile/tool/gen_protocol.mjs. A re-typed copy keeps working until the day the ' +
          'host or the path moves, and then it refuses every QR it is handed while its own ' +
          'tests stay green.',
      };
    }
  }

  return {
    status: 'PASS',
    detail:
      `${files.length} .dart file(s) under ${MOBILE_LIB} hand-type ` +
      `${PREFIXES.map((p) => `'${p.prefix}'`).join(' and ')} zero times; ` +
      `both spellings are generated from ${PROTOCOL_FILE} ` +
      '(PAIR_HTTPS_HOST + PAIR_HTTPS_PATH; PAIR_CUSTOM_SCHEME + PAIR_CUSTOM_HOST) ' +
      'into lib/generated/flowmic_protocol.g.dart',
  };
}
