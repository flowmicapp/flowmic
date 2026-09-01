# FlowMic

> Your phone is the mic. Your PC gets the words.
> Self-hostable, no GPU required, speaks your language — and types another.

FlowMic turns the phone already in your hand into a microphone for the computer
in front of you. You talk; transcribed text streams, live, into whatever input
field has focus on your PC. It can translate as you speak (say it in Chinese,
type it in English) or clean up rambling into structured prose — and it works
entirely on your own network, with no cloud account, if you want it to.

It is also a decent voice-notes app on its own: everything you say lands on a
timeline on the phone, whether or not a computer was listening.

---

## Download & platform status

**Every release is on [the Releases page](https://github.com/flowmicapp/flowmic/releases/latest)**,
with a SHA-256 checksum beside every file. The project is under active daily
development by a very small team; the desktop and mobile apps are used daily
on real devices before anything is tagged.

| Platform | State | What you get |
|---|---|---|
| **Windows 10/11** | ✅ **Shipped** | MSI installer (en-US / zh-CN) and a portable zip. Tauri v2 + a native injection layer; the primary development target. |
| **Android** | ✅ **Shipped** | APK, installed directly. Tested on real devices every round. |
| **macOS (Apple Silicon)** | ✅ **Shipped** | Notarized, stapled `FlowMic.app` zip (arm64) — Gatekeeper opens it without warnings. |
| **iOS / iPadOS** | 🧪 **Public TestFlight beta** | [Join the beta](https://testflight.apple.com/join/fvTxBgE3) — Apple's beta channel, so it comes with limits. Read them below before you click. |
| **Linux** | ⏳ **Server yes, desktop not yet** | The server runs on Linux today — that is what the relay is. The *desktop* app does not; nobody has written the injection layer for X11/Wayland. Contributions very welcome. |

A platform marked ⏳ has no download link because no public artifact exists —
we would rather show you a blank than a 404.

### About the iOS / iPadOS beta

TestFlight is Apple's beta channel, not a store listing. Four limits are worth
knowing before you join, because none of them are ours to lift:

- **A new version does not show up straight away.** Every build goes through
  Apple's Beta App Review first — usually inside 24 hours, sometimes longer.
  Until a build clears, the link installs the **previous approved** build, which
  may be older than the newest release notes on this page.
- **300 testers.** That is the cap on this public link. When it is full, the
  page stops accepting people until a slot frees up.
- **Each build expires 90 days after we upload it.** TestFlight tells you when;
  reinstall from the same link.
- **iOS or iPadOS 15 and later**, plus Apple's free TestFlight app.

And one that is ours: **you also need a computer running FlowMic.** The phone is
the microphone — the words land on the computer. On its own, the phone app has
nowhere to send anything.

---

## How it works

```
   phone (Flutter)                                        PC (Tauri + Rust)
  ┌────────────────┐                                     ┌──────────────────┐
  │ mic ──► audio  │ ══ LAN sidecar  (no cloud at all) ══│ transcript ──►   │
  │        frames  │            ── or ──                 │ the focused      │
  │                │ ══ relay (when not on same network) │ input field      │
  └────────────────┘                                     └──────────────────┘
                              ▲
                        server-core
              one binary, two modes: standalone | saas
```

The server is one Node program. In `standalone` mode the desktop app spawns it
as a local sidecar — single user, SQLite on disk, **no account, no telemetry,
no phone-home**. What does leave your network is decided entirely by the two
engines you configure (speech and language model — they are separate settings);
see *Privacy, in specifics* below. In `saas` mode the same binary is the relay
that lets a phone reach a PC across the internet. Same code path, same protocol; the mode changes who is
allowed in, not what the software can do.

**Speech recognition is pluggable** — seven engines are wired
(`apps/server-core/src/stt/engines/`), including a fully local one
(sherpa-onnx) that needs no GPU and no account, plus OpenAI Whisper/Realtime,
Deepgram, FunASR, and any OpenAI-compatible endpoint you point it at. Which
model to pick for which language is its own section,
[below](#speech-models-by-language).

### Repository layout

| Path | What |
|---|---|
| `packages/protocol` | `@flowmic/protocol` — event whitelist, zod schemas, error codes, Dart codegen. **Apache-2.0** |
| `apps/server-core` | Node server — LAN sidecar *and* relay, seven STT engines |
| `apps/desktop` | Windows desktop — Tauri v2 + Vue 3 + Rust injection layer |
| `apps/mobile` | Flutter app (Android; iOS in progress) |
| `verify/` | The gates: the static lint rules and the end-to-end golden paths, run against a real server (counts drift; the runner's own output is the truth) |
| `docs/rebuild/` | Behaviour contracts — protocol, data, engine, desktop, mobile, delivery states, portable record format |
| `docs/decisions/` | Decision log. Why the obvious refactor is usually wrong |

> Most documentation under `docs/` is written in Chinese. Code, comments in the
> hot paths, and everything contributor-facing are in English. If a Chinese doc
> is blocking you, open an issue — we will translate the section you need.

---

## Speech models, by language

FlowMic hosts no model weights, mirrors none, and pulls none behind your back:
auto-download is **off** by default, and a missing model fails loudly instead of
quietly falling back to something else. What the desktop app does give you is a
catalogue of packs it knows how to fetch, checksum and open, under
**Settings → Speech recognition → Built-in speech model**.

Pick the pack for the language you actually speak. Every row below is read out
of the product's own catalogue,
`apps/server-core/src/stt/sherpa/model-catalog.ts` — if that file and this table
ever disagree, the file is right and this table is stale.

| Spoken language | Pack to download | Size | Licence | Live text while you talk |
|---|---|---|---|---|
| **English** | `sherpa-onnx-zipformer-en-2023-06-26` | 67 MiB | Apache-2.0 | no |
| **Chinese (Mandarin)** | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` | 228 MiB | FunASR Model 1.1 ⚠️ | partial |
| **Japanese** | `sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01` | 169 MiB | Apache-2.0 | no |
| **Korean** | `sherpa-onnx-zipformer-korean-2024-06-24` | 73 MiB | Apache-2.0 | no |
| **Russian** | `sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19` | 226 MiB | MIT | no |
| **Spanish** | `sherpa-onnx-nemo-fast-conformer-ctc-es-1424-int8` | 126 MiB | CC-BY-4.0 | no |
| **German** | `sherpa-onnx-nemo-stt_de_fastconformer_hybrid_large_pc-int8` | 126 MiB | CC-BY-4.0 | no |
| **French** | `sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8` | 198 MiB | CC-BY-4.0 | no |
| **All eight, one pack** | `sherpa-onnx-whisper-turbo` | 989 MiB | MIT | no |

Second choices, and why you might want one:

- **English, smaller footprint is not the reason** — `sherpa-onnx-moonshine-tiny-en-int8`
  (118 MiB, MIT) is the "lite" tier but is *larger* than the Zipformer above.
  Take it if you want an MIT pack rather than a smaller one.
- **Chinese under an OSI licence** — `sherpa-onnx-zipformer-zh-en-2023-11-22`
  (257 MiB, Apache-2.0) if the FunASR licence below is a problem for you. It
  covers Chinese *and* English in one pack, but has no live preview.
- **Russian, smaller** — `sherpa-onnx-zipformer-ru-int8-2025-04-20` (70 MiB,
  Apache-2.0), a third of the size of the GigaAM pack.
- **Spanish / German / French / English in one pack** — the Canary pack listed
  on the French row covers all four.
- **French is the one language with no offline single-language pack today.**
  The dedicated French Zipformer *is* in the catalogue, but it is a *streaming*
  pack and this release's recogniser cannot open one — so the download button
  and the loader both refuse it **by name** rather than pretending. Until that
  changes, French means Canary or Whisper.

⚠️ **Two licence facts that are easy to get wrong.** The *engine*
(sherpa-onnx) is Apache-2.0; the *weights* are not necessarily anything of the
sort — the two just travel together. And the built-in default, SenseVoice-small,
is under the **FunASR Model License v1.1, which is not an OSI-approved
open-source licence** and carries non-standard terms. Read it before you rely
on it commercially. Every pack's licence is a field in the catalogue, rendered
on the card, precisely so nobody has to take a README's word for it.

### What we have actually measured

Honest answer first: **there is no per-language error rate for the packs in the
table above.** The multilingual benchmark that would produce them is planned and
has not been run. Two things *have* been measured, and neither is a substitute
for it.

**1. Does the language work at all** (2026-08-17) — one ~8 s utterance per
language, pushed through the product's real session path:

| Language | Built-in default (SenseVoice) | The pack recommended above | Cloud engine on the hosted relay |
|---|---|---|---|
| English | ✅ correct | 🔬 to be evaluated | ✅ correct |
| Chinese | ✅ correct | 🔬 to be evaluated | ✅ correct |
| Japanese | ✅ correct | 🔬 to be evaluated | ✅ correct |
| Korean | ✅ correct | 🔬 to be evaluated | ✅ correct |
| French | ❌ 22 words in, `La Mer.` out | 🔬 to be evaluated | ✅ correct |
| Spanish | ❌ `,on.` | 🔬 to be evaluated | ✅ correct |
| German | ❌ a single full stop | 🔬 to be evaluated | ✅ correct |
| Russian | ❌ a full stop, labelled Korean | 🔬 to be evaluated | ✅ correct |

Those four ❌ cells are why French, Spanish, German and Russian each get their
own pack in the table above, and why the engine now **refuses a language its
model does not cover, by name**. It used to exit cleanly and hand back
punctuation instead: silence dressed up as a transcript, which is worse than an
error, because nothing about it looks wrong.

**2. How accurate, in Mandarin** (2026-08-29) — 15 human-read clips of 21–26 s
(10 Mandarin, 5 Mandarin/English code-switching), every engine scored by the
same script:

| Engine | Deployment | Median CER | Code-switching |
|---|---|---|---|
| Cloud engine on the hosted relay | not self-hostable | **1.1 %** | **0.8 %** |
| Qwen3-ASR 0.6B (Apache-2.0) | your own GPU, ~1.7 GB VRAM | **2.1 %** | 2.8 % |
| Nemotron 3.5 0.6B | your own GPU | 10.4 % | 24.8 % |

Read those with three caveats. They are **Mandarin only** — that run says
nothing about French, German, Spanish, Japanese, Korean or Russian. **None of
the three is a pack from the table above**; they were driven directly, not
through FlowMic (Qwen3-ASR would be reachable through the OpenAI-compatible
endpoint setting, which we have not measured end to end). And a 30× spread on
code-switching between two models on the same card, the same audio and the same
scoring script is the real lesson here: **which model you choose matters far
more than what you run it on.**

### Not using the built-in packs

Three other shapes work, and they differ in one way you will feel immediately:

- **A self-hosted streaming service** (FunASR over WebSocket) — real live text
  while you speak.
- **A self-hosted batch endpoint** (Whisper, or anything speaking the
  OpenAI-compatible `/audio/transcriptions` API) — **no live text**: the line
  stays empty while you hold the button and the whole utterance lands when you
  release. It still works; it just feels different.
- **A cloud key of your own** (Deepgram, OpenAI Realtime) — streaming, and your
  audio goes to them.

Cantonese is a fourth case: SenseVoice claims it, the language picker does not
offer it, and it is reachable only by configuring the engine by hand.

---

## Try it

**Requirements:** Node ≥ 22, pnpm ≥ 9. For the desktop app also Rust ≥ 1.90; for
the phone app, Flutter ≥ 3.41.

```bash
pnpm install
pnpm --filter @flowmic/protocol build       # server-core consumes protocol's dist/
pnpm --filter @flowmic/desktop build:sidecar # the Tauri build script needs this
pnpm verify:delivery                         # lint + types + clippy + scripts + golden
```

Both build steps are **required on a fresh clone**, not optional warm-ups: each
produces a gitignored artifact that a later stage resolves by path, so skipping
them fails the gate before it checks anything of yours. (Skip the second one if
you are not set up for Rust — the first three stages will still run.)

Self-hosting the server on its own (Docker):

```bash
docker compose up --build                 # standalone mode, SQLite in a volume
```

Then pair the phone by scanning the QR code the desktop app shows.

---

## Privacy, in specifics

- **LAN mode makes zero outbound connections of its own.** No telemetry, no
  phone-home, no account. Your *engines* are a separate question, and there are
  two of them. Speech: with a local STT engine your voice never leaves your
  network. Language model: Translate, Organize and AI polish all send text to
  whichever endpoint `llm.config` names — a fresh install seeds **none**, and
  one of the presets on offer is a cloud vendor. Configuring a speech engine
  does not configure a language model.
- **The relay does not store transcripts.** It hands frames from the phone to
  the PC and forgets them. The server-side history endpoints do not merely go
  unused — they refuse, out loud, with a named error code.
- **The timeline lives on your devices**, and both ends can export it. Exports
  are plaintext by design — anyone who gets the file can read it — and a
  delivered entry includes the title of the window that received the text, so
  an export can contain window titles from your other applications.
- **The LAN channel is encrypted — if your pairing is recent.** A pairing made by
  scanning the QR code uses TLS and pins the computer's key from the QR itself,
  checked on every later connection. A pairing made before that shipped stays in
  the clear until you pair again, and a configuration switch on the computer can
  turn the whole thing off. Those caveats are short but real, and SECURITY.md
  below states them in full.

One thing that is **not** true yet, stated plainly because you would
reasonably assume otherwise:

- **Blind storage is a table, not yet a feature.** The schema and the
  server-side guard for the zero-knowledge store exist; the client that would
  write to it does not. Nothing is stored blind today because nothing is stored
  there at all.

[SECURITY.md](SECURITY.md) has the full boundary list. We would rather name an
open gap than imply it is shut.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and [CLAUDE.md](CLAUDE.md) — the
working contract for this repository. It documents the rules that are not style
preferences, and every one of them is there because a real bug got past us once.

Please report security issues privately via [SECURITY.md](SECURITY.md) rather
than in a public issue.

---

## License

FlowMic is **[AGPL-3.0-only](LICENSE)**.

You can run it, modify it, and self-host it freely. If you run a *modified*
version as a network service that other people use, you have to publish your
modifications. Running it for yourself — on your own machine, on your own LAN,
or inside your company — triggers no obligation at all.

Two deliberate carve-outs:

- **`packages/protocol` is [Apache-2.0](packages/protocol/LICENSE).** Writing a
  third-party FlowMic client should not pull you into the AGPL. We want other
  clients to exist.
- **Official builds distributed through app stores** carry an additional
  permission from us, the copyright holders, granting the rights those stores'
  terms require — the full text is
  [LICENSE-APP-STORE-EXCEPTION.md](LICENSE-APP-STORE-EXCEPTION.md). This is what
  makes an AGPL application distributable on the App Store. It applies to builds
  *we* publish; it is not a general relicensing.

Because that second carve-out depends on us holding the copyright, contributions
require a CLA — see [CONTRIBUTING.md](CONTRIBUTING.md).
