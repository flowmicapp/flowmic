# @flowmic/i18n-web

The nine-locale message subset the FlowMic browser clients render.

Everything under `src/generated/` is produced by `scripts/i18n/gen-i18n-web.mjs`
from two files in the FlowMic monorepo:

- `i18n/web/subset.json` — **which** keys the web clients may render (a
  hand-maintained selection, reviewed like any other product decision);
- `i18n/mobile/<locale>.json` — **what** they say (the same catalogue the phone
  app compiles, so a wording ruling lands on both surfaces at once).

No sentence in this package is written by hand. `pnpm verify:lint`
(`i18n-generated-fresh`) fails when the generated output and its source disagree.

## Use

```ts
import { formatMessage, WEB_LOCALES, isWebLocaleCode } from '@flowmic/i18n-web';

formatMessage('zh-CN', 'statusInjected');
formatMessage('en', 'outboxPendingNotice', { count: 3 });
```

`formatMessage` requires a parameter object exactly when the sentence has holes,
and its keys must be that sentence's hole names — both are compile errors
otherwise. At runtime a hole with no value throws rather than rendering
`{count}` to a user.

## Registry and publishing

Published to GitHub Packages (private) as **`@flowmicapp/i18n-web`** — GitHub's
npm registry requires the package scope to match the repository owner. Consumers
keep the `@flowmic/…` import specifier through an alias; see
`docs/strategy/2026-09-05-web-client-subproject-design.md` §10 and the header of
`scripts/publish-packages.mjs` for the exact `package.json` and `.npmrc` lines.

The package version tracks the product version line (one product, one version
line — owner 2026-07-29), so `0.3.77` here is the same delivery as `0.3.77`
everywhere else in the repo.

## Licence

`AGPL-3.0-only`, the same as the monorepo this copy is derived from — **not**
`@flowmic/protocol`'s Apache-2.0. The two packages carry different things: the
protocol package is the wire contract, this one is product copy.
