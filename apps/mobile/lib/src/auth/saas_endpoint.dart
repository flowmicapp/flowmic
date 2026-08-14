// SPEC-REF:
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-2 ③ (endpoint seam:
//     --dart-define FLOWMIC_SAAS_ENDPOINT overrides; fallback the protocol
//     default constant; the private line may point this at the owner LAN model
//     service at build time — never hardcoded in a widget)
//   packages/protocol/src/constants.ts (DEFAULT_SAAS_ENDPOINT)
//   CLAUDE.md environment facts: the old office LAN model service
//     (100.64.7.x) must never be hardcoded in code → the
//     effective endpoint is a build-time --dart-define, not a literal.
//
// The SaaS endpoint seam. The effective cloud endpoint is resolved once here so
// no widget/controller carries a hardcoded literal: a build supplies it via
// `--dart-define=FLOWMIC_SAAS_ENDPOINT=...`, and absent that the fallback is the
// protocol SSOT default (mirrored from packages/protocol DEFAULT_SAAS_ENDPOINT).
// LoginController / ConnectionsController take an injectable `saasEndpoint`
// param defaulting to [resolveSaasEndpoint], so tests dial a fake host.

/// Mirrors packages/protocol/src/constants.ts DEFAULT_SAAS_ENDPOINT. This is the
/// fallback only — a real private build overrides it with --dart-define.
const String kDefaultSaasEndpoint = 'https://flowmic.app';

/// Build-time override key. `flutter build --dart-define=FLOWMIC_SAAS_ENDPOINT=…`.
const String kSaasEndpointDefineKey = 'FLOWMIC_SAAS_ENDPOINT';

/// The effective SaaS endpoint: the --dart-define override when present and
/// non-empty, else [kDefaultSaasEndpoint]. Never a widget-embedded literal.
String resolveSaasEndpoint() {
  const String override = String.fromEnvironment(kSaasEndpointDefineKey);
  return override.isNotEmpty ? override : kDefaultSaasEndpoint;
}
