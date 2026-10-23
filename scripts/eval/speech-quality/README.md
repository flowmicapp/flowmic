# Speech-quality eval harness (EVAL-1)

A repeatable measurement of what a user gets from one dictation: Soniox
recognition accuracy, what the realtime polish (Strict / Smooth) does to it, and
how long each step takes. English first, plus Chinese and mixed Chinese/English.
Use it before and after any change to the STT config, the polish prompt or the
polish guard, so the change is measured instead of guessed.

**This is not a gate.** Every runner except `score.mjs` calls a paid external
API (Soniox, DeepSeek). Do not add any of it to `verify:*`, `ship`, CI or a
pre-commit hook.

## Files

| file | what it does | cost |
|---|---|---|
| `corpus.json` | 110 utterances: 60 English, 30 Chinese, 20 mixed. Fields: `id`, `lang`, `voice`, `speak_text` (what the TTS says), `reference` (verbatim of what was said, fillers and spoken punctuation words included), `polish_expect` (per-strength `must` / `must_not`), `terms` (exact case), `tags`, and optional `numbers` (groups of accepted forms), `fillers`, `contractions`, `spoken_punct` (`{cmd, sym}`). `variants` lists the quiet-onset and noise subset. | none |
| `gen-audio.mjs` | Renders each item with macOS `say` on the Mac mini (`ssh flowmic-mac`) as WAV 16 kHz mono s16le, pulls them back, and synthesises the variants locally: 1.5 s and 3 s of leading silence, and white noise at 20 dB SNR. Only re-renders items whose voice or text changed. | none (Mac CPU) |
| `run-stt.mjs` | Streams WAVs through the product's `SonioxEngine` (`@flowmic/stt-cloud` dist) in 200 ms chunks at real-time pace, then `flush()` (the phone's release). Records final text, the product pipeline's version of it, time to first token, release-to-final, raw final tokens and the config frame actually sent. | Soniox audio-seconds |
| `run-polish.mjs` | Runs STT finals (and the references) through the product's `polishFinalText`, Strict and Smooth, with the LLM config from the product's `managedLlmConfig` pointed at DeepSeek. Records outcome, the guard's reason, the delivered text, the model's candidate (also when the guard discarded it), and latency. | DeepSeek calls |
| `score.mjs` | Pure local scoring; writes a markdown report. | none |
| `lib.mjs` | Paths, secrets, WAV I/O, the production-source bundle, the usage ledger. | |

Data lives in the main checkout's `.local/` (gitignored), whichever worktree you
run from: audio in `.local/eval-audio/`, results and reports in
`.local/eval-speech/`. Override with `FLOWMIC_EVAL_DATA`. Audio is TTS today;
real recordings belong in the same folder, never in the repo.

## Run

```sh
node scripts/refresh-derived.mjs --lane          # builds the stt-cloud dist run-stt imports
node scripts/eval/speech-quality/gen-audio.mjs
R=../flowmic-app/.local/eval-speech               # or wherever dataRoot() resolves
node scripts/eval/speech-quality/run-stt.mjs --config hints --concurrency 5 --out $R/base-stt-hints.jsonl
node scripts/eval/speech-quality/run-stt.mjs --config hints --variants only --out $R/base-stt-hints-variants.jsonl
node scripts/eval/speech-quality/run-stt.mjs --config ctx        --tags jargon,names --lang en,mixed --not-tags long_ramble --out $R/base-stt-ctx.jsonl
node scripts/eval/speech-quality/run-stt.mjs --config ctx-struct --tags jargon,names --lang en,mixed --not-tags long_ramble --out $R/base-stt-ctx-struct.jsonl
node scripts/eval/speech-quality/run-polish.mjs --stt $R/base-stt-hints.jsonl --out $R/base-polish.jsonl
node scripts/eval/speech-quality/score.mjs --prefix base            # -> $R/base-report.md
```

Comparing another lane's polish against main: point `--server-core` at that
lane's `apps/server-core` (the source is bundled with esbuild, no build needed),
reuse the same STT file, and give the output a new prefix:

```sh
node scripts/eval/speech-quality/run-polish.mjs --stt $R/base-stt-hints.jsonl \
  --server-core ../flowmic-app-worktrees/lane-b/apps/server-core --out $R/laneb-polish.jsonl
node scripts/eval/speech-quality/score.mjs --prefix laneb --stt $R/base-stt-hints.jsonl
```

Every runner takes `--ids a,b`, `--dry-run` prints the plan and its cost.
`run-stt` also takes `--tags`, `--not-tags`, `--lang`, `--variants no|yes|only`,
`--endpoint`, `--stt-cloud <dir>`; `run-polish` takes `--sources stt,ref`,
`--strengths strict,smooth`, `--model`, `--endpoint`.

STT config variants:

- `hints`: what production sends a user with no terminology configured
  (`buildConfigFrame`: `language_hints` only).
- `ctx`: plus the product's `context` string from `buildSonioxContext`, over a
  simulated dictionary made of every `terms` entry in the corpus (90 terms).
- `ctx-struct`: the same term list in Soniox's documented object form
  (`context: { terms: [...] }`). The product cannot send this today
  (`SttEngineConfig.context` is a string), so the harness rewrites that one
  field of the first frame on its way to the socket.

### Card CTX-1: default context configs

- `default --size N`: the product's coding default only (`CODING_DEFAULT_TERMS`
  in `apps/server-core/src/stt/coding-terms.ts`, first N terms, built by the
  product's `assembleSonioxContext`). This is what a user with no dictionary
  gets when the target PC has an editor or terminal focused.
- `merged --size N`: the simulated dictionary first, then the default, under
  one total cap of N terms.
- `domain`: no terms, only `context.general` (domain/topic pairs). The product
  cannot send this today.

`compare-ctx.mjs` scores any of these against `base-stt-hints.jsonl`, split into
jargon (tagged `jargon` or `names`) and control items, and lists the items each
config made worse:

```sh
node scripts/eval/speech-quality/run-stt.mjs --config default --size 150 --tags jargon,names --lang en,mixed --not-tags long_ramble --out $R/ctx1-stt-default150.jsonl
node scripts/eval/speech-quality/run-stt.mjs --config default --size 150 --not-tags jargon,names,long_ramble --out $R/ctx1-stt-default150-controls.jsonl
node scripts/eval/speech-quality/compare-ctx.mjs --base base-stt-hints.jsonl d150=ctx1-stt-default150.jsonl d150c=ctx1-stt-default150-controls.jsonl
```

Measured 2026-10-13 (19.2 audio-min): 50, 150 and 300 terms on English jargon
were within run-to-run noise of each other (15 / 17 / 18 edits against 24 with
no context); only 150 and 300 helped the mixed items (3 edits against 6); 150
did not hurt the 56 controls (en 16 -> 11 edits, zh 2 -> 2). `domain` alone
helped English less (16 edits) and mixed not at all. The product ships 150.
The list now holds only those 150, so `--size` above 150 measures nothing new;
the 300-term run used the longer list in the card's first commit. Caveat: the
list was written by someone who had read this corpus, and 41 of its 150 terms
are corpus terms; read the gain on jargon as an upper bound for real speech.

## Cost of one full run

Measured on 2026-10-13: the commands above stream **18.5 audio-minutes**
(9.3 base + 2.8 variants + 3.1 + 3.1 context subsets) and make **440 LLM
calls** (about 145k input and 7k output tokens on `deepseek-v4-flash`). Wall
time is about 10 minutes at concurrency 5.

Every Soniox second and LLM call is appended to `.local/eval-speech/usage-ledger.jsonl`.
A run that would take the ledger past `FLOWMIC_EVAL_SONIOX_CAP_SEC` (default
1500 s) or `FLOWMIC_EVAL_LLM_CAP` (default 600) refuses to start; pass
`--allow-over` deliberately, or start a fresh ledger for a new card.

## Keys and endpoints

- Soniox: `SONIOX_API_KEY` from `.local/soniox.env`, the TEST project key. Never
  the production key. That key's project is in Soniox's **JP region**: it is
  refused with 401 on `stt-rt.soniox.com` and `stt-rt.eu.soniox.com` and accepted
  on `stt-rt.jp.soniox.com` (measured 2026-10-13), so `run-stt` defaults to the
  JP endpoint. Production's NY relay uses the global endpoint.
- DeepSeek: `FLOWMIC_DEEPSEEK_API_KEY` from `.local/deepseek.env`. The vendor
  body is production's (`{"thinking":{"type":"disabled"}}`).
- Neither key is ever printed or written to a result file.

## What each metric means, and what it cannot see

| metric | definition | blind spots |
|---|---|---|
| WER / CER / MER | Edit distance / reference length. English: words. Chinese: Han characters. Mixed: Han characters plus Latin words as single tokens. Lower case, punctuation removed, fillers (um, uh, er, hmm, 嗯, 呃) removed from both sides. Number formats listed in an item's `numbers` are mapped to the reference's form first, and spoken punctuation command words are removed from both sides (they have their own metric). | Blind to punctuation and casing. A number format that is not listed counts as an error (zh-07's "2点" vs "两点"). Mixed spacing is invisible. Micro-averaged, so long items weigh more. |
| terms exact / any-case | Share of `terms` present as exact substrings (and ignoring case). The gap between the two is pure casing. | Substring: "Redis" inside "Redistribute" would count. Says nothing about where the term landed. |
| numbers | Share of `numbers` groups where any accepted form appears. | Substring match: a short number like "5" can be satisfied by another number in the sentence. |
| contractions | Share of listed contractions present as words. | Does not penalise extra expansions elsewhere. |
| spoken punct converted | A command (`comma`, `new line`, ...) counts as converted when the command word appears fewer times than in the reference AND its symbol is present. | The symbol may come from ordinary punctuation, not the command (a `.` is almost always present). The polish prompts never ask for command conversion, so this measures what the engine and the model do unprompted. |
| filler-free items | Items with `fillers` whose output contains none of them. | Only listed fillers; Strict is not supposed to remove them, so a low Strict number is expected. |
| first word wrong | English: the first reference word is not among the first 3 output words. Chinese and mixed: the first two reference tokens are not in the first 5 output tokens. | A proxy, not an onset detector: a misheard first word ("Satya" -> "Saadir") and an expanded contraction ("They're" -> "They are") both count. Use the variant table (same text, more silence) to see onset loss as such. |
| TTFT | Wall time from the first audio chunk to the first non-control token. `from speech` subtracts the known leading silence. | TTS audio starts speaking within about 100 ms; real speech has its own onset. Measured from this machine to Soniox JP, not from the NY relay. |
| release→final | Wall time from the moment the last chunk is due (the user releases) to the engine's final. | Same network caveat. |
| polish outcome | `applied` (changed text accepted), `applied_unchanged` (model echoed), `guard_reject` + check name, `timeout`, `llm_error`, `empty_output`, `model_rejected`. | One sample per call; the model is not deterministic, so a single item flipping between runs is noise. |
| error vs reference (polish) | The same edit distance on the delivered text. | For Smooth a resolved self-correction is correct but raises this number. |
| expectations met | `polish_expect.<strength>` `must` / `must_not` checks. | Only on the 13 items that carry expectations. |
| latency (polish) | `polishFinalText`'s own elapsed time. | DeepSeek reached from this machine, not from NY. Budget is 2,000 ms + 20 ms/char, capped at 6,000 ms. |

General limits: the audio is synthetic (macOS voices; clean, evenly paced, no
room acoustics), so absolute error rates are optimistic and tell you about
direction, not about a real user's day. The simulated dictionary for `ctx` is
exactly the set of terms being scored, which is the best case for context; a
real user's dictionary is partial. `score.mjs` honours `EVAL_DEBUG_ID=<id>` to
print the token streams it compared for one item.

## Through a local relay (EVAL-2)

`run-relay.mjs` streams the same WAVs through a LOCAL server-core end to end,
so the numbers include our own pipeline (VAD gate and pre-roll, the 3 s idle
hang-up and redial, leg merge, final-text normalizer, dictionary replace,
realtime polish), not just Soniox.

- Each worker starts one `apps/server-core/dist` process (`relay-server.mjs`):
  standalone mode on 127.0.0.1, a throwaway FLOWMIC_HOME and database under
  `<results>/relay-runs/<stamp>/`, managed Soniox (TEST key, JP endpoint) and
  managed DeepSeek set only in that child's environment; no FLOWMIC_* or
  SONIOX* variable is inherited from your shell. `FLOWMIC_STT_CLOUD_MODULE`
  points at `packages/stt-cloud/dist/index.cjs` because a lane worktree has no
  node_modules link for the private adapter. Nothing touches a production relay.
- A PC and a phone are paired with the golden-path helper
  (`verify/golden/harness.mjs` `registerAndPair`). The phone sends what
  apps/mobile sends: `audio:start` with `prefs.stt.polish`, 200 ms base64
  `audio:chunk` frames at real-time pace, the residual tail and `audio:stop` on
  release, then one `inject:request` built from the finals the way
  `segment_buffer.dart` joins them. The PC timestamps the `inject:request`,
  injects nothing, and answers `inject:result ok` so the relay prints its
  `latency.segment` line.
- The relay caches polish results per process, so a worker restarts its relay
  before it would repeat an item. `relay_seq` 0 marks a relay's first (cold)
  utterance.

Scenarios: `base` (the TTS file; speech starts within 10 ms, so it is also the
"speech at t=0" case), `onsetN` (lead trimmed, then N s of digital silence),
`midpauseN` (N s of silence inserted at the word gap nearest the middle, found
from EVAL-1's token timing, so `base-stt-hints.jsonl` must exist), `noise20`.
Polish strengths `strict`, `smooth`, or `off` (polish disabled: shows the raw
relay text).

```sh
node scripts/eval/speech-quality/run-relay.mjs --dry-run              # plan and cost
node scripts/eval/speech-quality/run-relay.mjs --prefix relay         # baseline plan, about 16 min wall
node scripts/eval/speech-quality/run-relay.mjs --prefix seam --scenarios midpause4 --strengths off --ids en-jar-01,en-jar-08
node scripts/eval/speech-quality/score-relay.mjs --prefix relay --runs relay-runs.jsonl,seam-runs.jsonl
```

Options: `--server-core <dir>` (another lane's build; its `dist/` is run, so
build it first) and `--stt-cloud <dir>`, `--ids`, `--lang`, `--scenarios`,
`--strengths`, `--concurrency`, `--keep-home`, `--endpoint`, `--model`.
`score-relay.mjs --latency a.jsonl,b.jsonl` takes the latency section from
other files than the text sections.

Its own ledger is `relay-usage-ledger.jsonl` (a card may name its own with `FLOWMIC_EVAL_RELAY_LEDGER`; each record counts the polish calls the relay actually made, and `--llm-tap` records the vendor's token usage per call) (caps: `FLOWMIC_EVAL_SONIOX_CAP_SEC`
default 1200 s streamed, `FLOWMIC_EVAL_LLM_CAP` default 500). The streamed
figure is an upper bound: the relay's VAD gate does not send silence to Soniox
(`audio intake.gatedMs` in each record is what was fed).

What the extra metrics mean and what they cannot see:

| metric | definition | blind spots |
|---|---|---|
| first interim from speech | First non-empty `stt:interim` at the phone minus the time speech starts in the audio. | Includes the Soniox connect made at `audio:start` (JP endpoint from this machine) and up to 200 ms of chunking. |
| idle hang-ups | Utterances with an `stt.cut kind:hangup` line in the relay log. | Log lines are matched to an utterance by arrival time; one relay runs one utterance at a time, so this is exact at any concurrency. |
| lost around pause | Reference words in [2 before, 2 after] the split that the delivered text does not reproduce, only where the same item's base run got them right. Glued words ("Kubernetes.And") are split first. | The split's word index comes from EVAL-1's tokens, not a forced alignment; one-word drift is possible. |
| seam glued | The delivered text has `.X`, `!X`, `—X` with no space where the base run had none. | Only Latin script; a CJK seam needs no space and is not checked. |
| release→final / release→PC | Phone release to the terminal `stt:final` at the phone / to the `inject:request` at the PC. Both ends are this process, one clock. | The real phone writes its outbox before sending; the simulated one does not, so phone turnaround is a lower bound. |
| vendor flush | The relay's own `stt.cut kind:stop flush_ms`. | |
| relay turnaround | The relay's `latency.segment.phone_turnaround_ms`. A simulated phone answers in about 0 ms, so a large value is a stalled event loop. | |

⚠️ Read latency only from runs at `--concurrency 1` (the default). On
2026-10-13, with three workers on a loaded machine, 34 of 136 utterances
showed a relay turnaround of 80 to 1800 ms; the same items one at a time read
1 to 6 ms. Every record carries `harness_loop_delay_max_ms` so the ruler can be
checked. Text results did not depend on it.

## Card ML-0: French, Spanish, German, Japanese, Korean, Russian

A separate corpus and scorer, so the EVAL-1 numbers above cannot move when this
part changes. Every runner selects the corpus through one environment variable;
give the card its own usage ledger the same way:

```sh
export FLOWMIC_EVAL_CORPUS=corpus-ml.json FLOWMIC_EVAL_LEDGER=ml0-usage-ledger.jsonl
export FLOWMIC_EVAL_SONIOX_CAP_SEC=2100 FLOWMIC_EVAL_LLM_CAP=900
node scripts/eval/speech-quality/fleurs-fetch.mjs --n 10            # real voices, see below
node scripts/eval/speech-quality/gen-audio.mjs                      # TTS items only
node scripts/eval/speech-quality/run-stt.mjs --config hints --concurrency 6 --out $R/ml0-stt-hints.jsonl
node scripts/eval/speech-quality/run-stt.mjs --config default --size 150 --tags jargon --out $R/ml0-stt-default150.jsonl
node scripts/eval/speech-quality/run-polish.mjs --stt $R/ml0-stt-hints.jsonl --ref-not-tags fleurs --out $R/ml0-polish.jsonl
node scripts/eval/speech-quality/run-compose.mjs --stt $R/ml0-stt-hints.jsonl --ids fr-ram-01,... --out $R/ml0-compose.jsonl
node scripts/eval/speech-quality/run-guard-pairs.mjs                # local, no cost
node scripts/eval/speech-quality/score-ml.mjs --prefix ml0          # -> $R/ml0-report.md
```

| file | what it is |
|---|---|
| `corpus-ml.json` | 180 items. 120 written for the card (20 per language: numbers/dates/currency in local conventions, names, English tech terms inside the sentence, fillers, self-corrections, negation, politeness register, spoken punctuation command words, one 25-35 s ramble), voiced by macOS `say`. 60 real read sentences from FLEURS (10 per language). Extra fields: `self_correction {wrong[], right[]}`, `register {form, keep[], forbid[]}`, `negation[]` (a multiset), `unsure` (the author is not sure a native speaker writes it that way: ja-nam-01, ja-pun-02, ko-pun-01, ru-jar-01), `audio` (a recording path instead of `<id>.wav`). |
| `guard-pairs-ml.jsonl` | 133 adversarial and control pairs for the polish guard (16 harmful per language: number words, negation removed or moved, register flips, a dropped clause, drift to English, quantifiers, modals; plus 6-7 benign ones that must be accepted). `expect` per strength is `accept`, `reject` or `any`. Meant to become a test fixture in the fix card. |
| `run-guard-pairs.mjs` | The pairs through `checkMeaningPreserved` (strict, smooth) and `guardComposeOutput` (`draft_polish`, `organize`). Pure local. |
| `run-compose.mjs` | Organize and translate on STT output: the product's `renderSystemPrompt`, streamer and `guardComposeOutput`, without the session plumbing. |
| `ml-scoring.mjs` / `score-ml.mjs` | Scoring and the report. |
| `fleurs-fetch.mjs` | Downloads the FLEURS test TSV and only the first N files of each language's audio archive (stream read, then abandoned), re-encodes them with the local `ffmpeg` to 16 kHz mono. |

FLEURS: https://huggingface.co/datasets/google/fleurs, license **CC-BY-4.0**,
Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal
Representations of Speech" (2022). The audio stays in
`.local/eval-audio/fleurs/` (gitignored); the raw downloads sit in their own
`raw/<config>/` directory and nothing from them is executed. The corpus keeps
each item's FLEURS id and file name.

What the ML-0 metrics mean, beyond the table above:

| metric | definition | blind spots |
|---|---|---|
| error rate | WER for fr/es/de/ru (Unicode words; French elisions split). CER for ja and ko (one token per kana, kanji or Hangul syllable; a Latin/digit run is one token). ko also gets eojeol WER, which charges a spacing difference as two word errors, so CER is the primary number. | Same as EVAL-1. Ambiguous fillers (es este, ru это, ko 그) are not dropped, only the unambiguous ones in `DROP_FILLERS`. |
| numbers (digit/word) | A group counts when any accepted form appears; the form that matched is classed as digits or words. | Substring match, as in EVAL-1. |
| register kept | Every `keep` marker present and no `forbid` marker present (German is case-sensitive: Sie vs sie; Korean ignores spacing). | Surface markers only. A register change that uses none of the listed words is not seen. |
| negation kept | Each listed negation word survives at least as often as listed. | A paraphrase that keeps the meaning with another negation (ko 안 끝났고 -> 끝나지 않았고) counts as lost; read the listed text before acting on it. |
| self-correction resolved | A `right` form present and no `wrong` form present. Only meaningful for Smooth (Strict may not delete words). | Number corrections are often digits after STT, so both forms are listed. |
| language drift | Per sentence: kana share for ja, Hangul for ko, Cyrillic for ru, Han for zh; Latin sentences go to en/fr/es/de by counting function words from four lists that avoid shared words, two hits minimum. The item's own `terms` are removed first. | Short sentences (< 4 letters or < 4 words) are never judged. Mixed sentences that keep half their function words are judged by the majority. |

⚠️ Latency from the `--concurrency 6` STT run is not a latency measurement: on
2026-10-13 French and Spanish items showed release→final up to 9.2 s at c=6
and 138-752 ms for the same files at c=1. Re-run with `--concurrency 1` to
read latency.

⚠️ On 2026-10-13, 9 of about 720 `polishFinalText` calls at concurrency 6 never
settled (the process ended on "unsettled top-level await" with those jobs
missing); the same items at concurrency 1 completed. Root cause not
investigated. If a runner's line count is short, list the missing keys and
re-run them with `--ids`.

## Dictated punctuation (ML-2)

`run-dictation.mjs` runs every corpus item with `spoken_punct` (both corpora;
`stt` = an STT run's raw final through the build's own final-text pipeline,
`ref` = the reference) plus `dictation-controls.json` (the command words used
as part of the sentence) through the product polish at Strict and Smooth, and
prints converted / lost-without-symbol / false-conversion counts. `--score
<file>` re-scores a result file. `run-stt.mjs --config dictation --lang ja`
sends the Japanese command words as Soniox context (what production now does
for a Japanese session, `terminology-context.ts` DICTATION_CONTEXT_TERMS);
`es` and `ko` lists are kept for re-measuring.

Measured 2026-10-14 (deepseek-v4-flash, one sample per call; files
`ml2-before.jsonl` / `ml2-after.jsonl` / `ml2-final-*.jsonl`): command
conversion on references went from 4% to 91% at Strict and from 77% to 98% at
Smooth; on STT finals from 0% to 79% (Strict) and 42% to 79% (Smooth); no
command word was lost without its symbol after the change (2 before);
controls: no false conversion before or after (the one hit in each run is
`줄바꿈` -> `줄 바꿈`, a spacing fix the substring metric counts as a loss).
Japanese STT with the context: both items 6/6 commands converted at both
strengths. Blind spots: the metric does not check WHERE a symbol landed, and
the controls are 21 hand-written sentences.

MAIN 2026-10-14 follow-up: layout commands become line breaks only for an
utterance that is not delivered to a PC (`--line-breaks` measures that path;
the default is PC-bound, where "new line" stays as words and no line break may
be added). Live check (55 calls, `ml2b-*.jsonl`): PC-bound Strict on
references converted 45/47 punctuation commands, added 0 line breaks, 0 false
conversions on the 21 controls; Notes Smooth converted 55/57 commands
including line breaks. The guard now also wants each symbol at its command's
place.

## Two-stage polish (POL-2)

The eval for the two-stage polish design
(`docs/strategy/2026-10-14-two-stage-polish-design.md` §9): long presses that
the relay cuts into rows, scored on what happens at the cut and on words whose
right form only an earlier row shows.

| file | what it is |
|---|---|
| `corpus-long.json` | 24 presses of 68-91 s, 6 each in en, zh, ja, de, all dictation-like (status updates, a landlord email, meeting notes, podcast notes, a trip plan). Each has two planned cuts, one inside a sentence and one after a sentence end: `speak_text` carries `[[slnc 2000]]` (macOS `say` inserts 2 s of silence) and `cuts[].after` is a unique substring of `reference` that ends at the cut. Annotations: `cross_refs` (a term or name written correctly in the first row, spoken as a soundalike later), `self_correction.right` (a value corrected right after a cut), `poison` (an ordinary word next to a context term that must stay), `numbers`, `terms`, `polish_expect` (`must` entries may list alternatives with `\|`). |
| `relay-rows.mjs` | The phone's realtime row settlement (one row per soft-segment final, the terminal final takes the rest) and the segment joiner; used by `run-relay.mjs` and the scorer. |
| `run-two-stage.mjs` | Runs `run-relay.mjs` on the long corpus with `--live-stamp --record-finals --llm-tap` always on and its own ledger (`pol2-relay-usage-ledger.jsonl`, caps 150 audio-min / 1,500 calls unless set). `--arm A` = today's relay. Checks the audio first and refuses to spend when a planned silence would not be cut on. |
| `run-relay.mjs --record-finals` | The simulated phone settles rows as the app does and, on the PC path, sends one `inject:request` per row as it settles (without the flag: one joined request at the end, as before). Records carry `rows` (text, `raw` = the text the relay asked the model to polish for that row, polish flag, timing, PC arrival) and `interim_times`. |
| `two-stage-scoring.mjs` / `score-two-stage.mjs` | Scoring (pure) and the report. Drill: `scripts/pol2-two-stage-scoring.test.mjs` (in `verify:scripts`). |

```sh
node scripts/eval/speech-quality/run-two-stage.mjs --check-audio
FLOWMIC_EVAL_CORPUS=corpus-long.json node scripts/eval/speech-quality/gen-audio.mjs   # only if the text changed
node scripts/eval/speech-quality/run-two-stage.mjs --arm A --paths pc --strengths strict,smooth --prefix pol2a-pc
node scripts/eval/speech-quality/run-two-stage.mjs --arm A --paths notes --strengths strict,smooth --concurrency 3 --prefix pol2a-notes
node scripts/eval/speech-quality/score-two-stage.mjs --runs pol2a-pc-runs.jsonl,pol2a-notes-runs.jsonl --prefix pol2a
```

🔴 Always through `run-two-stage.mjs` (or `run-relay.mjs --live-stamp`): a
shipped phone sends the live-start fields on every press, and without them the
relay does not take the segment path users get. On 2026-10-13 a fix was
compared without the stamp and shipped as a no-op. The scorer refuses records
without the stamp or the rows.

What the metrics mean and what they cannot see:

| metric | definition | blind spots |
|---|---|---|
| seam, mid / end | The boundary between two rows, placed in the reference by a token alignment of the joined rows. `end` when the reference has a sentence terminator (followed by a space, or a CJK one) right before that point. | A seam next to misrecognised words can shift by a token. Abbreviations: only Mr, Mrs, Ms, Dr, St, Nr, z.B, bzw, ca are known. |
| cut errors | Mid seams with any of: the row before ends on a sentence terminator (`terminator`) or on an em dash (`dash`, the mark Soniox's forced finalize leaves mid-phrase), the next row's first word capitalised where the reference word is not (`capital`; Latin only; German nouns are capitalised in the reference, so not errors), the next row starts with punctuation (`lead_punct`). | Only the row edges are looked at. |
| lost terminator | End seams whose row does not end on a terminator. | |
| seam words lost / dup | Reference tokens within 3 of the seam deleted or substituted by the alignment, and inserted hypothesis tokens within 3 of it. | Includes recognition errors; compare with the raw column. |
| raw → delivered | The same metric on `raw` (what the relay asked the model to polish, from the LLM tap) and on the delivered rows. | A press where a row's polish was skipped before any call has no raw text and is left out of the raw column. |
| cross-ref right | The later rows contain the right form and none of the listed wrong forms; `(context had it)` counts only presses whose first row has the right form. | Substring/word match; says nothing about where in the row. |
| self-correction kept / poison kept / expectations | As in ML-0; `poison` also checks the bad string is absent. | |
| term spelling inconsistent | Occurrences of a listed term that match ignoring case but not exactly. | Only listed terms. |
| polish status per stage | Per row: `applied`, `skipped` + reason, or no flag; segment rows vs the terminal row. | |
| segment hold / terminal wait | The relay's `stt.polish.final wait_ms`. | Read only from `--concurrency 1` runs. |
| next row first interim after speech resumes | For row k of a press cut as planned: the first non-empty interim of a later segment minus the end of the k-th planned silence. The relay holds that speech's interims behind row k's polish (ordered outbox), so this is what the user sees of the hold. | Includes the normal first-interim latency (the report prints the press's own first interim beside it). |

The audio is TTS with a digital-silence pause at each cut; a real speaker's
pause has room noise and the relay may cut elsewhere. The texts were written
for this card by someone who knew what is scored.

⚠️ `--llm-tap` at `--concurrency` above 1: until POL-2 all relays of a run
shared one tap, so each record also picked up other workers' calls (on
2026-10-14 at 3 workers the raw text came from other presses and tokens were
counted three times). Each worker now has its own tap. Tap-derived fields of
earlier multi-worker runs (`llm_tap`, raw text, ledger tokens) are not to be
trusted; the relay's own log fields are unaffected.
