// card HANGUP-3 — `client_caps` survives the relay's boundary parse on every
// admission frame that can carry it (docs/rebuild/04 §3.3-a (c′)). A schema that
// stripped it would leave the server believing every phone undeclared: the new
// code would simply never be sent, and nothing would say why.
import { describe, expect, it } from 'vitest';
import { safeParseEvent } from '../src/protocol-schemas';
import { CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED as CAP } from '../src/protocol-schemas-auth';

const TOKEN = 'tok-0123456789abcdefghijklmnopqrstuv';
const UID = '0123456789abcdef0123456789abcdef';

describe('client_caps on the admission frames', () => {
  it.each([
    ['short_code arm', { short_code: '4242' }],
    ['qr arm', { qr_payload: 'flowmic://pair?code=1234' }],
    ['cloud instance arm', { cloud_instance: true }],
  ] as const)('mobile:pair %s keeps it', (_name, base) => {
    const r = safeParseEvent('mobile:pair', { ...base, client_caps: [CAP] });
    expect(r.success).toBe(true);
    expect((r as { data: { client_caps?: string[] } }).data.client_caps).toEqual([CAP]);
  });

  it('mobile:reconnect keeps it', () => {
    const r = safeParseEvent('mobile:reconnect', { token: TOKEN, device_uid: UID, client_caps: [CAP] });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect((r as { data: { client_caps?: string[] } }).data.client_caps).toEqual([CAP]);
  });

  it('absent stays absent (an old phone), and a malformed list is refused', () => {
    const old = safeParseEvent('mobile:reconnect', { token: TOKEN, device_uid: UID });
    expect(old.success).toBe(true);
    expect((old as { data: object }).data).not.toHaveProperty('client_caps');
    expect(safeParseEvent('mobile:reconnect', { token: TOKEN, device_uid: UID, client_caps: [''] }).success).toBe(false);
    expect(safeParseEvent('mobile:reconnect', { token: TOKEN, device_uid: UID, client_caps: 'x' }).success).toBe(false);
  });
});
