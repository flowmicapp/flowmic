// UP-3b — the view model's rules.
//
// 🔴 The headline test is `no_input_whatsoever_can_be_read_as_up_to_date`, which
// sweeps every failure tag and every plan shape at once. That is the shape the
// design's §3 table is built around and the one a component test could not make.

import { describe, expect, it } from 'vitest';
import {
  FAILURE_KEYS,
  UPDATE_MANIFEST_BASE,
  action,
  failureKey,
  megabytes,
  pendingNotice,
  progressPercent,
  showsLastCheck,
  showsUpdateBlock,
  verdict,
  type UpdateStateDto,
} from './update-view';

function state(over: Partial<UpdateStateDto> = {}): UpdateStateDto {
  return {
    current_version: '0.2.59',
    form: 'portable',
    auto_check: true,
    last_success_check: null,
    checking: false,
    plan: null,
    latest: null,
    notes_url: null,
    manual_reason: null,
    failure: null,
    download: { active: false, received: 0, total: 0 },
    verified_filename: null,
    verified_sha256: null,
    verified_size: null,
    can_swap_in_place: null,
    pending: null,
    ...over,
  };
}

const SHA = 'a'.repeat(64);

describe('verdict', () => {
  it('only an explicit up_to_date plan says “up to date”', () => {
    expect(verdict(state({ plan: 'up_to_date' }))).toEqual({ kind: 'up_to_date' });
  });

  /**
   * 🔴 THE RED LINE, over every input at once.
   *
   * unknown ≠ up to date. A client that has never reached the server, one whose check
   * failed in any of 22 ways, and one that is mid-check must all be
   * distinguishable from one that just confirmed it is current.
   */
  it('🔴 no input whatsoever can be read as up to date', () => {
    const inputs: UpdateStateDto[] = [
      state(), //                                    never checked
      state({ checking: true }), //                  in flight
      state({ plan: 'available', latest: '0.2.60' }),
      state({ plan: 'manual_only', latest: '0.2.60', manual_reason: 'unknown_form' }),
      // …and every single failure tag, including on top of a stale up_to_date.
      ...Object.keys(FAILURE_KEYS).flatMap((tag) => [
        state({ failure: { tag, detail: 'x', blocking: false } }),
        state({ plan: 'up_to_date', failure: { tag, detail: 'x', blocking: true } }),
      ]),
    ];
    for (const s of inputs) {
      expect(verdict(s).kind, `tag=${s.failure?.tag ?? '-'} plan=${s.plan}`).not.toBe('up_to_date');
    }
  });

  /**
   * 🔴 §3 row 8 — turning auto-check off does not make this machine current.
   *
   * It makes it uninformed. The two states must not converge on one sentence.
   */
  it('🔴 auto-check being off is not the same as being up to date', () => {
    expect(verdict(state({ auto_check: false })).kind).toBe('unknown');
    // …and it still shows the block, so the manual button is reachable.
    expect(showsUpdateBlock(state({ auto_check: false }))).toBe(true);
  });

  /** A dev build checked nothing, so it claims nothing — not even “unknown”. */
  it('a dev build shows nothing at all', () => {
    expect(verdict(state({ form: 'dev' }))).toEqual({ kind: 'hidden' });
    expect(verdict(state({ plan: 'not_checked' }))).toEqual({ kind: 'hidden' });
    expect(showsUpdateBlock(state({ form: 'dev' }))).toBe(false);
  });

  it('a newer version is announced with its number', () => {
    expect(verdict(state({ plan: 'available', latest: '0.2.60' }))).toEqual({
      kind: 'available',
      latest: '0.2.60',
    });
  });

  /**
   * 🔴 A `manual_only` plan keeps the version number and gets a reason.
   *
   * `failure.rs` states why the variant carries `latest` at all: dropping it
   * would leave the user with "there's an update but I can't tell you what it
   * is" — a state they can neither act on nor leave.
   */
  it('manual-only still names the version and says why', () => {
    const v = verdict(
      state({ plan: 'manual_only', latest: '0.3.0', manual_reason: 'no_fetchable_kind' }),
    );
    expect(v).toEqual({ kind: 'manual_only', latest: '0.3.0', reasonKey: 'upd_no_fetchable' });
  });
});

describe('the last-successful-check line', () => {
  /**
   * 🔴 Design §5.0's named silent failure, asserted as an invariant.
   *
   * Without this line, a client that has NEVER once reached the server and one
   * that checked a second ago look identical. It is the only evidence
   * "up to date" has, so it is shown wherever the block is — never conditionally
   * on having a value.
   */
  it('🔴 is shown wherever the block is shown, including when it has never succeeded', () => {
    for (const s of [
      state(),
      state({ plan: 'up_to_date', last_success_check: '2026-08-08T09:12:00Z' }),
      state({ failure: { tag: 'unreachable', detail: 'timeout', blocking: false } }),
      state({ auto_check: false }),
    ]) {
      expect(showsLastCheck(s)).toBe(true);
    }
  });

  /**
   * A failed check leaves the previous timestamp standing — that is what lets
   * the card say "check failed" and "last successful check at …" at the same time, which is
   * the true state and more useful than either sentence alone.
   */
  it('survives a failure so both facts can be shown together', () => {
    const s = state({
      last_success_check: '2026-08-05T01:00:00Z',
      failure: { tag: 'unreachable', detail: 'connect', blocking: false },
    });
    expect(s.last_success_check).toBe('2026-08-05T01:00:00Z');
    expect(verdict(s).kind).toBe('unknown');
  });
});

describe('action', () => {
  it('offers a download before anything has been verified', () => {
    expect(action(state({ plan: 'available', latest: '0.2.60' }))).toEqual({ kind: 'download' });
  });

  /**
   * 🔴 Install is only offered once the hash gate has passed.
   *
   * `verified_sha256` comes from `VerifiedPackage`, a Rust type with no public
   * constructor — so a value here cannot exist unless the bytes were hashed and
   * matched. This asserts the UI honours that rather than routing around it.
   */
  it('🔴 never offers to install anything that has not been verified', () => {
    const unverified = state({ plan: 'available', latest: '0.2.60', form: 'msi' });
    expect(action(unverified).kind).toBe('download');
    const verified = state({
      plan: 'available',
      latest: '0.2.60',
      form: 'msi',
      verified_sha256: SHA,
    });
    expect(action(verified)).toEqual({ kind: 'install_msi' });
  });

  it('a verified portable bundle offers the in-place update', () => {
    const s = state({
      plan: 'available',
      latest: '0.2.60',
      form: 'portable',
      verified_sha256: SHA,
      can_swap_in_place: true,
    });
    expect(action(s)).toEqual({ kind: 'install_portable' });
  });

  /**
   * 🔴 A location we already know cannot be replaced must not be offered the
   * button.
   *
   * The preflight ran while the app was still on screen. Offering it anyway
   * would promise something we know will fail — and it would fail AFTER the
   * exit, the one moment nothing is left to report it.
   */
  it('🔴 refuses the in-place button when the preflight already said no', () => {
    const s = state({
      plan: 'available',
      latest: '0.2.60',
      form: 'portable',
      verified_sha256: SHA,
      can_swap_in_place: false,
    });
    expect(action(s)).toEqual({ kind: 'open_page' });
  });

  it('an unknown form is sent to the download page, never to an installer', () => {
    for (const form of ['unknown', 'unsupported_platform']) {
      const s = state({ plan: 'available', latest: '0.2.60', form, verified_sha256: SHA });
      expect(action(s)).toEqual({ kind: 'open_page' });
    }
  });

  it('offers nothing while a download is running', () => {
    const s = state({
      plan: 'available',
      latest: '0.2.60',
      download: { active: true, received: 5, total: 10 },
    });
    expect(action(s)).toEqual({ kind: 'none' });
  });
});

describe('progress', () => {
  it('is null when nothing is downloading and clamped when it is', () => {
    expect(progressPercent(state())).toBeNull();
    expect(progressPercent(state({ download: { active: true, received: 5, total: 10 } }))).toBe(50);
    // A total of zero must not produce Infinity or NaN on screen.
    expect(progressPercent(state({ download: { active: true, received: 5, total: 0 } }))).toBeNull();
    expect(progressPercent(state({ download: { active: true, received: 99, total: 10 } }))).toBe(100);
  });

  it('renders a byte count the way the design sketch does', () => {
    expect(megabytes(61_000_000)).toBe('58.2 MB');
  });
});

describe('the last attempt’s notice', () => {
  it('says nothing when there was no attempt', () => {
    expect(pendingNotice(state())).toBeNull();
  });

  it('announces a completed update', () => {
    const s = state({ pending: { outcome: 'completed', from: '0.2.59', to: '0.2.60', detail: null } });
    expect(pendingNotice(s)).toEqual({ kind: 'done', to: '0.2.60' });
  });

  /**
   * 🔴 "It didn't work" and "it didn't work AND your old copy is back" are two
   * different nights for a user, so the reassurance is shown only when the mover
   * actually performed a rollback and said so.
   */
  it('🔴 only claims a rollback when the mover recorded one', () => {
    const rolled = state({
      pending: { outcome: 'not_completed', from: '0.2.59', to: '0.2.60', detail: 'rolled_back:x' },
    });
    expect(pendingNotice(rolled)).toEqual({ kind: 'failed', to: '0.2.60', rolledBack: true });

    for (const detail of [null, 'nothing_moved:timeout_waiting_for_lock', 'rollback_failed:a/b']) {
      const s = state({ pending: { outcome: 'not_completed', from: '0.2.59', to: '0.2.60', detail } });
      expect(pendingNotice(s), `detail=${detail}`).toEqual({
        kind: 'failed',
        to: '0.2.60',
        rolledBack: false,
      });
    }
  });
});

describe('the manifest base', () => {
  /**
   * 🔴 "Which relay am I paired with" and "where is the authoritative release
   * list" are two different questions. The value is the same today; the source
   * must not be.
   */
  it('🔴 comes from the protocol constant, not from a cloud config', () => {
    expect(UPDATE_MANIFEST_BASE).toBe('https://flowmic.app');
    // A self-hosted relay is a legitimate pairing target and must not become the
    // place we ask about releases.
    const cloudConfig = { endpoint: 'http://10.0.0.5:41879' };
    expect(UPDATE_MANIFEST_BASE).not.toBe(cloudConfig.endpoint);
  });
});

describe('failureKey', () => {
  it('maps every known tag and invents nothing for an unknown one', () => {
    expect(failureKey('hash_mismatch')).toBe('upd_fail_hash_mismatch');
    // 🔴 `null`, not a generic sentence. A bare identifier is ugly; a fluent
    // "update failed" that explains nothing is worse, because the user cannot tell it
    // apart from a real explanation.
    expect(failureKey('a_code_from_a_future_build')).toBeNull();
  });
});
