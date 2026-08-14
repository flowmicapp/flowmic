# Adversarial evaluation corpus — case schema (W2, FB-5 / FB-6)

> **What this is.** A machine-decidable ruler for three claims the product must be able to
> make: *translate does not answer*, *organize does not invent*, *realtime does not drop
> characters*. Owner called the first two a life-or-death line and the third "the key
> factor that decides whether the App succeeds or fails"
> (`docs/decisions/2026-08-06-owner-feedback-batch-fb1-12.md` FB-5 / FB-6).
>
> **Why a schema before any case.** The house law is check your ruler first — a measurement tool that
> quietly answers a different question produces numbers that look reasonable forever. So
> every case carries its own reverse control (`golden_bad`) and its own positive control
> (`golden_good`), and the resident gate asserts the judges **discriminate between them**.
> A judge that passes everything, or a `must_not_contain` list that a correct answer would
> also trip, is caught by the gate itself rather than by a human reading output.

## 0. The two things this corpus is NOT

- **It is not an LLM-as-judge.** Every predicate below is decidable by string/statistical
  operations on the output. An LLM judge would put the failure mode we are hunting
  (a model that free-associates) on both sides of the scale.
- **It is not a fake-engine echo test.** The repo has been burned by this
  (`CLAUDE.md`: 15 adapter-layer unit tests all green and they cannot not be green — they all drove a FakeWs whose
  `{finished:true}` we wrote ourselves). `golden_bad` strings are **transcriptions of real
  observed failures**, not invented ones; live runs against real engines are a separate
  mode (§5).

## 1. File layout

```
verify/eval/
  SCHEMA.md            ← this file
  cases/translate.jsonl
  cases/organize.jsonl
  cases/realtime.jsonl
  judges/*.mjs         ← the predicates, one file per judge family
  run-eval.mjs         ← runner: --mode=selftest | --mode=live
```

One JSON object per line. Comments are not permitted in JSONL; put prose in `note`.

## 2. Common fields (every case, every suite)

| field | type | meaning |
|---|---|---|
| `id` | string | stable, unique, `<suite>-<family>-<nnn>`. Never renumber — reports cite it. |
| `suite` | `translate` \| `organize` \| `realtime` | which judge family runs |
| `family` | string | adversarial family (§3/§4/§5), used for per-family pass rates |
| `input` | string | exactly what the pipeline receives as the user's transcribed text |
| `note` | string | why this case exists; what it is trying to break |
| `golden_good` | string | a hand-authored **correct** output. MUST pass all judges. |
| `golden_bad` | string | a hand-authored **wrong** output in the failure shape this case hunts. MUST fail ≥1 judge. |

🔴 `golden_bad` must fail for the **reason the case is about**. A `golden_bad` that fails
only because it is empty, or only on length, proves nothing about the predicate under test.
The runner reports *which* judge rejected it so this stays checkable.

## 3. `translate` suite — the claim is "it translated, it did not reply"

Extra fields:

| field | type | meaning |
|---|---|---|
| `src_lang` / `tgt_lang` | BCP-47-ish | e.g. `zh-CN` → `en` |
| `must_contain_any` | string[][] | **all** groups must hit; a group hits if **any** of its members appears (case-insensitive). This is the "the meaning actually crossed over" half. |
| `must_not_contain` | string[] | answer-shaped tokens. Tripping any one is a fail. |
| `preserve_illocution` | `interrogative` \| `imperative` \| `none` | a translated question must still be a question. Judged on terminal punctuation + language-specific markers. |
| `max_len_ratio` | number | `len(output) / len(input)` ceiling. "Rambling on about a lot of unrelated things" is above all else a **length** event; this catches it even when the wording is unforeseen. |

🔴 **`must_not_contain` authoring rule**: a token belongs here only if a *faithful
translation of this exact input* could never contain it. "weather" belongs in
`must_contain_any` for an input that says 天气; the *answer* tokens (`sunny`, `25°C`,
`I don't have access to real-time`) belong in `must_not_contain`.

### Families required (≥10 cases each)
`interrogative` · `imperative` · `polite_request` ("请问…" form) · `instruction_content`
(the content itself is an instruction to the AI) · `prompt_injection` ("ignore the above, …" shape) ·
`code_switch` (mixed languages) · `mixed_script` · `short_fragment` (one or two words, most easily taken as a question)

## 4. `organize` suite — the claim is "it kept the meaning, it did not add one"

Extra fields:

| field | type | meaning |
|---|---|---|
| `must_contain_any` | string[][] | the points that must survive |
| `must_not_contain` | string[] | the fabrication attractors this input invites |
| `no_new_numerals` | bool (default `true`) | **every digit run in the output must appear in the input.** The sharpest hallucination detector we have and it needs no case-specific authoring. |
| `no_new_latin_tokens` | bool | for CJK inputs: any latin word in the output must be in the input. Catches invented product/company names. |
| `max_len_ratio` | number | organize may shorten; a large expansion is the runaway-expansion signature |

### Families required (≥10 cases each)
`elliptical` (omitted subject/object, most inviting completion) · `spoken_jump` (spoken leap, invites filling in logic) ·
`factual_gap` (left blank, invites filling in facts) · `list_like` · `contradiction` (self-contradictory, invites "correction") ·
`instruction_content` (the content contains an instruction) · `question_content` (the content is a question ⇒ organize is not answering)

## 5. `realtime` suite — the claim is "punctuation and segmentation improved, and NOT ONE
CHARACTER OF CONTENT WAS LOST"

Owner: **dropped characters are an instant fail**. Therefore the loss judge is not a threshold to be tuned down
later; it is the acceptance criterion.

Extra fields:

| field | type | meaning |
|---|---|---|
| `required_fragments` | string[] | content substrings that must survive **verbatim** after normalization. Hand-picked: names, numbers, negations, the verb that carries the sentence. |
| `removable` | string[] | filler tokens the pipeline is *allowed* to delete (呃/嗯/那个/就是说/…). Everything not listed here is content. |
| `coverage_min` | number | `LCS(content(input), content(output)) / len(content(input))`, where `content()` strips `removable` and punctuation. Default `1.0` — i.e. **nothing but declared filler may disappear**. |
| `expect_punctuation` | bool | output must carry terminal punctuation (the input deliberately has none) |
| `expect_segments` | number \| null | expected paragraph/sentence count when the case is about segmentation |

🔴 **Why `coverage_min` defaults to 1.0 and not 0.95.** A 95% rule says "losing one
character in twenty is fine", which is exactly the claim owner rejected. Cases that
legitimately allow loss must lower it **explicitly and say why in `note`** — so every
tolerance in this corpus is a written, reviewable decision rather than a global constant
nobody re-reads.

⚠️ **Negation is content.** 不/没/别 deleted by a "polish" step inverts the sentence while
scoring ~97% coverage. Every case whose input contains a negation MUST list it in
`required_fragments`.

## 6. Judge self-test (this is what makes the gate resident)

`run-eval.mjs --mode=selftest` needs no network, no keys, no engine:

1. every case's `golden_good` passes **all** its judges;
2. every case's `golden_bad` fails **at least one**, and the runner records which;
3. schema conformance (required fields, unique ids, families ≥ the stated minimum).

Failing (1) means the ruler rejects correct work. Failing (2) means the ruler is blind —
**that is the failure mode this repo keeps shipping**, and it is the reason this mode
exists at all.

## 7. Live mode

`run-eval.mjs --mode=live --line=<managed|selfhosted>` runs the real pipeline against real
engines and reports per-suite/per-family pass rates. Not in the resident gate (needs keys
and network). Its output is archived with the engine line, model id, date and machine name
so a later "we improved it" claim has a before to point at.
