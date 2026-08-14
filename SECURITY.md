# Security

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). It goes to the maintainers and nobody else.

What to expect:

| | |
|---|---|
| First response | within **3 working days** |
| Assessment and a plan | within **10 working days** |
| Fix and disclosure | coordinated with you; we will not disclose before you are ready |

We are a very small team. If you have not heard back in three days, assume the
message got lost and ping the same channel again — that is not rude, it is
useful.

We do not run a paid bounty program. We will credit you in the release notes
unless you would rather we did not.

---

## What this software actually does with your data

Read this before you decide to trust it. **Everything below describes the code
in this repository as it stands, not what we intend to build.** Where something
is not done, it says so.

### LAN mode (no FlowMic cloud)

The desktop app spawns the server as a local sidecar. There is no account, no
telemetry, and FlowMic itself opens no outbound connection. With a local speech
engine (sherpa-onnx), audio and transcripts never leave your network.

The **language model is a second, independent configuration**, and this section
used to be silent about it. Translate, Organize and AI polish do not use the
speech engine — they send text to whatever `llm.config` names
(`apps/server-core/src/compose/llm-config.ts`; AI polish reaches it through the
same resolver, `apps/server-core/src/engine/stt-factory.ts resolvePolishDep`).
A stock install seeds **no** `llm.config` at all
(`apps/server-core/src/settings/defaults.ts`, `LLM_NOT_CONFIGURED`), so those
turns fail with a named error until you configure one — and if what you
configure is a cloud vendor, that is where the text of those turns goes. See
*Cloud engines* below. Configuring a speech engine does not configure a
language model, and the reverse is equally true.

**The LAN channel is encrypted as of 0.2.60** — with caveats that matter more
than the headline, so they are named first-class below rather than footnoted.

The sidecar answers both plain and TLS on the same port
(`apps/server-core/src/lan-tls/dual-listener.ts`), and the pairing QR carries the
SHA-256 of the sidecar's TLS **public key** — SPKI, not the certificate
(`apps/server-core/src/lan-tls/fingerprint.ts`, `spkiFingerprint`), so a
certificate renewal or a NIC change does not invalidate a pairing.

- **The pin is checked on every dial, not just at pairing.** The phone stores the
  fingerprint with the pairing and re-presents it on each connection: first pair,
  *every rung* of the reconnect ladder, session resume, and the unpair probe. The
  check is `apps/mobile/lib/src/signaling/lan_pinning.dart`
  (`PinnedHttpClient._judge`); the four call sites are held down by
  `apps/mobile/test/lan_pin_enforced_on_every_dial_test.dart`, because a ladder
  that re-dialled unpinned after one drop is exactly the regression this design
  invites.
- **It fails closed where that is the safe direction.** A pinned dial builds its
  client with `SecurityContext(withTrustedRoots: false)`, so the verification
  callback is unconditional rather than a fallback after CA validation; and
  `SocketCore.connect` **refuses outright** to dial a plain `ws://` URL while
  holding a pin (`apps/mobile/lib/src/signaling/socket_core.dart`) instead of
  silently downgrading. A key mismatch is reported to the user as a key mismatch,
  not as a generic network error — the two call for opposite responses.
- **A typed address gets trust-on-first-use, and the UI says so.** There is no
  fingerprint to compare against, so the phone learns the identity on first sight
  and refuses a change afterwards. That state is displayed as distinct from a
  QR-verified connection; the two deliberately do not share one "encrypted"
  badge.
- **The 4-digit pairing code is unchanged**, but for a QR pairing it is now
  exchanged over the already-pinned connection — `openPairingHttpClient` throws
  rather than carry a pin over a non-`https` URL.

🔴 **What is still open, and this is the part to weigh.** Pairings created
*before* 0.2.60 remain plaintext until they are re-paired: `resumePairing`
(`apps/mobile/lib/src/ptt/ptt_session.dart`) passes a null pin for every such row
and that dial is byte-for-byte the pre-0.2.60 one. **There is no automatic
upgrade.** For those pairings the original advice stands unchanged — treat LAN
mode the way you would treat any unencrypted service on your LAN: fine on your
home network, not fine on a café's Wi-Fi.

🔴 **`FLOWMIC_LAN_TLS=0` is an escape hatch, not a rollback.** It returns the leg
to plaintext and stops the QR carrying the fingerprint
(`apps/server-core/src/config.ts`, `resolveLanTls`). But phones already paired
under TLS stored `https://` plus a pin, `resumePairing` has no plaintext
fallback, and with no certificate seen the mismatch flag is false — so those
phones simply fail to connect and can report only a generic connection failure.
Delete-and-re-pair on the phone is the only recovery. If you are evaluating the
switch as an incident response, evaluate that cost with it.

### Relay mode (our servers, or yours)

The relay carries frames from a phone to a PC when they are not on the same
network. Transport is TLS.

- **It does not store transcripts.** The server-side history endpoints were
  retired, and they do not fail silently — they refuse with a named error code
  (`HISTORY_SYNC_RETIRED`) so that an old client is told, rather than having its
  data quietly dropped.
- **Settings and credentials** stored server-side are encrypted with a
  server-held key (`enc:v1:`). The server *can* read these. That is deliberate:
  it has to, to route and to authenticate.
- **The zero-knowledge store** (`e2e:v1:`) is where phone-side light records are
  meant to live, encrypted so that we cannot read them. 🔴 **The table and the
  server-side guard exist; the client write path does not.** Nothing is in that
  store today. The guard is real and enforced — a blob whose prefix is not
  `e2e:v1:` is rejected outright and is *never* coerced into the
  server-readable form — but there is nothing writing to it yet.

Both prefixes are load-bearing and must never be interchanged. That invariant is
enforced in `apps/server-core/src/db/repos/timeline.repo.ts` and is a documented
red line.

### Cloud engines — speech, and the language model separately

If you configure a third-party **speech** engine (OpenAI, Deepgram, …), your
audio goes to that vendor under *their* terms. FlowMic does not proxy or retain
it. If that matters to you, use the local engine — it needs no GPU and no
account.

The **language model** is chosen in its own settings section and answers a
different question. There is no local default for it: the built-in speech engine
has an on-device counterpart, the language model has none, so "I run FlowMic
locally" says nothing about where Translate / Organize / AI polish text goes.
Whatever endpoint you name is where it goes, under that provider's terms if the
endpoint is theirs.

### What the desktop app does to your computer

FlowMic types into whatever window has focus. It uses synthetic keyboard input
and, for images, the clipboard. Two consequences worth stating out loud:

- **It can type into any application**, including one you did not mean to be
  focused. The timeline records where each delivery went.
- **"Injected" means "delivered to the keyboard focus"** — not "the target
  accepted it". We measured this: for a browser input field, no cross-process
  API can distinguish "focused and editable" from "blank page, nothing focused";
  the bytes are identical. Rather than guess, the receipt says what it can
  actually prove. See
  `docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md`.

---

## Supported versions

Pre-1.0. Only the latest release gets fixes. There are no maintained branches.

## Review practice

Four areas get line-by-line human review and cannot merge on green tests alone:
**protocol and schema changes (including database migrations)**, **the injection
path**, **pairing and authentication**, and **cryptography**. This is a public
commitment, not an internal formality — if you see a merged change in one of
those areas that clearly did not get it, that itself is worth reporting.

## Secrets in this repository

There are none, and that is checked mechanically rather than remembered: a lint
rule (`verify/lint/no-cloud-keys.mjs`) fails the build on real cloud API keys,
and signing keystores, certificates and `.env` files are excluded from version
control. If you ever find a credential in this tree or its history, that is a
security report — please use the private channel above.
