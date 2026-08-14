// Minimal structured logger. Standalone/saas both log to stderr so stdout can
// stay reserved for machine-readable output (e.g. the resolved port on boot).
// No dependency, no config surface — this is a private internal line (0.1.0).
//
// owner 2026-07-27 P0 — LOGGING USED TO KILL THE SERVER. When the desktop is
// force-killed its sidecar survives, and a later desktop ADOPTS that orphan
// ("connected to the existing local service"). The orphan's stderr pipe has no reader left, so the
// first burst of logging — which is exactly what SPEAKING produces — hit EPIPE,
// and an unhandled stdio error takes the whole Node process down. Reproduced on
// the real tablet: connect fine, hold PTT ~12 s, server pid gone, port free,
// both ends "lost connection".
//
// Two consequences, both fixed here:
//   ① a write that cannot land must never be fatal — the log line is worth less
//      than the session it would kill;
//   ② the lines still have to go SOMEWHERE. FLOWMIC_LOG_PATH (set by the desktop
//      when it spawns the sidecar) gives them a file that outlives any pipe, and
//      that file is the answer to "server-side logs are invisible" — the single biggest
//      diagnostic blind spot of this line so far.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

type Fields = Record<string, unknown>;

/** Durable sink. Absent → file logging is simply off (tests, CI, bare CLI). */
const FILE_PATH = process.env.FLOWMIC_LOG_PATH ?? '';
/** Cheap guard so a broken sink complains once, not once per line. */
let fileBroken = false;
let stderrBroken = false;
/** One rollover at 4 MB, one kept generation. A diagnostic file that grows
 *  without bound is its own incident. */
const MAX_BYTES = 4 * 1024 * 1024;
let fileBytes = 0;

/** EPIPE on stdio is asynchronous on some platforms — without a listener Node
 *  turns it into an uncaught exception. This is the half that actually killed
 *  the adopted orphan. */
process.stderr.on('error', () => { stderrBroken = true; });
// stdout carries the boot handshake line and whatever console.log the tree does.
// Its pipe dangles for exactly the same reason, and an unhandled error there is
// just as fatal — the listener is the whole fix.
process.stdout.on('error', () => {});

function toFile(text: string): void {
  if (FILE_PATH === '' || fileBroken) return;
  try {
    if (fileBytes > MAX_BYTES) {
      const prev = `${FILE_PATH}.1`;
      rmSync(prev, { force: true }); // Windows rename refuses an existing target
      renameSync(FILE_PATH, prev);
      fileBytes = 0;
    }
    appendFileSync(FILE_PATH, text);
    fileBytes += Buffer.byteLength(text);
  } catch {
    // A log file we cannot write is not a reason to take the server down.
    fileBroken = true;
  }
}

function toStderr(text: string): void {
  if (stderrBroken) return;
  try {
    process.stderr.write(text);
  } catch {
    // Dangling pipe (adopted orphan) / closed fd. Stop trying; the file sink —
    // when configured — still carries the record.
    stderrBroken = true;
  }
}

function line(level: string, msg: string, fields?: Fields): void {
  const base = `[${new Date().toISOString()}] ${level} ${msg}`;
  const text = fields && Object.keys(fields).length > 0
    ? `${base} ${JSON.stringify(fields)}\n`
    : `${base}\n`;
  toStderr(text);
  toFile(text);
}

/** Create the log file's directory once at boot so the first append cannot fail
 *  on a missing parent. Safe to call when no path is configured. */
export function initLogFile(): void {
  if (FILE_PATH === '') return;
  try {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    // Carry the existing size forward so a restart cannot dodge the cap.
    try {
      fileBytes = statSync(FILE_PATH).size;
    } catch {
      fileBytes = 0; // no file yet — the normal first-run case
    }
  } catch {
    fileBroken = true;
  }
}

export const log = {
  info: (msg: string, fields?: Fields): void => line('INFO', msg, fields),
  warn: (msg: string, fields?: Fields): void => line('WARN', msg, fields),
  error: (msg: string, fields?: Fields): void => line('ERROR', msg, fields),
};
