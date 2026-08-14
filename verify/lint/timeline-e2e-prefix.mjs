// verify/lint/timeline-e2e-prefix.mjs
// Timeline write-path enc: prefix ban — the double-prefix red line, as a gate.
//
// 🔴 NO LONGER A STUB (card E-CL, 2026-08-08). The stub reserved this slot with a
// condition written into its own header: "when the write path lands, this lint must assert that no
// e2e:v1: blob is coerced into a server-decryptable enc:v1: form". The write path landed
// (apps/mobile/lib/src/timeline/cloud/), so the condition is met and the slot is
// now a real assertion. Design §5 spells out the three properties to pin:
//   1. no e2e:v1: blob is coerced into enc:v1: on the cloud sync write path;
//   2. the reverse is equally banned — no enc:v1: value may enter timeline_blobs;
//   3. 🔴 the two envelope implementations must not share a code path.
//
// ── WHAT THIS ACTUALLY DEFENDS AGAINST ──────────────────────────────────────
// Not a typo. Book 05 §2's "the two prefixes never interchange" exists because `enc:v1:` (server-
// decryptable, key = SHA-256(deployment secret), apps/server-core/src/auth/
// crypto.ts) and `e2e:v1:` (server-blind, key = Argon2id(user passphrase)) are
// nearly identical in shape: both AES-256-GCM, both nonce(12)‖tag(16)‖ct, both
// base64, both prefixed. The failure mode is a REFACTOR that merges them into
// one "generic envelope helper", after which one wrong argument produces
// server-readable bytes that still carry the `e2e:v1:` prefix — and every
// existing guard still passes, because `assertE2ePrefix` (timeline.repo.ts) and
// the `E2eCiphertext` zod type both check the literal prefix and NOTHING else.
// They are namespace markers, not cryptographic validators.
//
// So the properties below are all STRUCTURAL: how many places exist, and which.
// A gate that could only see one blob at a time could not see this coming.
//
// ── WHY IT STRIPS COMMENTS FIRST, AND WHY THAT IS NOT A DETAIL ──────────────
// The blind-store sources DISCUSS `enc:v1:` at length — that prose is the
// argument for why the two implementations are separate, and it is the most
// valuable text in the directory. Two of those comments quote the string. A
// scanner that could not tell code from prose would therefore have been born RED
// on the very tree it was written for, and the repo's own rule says a gate that
// starts red gets ignored by the next day. It parses Dart string/comment state
// instead, so it bans the LITERAL and leaves the argument alone.

import path from 'node:path';
import { ROOT, walk, readText, rel } from './_util.mjs';

export const name = 'timeline-e2e-prefix';

const MOBILE_LIB = path.join(ROOT, 'apps', 'mobile', 'lib');
const PROTOCOL_CONSTANTS = path.join(
  ROOT,
  'packages',
  'protocol',
  'src',
  'constants.ts'
);

// The directories that implement the blind store. `enc:v1:` must never appear as
// a literal in either.
const BLIND_STORE_DIRS = [
  'apps/mobile/lib/src/crypto',
  'apps/mobile/lib/src/timeline/cloud',
];

// The one file allowed to build an `e2e:v1:` value (prefix + payload).
const ENVELOPE_FILE = 'apps/mobile/lib/src/crypto/blind_store_envelope.dart';
// The one file allowed to declare the prefix literal.
const PREFIX_FILE = 'apps/mobile/lib/src/crypto/blind_store_params.dart';

/**
 * Replace Dart comments with spaces, leaving string literals intact.
 *
 * Offsets are preserved (comment characters become spaces) so a future caller
 * could still report a line number. Handles //, nested block comments, single
 * and double quotes, triple-quoted strings, raw strings and backslash escapes.
 * `${...}` interpolation is treated as ordinary string content: a comment inside
 * an interpolation is not a thing this repo writes, and treating it as string
 * content can only make the scanner MORE conservative (it would see more, never
 * less).
 */
function stripDartComments(src) {
  const out = Buffer.from(src, 'utf8').toString('utf8').split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (src[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // line comment
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // block comment (Dart nests them)
    if (c === '/' && c2 === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // string literal — skip over it verbatim
    if (c === "'" || c === '"' || (c === 'r' && (c2 === "'" || c2 === '"'))) {
      let j = c === 'r' ? i + 1 : i;
      const raw = c === 'r';
      const q = src[j];
      const triple = src[j + 1] === q && src[j + 2] === q;
      j += triple ? 3 : 1;
      while (j < n) {
        if (!raw && src[j] === '\\') {
          j += 2;
          continue;
        }
        if (triple) {
          if (src[j] === q && src[j + 1] === q && src[j + 2] === q) {
            j += 3;
            break;
          }
        } else if (src[j] === q || src[j] === '\n') {
          j += 1;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Every quoted occurrence of `needle` in already-comment-stripped Dart. */
function countLiteral(code, needle) {
  let n = 0;
  for (const q of ["'", '"']) {
    let from = 0;
    for (;;) {
      const at = code.indexOf(q + needle, from);
      if (at < 0) break;
      n++;
      from = at + 1;
    }
  }
  return n;
}

function inDirs(relPath, dirs) {
  return dirs.some((d) => relPath === d || relPath.startsWith(`${d}/`));
}

export default async function run() {
  const failures = [];

  // The protocol's constant is the admission check the server enforces; the
  // mobile constant is what the phone emits. Read the TypeScript rather than
  // restating the string, so a change on either side is a red gate and not a
  // silent divergence (the mirror technique inject_verdict_authorship uses).
  const protoSrc = await readText(PROTOCOL_CONSTANTS);
  if (protoSrc == null) {
    return {
      status: 'FAIL',
      detail: `cannot read ${rel(PROTOCOL_CONSTANTS)} — the prefix contract has no source of truth`,
    };
  }
  const protoMatch = protoSrc.match(
    /export const TIMELINE_E2E_PREFIX\s*=\s*'([^']+)'/
  );
  if (!protoMatch) {
    return {
      status: 'FAIL',
      detail: 'TIMELINE_E2E_PREFIX not found in packages/protocol/src/constants.ts',
    };
  }
  const prefix = protoMatch[1];

  let dartFiles = 0;
  let prefixDecls = 0;
  let pushEmitters = [];
  let envelopeBuilders = [];

  for (const abs of await walk(MOBILE_LIB)) {
    if (!abs.endsWith('.dart')) continue;
    const r = rel(abs).replaceAll('\\', '/');
    if (r.endsWith('.g.dart')) continue; // codegen: the whitelist, not a write path
    const src = await readText(abs);
    if (src == null) continue;
    dartFiles++;
    const code = stripDartComments(src);

    // ── 1. the e2e:v1: literal exists in exactly one place ──────────────────
    const e2e = countLiteral(code, prefix);
    if (e2e > 0) {
      prefixDecls += e2e;
      if (r !== PREFIX_FILE) {
        failures.push(
          `${r}: declares the '${prefix}' literal; it must exist only in ${PREFIX_FILE} ` +
            `(a second spelling is a second contract)`
        );
      }
    }

    // ── 2. enc:v1: must not be a literal anywhere in the blind store ────────
    if (inDirs(r, BLIND_STORE_DIRS)) {
      const enc = countLiteral(code, 'enc:v1:');
      if (enc > 0) {
        failures.push(
          `${r}: contains ${enc} 'enc:v1:' string literal(s) in CODE — the ` +
            `double-prefix red line (05 册 §2). Prose about it is fine; a value is not`
        );
      }
    }

    // ── 3. one write path ───────────────────────────────────────────────────
    if (code.includes('FlowMicEvents.timelinePush')) pushEmitters.push(r);

    // ── 4. one envelope builder ─────────────────────────────────────────────
    // Only the sealer may CONCATENATE the prefix onto a payload. Everywhere else
    // may compare against it (startsWith / substring), which is a guard, not a
    // producer.
    if (/kBlindStoreEnvelopePrefix\s*\+/.test(code)) envelopeBuilders.push(r);
  }

  if (dartFiles === 0) {
    return {
      status: 'FAIL',
      detail: `no Dart files under ${rel(MOBILE_LIB)} — the scan is blind, which is not the same as clean`,
    };
  }
  if (prefixDecls === 0) {
    failures.push(
      `the '${prefix}' literal is declared nowhere in apps/mobile/lib — either the ` +
        `blind store lost its prefix or this lint stopped being able to see it`
    );
  }

  if (pushEmitters.length === 0) {
    // Not a SKIP. The write path exists in this tree; if it stops existing, that
    // is a regression to report, not a reason to stand down.
    failures.push(
      'nothing in apps/mobile/lib emits FlowMicEvents.timelinePush — the blind-store ' +
        'write path is gone (this lint stopped being a stub when it landed)'
    );
  } else if (pushEmitters.length > 1) {
    failures.push(
      `${pushEmitters.length} files emit timeline:push (${pushEmitters.join(', ')}) — ` +
        `there must be exactly one write path, because a second producer is how the ` +
        `red line actually gets crossed`
    );
  } else {
    // The single write path must refuse anything not carrying the prefix BEFORE
    // it reaches the wire. Losing this check is losing the client-side half of
    // the red line, and the server's identical-looking check does not replace it
    // (that one protects the server's namespace, this one protects the user).
    const emitter = path.join(ROOT, pushEmitters[0]);
    const src = await readText(emitter);
    const code = src == null ? '' : stripDartComments(src);
    if (!code.includes('startsWith(kBlindStoreEnvelopePrefix)')) {
      failures.push(
        `${pushEmitters[0]}: emits timeline:push without a ` +
          `startsWith(kBlindStoreEnvelopePrefix) guard on the outgoing ciphertext`
      );
    }
  }

  if (envelopeBuilders.length !== 1 || envelopeBuilders[0] !== ENVELOPE_FILE) {
    failures.push(
      `the '${prefix}' prefix is concatenated onto a payload in ` +
        `[${envelopeBuilders.join(', ') || 'nowhere'}] — it must be exactly ` +
        `${ENVELOPE_FILE} (design §5-3: the two envelope implementations must not ` +
        `share, or grow, a code path)`
    );
  }

  if (failures.length > 0) {
    return { status: 'FAIL', detail: failures.join(' | ') };
  }
  return {
    status: 'PASS',
    detail:
      `${dartFiles} dart file(s): one '${prefix}' declaration, one write path ` +
      `(${pushEmitters[0]}), one envelope builder, zero 'enc:v1:' literals in the blind store`,
  };
}
