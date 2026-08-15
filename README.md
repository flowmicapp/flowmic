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
| **iOS / iPadOS** | 🚧 **Built, TestFlight-internal** | Builds from the same tree and runs on real iPads, uploaded to TestFlight — but not yet publicly installable. Store review is an external clock we do not control. |
| **Linux** | ⏳ **Server yes, desktop not yet** | The server runs on Linux today — that is what the relay is. The *desktop* app does not; nobody has written the injection layer for X11/Wayland. Contributions very welcome. |

A platform marked 🚧 has no download link because no public artifact exists —
we would rather show you a blank than a 404.

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
Deepgram, FunASR, and any OpenAI-compatible endpoint you point it at.

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
  terms require. This is what makes an AGPL application distributable on the App
  Store. It applies to builds *we* publish; it is not a general relicensing.

Because that second carve-out depends on us holding the copyright, contributions
require a CLA — see [CONTRIBUTING.md](CONTRIBUTING.md).
