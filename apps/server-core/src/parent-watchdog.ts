// NR-136: stdin is a lifetime pipe only for desktop-spawned standalone servers.
// Bare CLI / SaaS stdin can legitimately be /dev/null and must not trigger this.
import type { Readable } from 'node:stream';

export function installParentWatchdog(
  enabled: boolean,
  input: Readable,
  parentGone: () => void,
): void {
  if (!enabled) return;
  let fired = false;
  const gone = (): void => {
    if (fired) return;
    fired = true;
    parentGone();
  };
  input.once('end', gone);
  input.once('error', gone);
  input.once('close', gone);
  input.resume();
  if (input.readableEnded || input.destroyed) gone();
}
