# Disposable local web-input relay bench

This is an opt-in local integration tool. It runs the production bootstrap,
HTTP routing, Socket.IO handlers, billing repositories, and custom ASR adapter.
The only recognition provider is a loopback HTTP fixture: it requires a real WAV
with nonzero PCM and then returns fixed text. Browser audio is synthetic. This
is not a physical microphone/phone test or a recognition accuracy result.

The two host origins, integrator owners/keys, database, ports, and control token
are generated locally. No production account, service, DNS, system hosts entry,
owner switch, or deployment is used. The browser maps `flowmic.app` to
`127.0.0.44:443`; this keeps the real strict `/go` URL and real microphone page.
The test certificate remains in the client ignored `e2e/fixtures` directory.

All commands below use PowerShell. Set `TEMP` and `TMP` to an existing F-drive
temp directory. Both repositories, dependency stores, state, builds, and output
must remain on the repository volume. Use the actual checkout paths on your
machine. The scripts require the normal installed server-core dependencies,
current protocol/STT builds, client dependencies, Playwright Chromium, and
OpenSSL (the existing client TLS helper locates Git for Windows OpenSSL).

## Build and start

From the main repository:

```powershell
$env:TEMP='F:/flowmic-tools/tmp'
$env:TMP=$env:TEMP
pnpm --filter @flowmic/protocol build
pnpm --filter @flowmic/stt-cloud build
node apps/server-core/test/local-web-bench/build.mjs
```

The default state directory is `apps/server-core/.local/local-web-bench`.
`build-evidence.json` records the bundle hash and every bundled input hash;
startup refuses a modified bundle or stale input.
The state contains generated code, SQLite data, observations, and random local
credentials; never commit it. An optional `--state-dir` must remain inside
`apps/server-core/.local`, so external dependencies resolve from this checkout.

Build the current client core, SDK, demo card, microphone app, and account target:

```powershell
pnpm --filter @flowmic/web-core build
pnpm --filter @flowmic/web-sdk build
pnpm --filter @flowmic/web-demo-card build
pnpm --filter @flowmic/web-mic build
pnpm --filter @flowmic/web-target build
node scripts/build-freshness.mjs @flowmic/web-core @flowmic/web-mic @flowmic/web-target
```

After the current build succeeds, write the lowercase SHA-256 of
`packages/sdk/dist/flowmic-sdk.v1.js` to the main state directory's
`approved-sdk.sha256`. `/sdk.js` returns 503 if that exact digest no longer
matches. Never approve an old bundle to bypass source freshness.

From the main checkout run (replace the client path):

```powershell
node apps/server-core/test/local-web-bench/harness.mjs --web-root F:/src/flowmic-web
```

For a background Windows launch use `Start-Process -WindowStyle Hidden` with
explicit F-drive stdout/stderr paths. The process writes `meta.json` containing
its own PID, current hosts/ports, test keys, and control token. Wait for
`LOCAL_B_READY` and `healthy:true, sdkReady:true` from the host `/health` before
browser execution. Read the current metadata; do not reuse old ports or keys.
If port 443 on 127.0.0.44 is occupied, report it; do not kill unrelated services.
Stop only this process after verifying the metadata PID and its command line.

## Browser checks

From the client checkout, with the same F-drive temp settings:

```powershell
$env:FLOWMIC_LOCAL_B_META='F:/src/flowmic-app/apps/server-core/.local/local-web-bench/meta.json'
$env:PLAYWRIGHT_BROWSERS_PATH='F:/flowmic-tools/ms-playwright'
# Copy the mobile checkout's actually resolved Dart libraries; do not change its config/cache.
node e2e/harness/prepare-local-relay-dart.mjs F:/src/flowmic-app/apps/mobile/.dart_tool/package_config.json F:/flowmic-tools/dart-socket-probe
$env:FLOWMIC_DART_EXECUTABLE='F:/flutter/bin/cache/dart-sdk/bin/dart.exe'
$env:FLOWMIC_DART_PACKAGE_CONFIG='F:/flowmic-tools/dart-socket-probe/package_config.json'
pnpm exec playwright test e2e/b-local-input.spec.ts --config e2e/playwright.local-relay.config.ts
```

Nine cases must execute with zero skips: actual two-leg local audio/owner billing/
DOM receipt/reconnect pong and real browser `/go` handover; a foreign host key
refusal; processing handover with natural delivery; and the same handover with a
150 ms and 2000 ms delays in forwarding actual production `pc:mobile-left` frames;
and an independently opened second real `/go` page after a requested local yield. The
delay never creates a departure: it captures the production frame and delays
only its transfer. Evidence separately records the production observation and
the eventual outbound frame. Compare natural and delayed animation-frame
samples; do not claim an intermediate state was naturally visible when it had
zero animation frames. All handover cases require the matching real receipt outbound
to the microphone to precede the real leave notification, then QR visibility. The 2000 ms case requires QR hidden throughout the real-frame
hold and visible within 500 ms after actual forwarding. The independent second
M must be joined by a real relay acknowledgement, without PC_BUSY.

The additional checks cover two same-origin local tabs with distinct rooms and
text delivered only to each own textarea; a real Dart `client:app` socket whose
one handset slot is unchanged after a browser local microphone joins; and the
actual `/target/` app after a local account is registered and signed in through
its normal account path, then local audio and real `/go` handover. The slot
snapshot calls production `countMobileDevices`, the same arithmetic used by the
ceiling and console. The Dart probe uses the mobile checkout's resolved
`socket_io_client` and reuses one valid device UID per disposable bench, so
repeated runs do not fill new handset slots. It then really reconnects its
separate target socket to trigger the relay's 1500 ms liveness probe. A matching
server-observed ping/pong nonce, the confirmed reconnect roster, a later
`pc:list-mobiles` online reading, and a still-connected Dart socket must all agree
after more than 1500 ms. Waiting alone is not accepted as proof. This proves the
real Dart Socket.IO path, not physical phone hardware or the Flutter screen. The old microphone
page's own two-tab behavior is not claimed fixed by the new local-tab check.

The full walk intentionally pauses before the two-tab case until the observed
room requests have left the production owner limiter's one-minute window. The
first group uses all five permitted mints; racing straight into the next group
would correctly receive `WEB_ROOM_RATE_LIMITED`. This pacing does not change,
clear, or bypass the production limit. Use a newly started disposable bench for
a full run; retain older databases and evidence rather than reusing their
request windows or account-registration budget.

The optional spec is skipped by the unrelated default fixture suite when no
metadata path is provided. That skip is not an acceptance result. Results,
screenshots, traces, PCM/billing facts, and animation-frame samples go to the
client `.local/b-local-results`; archive each run before the next overwrite.

The bench clears inherited FLOWMIC configuration. It sets runtime trusted proxy
only for its literal loopback TLS proxy and points STT only to its local HTTP
fixture. Merely overriding `loadConfig.trustedProxies` declares posture but does
not establish runtime trust; omitting the actual literal loopback setting mints
ws:// URLs whose browser upgrade may lose Origin. Do not loosen the production
Origin policy to accommodate such a fixture mistake.
