# Translation brief — mobile catalogue (0.2.67)

You are producing ONE language file for the FlowMic mobile app. Paths below are
relative to the repository root. Your target language is given in the invocation.

## Read first, in this order

1. **`docs/rebuild/17-UI-LOCALE-GLOSSARY.md`** — the terminology lock (§2), the
   do-not-translate list (§3), the Traditional-Chinese rules (§4) and the layout
   risk (§5). It is a behaviour contract, not advice.
2. **`i18n/mobile/leaves.json`** — the key contract (678 keys).
3. **`i18n/mobile/en.json`** — **your source.** English is the base language
   (owner 2026-08-14). `zh-CN.json` is a secondary reference where the English
   is terse. Never translate from `ja.json` / `ko.json`: those are themselves
   machine translations and chaining them multiplies the error.

## Write exactly one file: `i18n/mobile/<code>.json`

Same structure as `en.json`. Every value is **Dart source for a string
literal**, so:

- escaping must stay valid Dart;
- 🔴 interpolation holes (`$name`, `${expr}`) **must survive with the same
  names** — those names are the generated method's signature. You **may reorder
  them** for natural word order; you may not rename, add or drop one.
- some values are **arrays of adjacent literals** (Dart implicit
  concatenation) — keep that shape.

## Rules that are not negotiable

- 🔴 **「投递」 (deliver, phone→PC) and 「注入」 (inject, PC→focused field) are two
  different segments of the pipeline and must use two different word roots.**
  Same for the four state words: *delivered / pending delivery / not delivered /
  not injected*. Conflating any of them violates an owner red line — a user must
  be able to tell "it never reached the PC" from "it reached the PC but was not
  typed in".
- 🔴 **Never translate**: `FlowMic`, `PCID`, the plan names `free`/`pro`/`max`,
  error-code identifiers, and key names such as `Enter`.
- Copy that names an **action the user can take** must still name that action
  after translation. A refusal that becomes vague is a defect, not a style
  choice — it turns a solvable problem into an unsolvable one.
- Prefer the **shorter correct wording**. This copy lives in fixed-width chips,
  single-line rows and three-line cards; the layout budget is real.
- 🔴 **Partial delivery is allowed and expected.** A key you cannot translate
  confidently: **omit it.** It inherits English automatically and is counted in
  `i18n/mobile/coverage.json`. **An omission is honest; a guess is not.** Never
  invent product behaviour you cannot see in the source string.

## Verify before finishing

```
node scripts/i18n/gen-mobile-dart.mjs          # must succeed, prints your coverage
cd apps/mobile && flutter analyze              # must stay 0 errors
cd apps/mobile && flutter test --timeout 90s --reporter compact
```
Baseline for the suite: **2495 passed / 1 skipped / 0 failed**.
A broken escape or a renamed interpolation hole surfaces in `analyze`.

## Discipline

English only for any code comment you write. **Do not `git add`, do not commit,
and never run `git checkout` / `restore` / `stash`** — other lanes are working in
this same tree. No AI attribution anywhere.

## Report

Coverage (n/678); every key you deliberately omitted **and why**; any term where
the glossary's rule was hard to honour in your language; the gate results.
