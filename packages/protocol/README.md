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
