import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { installParentWatchdog } from '../src/parent-watchdog';

describe('desktop lifetime pipe', () => {
  it('does not fire while the parent keeps the pipe open, even after data', async () => {
    const input = new PassThrough();
    const gone = vi.fn();
    installParentWatchdog(true, input, gone);
    input.write('still alive');
    await new Promise((resolve) => setImmediate(resolve));
    expect(gone).not.toHaveBeenCalled();
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(gone).toHaveBeenCalledTimes(1);
    input.destroy();
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('leaves bare CLI and SaaS stdin alone', async () => {
    const input = new PassThrough();
    const gone = vi.fn();
    installParentWatchdog(false, input, gone);
    input.resume();
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(gone).not.toHaveBeenCalled();
  });

  it('handles a broken or already closed pipe once', () => {
    const input = new PassThrough();
    const gone = vi.fn();
    installParentWatchdog(true, input, gone);
    input.emit('error', new Error('broken pipe'));
    input.destroy();
    expect(gone).toHaveBeenCalledTimes(1);
    const closed = new PassThrough();
    closed.destroy();
    installParentWatchdog(true, closed, gone);
    expect(gone).toHaveBeenCalledTimes(2);
  });
});
