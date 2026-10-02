# Web voice v2 local acceptance

This extends EMB-13 without changing product sources. Read the rig header before
running: managed recognition spends real transcription minutes. The opt-in gate
is still `FLOWMIC_EMB13_LIVE=1`; `node scripts/emb13-live-rig.test.mjs` spends none.

Export and build the web client and website with `git archive`, then set:

```powershell
$env:__COMPAT_LAYER = $null
$env:FLOWMIC_EMB13_LIVE = '1'
$env:FLOWMIC_EMB13_WV7 = '1'
$env:FLOWMIC_EMB13_WEB_ROOT = '<exported web client>'
$env:FLOWMIC_EMB13_WEBSITE_ROOT = '<exported website>'
$env:FLOWMIC_EMB13_WV7_OUT = '<evidence directory>'
node scripts/emb13-live-rig.mjs --wv7-scenario=budget
```

Build the website with `VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA`.
The local challenge fixture calls the completion callback after 25 ms; the
visitor sees microphone startup and connection states without a Cloudflare
challenge widget. The local HTTP adapter exchanges the demo's
anonymous admission envelope for the throwaway publishable key, so its account
funds every recognition. The visitor sees the account's remaining time in the
demo footer. Anonymous trial limits and production Turnstile timing are not
measured by this boundary. Browser requests outside loopback are blocked; the
child relay alone contacts the configured recognition provider.

Scenarios: `budget`, `toggle`, `hold`, `gestures` (`tap-hold` is a compatibility alias), `escape` (control focused),
`escape-field`, `quiet`, `finishing`, `placement`, `keyboard`, `screenshots`,
`browsers`. `FLOWMIC_EMB13_WV7_SURFACES=home,try,sdk` selects surfaces;
`FLOWMIC_EMB13_RUNS=5` selects budget repetitions. Each budget repetition has a
new room and a second sentence in that room. `--wv7-check=<name>` restricts the
exit verdict to one named check for reverse controls; all observations stay in
the JSON. `all` runs budgets and basic behaviours; the separate scenarios are
needed for transport delays, the screenshot matrix, and the browser probes.

The silence scenario uses five seconds of digital silence followed by the real
fixture. The final-delay scenario holds actual incoming `stt:final` packets for
4.4 seconds. Neither substitutes recognized text. Screenshots record real states
at 1280 and 360 CSS pixels in light and dark contexts. The hero capsule retains
the website's explicitly dark theme. The SDK host intentionally retains EMB-13's
wide form, so its neighbouring fields extend beyond a 360 px viewport.

Budget timing is frame-sampled. Speech onset comes from a read-only analyser on
the actual capture stream (-40 dBFS); the first live word comes from rendered DOM.
The old relay-level interval is saved separately because its 300 ms window is
not speech onset. Stop timing uses the browser input event, and field arrival
uses the host's `input` event. CLS uses the browser's `hadRecentInput` exclusion;
raw shift entries are retained. Missing observations are `not measured`.

Reverse controls require the `tmp-wv7` archive export and its `web.tar` marker:

```powershell
node scripts/emb13-wv7-reverse.mjs placement
```

Other named controls are listed in that script. Each edits only the exported
demo heavy bundle, runs only its named scenario/check, restores the original
bytes in `finally`, verifies SHA-256 equality, and runs the same check again.
A receipt passes only on an actual named FAIL followed by PASS. Product defects
whose baseline is already red cannot supply a green restoration receipt.

Firefox uses native fake media preferences; its tone reaches the relay and
produces no recognized words. On the tested Windows WebKit build,
`navigator.mediaDevices` is absent and the visitor sees the microphone-start
failure sentence. The browser probe records unavailable enumeration as null,
never as a zero-device measurement. Layout-shift support is also recorded rather
than interpreting an unsupported API as a zero score.


WV-7d extension (code-only delivery; no new live acceptance claimed):

- `all` includes budget samples, request policy, a cold external hold, field Esc
  in recording/connecting/finishing and inactive states, idle/recording host
  dialogs (including idle after a settled sentence), the reused sequence (setup → toggle → hold → control
  Esc → quiet), plus independent quick-double-tap, tap/speak/tap, hold/speak/release and error-clearing rows, first-word retention, and control keyboard checks. Each field
  Esc case also checks host Space/Enter propagation and default prevention.
- Dedicated names: `escape-scoped`, `cold-hold`, `reused-silence`,
  `request-policy`, `first-word`. The finishing Esc case waits for an actual nonempty
  vendor final to enter transport escrow before it cancels in the anchored field, then delivers that final and
  checks for input events, insertion and a late restart. It cannot pass without
  a real delayed final. The dialog is a rig-owned nonmodal host dialog with an
  ancestor bubble Esc closer; arbitrary earlier host capture handlers are not
  covered by this integration contract.
- `/try` may load the challenge script before intent. Every surface still
  rejects pre-intent `/api/web/*` (including anonymous minting); the homepage
  also rejects the challenge request. Ordinary page assets are outside this
  voice-admission request budget.
- `FLOWMIC_EMB13_SENTENCES` is the budget sample count **per surface** (default
  10, or twice legacy `FLOWMIC_EMB13_RUNS`). Alternating sentences use a fresh
  context then its existing room. `FLOWMIC_EMB13_T4_RUNS` defaults to 5. The
  first-word reference has a setup sentence followed by an aligned sentence
  in the joined room. Cold trials require ONE original press, measured audible
  onset within 200 ms, audio withheld until the delayed room response, a
  buffered seq-0 chunk, matching reference prefix, insertion and an OK receipt.
  Slow microphone acquisition is a failed/non-probative row, never re-timed to
  a later chooser click. The supplied scene-G patch is also included; scene G
  remains opt-in through `FLOWMIC_EMB13_ONLY=G` outside WV7 mode.
- Before any relay/account is started, WV7 prints its plan and estimates 15
  seconds of streamed audio per planned recording. It refuses an estimate over
  `FLOWMIC_EMB13_MAX_MINUTES` (default 25). This estimate is not a hard billing
  ceiling: the existing throwaway key also has its independent 15-minute cap.
  The expanded complete plan has 39 recordings per surface (9.75 estimated
  minutes each, 29.25 total), exceeding the default cap; use the focused rerun below. Larger latency-only samples
  can use `budget`; 20 sentences on all three surfaces estimate 15 minutes.
- DRY resolves this same configuration and cap. `FLOWMIC_EMB13_LIVE=1` is still
  required to reach DRY, but DRY exits before relay/browser/account creation.
- Output is always a new timestamp/PID directory beneath
  `FLOWMIC_EMB13_WV7_OUT`. No rerun overwrites an earlier failure. All planned
  budget attempts survive as rows, including startup errors, missing metrics
  and timeouts. Never choose only a passing report when aggregating runs.
- `statistics` reports all/cold/warm/first-use/subsequent live-word strata;
  `metricStatistics` also reports reaction, listening and insertion. Each has
  attempted n, measured n, missing/failure/timeout counts, p50/p95 with exact
  binomial order-statistic 95% intervals, and the fraction above 2 s among
  measured values plus bounds across all attempts. Null interval endpoints
  mean unbounded. These nominal intervals assume independent sentences;
  paired sessions violate that assumption. Small samples cannot establish a
  stable p95, and no production latency is measured here.
- Each measured sentence carries a non-auth SHA-256-derived key, explicit
  browser timeOrigin, backend capture attachment, speech onset, first sent
  chunk/first loud PCM chunk, browser WebSocket interim receive, and DOM render.
  Receive/render use the same browser clock; relay wall timestamps are kept
  separate. No audio bytes or authorization envelopes enter decomposition.
  Existing relay first-interim emit logs are joined by hashed room plus sentence
  interval (room mapping is read from the local throwaway DB). Ambiguous/missing
  matches stay null. Audio arrival, vendor-leg-open, first-feed and first-vendor-
  interim timestamps are not logged per sentence by this relay and remain null.
- Offline gate: `node scripts/emb13-live-rig.test.mjs`. Every new acceptance
  judge has failing fixtures in `emb13-wv7-drill.mjs`. These validate the harness
  logic, not real recognition or a product-fix reverse control.


WV-RIG2 corrections (offline verification only):

- Field Esc requires a real textarea/input click and `document.activeElement`.
  Its default-prevention mark is sampled on the next task after dispatch.
  Finishing waits for a nonempty final in escrow, cancels, then releases it;
  `delayedFinalDelivered` also requires the browser's receive mark after Esc.
- Warm decomposition only exempts a missing capture attachment when an earlier
  attachment exists and this sentence made no new getUserMedia/attachment call.
  It reports `not applicable (capture reused)` and retains onset-to-word data.
- `gestures` replaces tap-then-hold. Each independent row is a named check:
  quick double tap during the fixture's silent segment (<1 s, no notice for
  >=5 s); tap/speak/tap; hold/speak/release; >=1 s empty-sentence notice followed
  by a new press that clears it. Reused-silence also exposes each child verdict.
- SDK budgets and first-word trials require one start press. No chooser clicks
  are synthesized. Reaction uses the first painted capsule or visible button
  pressed/loading feedback; the browser's generic `:active` alone is excluded.
  `phone-link` is a separate optional SDK panel check after a settled sentence.
- Placement accepts `dockTop` when capsule geometry is fully within the viewport
  with zero field/control overlap. WebKit errors/missing rows record FAIL and
  `WebKit not measured`; unavailable measurements cannot silently pass.
- Run `node scripts/emb13-wv7-drill.mjs` and
  `node scripts/emb13-live-rig.test.mjs` offline. Every changed judge has PASS
  fixtures and failing reverse controls. The transport fixture is invented text
  solely in the drill; live escrow releases the genuine final unchanged.
- `scripts/emb13-wv7-rerun.ps1 -WebRoot <built-client> -WebsiteRoot <built-site>`
  runs only failed areas plus 5/5 first-word trials on each surface. Estimated
  transcription is 17 minutes, or 18.75 with `-BaseWebRoot <eligible-built-base>`.
  Add `-Dry` to resolve inputs without starting anything. The optional base must
  itself support one-press SDK recording; a chooser-only base cannot isolate
  first-word retention. Two budget samples cover cold/warm regression only,
  not a stable latency distribution. Optional phone/browser checks are separate.
- The expanded `all` plan now estimates 29.25 minutes with default counts and
  is refused by the unchanged 25-minute cap. Use the focused plan above for
  this card's <=20-minute rerun; do not raise the cap just to run everything.
