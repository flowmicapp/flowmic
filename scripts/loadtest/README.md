# NR-5 S0a load-test harness

Owner ruling (`docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md` item 7,
splitting NR-5 §5's S0 into two steps): **"S0a presses the LA VPS relay's own
concurrency ceiling — do not hit the upstream vendors; the STT leg uses a fake
engine or short sessions."** S0b (a real Soniox/DeepSeek run, small and
budgeted) is a separate, later, explicitly-costed step and is **out of scope
for this tool** — see "What this deliberately does not do" below.

This tool answers one question: **how many simultaneous simulated phones can
one `@flowmic/server-core` standalone process serve before something gives
way, and what gives way first** — on the machine you run it on.

## Quick start

```bash
# one run
node scripts/loadtest/run.mjs --clients 50 --minutes 2 --ramp 10

# the owner's requested ramp (10 → 50 → 100 → 200, stops early on failure spike)
node scripts/loadtest/baseline.mjs
```

Both commands build `@flowmic/server-core` first if `dist/index.js` is
missing (`pnpm --filter @flowmic/server-core build`), then spawn a **local**
standalone instance on a random loopback port and tear it down when the run
ends. Nothing is left running.

Results land in `scripts/loadtest/results/` (gitignored — these are
machine-specific measurements, not something to check in) as one `.json`
(everything, including every client's raw samples) and one `.txt` (the human
summary) per run.

## What it simulates

For each of N "clients", the harness plays **both halves of one paired
device** over real `socket.io` connections against the real protocol
(`packages/protocol`) — a PC-role socket and a mobile-role socket, each with
its own `client_instance_id` so N clients produce N independent
rooms/pairings, not one room contending over a single PC (see
`lib/phone-client.mjs`'s header for why that matters and how the real
`pc:register` machine-identity dedup would otherwise collapse them).

Per utterance, each client does exactly what a real PTT press does on the
wire:

1. `audio:start` (`{sample_rate:16000, channels:1, encoding:'pcm_s16le',
   mode:'realtime', source_lang:'zh'}`)
2. a stream of `audio:chunk` frames, one every 200ms, each carrying 6400 raw
   PCM bytes (200ms of 16kHz mono s16le — a fixed sine tone, not silence; see
   `lib/audio-synth.mjs` for why silence would be the wrong choice even for a
   "not testing recognition" test) base64-encoded
3. `audio:stop`
4. a gap (simulating time between PTT presses), then repeat until the run's
   wall-clock deadline

Independently, each client's **PC-role** socket also emits a `heartbeat`
every 5s (matching production cadence) and times the ack round-trip. This
doubles as a latency sample and as a proxy for server event-loop lag: the
heartbeat handler does almost no work (one auth check, one `last_seen_at`
write), so a growing ack RTT under load is dominated by how long this
client's turn sat in the server's event queue behind everyone else's frames,
not by heartbeat's own cost.

`--ramp S` staggers client start times evenly across S seconds so the server
sees a ramp, not a thundering herd, and every client (early or late starter)
runs its utterance loop until the SAME wall-clock deadline
(`ramp + minutes` after the run begins) — `--ramp` does not eat into any
client's share of `--minutes`.

## Engine modes — read this before trusting a number

There is no "fake STT engine" switch reachable over the wire, because this
server has no such switch: engine selection (`stt/engine-router.ts`) either
resolves to a real engine or throws `SttConfigMissingError` — there is no
implicit stub (see that file's own `#16` "no silent fallback" comment). This
harness therefore gets as close to the owner's "fake engine" instruction as
the real wire protocol allows, in two modes:

- **`--engine off` (the DEFAULT).** Before the audio loop starts, the client
  sends `settings:update {key:'stt.routings', value:[]}` on its own account,
  which is the same mechanism a real settings screen uses. With no routing
  configured, `audio:start` fails immediately and *loudly*
  (`STT_CONFIG_MISSING`, acked as an error and echoed as `stt:error` — this
  is expected, correct behaviour, not a bug in the harness or the product).
  **`audio:chunk` frames still stream and `audio:stop` still round-trips on
  every attempt** — deliberately: an earlier version of this tool skipped the
  chunk loop whenever `audio:start` had failed, which silently zeroed out the
  one thing this tool exists to load-test (caught during development — see
  the git history on `phone-client.mjs`). What `off` mode measures is
  therefore **transport + auth + room fan-out + settings I/O**, at the exact
  chunk cadence a real PTT session uses. **It does NOT exercise base64→PCM
  decode or VAD** — both live inside the STT session object
  (`engine/stt-session.ts`), which is never constructed when there is no
  routing, so `pushChunk` is a same-tick no-op (`audio.handler.ts`: "no live
  session → drop"). This is the closest available approximation of the
  owner's "fake engine" instruction — not a perfect one, and this file says so
  rather than letting a reader assume otherwise.

- **`--engine local`.** Leaves the server's DEFAULT seeded routing in place —
  which, measured directly against this server (`settings/defaults.ts`), is
  the **bundled, local, offline `builtin-sherpa-local` engine**. This is NOT
  an upstream vendor (no network call, no third-party cost, nothing the
  owner's "don't touch upstream" instruction is about) — it is the same model
  every self-hosted/OSS build runs by default. In this mode `audio:start`
  succeeds, chunks are actually base64-decoded and pushed through a real VAD
  gate (`stt/vad-gate.ts`) and a real offline ONNX recognizer
  (`stt/engines/sherpa-local.ts`), and the utterance ends with a real
  `stt:final`. **This is real, CPU-heavy local speech recognition, not a
  cheap stand-in** — measured on this dev machine, 2 concurrent clients alone
  pushed the server process to ~120% of one core (see
  `results/run-*-baseline-local.txt` if you ran one). At any real concurrency
  this mode will be dominated by local-ASR CPU cost long before it tells you
  anything about the relay's own socket/transport ceiling, which is why it is
  **not the default** and should be read as "the worst case if this box ever
  serves STT locally", not as "the relay's ceiling".

Neither mode gives you "decode + VAD, but not recognition" in isolation —
that specific slice does not exist as a reachable configuration on this
server today (there is no stub/null STT engine). If a future S0-family task
wants that middle measurement, the smallest correct fix is a test-only null
engine in `apps/server-core/src/stt/engines/` that runs `VadGate` and decode
but skips the recognizer call; this harness does not add one.

## What this deliberately does NOT do

- **Never talks to any upstream STT/LLM vendor.** `--engine off` configures
  zero engines; `--engine local` uses the bundled offline model. Neither mode
  makes a network call to Soniox, DeepSeek, or anything else. That is S0b's
  job, not this tool's — S0b is a separate, small, explicitly-costed run
  against real vendor accounts and does not exist in this repo yet.
- **Never exercises saas/auth/billing.** The server is spawned in
  `FLOWMIC_MODE=standalone`, the same single-user mode `pnpm golden` uses —
  no JWT, no Paddle, no per-account quota. A saas-mode run would need its own
  design (account provisioning at scale, quota interaction) and is out of
  scope here.
- **Never runs against production**, and structurally cannot by accident —
  see "Safety: never production" below.
- **Does not simulate the LLM `compose:*` path** (translate/organize) or
  image transit — only the realtime PTT audio path NR-5's own ledger entry
  names as the concurrency-relevant one (VAD + decode on the hot path).
- **Is not a precision instrument.** CPU/RSS sampling shells out to
  PowerShell per sample (see `lib/process-sampler.mjs`'s header) at a
  deliberately coarse interval so the sampler does not meaningfully perturb
  the number it is reading. Read the percentiles as "which order of
  magnitude", not as a profiler-grade trace.

## Safety: never production

- Default target is **always** `127.0.0.1` — the tool spawns its own local
  server unless you pass `--host` explicitly.
- Passing `--host` to point at an already-running instance still requires
  `--port`, and if the host is not loopback the tool refuses with a named
  error (`NonLoopbackTargetRefusedError`, `lib/target-guard.mjs`) unless you
  also pass `--i-know-this-is-not-production`. There is no config file, env
  var, or saved flag that carries that consent across runs — it must be typed
  every time.
- `baseline.mjs` never sets that flag itself and never accepts a `--host`
  override — the owner-requested ramp only ever runs against a freshly
  spawned local instance.

## Running S0a on the VPS (a separate operator action — not automated here)

The owner's actual question is the LA VPS's own ceiling, not this
workstation's. This tool does not connect to the VPS itself — that would mean
either shipping SSH credentials into a load-test script or silently
special-casing "the VPS is fine to hit", both of which are exactly the shape
the loopback-only rule above exists to prevent. Instead:

1. `ssh` to the VPS (see `docs/decisions/2026-08-17-*` production-origin notes
   for which box is current — do **not** assume the address in an old note is
   still it).
2. Copy or `git pull` this repo there (or just `scripts/loadtest/` plus
   `verify/golden/harness.mjs` plus `packages/protocol` — the harness only
   needs those).
3. `pnpm --filter @flowmic/protocol build && pnpm --filter @flowmic/server-core build`
   on the VPS.
4. Run `node scripts/loadtest/baseline.mjs` **on the VPS, against its own
   loopback** — from the VPS's own point of view this is still
   `127.0.0.1`, so no override flag is needed and no production traffic is
   touched (the harness always spawns its own throwaway instance on a random
   port; it never attaches to the box's real running relay process or
   database).
5. Copy `scripts/loadtest/results/*` back for comparison against the
   dev-machine numbers.

This is deliberately a manual, explicit, on-box action — an operator decision
each time, matching the owner's "compare a VPS run separately" framing in the
ledger, not something this tool automates or defaults toward.

### That run has been done — 2026-08-27

Results, production-impact evidence, cleanup proof and the capacity conclusion:
**`docs/strategy/2026-08-27-nr5-s0a-vps-load-test-results.md`**.

Headline: on the LA VPS (`flowmic-services`, 2 vCPU / 4 GB), **400 concurrent
paired devices held 100% connect and 100% pair with zero client-side errors,
`audio:start` p95 = 1ms, server CPU peak 49.98% of one core, RSS 183 MB** —
the relay's own transport ceiling was never reached. The live production relay
stayed under 2.5ms on `/api/health` throughout and was never restarted.

⚠️ Read that document's §6 before quoting the number: the load generator shared
the same two cores as the server under test, so the extrapolated ceiling
(~800–1,700) is **not** a measurement, and `engine='off'` still means no
decode/VAD/recognition was exercised.

Two portability defects in this harness were fixed to make that run possible —
`lib/process-sampler.mjs` had no Linux backend (and failed *silently* there,
reporting `n/a` CPU/RSS as though it had measured), and the report template
asserted "this ran on the operator's workstation, NOT the production VPS" as a
hard-coded string. The machine is now measured per run and printed in every
report. See that document's §7.

## CLI reference

Run `node scripts/loadtest/run.mjs --help` for the full flag list
(`--clients`, `--minutes`, `--ramp`, `--engine`, `--utterance-ms`, `--gap-ms`,
`--heartbeat-ms`, `--sample-interval-ms`, `--host`/`--port`,
`--i-know-this-is-not-production`, `--label`).

`baseline.mjs` takes `--steps` (comma list, default `10,50,100,200`),
`--minutes`, `--ramp`, `--engine`, and the same per-utterance flags; it stops
the ramp early (naming why) if a step's connect rate or pairing rate drops
below 95%, or its client-side error count exceeds 5% of utterance attempts.

## Reading the output

- **connect / pairing success** — should be 100% until something actually
  breaks; a drop here (not an audio-loop error) means the server stopped
  accepting new sockets/rooms, which is a different ceiling than the audio
  path's.
- **`audio:start` / `audio:stop` / `heartbeat` ack latency percentiles** —
  p50 tells you the happy-path cost; watch p95/p99 for queueing (a single
  thread falling behind shows up here first, before CPU% saturates, because
  Node's event loop queues rather than rejects).
- **server CPU% is "percent of one core"** — Node is single-threaded for JS
  execution, so 100% here means the main thread is saturated even on a
  multi-core box; the STT-engine-local mode can exceed 100% because the
  native ONNX addon it calls is not confined to the JS thread.
- **`stt_errors_acked` in `--engine off` runs is EXPECTED to equal
  `utterances_attempted`** — see "Engine modes" above. It is not a defect
  count in that mode.
