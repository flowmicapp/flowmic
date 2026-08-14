// RV-94 (B4-11) — reverse-check partner for settings-sync-notice.ts. See that
// file's header for why `settingsPending` alone cannot answer "why".
import { describe, expect, it } from 'vitest';
import { settingsSyncNotice } from './settings-sync-notice';

describe('settingsSyncNotice', () => {
  it('nothing pending → saved, regardless of sidecar phase', () => {
    expect(settingsSyncNotice(false, null)).toBe('saved');
    expect(settingsSyncNotice(false, 'failed')).toBe('saved');
    expect(settingsSyncNotice(false, 'healthy')).toBe('saved');
  });

  it('pending while the LAN sidecar is up (healthy / adopted_external) → transient', () => {
    expect(settingsSyncNotice(true, 'healthy')).toBe('pending_transient');
    expect(settingsSyncNotice(true, 'adopted_external')).toBe('pending_transient');
  });

  it('pending while the LAN sidecar never reached Healthy → the actionable no-service notice', () => {
    // Failed outright.
    expect(settingsSyncNotice(true, 'failed')).toBe('pending_no_service');
    // Still bringing up (every phase before Healthy).
    expect(settingsSyncNotice(true, 'resolving')).toBe('pending_no_service');
    expect(settingsSyncNotice(true, 'spawning')).toBe('pending_no_service');
    expect(settingsSyncNotice(true, 'awaiting_handshake')).toBe('pending_no_service');
    expect(settingsSyncNotice(true, 'awaiting_health')).toBe('pending_no_service');
    expect(settingsSyncNotice(true, 'probing')).toBe('pending_no_service');
    expect(settingsSyncNotice(true, 'clearing')).toBe('pending_no_service');
    // Dead sidecar_ctl.rs state (never set true today, see CLAUDE.md-adjacent
    // observation in the handoff report) — still must not be misread as "up".
    expect(settingsSyncNotice(true, 'suspended')).toBe('pending_no_service');
    // No snapshot has arrived yet (right after launch).
    expect(settingsSyncNotice(true, null)).toBe('pending_no_service');
  });
});
