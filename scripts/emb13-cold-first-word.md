# Cold first word (WV-RIG3)

This scene tests cold capture and delivery through the built homepage, `/try`
and SDK, the real browser capture pipeline and the local server-core relay.
It requires a PCM-dependent **fake STT**; no vendor credentials are read and
no managed recognition is allowed for this scene. The relay's ordinary usage
counter still increments locally; it is not a vendor spend measurement.

After building web core, SDK, demo-card and the website, run in PowerShell:

```powershell
$env:__COMPAT_LAYER = $null
$env:FLOWMIC_EMB13_LIVE = '0'
$env:FLOWMIC_EMB13_FAKE_STT = '1'
$env:FLOWMIC_EMB13_WV7 = '1'
$env:FLOWMIC_EMB13_WV7_SCENARIO = 'cold-first-word'
$env:FLOWMIC_EMB13_WV7_SURFACES = 'home,try,sdk'
$env:FLOWMIC_EMB13_WEB_ROOT = 'C:\built-client'
$env:FLOWMIC_EMB13_WEBSITE_ROOT = 'C:\built-website'
$env:FLOWMIC_EMB13_DRY = '1'
node scripts/emb13-live-rig.mjs
$env:FLOWMIC_EMB13_DRY = '0'
node scripts/emb13-live-rig.mjs --wv7-check=cold-first-word
```

Exit 0 means every selected surface passed; 1 retains a failing report. A bare
invocation still skips with exit 2. Each run gets a distinct timestamped output
directory under `FLOWMIC_EMB13_WV7_OUT` (default `.local/wv7`).

All knobs are nonnegative integer milliseconds (maximum 60000):

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `FLOWMIC_EMB13_CHALLENGE_DELAY_MS` | 8000 | Render to challenge callback, homepage and `/try` |
| `FLOWMIC_EMB13_ENTRY_DELAY_MS` | 1500 | Entry GET response body completion |
| `FLOWMIC_EMB13_RUNTIME_DELAY_MS` | 1500 | Demo and SDK runtime/chunk response completion |
| `FLOWMIC_EMB13_ROOM_DELAY_MS` | 1500 | Room response completion |
| `FLOWMIC_EMB13_JOIN_DELAY_MS` | 0 | Actual outgoing `mobile:pair` / `mobile:reconnect` forwarding |
| `FLOWMIC_EMB13_SPEECH_DELAY_MS` | 500 | Source onset relative to the first press |
| `FLOWMIC_EMB13_COLD_SETTLE_MS` | 1800 | Maximum pre-press wait for permitted idle entry delivery |

Requests are intercepted and complete bodies are held for the configured delay.
This models unavailable code during a download; it is not packet-level bandwidth
simulation. HEAD probes stay immediate, so entry GET is delayed only once.
The SDK's publishable-key admission has no Turnstile; challenge timing is not
invented there. Room/join knobs apply to all surfaces. `joinMs` is wire delay,
not an artificial product state. Defaults honor the card's 1.5 s runtime; MAIN
can set runtime to 2000 for the design ruling's >=2 s stress check.

Each surface gets a new browser context, blocked service workers, routing and
explicit CDP cache disabling. The rig permits idle entry prefetch, waits at most
the settle interval for it and gives it 50 ms to evaluate. It never deliberately
prewarms the heavy runtime or waits for a room. SDK field focus selects the
insertion target. The first press starts speech at +500 ms, then the rig stops
after the six-second fixture plus 800 ms. Slow demo admission therefore finishes
after stop, exercising buffered replay.

The WebAudio bus runs silent before the press. Its source starts once at the
press-derived audio timestamp, regardless of whether `getUserMedia` has been
called. Each acquisition clones that running bus: opening late loses samples;
it never restarts speech. An independent AudioWorklet measures the source's
first nonzero sample, including when no product microphone is open. The clock
mapping uncertainty is one 128-sample render quantum plus the performance-clock
sampling interval (8 ms at 16 kHz); the judge allows at most 20 ms and also
requires measured graph onset within 20 ms of schedule. OS device latency,
permission-prompt timing and physical microphone accuracy are not measured.

The bundled six-second Mandarin WAV carries pilot tones over its first 700 ms
(700 Hz) and a later segment (1300 Hz, 3.5–5.5 s). A local adapter at the existing
`FLOWMIC_STT_CLOUD_MODULE` hook decodes only **received PCM**: >=600 ms of first
pilot earns the deterministic label `First`, >=100 ms of tail earns `tail`.
These are fixture labels, not a Mandarin transcript. The adapter has no network
implementation. This checks preservation of nearly the whole first segment,
relay final delivery and actual field insertion, not recognition accuracy.

PASS requires the first label in both relay final and field, the tail, a
successful insertion receipt, measured press alignment, exercised latency knobs,
and no rendered Listening state/text before the browser sends its first audio
frame. No Listening state is required: stop-before-join can skip it truthfully.
Source schedule/onset, mic calls, request deliveries, wire facts, rendered states
and a screenshot survive in the report. No tokens or audio payloads are exported.

The drill includes reverse controls for missing/clipped first audio, plain
speech without pilots, silence, mic-relative scheduling, false Listening,
missing receipts/transport/timing evidence and omitted latency injection:

```powershell
node scripts/emb13-wv7-drill.mjs
node --test scripts/emb13-cold.test.mjs
node scripts/emb13-live-rig.test.mjs
```

A useful browser positive control is the same production build with challenge,
entry, runtime and room delay variables set to zero. Restore them before judging
WV-PRESS. For archived-build runs, preserve source SHAs and hashes of served
artifacts. If removing an export containing dependency junctions, unlink those
junctions first, then remove only the verified export directory.

## Touch and second press (WV-RIG4)

Use `FLOWMIC_EMB13_WV7_SCENARIO=cold-first-word-touch` and
`FLOWMIC_EMB13_GESTURE=tap` or `hold` for each touch variant. Each invocation
covers all three surfaces in fresh mobile contexts with `hasTouch: true` and
`isMobile: true`. Taps use Playwright `touchscreen.tap`; holds use CDP
`Input.dispatchTouchEvent` touchStart/touchEnd. Coordinates are measured again
for each tap because focusing a field can move the mobile viewport.
`FLOWMIC_EMB13_TOUCH=1` also selects touch input for other cold scenes;
its default is `0`. GESTURE defaults to `tap`; other values fail configuration.

Use `FLOWMIC_EMB13_WV7_SCENARIO=second-press` (tap only) for press, speak,
stop, press again while the runtime is pending, speak, stop. Two independent
700 ms marked speech segments start 500 ms after their respective presses.
The first stop is 1250 ms after the first press and the next press follows
100 ms later. The judge checks the measured second press against actual runtime
delivery, independently measured audio onsets, exactly one audio start/final,
and exactly `First tail.` in both the final packet and the field. The fake STT
preserves pilot arrival order, so reversed audio cannot manufacture a pass.
All cold scenes reject Listening before the first transported audio chunk.

For the WV-PRESS comparison use runtime delay 2000 ms, challenge delay 8000 ms,
and the other defaults above. Run all three combinations on both the candidate
and production builds, selecting `--wv7-check` to match the scenario. These
scenes always require `FLOWMIC_EMB13_FAKE_STT=1`; use `FLOWMIC_EMB13_LIVE=0`.
Chromium touch emulation is not a physical-device Safari test.

## Quiet release (WV-RIG6)

Use `FLOWMIC_EMB13_WV7_SCENARIO=quiet-release`, with
`FLOWMIC_EMB13_QUIET_PAUSE_MS=250` or `600`, `FLOWMIC_EMB13_GESTURE=tap` or
`hold`, and `FLOWMIC_EMB13_TOUCH=0` or `1`. Run all eight combinations on all
three surfaces with runtime delay 2000 ms and challenge delay 8000 ms.
This fake-only scene plays the 700 ms first marked speech segment, then digital
silence. An independent AudioWorklet observes the last audible sample. The
actual stop input must follow it by the requested pause (20 ms clock tolerance,
100 ms maximum dispatch slack) and precede the first runtime delivery.
Exactly one audio start and one final must produce `First.` in the field with
a successful insertion receipt. Any rendered Reconnecting state fails. The
rig observes for five seconds after insertion to catch late duplicate finals.
The drill includes reverse controls for missing/incorrect silence timing,
release after runtime, reconnecting, missing insertion and duplicate sentences.

`node scripts/emb13-wv7-drill.mjs` covers the knobs and judges with reverse
controls (mouse input, short hold, late/missing second press, missing/reversed
parts, multiple finals and premature Listening). `node --test
scripts/emb13-cold.test.mjs` checks the real interception and fake-only guard.
