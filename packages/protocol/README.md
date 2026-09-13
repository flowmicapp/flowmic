# @flowmic/protocol

FlowMic wire protocol: the socket.io event-name whitelist, zod payload schemas,
error codes, engine/LLM presets, and shared TypeScript types. The single source
of truth for every FlowMic client and server — the event whitelist is
count-guarded (55) and `PROTOCOL_SCHEMA_VERSION` gates handshake negotiation.

## Install

Workspace package; consumed via `pnpm`. From the repo root:

```
pnpm install
```

## Build

Bundled with tsup (ESM + CJS + d.ts) into `dist/`:

```
pnpm -F @flowmic/protocol build
```

## Test

Vitest (zod round-trip, event-count guard, preset catalogue, error codes):

```
pnpm -F @flowmic/protocol test
pnpm -F @flowmic/protocol typecheck
```

## Codegen (Dart)

Regenerates the Dart mirror of `EVENT_NAMES` for the mobile client (event-name
constants only; the zod-schema Dart mirror is a later card). Runs on bare
`node`, no build step:

```
node packages/protocol/scripts/gen-dart.mjs      # or: pnpm -F @flowmic/protocol codegen:dart
```

Output (gitignored, regenerated in the mobile build flow):
`packages/protocol/gen/dart/flowmic_events.g.dart`

## Consuming this package from another repository

Published to GitHub Packages (a **private** npm registry) so the web clients can
speak exactly the protocol the relay speaks. Two facts a consumer has to know
before the first `pnpm add`:

1. **The published name is `@flowmicapp/protocol`, not `@flowmic/protocol`.**
   GitHub's npm registry requires the package scope to match the repository
   owner (`flowmicapp`). The monorepo keeps `@flowmic/…` internally, so the
   consumer aliases it and every `import … from '@flowmic/protocol'` keeps
   working:

   ```json
   {
     "dependencies": {
       "@flowmic/protocol": "npm:@flowmicapp/protocol@0.3.77"
     }
   }
   ```

2. **The registry needs the scope route and a token**, in the consumer's
   `.npmrc` — with the token supplied by the environment, never written into a
   tracked file:

   ```
   @flowmicapp:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```

Pin an exact version. A range would silently move the wire contract underneath a
deployed relay, and the two are only guaranteed to agree at the version they were
released together at (see the design register's note on the monorepo reading
`dist` through a workspace symlink while an outside repo reads the published
tarball — one symbol, two answers).

## Publishing

`node scripts/publish-packages.mjs --package @flowmic/protocol --dry-run` from
the repo root, or the `publish-packages` workflow on a `v*` tag. Both rebuild
`dist/` first: publishing whatever happens to be on disk is how a stale bundle
becomes a released one.
