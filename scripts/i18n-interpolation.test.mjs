#!/usr/bin/env node
// Probes for scripts/i18n/interpolation.mjs — the parser the 0.2.67 mobile
// catalogue migration reads every one of its 690 strings through.
//
// WHY THIS FILE EXISTS. The migration's own golden (447 getters x 4 locales)
// proves the RESULT, and it is the real gate. But it can only speak about
// members that exist today: the strings it walks are the ones that came out
// intact. A literal this parser mis-slices does not usually produce a wrong
// string — it produces a Dart file that does not compile, which is loud, or an
// interpolation quietly turned into text, which is not. These probes pin the
// second kind, and they run wherever `scripts/*.test.mjs` runs, so they have a
// caller (CLAUDE.md: 「测试写了没人叫 = façade 的运行时版」).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitLiteral, renderLiteral, paramNameFor, planEntry } from './i18n/interpolation.mjs';
import { convert } from './i18n/gen-i18n-web.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function ok(cond, what) {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${what}`);
  }
}
function eq(got, want, what) {
  ok(got === want, `${what}${got === want ? '' : `\n         got:  ${got}\n         want: ${want}`}`);
}

console.log('splitLiteral / renderLiteral');
{
  const idem = (src) => renderLiteral(splitLiteral(src), (e) => e);
  // Round-tripping with an identity map must reproduce the source BYTE FOR BYTE.
  // This is the property the whole migration rests on: nothing is re-encoded.
  for (const src of [
    "'plain'",
    '"double"',
    "r'raw \\n not an escape'",
    "'escaped \\\\$ dollar'",
    "'还有 $n 条'",
    "'${age.inHours} 小时前'",
    "'${outcome.detail ?? '未知原因'}'",
    "'$n match${n == 1 ? '' : 'es'}'",
    "'${t.hour.toString().padLeft(2, '0')}:${t.minute}'",
    "'a\\nb\\tc \\u{1F600}'",
    "'trailing \$'",
  ]) {
    eq(idem(src), src, `identity round-trip: ${src}`);
  }

  const raw = splitLiteral("r'$notAHole'");
  ok(raw.parts.length === 1 && raw.parts[0].kind === 'text', 'a raw string has no interpolation');

  const esc = splitLiteral("'\\$notAHole'");
  ok(esc.parts.length === 1 && esc.parts[0].kind === 'text', 'an escaped $ is not interpolation');

  const bare = splitLiteral("'$n条'");
  ok(
    bare.parts.length === 2 && bare.parts[0].expr === 'n',
    'a bare $name stops at the first non-identifier byte (CJK included)',
  );

  // 🔴 The one substitution that must NOT keep the bare form: `${n}abc` would
  // re-parse as the identifier `nabc`.
  eq(
    renderLiteral(splitLiteral("'${n}abc'"), () => 'n'),
    "'${n}abc'",
    'a braced hole stays braced even when the name is unchanged',
  );
  eq(
    renderLiteral(splitLiteral("'$n abc'"), () => 'count'),
    "'${count} abc'",
    'a renamed bare hole becomes braced',
  );
}

console.log('paramNameFor');
{
  eq(paramNameFor('why'), 'why', 'bare identifier');
  eq(paramNameFor('age.inHours'), 'ageInHours', 'dotted access');
  eq(paramNameFor('r.added'), 'rAdded', 'short receiver');
  eq(paramNameFor('formatBytes(bytes)'), 'formatBytesBytes', 'call with an argument');
  eq(paramNameFor("outcome.detail ?? '未知原因'"), 'outcomeDetail', 'localised text never enters the name');
  eq(paramNameFor("'literal only'"), 'value', 'nothing tokenisable falls back to a name');
  eq(paramNameFor('in'), 'inValue', 'a Dart keyword is escaped');
}

console.log('planEntry');
{
  const arms = ['zh', 'en', 'ja', 'ko'];
  const lit = (s) => [s];

  const plain = planEntry(
    { arms: { zh: lit("'中'"), en: lit("'En'"), ja: lit("'日'"), ko: lit("'한'") } },
    arms,
    'en',
  );
  eq(plain.kind, 'getter', 'no interpolation -> getter');

  // 🔴 The word-order case. zh puts the count last, en puts it first; matching
  // by position would swap them.
  const reordered = planEntry(
    {
      arms: {
        zh: lit("'$b 的 $a'"),
        en: lit("'$a of $b'"),
        ja: lit("'$b の $a'"),
        ko: lit("'$b 의 $a'"),
      },
    },
    arms,
    'en',
  );
  eq(reordered.kind, 'method', 'interpolation -> method');
  eq(reordered.params.map((p) => p.name).join(','), 'a,b', 'declared order comes from the base arm');
  eq(reordered.bodies.zh[0], "'$b 的 $a'", 'the zh arm keeps ITS order, unchanged');

  const renamed = planEntry(
    {
      arms: {
        zh: lit("'${age.inHours} 小时前'"),
        en: lit("'${age.inHours} hr ago'"),
        ja: lit("'${age.inHours}時間前'"),
        ko: lit("'${age.inHours}시간 전'"),
      },
    },
    arms,
    'en',
  );
  eq(renamed.params[0].name, 'ageInHours', 'a complex expression becomes one parameter');
  eq(renamed.params[0].expr, 'age.inHours', 'the call site still passes the ORIGINAL expression');
  eq(renamed.bodies.ja[0], "'${ageInHours}時間前'", 'each arm is rewritten to the parameter');

  const disagree = planEntry(
    {
      arms: {
        zh: lit("'$n 条'"),
        en: lit("'$n match${n == 1 ? '' : 'es'}'"),
        ja: lit("'$n 件'"),
        ko: lit("'$n개'"),
      },
    },
    arms,
    'en',
  );
  eq(disagree.kind, 'skip', 'an English-only plural rule is refused, not hoisted');

  const collide = planEntry(
    {
      arms: {
        zh: lit("'${a.x} ${b.x}'"),
        en: lit("'${a.x} ${b.x}'"),
        ja: lit("'${a.x} ${b.x}'"),
        ko: lit("'${a.x} ${b.x}'"),
      },
    },
    arms,
    'en',
  );
  eq(collide.params.map((p) => p.name).join(','), 'aX,bX', 'distinct expressions get distinct names');

  const computed = planEntry(
    { arms: { zh: lit("'中'"), en: { expression: 'label' }, ja: lit("'日'"), ko: lit("'한'") } },
    arms,
    'en',
  );
  eq(computed.kind, 'skip', 'an arm that is a bare expression while the others are not is refused');
}

console.log('web convert() wrapped adjacent literals');
{
  // Phone rendering of en#spokenLangNote, obtained by running Dart on the two
  // pieces copied verbatim from i18n/mobile/en.json (adjacent literals, no
  // separator). Command: `dart run .local/genfix-phone-render.dart`.
  const PHONE_EN =
    'Used on both connections. When you are connected to your own computer, it uses its local model for this language and tells you if it has none.';

  const en = JSON.parse(readFileSync(join(REPO, 'i18n', 'mobile', 'en.json'), 'utf8'));
  const pieces = en.strings.spokenLangNote;
  ok(Array.isArray(pieces) && pieces.length >= 2, 'en#spokenLangNote is stored as a wrapped pair');

  const { text, params } = convert(pieces, 'en#spokenLangNote');
  eq(text, PHONE_EN, 'wrapped en#spokenLangNote is byte-identical to the phone render');
  ok(params.length === 0, 'spokenLangNote has no placeholders');

  // Placeholders live in separate pieces of one sentence. Converting each
  // piece and concatenating must keep both holes and first-seen param order.
  const holes = convert(["'Hello $name, '", "'you have $n left'"], 'synth#holes');
  eq(holes.text, 'Hello {name}, you have {n} left', 'holes in separate pieces become one sentence');
  eq(holes.params.join(','), 'name,n', 'params are first-seen across pieces, not reordered');

  eq(convert("'plain'", 'synth#plain').text, 'plain', 'a single literal still converts');

  // zh-CN authors this key as one literal — the other shape the same key takes.
  const zh = JSON.parse(readFileSync(join(REPO, 'i18n', 'mobile', 'zh-CN.json'), 'utf8'));
  ok(typeof zh.strings.spokenLangNote === 'string', 'zh-CN#spokenLangNote is a single literal');
  const zhOut = convert(zh.strings.spokenLangNote, 'zh-CN#spokenLangNote');
  eq(
    zhOut.text,
    // Repointed 2026-09-11 at the zh-CN copy rewrite (0cd113bb / 8420cf7a).
    // The probe is about the SHAPE (one literal converts like a wrapped pair),
    // not about the sentence, so the fixture follows the catalogue verbatim.
    '所有连接通道均依据此处所选语种识别。连接电脑端时将优先使用对应的本地离线模型，若未配置将给予提示。',
    'a single-literal locale still converts',
  );
}

console.log(failures === 0 ? '\nOK i18n interpolation probes' : `\nFAILED ${failures} probe(s)`);
process.exit(failures === 0 ? 0 : 1);
