// FR-D2 (D-MKT-7, 2026-11-06): the Devices page said "Paired 2026-11-05 08:20" for
// a pairing made at 16:20 local time (UTC+8). The database stamps paired_at itself
// as `YYYY-MM-DD HH:MM:SS` in UTC with no zone suffix (apps/server-core/src/db/
// utc-stamp.ts states the rule), and `new Date` reads that form as LOCAL time.
//
// Rendered through the real card, in a fixed zone, so a developer or CI machine
// that happens to run at UTC cannot pass this by coincidence: the first test is
// the control that the zone really took.

import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PairedList from './PairedList.vue';
import { formatRelativeTime } from '../../lib/relative-time';
import { setLocale } from '../../lib/strings';
import type { PresenceMobile } from '../../lib/paired-mobiles';

const realTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Shanghai';
  setLocale('en');
});
afterAll(() => {
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
  setLocale('zh-CN');
});

const PHONE: PresenceMobile = {
  pairing_id: 'p1',
  mobile_name: 'Test phone',
  device_uid: 'u1',
  paired_at: '2026-11-05 08:20:00',
  last_seen_at: null,
  online: false,
  presence: 'offline',
  asOf: null,
  channel: 'lan',
} as PresenceMobile;

const render = (over: Partial<PresenceMobile>): Promise<string> => renderToString(
  createSSRApp(PairedList, { view: { rows: [{ ...PHONE, ...over }], unlisted: [] } }),
);

describe('a paired time from the database', () => {
  it('control: this file really runs at UTC+8', () => {
    expect(new Date(2026, 10, 5).getTimezoneOffset()).toBe(-480);
  });

  it('is shown in local time on the Devices page', async () => {
    const html = await render({});
    expect(html).toContain('2026-11-05 16:20');
    expect(html).not.toContain('2026-11-05 08:20');
  });

  it('a stamp that carries its zone is not shifted twice', async () => {
    const html = await render({ paired_at: '2026-11-05T08:20:00.000Z' });
    expect(html).toContain('2026-11-05 16:20');
  });

  it('"last active" reads the same column shape the same way', () => {
    const now = new Date(Date.UTC(2026, 10, 5, 8, 25));
    expect(formatRelativeTime('2026-11-05 08:20:00', now)).toBe('5 min ago');
  });
});
