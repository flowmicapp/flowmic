<!--
  PUBLIC edition of the repository working contract.

  This file ships to the open-source repository AS `CLAUDE.md`
  (scripts/opensource-manifest.mjs → REPLACE). The internal edition stays
  private: it carries deployment topology, commercial decisions and the
  owner's private rulings, none of which belong in a public repo — and none
  of which a contributor needs.

  Keep the version anchor below. ⚠️ CORRECTION (2026-08-04, superseded
  2026-08-06): the line that used to sit here claimed
  verify/lint/version-sync.mjs treats THIS file as one of the version faces
  and fails on drift. That was false at the time — version-sync.mjs:104 and
  bump-version.mjs:56 both keyed on the FILENAME `CLAUDE.md`, so the anchor
  here only became a face AFTER the export renamed this file (see
  opensource-manifest.mjs REPLACE). How the false claim was caught: this
  anchor had drifted to 0.2.39 and sat there for fourteen releases while the
  lint reported 9 faces @ 0.2.53 and stayed green.

  ⇒ FIXED (2026-08-06): `CLAUDE.public.md` is now its own registered face —
  by its own filename, independent of the export rename — in BOTH
  scripts/bump-version.mjs (FACES table) and verify/lint/version-sync.mjs.
  The anchor below is re-levelled to match root, and the next
  `bump-version.mjs` run will move it along with every other face; drift here
  now fails `pnpm verify:lint` before it ever reaches a public export.
-->

# CLAUDE.md — working contract for this repository

> Read this before you change anything. It applies to humans and to AI agents
> alike; most of this codebase was written by agents under these rules, and the
> rules exist because each one was paid for with a real bug.

**Current version: <!--version:current-->0.2.66<!--/version:current-->**

## What this is

FlowMic is a cross-device voice input system. You speak into your phone;
transcribed text streams into whatever input field has focus on your computer.
Three modes — realtime, translate, organize — and nothing else, ever (see
"Product red lines"). It runs either as a LAN sidecar with no cloud at all, or
through a relay when the two devices are not on the same network.

```
packages/protocol   @flowmic/protocol — event whitelist, zod schemas, error
                    codes, Dart codegen.  Apache-2.0 (deliberately: third-party
                    clients should be able to speak this protocol without
                    inheriting the AGPL).
apps/server-core    Node server. One binary, two modes: `standalone` (the LAN
                    sidecar the desktop app spawns) and `saas` (the relay).
apps/desktop        Windows desktop — Tauri v2 + Vue 3 + a Rust injection layer.
apps/mobile         Flutter app (Android today; iOS in progress).
verify/             The gates. `verify/lint` (10 static rules) and
                    `verify/golden` (18 end-to-end paths against a real server
                    over real sockets).
docs/rebuild/       The behaviour contracts. 04 protocol · 05 data · 06 engine ·
                    07 desktop · 08 mobile · 15 channels/states/failures ·
                    16 portable record format. Written in Chinese.
docs/decisions/     Decision log. Four sections (Situation / Options / Chose /
                    Why), ≤20 lines. Read the one next to the code you touch —
                    it usually explains why the obvious refactor is wrong.
```

## Before you commit

```bash
pnpm verify:delivery      # lint + types + clippy + golden  (~35s)
```

All four must pass. `verify:lint` and `verify:types` also run in the
pre-commit hook; the golden suite does not, because it starts a real server and
real sockets (~7.5s) — so **you have to run it yourself**. A test nobody runs is
the runtime form of a feature nobody calls: it being red and it not existing are
the same thing. That is not hypothetical here — one golden path sat red for
weeks because nothing invoked it.

**If you change `packages/protocol`, build it first:**

```bash
pnpm --filter @flowmic/protocol build
```

`server-core` consumes protocol's `dist/` (gitignored), not `src/`. A stale
`dist` lies in both directions: it has produced a false green (a new zod field
silently stripped, so an assertion that should have failed passed) and a false
red. `verify:types` cannot catch it — tsc resolves through path mappings to
`src`. `pnpm golden` now rebuilds both packages every run for exactly this
reason.

## Rules that are not style preferences

Each of these is a scar. Breaking one has broken this product before.

### No silent failure — in both directions

Never swallow a failure, and never report something as done when it was not. Any
"success" receipt must be able to answer *how do you know the other side got
it*. If it cannot, it is not allowed to say success. This applies to user-facing
copy too: "queued for delivery" was a promise we had not kept, and it became
"not injected".

An unregistered event is silently dropped at the protocol boundary, so removing
an event is more expensive than adding one: old clients keep sending it into the
void. Protocol changes are additive-field-first, guarded by a whitelist and a
count check, and an unknown event fails CI.

### Anti-façade: a capability nobody calls is this codebase's #1 historical bug

Every change must be able to name the production caller of every new setting
key, event, and constant — by `grep`, not by memory. Four corollaries, each
learned the hard way:

1. `grep` is not only for *new* symbols. After a port or refactor, ask of every
   dependency-injection default: *who passes the real implementation in
   production?* A lost constructor argument leaves no new symbol to grep for.
   The microphone in this app was never once opened, and every test was green.
2. **A DI default must never be a friendly no-op.** Either the real
   implementation or a `throw`.
3. Green unit tests prove nothing about wiring. Every real path needs one run
   against the real ends.
4. **A comment that justifies a design is itself a grep-able claim.** If a
   comment says "this is how the UI learns X", then that UI must be findable.
   One such comment protected a genuine bug through code review because the
   reviewer read the justification and stopped asking.
5. A hand-written type predicate (`(x): x is T =>`) is an assertion the compiler
   does not check. One of them narrowed a field to `string` while testing
   `typeof x === 'object'`, so an array was empty on every machine on earth and
   a whole feature never appeared once — with eleven green tests over it.

### Language: English in the code, Chinese in the internal docs

The team is mixed Chinese/English. The split is by artefact, not by author:

- **English, always**: identifiers, **newly written code comments**, commit
  messages, PR titles and bodies, issues, and any human-readable string in CI
  config. This is what a future reader of the repository history gets.
- **Chinese, still**: `docs/rebuild/` behaviour contracts, `docs/decisions/`,
  `docs/strategy/` handoff reports, and day-to-day chat. Their audience is
  internal, and rewriting them buys nothing while risking real meaning.
- **This rule governs only what you write from now on.** There is a large body
  of Chinese comments and Chinese test descriptions in the tree. Do **not**
  sweep it — the same discipline that forbids a global regex over version
  numbers forbids it here. Translate a line only when you were already editing
  that line.
- Translating a comment does not make it true. An English comment is still
  bound by the anti-façade rule above: a claim about code elsewhere needs a
  grep-able anchor or a test that pins it.
- **User-facing product copy is out of scope.** The four-language strings in
  `AppStrings` and `error-codes.ts` are governed by the i18n lint; do not touch
  any language of a user-visible string because of this rule.

### One value answers one question

The single most common defect shape in this repository: a value that naturally
answers question A gets read somewhere else as the answer to question B. Five
instances surfaced in one day once. Before you reuse a value, ask what question
it is currently answering.

### Negative assertions need a positive control

If your test asserts something did *not* arrive:

- Assert on **frames**, not on one event name. "Replied with an error but
  forwarded it anyway" passes a test that only checks the error code.
- The probe on the side that *should* have received something must be non-empty
  in the same run — otherwise "zero" might mean your probe is blind.
- A reverse control counts only if you actually watched it go red.

### Versioning

Every delivered round bumps the patch version. Only the repository owner bumps
minor or major. Use the script — there are **8 version faces** and editing them
by hand always misses one:

```bash
node scripts/bump-version.mjs patch     # or minor / major / x.y.z
```

`verify:lint version-sync` fails on any face that drifts, including the anchor
at the top of this file. Do **not** run a global find-and-replace over `docs/`:
version numbers in the decision log are historical facts, and rewriting them is
falsifying the record.

## Product red lines

These are not up for refactoring. Ask before you approach them.

- **Three modes, never a fourth.** Switching modes clears the buffer.
- **Two encryption prefixes, never interchangeable**: `enc:v1:` (server can
  decrypt) and `e2e:v1:` (blind storage).
- **`source_text` is immutable.** Status records delivery truth only — five
  states (`injected` / `cached` / `failed` / `noted`) plus an `edited` flag.
- **Never cross wires.** A delivery id and its target machine id must
  correspond: which phone spoke, over which channel, to which computer — 100%
  correct. A queued item carries its full addressing; draining must never infer
  the destination from "who is connected right now". A mismatched frame is
  refused, never rerouted.
- LLM failure must never silently fall back to injecting raw transcript text.
- Settings save on change. No save button, no "advanced" drawer.
- The transparent HUD must ship `--disable-features=CalculateNativeWinOcclusion`,
  and must never steal focus.
- Any latch that closes on a remote event needs a local watchdog.

## Human review required

Four areas get line-by-line review and cannot be merged on green tests alone:
**protocol / schema (including DB migrations)**, **the injection path**,
**pairing and auth**, and **cryptography**. This is a commitment we make
publicly, not an internal formality.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request flow, the CLA, and
what a good first issue looks like. Security reports go through
[SECURITY.md](SECURITY.md) — please do not open a public issue for those.
