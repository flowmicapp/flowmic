// card S2-01 — the three additive optional fields that let this protocol tell a
// browser end from an app end, and let a microphone ask a target whether it can
// receive an image at all.
//
// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.1/§1.2/§5
//   docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3
//   docs/decisions/2026-09-06-owner-web-client-rulings-repo-protocol-domains.md 2
//
// 🔴 THE ONE PROPERTY WORTH TESTING TWICE: a frame from a build that predates
// these fields must parse to something BYTE-FOR-BYTE identical to what it parsed
// to before. Additive means 「the old world is unchanged」, and zod strips unknown
// keys — so 「the schema accepts the new field」 and 「the new field survives the
// parse」 are two different claims, and only the second one matters on the wire.

import { describe, it, expect } from 'vitest';
import {
  CLIENT_ORIGIN_DEFAULT,
  CLIENT_VERSION_MAX_LENGTH,
  ClientOriginSchema,
  MobilePairSchema,
  PcListMobilesAckSchema,
  PcPairedMobileSchema,
  PcReconnectSchema,
  PcRegisterSchema,
  TargetCapsAckFieldsSchema,
  TargetCapsSchema,
  clientOriginOf,
} from '../src/protocol-schemas';

const LEGACY_REGISTER = {
  device_name: 'dev-pc-a',
  client_instance_id: 'inst-0123456789abcdef',
  machine_uid: 'pc-00112233445566aa',
};
const LEGACY_PAIR = { short_code: '4831', mobile_name: 'Pixel 9', device_uid: 'mb-00112233445566aa' };

describe('client origin — the default has ONE author', () => {
  it('reads an absent / unknown / malformed value as the app', () => {
    for (const v of [undefined, null, '', 'App', 'ios', 42, {}]) {
      expect(clientOriginOf(v)).toBe('app');
    }
    expect(CLIENT_ORIGIN_DEFAULT).toBe('app');
  });

  it('reads the one value that is not the default', () => {
    expect(clientOriginOf('web')).toBe('web');
  });

  it('accepts exactly two kinds on the wire — a third is not silently admitted', () => {
    expect(ClientOriginSchema.safeParse('app').success).toBe(true);
    expect(ClientOriginSchema.safeParse('web').success).toBe(true);
    for (const bad of ['desktop', 'WEB', '', null]) {
      expect(ClientOriginSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('pc:register / pc:reconnect carry the origin and the target caps', () => {
  it('a pre-S2-01 frame parses to EXACTLY what it parsed to before', () => {
    expect(PcRegisterSchema.parse(LEGACY_REGISTER)).toEqual(LEGACY_REGISTER);
    const legacyReconnect = { token: 't'.repeat(32), machine_uid: 'pc-00112233445566aa' };
    expect(PcReconnectSchema.parse(legacyReconnect)).toEqual(legacyReconnect);
  });

  it('SURVIVES the parse (accepting a key and keeping it are different claims)', () => {
    const parsed = PcRegisterSchema.parse({
      ...LEGACY_REGISTER,
      client: 'app',
      client_version: '0.3.78',
      target_caps: { image: true },
    });
    expect(parsed.client).toBe('app');
    expect(parsed.client_version).toBe('0.3.78');
    expect(parsed.target_caps).toEqual({ image: true });
  });

  it('carries them on the RECONNECT leg too — an installed desktop never re-registers', () => {
    const parsed = PcReconnectSchema.parse({
      token: 't'.repeat(32),
      machine_uid: 'pc-00112233445566aa',
      client: 'app',
      client_version: '0.3.78',
      target_caps: { image: true },
    });
    expect(parsed.target_caps).toEqual({ image: true });
    expect(parsed.client).toBe('app');
  });

  it('caps the version string rather than trusting it', () => {
    const ok = { ...LEGACY_REGISTER, client_version: 'v'.repeat(CLIENT_VERSION_MAX_LENGTH) };
    expect(PcRegisterSchema.safeParse(ok).success).toBe(true);
    const tooLong = { ...LEGACY_REGISTER, client_version: 'v'.repeat(CLIENT_VERSION_MAX_LENGTH + 1) };
    expect(PcRegisterSchema.safeParse(tooLong).success).toBe(false);
    expect(PcRegisterSchema.safeParse({ ...LEGACY_REGISTER, client_version: '' }).success).toBe(false);
  });
});

describe('mobile:pair — all three admission arms, or none', () => {
  it('a pre-S2-01 pair frame is unchanged', () => {
    expect(MobilePairSchema.parse(LEGACY_PAIR)).toEqual(LEGACY_PAIR);
  });

  it.each([
    ['short_code', { short_code: '4831' }],
    ['qr_payload', { qr_payload: 'https://go.flowmic.app/pair?code=4831&pcid=930582147&v=1' }],
    ['cloud_instance', { cloud_instance: true as const }],
  ])('%s arm keeps client + client_version', (_name, arm) => {
    const parsed = MobilePairSchema.parse({ ...arm, client: 'web', client_version: '1.0.0' });
    expect(parsed.client).toBe('web');
    expect(parsed.client_version).toBe('1.0.0');
  });
});

describe('pc:list-mobiles projection — states a browser, never invents one', () => {
  const ROW = {
    pairing_id: 'pair-1',
    mobile_name: 'Chrome on Android',
    paired_at: '2026-09-08T10:00:00.000Z',
    last_seen_at: null,
    online: true,
  };

  it('carries client through the ack', () => {
    const ack = PcListMobilesAckSchema.parse({ mobiles: [{ ...ROW, client: 'web', client_version: '1.0.0' }] });
    expect(ack.mobiles[0]?.client).toBe('web');
    expect(ack.mobiles[0]?.client_version).toBe('1.0.0');
  });

  it('a legacy row travels as NULL — the projection does not fabricate "app"', () => {
    const parsed = PcPairedMobileSchema.parse({ ...ROW, client: null, client_version: null });
    expect(parsed.client).toBeNull();
    // …and the READER is the one that turns that into the default.
    expect(clientOriginOf(parsed.client)).toBe('app');
  });

  it('still refuses a kind nobody declares', () => {
    expect(PcPairedMobileSchema.safeParse({ ...ROW, client: 'android' }).success).toBe(false);
  });

  it('is still zero-secret with the new fields on it', () => {
    const out = PcPairedMobileSchema.parse({
      ...ROW,
      client: 'web',
      mobile_token: 'S3CRET-token-value-32-chars-long-xxxx',
    });
    expect(out).not.toHaveProperty('mobile_token');
    expect(JSON.stringify(out)).not.toContain('S3CRET');
  });
});

describe('target_caps — three states, and the third is the common one', () => {
  it('an ack with no field means UNDECLARED, not "no"', () => {
    const parsed = TargetCapsAckFieldsSchema.parse({ pairing_id: 'p1' });
    expect(parsed.target_caps).toBeUndefined();
    // The distinction this test exists for: undefined and {image:false} must not
    // be the same value, because they lead to opposite user-visible behaviour.
    expect(parsed.target_caps).not.toEqual({ image: false });
  });

  it('carries a declared yes and a declared no', () => {
    expect(TargetCapsAckFieldsSchema.parse({ target_caps: { image: true } }).target_caps).toEqual({ image: true });
    const no = TargetCapsAckFieldsSchema.parse({ target_caps: { image: false, image_note: 'text only' } });
    expect(no.target_caps).toEqual({ image: false, image_note: 'text only' });
  });

  it('requires the boolean — a target that declares nothing must omit the whole object', () => {
    expect(TargetCapsSchema.safeParse({}).success).toBe(false);
    expect(TargetCapsSchema.safeParse({ image: 'true' }).success).toBe(false);
    expect(TargetCapsSchema.safeParse({ image_note: 'text only' }).success).toBe(false);
  });

  it('caps and non-empties the note (it is rendered next to our own sentence)', () => {
    expect(TargetCapsSchema.safeParse({ image: false, image_note: '' }).success).toBe(false);
    expect(TargetCapsSchema.safeParse({ image: false, image_note: 'x'.repeat(201) }).success).toBe(false);
    expect(TargetCapsSchema.safeParse({ image: false, image_note: 'x'.repeat(200) }).success).toBe(true);
  });
});
