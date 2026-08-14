// Test-support helper for lan_pin_real_handshake_test.dart — mint a LAN TLS
// identity WITH THE PRODUCT'S OWN GENERATOR and print it as JSON.
//
// Why a runtime mint instead of a committed fixture: CLAUDE.md's security
// section forbids committing certificates/keys, and
// test/lan_pin_trust_funnel_guard_test.dart already ruled that a cert+key
// fixture is covered by that rule. Minting at test time keeps key material out
// of the repo entirely — and as a bonus the certificate the test serves comes
// from the exact code path a real sidecar walks (this repo's measurement-
// provenance law: a sample is only as hard as the mechanism that produced it).
//
// Node is NOT a new dependency of the mobile test flow: `make -C apps/mobile
// test` already runs `node tool/gen_protocol.mjs` before flutter test.
//
// `--experimental-strip-types` is required (x509.ts is TypeScript); the Dart
// caller passes it. Stdout carries exactly one JSON object; warnings go to
// stderr and are ignored by the caller.

import { mintLanTlsIdentity } from '../../../server-core/src/lan-tls/x509.ts';

const m = mintLanTlsIdentity();
process.stdout.write(
  JSON.stringify({
    certPem: m.certPem,
    keyPem: m.keyPem,
    spkiDerB64: m.spkiDer.toString('base64'),
  }),
);
