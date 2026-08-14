# Contributing to FlowMic

Thanks for looking. This is a small project with unusually specific rules, so
this page is short and concrete rather than welcoming-and-vague.

**Read [CLAUDE.md](CLAUDE.md) before you write code.** It is the working
contract for this repository — the rules there are not style preferences, and
each exists because a real bug got past us once. This page covers process; that
one covers substance.

---

## Setup

```bash
pnpm install
pnpm --filter @flowmic/protocol build        # ← required; see below
pnpm --filter @flowmic/desktop build:sidecar # ← required if you have Rust
make -C apps/mobile gen                      # ← required if you have Flutter
pnpm verify:delivery
```

Node ≥ 22, pnpm ≥ 9. Rust ≥ 1.90 for the desktop app; Flutter ≥ 3.41 for the
phone app. You do not need all three to contribute to one of them.

**Neither build step is a warm-up — the gate fails without them on a fresh
clone.** Both produce a gitignored artifact that a later stage resolves by path:

- `server-core` imports protocol's `dist/`. Without it, type-checking fails
  outright with `TS2307`. And a *stale* `dist` is worse than a missing one: it
  has produced a false green here, silently stripping a new schema field so that
  a test which should have failed passed. Type-checking cannot catch that
  either — measured 2026-08-07 with `--traceResolution`: there is no `paths`
  mapping anywhere, so `tsc` also resolves `@flowmic/protocol` to `dist/`,
  meaning the type check runs against whatever contract happens to be on disk.
- The phone app's string catalogue, event mirror and settings mirror are
  generated Dart (`lib/generated/`, `lib/src/settings/l10n/*.g.dart`), all
  gitignored because they are derived from `i18n/mobile/*.json` and the protocol
  package. Without `make -C apps/mobile gen` the app does not COMPILE — the
  failure is a wall of "getter isn't defined" and "no 'part of' declaration"
  from files you never wrote, which reads as a broken checkout rather than a
  missing step. Measured 2026-08-14 on a fresh export of this repo: 190 phone
  tests failed that way, and the instruction was in `apps/mobile/Makefile` but
  not here, where someone setting up would look.
- The Tauri build script resolves `resources/server.js` and the three files
  staged beside it, which `build:sidecar` emits. Without them, `cargo` fails
  before it type-checks anything. The gate now stops one step earlier and tells
  you so by name — `verify:clippy` and `verify:rust-tests` both run
  `pnpm verify:sidecar-resources` first, which lists every missing file and
  prints the command above. (Tauri's own error names a path and not the command,
  which reads as "create this directory". Do not: it only checks that the path
  exists, so an empty one buys you a build that gets further and is wrong.)

If you are not set up for Rust, skip the second one — lint, types, and the
golden suite all still run in full. The `scripts` segment also still runs, but
one test in it (`it27-publish-node-pin.test.mjs`) is gated on a binary that
same build step stages: without it, that single test reports **SKIP**, not
PASS or FAIL, and names the command that would produce it.

---

## The gate

```bash
pnpm verify:delivery      # every gate segment; takes minutes, not seconds.
                          # The authoritative segment list is the script in the
                          # root package.json — any list copied here would rot.
```

The `scripts` segment runs the release-tooling tests that live beside the
scripts they test (`scripts/*.test.mjs`).

Everything must pass before you open a pull request. The pre-commit hook runs
the fast half (lint + types); **the golden suite is not hooked** — it starts a
real server and real sockets, so you have to run it yourself. Please actually
run it. A gate nobody invokes is indistinguishable from a gate that does not
exist, and we have the scar tissue to prove it.

If a golden path fails and you think it is unrelated to your change, say so in
the PR rather than working around it. It usually is related.

---

## What a good pull request looks like

**Small and one-thing.** A PR that fixes a bug and also renames things is two
PRs.

**Carries its own evidence.** Say what you ran and what you saw. "Tests pass" is
not evidence; `pnpm verify:delivery` output is. If you fixed a bug, the ideal PR
includes a test that goes **red without your fix** — and says that you watched
it go red. A reverse control that was never observed failing proves nothing.

**Names its production caller.** If you add a setting key, an event, or a
constant, the PR must be able to `grep` the place that uses it in production.
Capability-without-caller is this codebase's most common historical defect, and
it is the first thing a reviewer will check.

**Does not quietly narrow a promise.** If something cannot be done, the code
must say so out loud. Never swallow a failure, and never report as done
something that was not.

### Language

Everything that lands in the repository history is **English**: identifiers,
newly written code comments, commit messages, PR titles and bodies, issues, and
human-readable strings in CI config.

Most of `docs/` is Chinese and stays Chinese — those are internal behaviour
contracts and decision logs, and they are the source of truth even when the
surrounding code is English. Do not bulk-translate existing Chinese comments;
change a line's language only when you were already editing that line. A
translated comment is not a verified comment.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) —
`feat:` `fix:` `docs:` `refactor:` `test:` `chore:` `build:` `perf:`. This is
enforced by a hook.

**Commit messages must contain information about FlowMic and nothing else.** No
tool attribution, no generated-by trailers, no co-author lines for automated
assistants. If you used an AI to write the patch, that is fine and normal here —
just do not put it in the permanent record.

---

## Areas that need line-by-line human review

These four cannot be merged on green tests alone, and a PR touching them will
take longer:

- **protocol and schema changes**, including database migrations
- **the injection path**
- **pairing and authentication**
- **cryptography**

This is a commitment we make publicly. It is not a comment on your patch.

Some things are settled and not open to refactoring — three transcription modes
and never a fourth, the two encryption prefixes, immutable `source_text`, and
the rule that a delivery's id and its target machine's id must always
correspond. [CLAUDE.md](CLAUDE.md) lists them under "Product red lines". If you
think one is wrong, open an issue and argue it there before writing code.

---

## Contributor License Agreement

First-time contributors are asked to sign a CLA — [CLA.md](CLA.md) in this
repository. On your first pull request, the `cla` workflow
(`.github/workflows/cla.yml`, using
[contributor-assistant/github-action](https://github.com/contributor-assistant/github-action))
comments with a link to it and the exact sentence to reply with; that reply is
your signature and covers every future PR from your account. It takes about a
minute.

**Honestly, not yet observed:** this repository is private and has never had
an external pull request, so the workflow itself has never fired against a
real one. What is actually true today is narrower: the workflow file exists,
its YAML has been checked for syntactic validity, and its configuration
matches the upstream action's documented format. Whether the first real PR
gets the comment as described is the thing to watch and confirm when it
happens, not something already proven.

**Why we ask, given that the project is AGPL.** FlowMic ships through app
stores, and store terms conflict with the AGPL unless the copyright holder
grants an additional permission alongside it. We can only grant that for code
we hold the copyright to. Without a CLA, the first merged external patch would
quietly close the App Store route for everyone. See
[CLA.md](CLA.md#why-flowmic-asks-for-this) for the full reasoning, and
`docs/decisions/2026-08-02-open-source-license-agpl-vs-apache.md` for the
licensing decision this sits under.

The CLA does not take your rights away — you keep your copyright and can do
whatever you like with your own code. It grants us a license broad enough to
sub-license and, if it ever becomes necessary, relicense your contribution,
which is what makes store distribution (and the possibility of a future
commercial dual-license, see the decision doc above) legally possible.

The CLA has been in force since 2026-08-14; questions about it go to
[github@flowmic.app](mailto:github@flowmic.app).

If you would rather not sign, open an issue describing the fix. That is a real
contribution and we will credit you for it.

---

## Good first contributions

- **Linux desktop support.** The server already runs on Linux; the desktop app
  does not, because nobody has written the injection layer for X11 or Wayland.
  This is the single most-requested thing we cannot do ourselves right now.
- **A speech engine we do not support.** The engine interface is small and lives
  in `apps/server-core/src/stt/engines/` — `base.ts` plus one file per engine.
- **Translating a doc.** Most of `docs/` is in Chinese. `docs/rebuild/` is the
  set worth reading, and worth translating.
- **Anything in the issue tracker labelled `good first issue`.**

## Reporting bugs

Include: what you did, what you expected, what happened, your platform, and the
version (Settings → About, or `/api/health` on the server). If it involves
delivery to a PC, the timeline row's status is the single most useful detail —
it records what we can actually prove happened, not what we hope happened.

**Security issues do not go in the tracker** — see [SECURITY.md](SECURITY.md).
