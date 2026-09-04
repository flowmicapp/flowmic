# FlowMic

> Your phone is the mic. Your PC gets the words.

FlowMic turns the phone in your hand into a microphone for the computer in
front of you. You talk, and the transcribed text streams live into whatever
input field has focus on your PC.

- **Translate while you speak.** Say it in Chinese, type it in English.
- **Tidy up while you speak.** Rambling goes in, structured prose comes out.
- **Run it entirely on your own network.** No account, no cloud, if that is
  what you want.

It is also a voice-notes app on its own: everything you say lands on a timeline
on the phone, whether or not a computer was listening.

---

## Download

Every release is on
[the Releases page](https://github.com/flowmicapp/flowmic/releases/latest), with
a SHA-256 checksum beside every file.

| Platform | State | What you get |
|---|---|---|
| **Windows 10/11** | Shipped | MSI installer (en-US / zh-CN) and a portable zip |
| **Android** | Shipped | APK, installed directly |
| **macOS (Apple Silicon)** | Shipped | Notarized, stapled `FlowMic.app` zip (arm64), which Gatekeeper opens without warnings |
| **iOS / iPadOS** | Public beta | [Join on TestFlight](https://testflight.apple.com/join/fvTxBgE3) |
| **Linux** | Server only | The server runs on Linux. The desktop app does not yet, and contributions are welcome |

The iOS build ships through TestFlight, which is Apple's beta channel and comes
with Apple's limits: a new build appears only after Apple's review, the public
link holds 300 testers, each build expires 90 days after upload, and you need
iOS or iPadOS 15 or later plus Apple's TestFlight app. One limit is ours: you
also need a computer running FlowMic, because the phone is the microphone and
the words land on the computer.

---

## Quick start

1. Install FlowMic on your computer and start it.
2. Install the phone app on your Android phone or iPhone.
3. Scan the QR code the desktop app shows, then hold the button and talk.

To run the server on its own, without the desktop app:

```bash
docker compose up --build      # single user, SQLite in a volume
```

Building from source is covered in [CONTRIBUTING.md](CONTRIBUTING.md).

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

The server is one Node program. On your own network the desktop app runs it
locally as a sidecar: single user, SQLite on disk, no account, no telemetry, no
phone-home. When the phone and the computer are not on the same network, the
same binary acts as a relay that carries frames between them and stores none of
them.

What leaves your network is decided by the two engines you configure, and they
are two separate settings. **Speech**: a local engine keeps your voice on your
own hardware, and cloud engines such as Soniox do not. **Language model**:
Translate, Organize and AI polish send text to whichever endpoint your settings
name. Configuring one of the two does not configure the other. There is more
detail under [Privacy](#privacy) below.

Speech recognition is pluggable. Seven engines are wired, including a fully
local one (sherpa-onnx) that needs no GPU and no account, plus OpenAI
Whisper/Realtime, Deepgram, FunASR, and any OpenAI-compatible endpoint you
point it at.

---

## Speech models

The desktop app can fetch, checksum and open a set of local speech packs, under
**Settings → Speech recognition → Built-in speech model**. FlowMic hosts no
model weights and mirrors none. Automatic download is off by default, and a
missing model fails with a named error rather than quietly falling back to
something else.

Pick the pack for the language you speak.

| Spoken language | Pack to download | Size | Licence | Live text while you talk |
|---|---|---|---|---|
| **English** | `sherpa-onnx-zipformer-en-2023-06-26` | 67 MiB | Apache-2.0 | no |
| **Chinese (Mandarin)** | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` | 228 MiB | FunASR Model 1.1 | partial |
| **Japanese** | `sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01` | 169 MiB | Apache-2.0 | no |
| **Korean** | `sherpa-onnx-zipformer-korean-2024-06-24` | 73 MiB | Apache-2.0 | no |
| **Russian** | `sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19` | 226 MiB | MIT | no |
| **Spanish** | `sherpa-onnx-nemo-fast-conformer-ctc-es-1424-int8` | 126 MiB | CC-BY-4.0 | no |
| **German** | `sherpa-onnx-nemo-stt_de_fastconformer_hybrid_large_pc-int8` | 126 MiB | CC-BY-4.0 | no |
| **French** | `sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8` | 198 MiB | CC-BY-4.0 | no |
| **All eight in one pack** | `sherpa-onnx-whisper-turbo` | 989 MiB | MIT | no |

**French has no offline single-language pack in this release.** Use the Canary
pack on the French row, which also covers English, Spanish and German, or use
Whisper.

Four alternatives, if the row above is not what you want:

- **English under MIT**: `sherpa-onnx-moonshine-tiny-en-int8` (118 MiB). It is
  the lighter tier by design and is still larger than the Zipformer above, so
  take it for the licence rather than for the size.
- **Chinese under an OSI licence**: `sherpa-onnx-zipformer-zh-en-2023-11-22`
  (257 MiB, Apache-2.0), covering Chinese and English in one pack, with no live
  text while you talk.
- **Russian, smaller**: `sherpa-onnx-zipformer-ru-int8-2025-04-20` (70 MiB,
  Apache-2.0), a third of the size of the GigaAM pack.
- **Cantonese** is recognised by the built-in default but is not offered in the
  language picker. It needs an engine configured by hand.

Two licence facts that are easy to get wrong. The **engine** (sherpa-onnx) is
Apache-2.0; the **weights** carry their own licences, which is why every pack
above lists one and why the app shows it on the pack's card. And the built-in
default, SenseVoice-small, is under the **FunASR Model License v1.1, which is
not an OSI-approved open-source licence** and carries non-standard terms. Read
it before you rely on it commercially.

### Not using the built-in packs

Three other setups work, and they differ in one way you will feel immediately:

- **A self-hosted streaming service** (FunASR over WebSocket) gives you live
  text while you speak.
- **A self-hosted batch endpoint** (Whisper, or anything speaking the
  OpenAI-compatible `/audio/transcriptions` API) gives you **no live text**: the
  line stays empty while you hold the button, and the whole utterance lands when
  you release it.
- **A cloud key of your own** (Deepgram, OpenAI Realtime) streams, and your
  audio goes to that vendor.

---

## Repository layout

| Path | What |
|---|---|
| `apps/desktop` | Desktop app for Windows and macOS: Tauri v2, Vue 3, and a Rust layer that types into the focused window |
| `apps/mobile` | Flutter phone app for Android and iOS |
| `apps/server-core` | The Node server: local sidecar and relay in one binary, plus the seven speech engines |
| `packages/protocol` | `@flowmic/protocol`: the event whitelist, schemas, error codes, and Dart codegen. **Apache-2.0** |

---

## Privacy

- **On your own network, FlowMic opens no outbound connection of its own.** No
  telemetry, no phone-home, no account.
- **Your engines are a separate question, and there are two of them.** With a
  local speech engine your voice never leaves your network; with a cloud engine
  such as Soniox it leaves your network and is transcribed there. Translate,
  Organize and AI polish send text to whichever language-model endpoint your
  settings name. A fresh install names none, and one of the presets on offer is
  a cloud vendor. Configuring a speech engine does not configure a language
  model.
- **The relay does not store transcripts.** It hands frames from the phone to
  the PC and forgets them. The server-side history endpoints do not merely go
  unused: they refuse, out loud, with a named error code.
- **The timeline lives on your devices**, and both ends can export it. Exports
  are plaintext by design, so anyone who gets the file can read it, and a
  delivered entry records the title of the window that received the text. An
  export can therefore contain window titles from your other applications.
- **The local-network channel is encrypted when the pairing is recent.** A
  pairing made by scanning the QR code uses TLS and pins the computer's key from
  the QR itself, checked on every later connection. A pairing made before that
  shipped stays in the clear until you pair again, and a configuration switch on
  the computer can turn the whole thing off.
- **Blind storage is a table, not yet a feature.** The schema and the
  server-side guard for the zero-knowledge store exist; the client that would
  write to it does not. Nothing is stored blind today, because nothing is stored
  there at all.

[SECURITY.md](SECURITY.md) has the full boundary list, including what is still
open.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, then [CLAUDE.md](CLAUDE.md),
which is the working contract for this repository.

Please report security issues privately through
[SECURITY.md](SECURITY.md) rather than in a public issue.

---

## Support

Bug reports and feature requests go through GitHub issues. For private
deployment or customisation, write to **github@flowmic.app**.

---

## License

FlowMic is **[AGPL-3.0-only](LICENSE)**.

You can run it, modify it, and self-host it freely. If you run a *modified*
version as a network service that other people use, you have to publish your
modifications. Running it for yourself, on your own machine, on your own LAN, or
inside your company, triggers no obligation at all.

Two deliberate carve-outs:

- **`packages/protocol` is [Apache-2.0](packages/protocol/LICENSE).** Writing a
  third-party FlowMic client should not pull you into the AGPL. We want other
  clients to exist.
- **Official builds distributed through app stores** carry an additional
  permission from us, the copyright holders, granting the rights those stores'
  terms require. The full text is in
  [LICENSE-APP-STORE-EXCEPTION.md](LICENSE-APP-STORE-EXCEPTION.md), and it is
  what makes an AGPL application distributable on the App Store. It applies to
  builds *we* publish; it is not a general relicensing.

Because that second carve-out depends on us holding the copyright, contributions
require a CLA. See [CONTRIBUTING.md](CONTRIBUTING.md).
