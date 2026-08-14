// SPEC-REF:
//   CLAUDE.md red line: no silent failure
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (fail loud, explicit surface)
//
// owner 2026-07-27, the PC timeline page went entirely blank.
//
// A single unhandled throw inside a Vue render blanks that component's whole
// subtree. That is bad; what made it a RED-LINE defect is that it did so in
// TOTAL SILENCE — main.ts installed neither `app.config.errorHandler` nor a
// `window.onerror`, so the owner got a white rectangle with no heading, no chips,
// no message, and nothing in the forensic log to explain it. The bug that caused
// it is fixed at its source (lib/timeline-store normalizeCachedRow +
// lib/inject-provenance), but "fix this one thrower" is not a fix for the CLASS.
//
// This module is the class-level answer: every uncaught frontend error is written
// to the forensic log AND made visible, so a blank surface can never again pass
// for an empty one. It deliberately uses raw DOM rather than a Vue component —
// the thing it reports on is Vue itself having failed, so it must not depend on
// Vue still rendering.

import type { App } from 'vue';
import { appendForensic } from './bridge';
import { S } from './strings';

const BANNER_ID = 'fm-crash-banner';

/** One-line, log-safe rendering of an unknown throw. Never throws itself — it is
 *  the last thing standing when everything else already broke. */
export function describeError(err: unknown, context?: string): string {
  let detail: string;
  try {
    if (err instanceof Error) {
      detail = `${err.name}: ${err.message}`;
      const stack = err.stack?.split('\n')[1]?.trim();
      if (stack !== undefined && stack !== '') detail += ` @ ${stack}`;
    } else if (typeof err === 'string') {
      detail = err;
    } else {
      detail = JSON.stringify(err) ?? String(err);
    }
  } catch {
    detail = '<unrenderable error>';
  }
  if (detail.length > 400) detail = `${detail.slice(0, 400)}…`;
  return context !== undefined && context !== '' ? `${context} — ${detail}` : detail;
}

/** Show the crash banner. Idempotent: repeated errors update the existing node
 *  rather than stacking banners down the window. */
function showBanner(doc: Document, detail: string): void {
  let el = doc.getElementById(BANNER_ID);
  if (el === null) {
    el = doc.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
      'background:#fdeaea', 'color:#8a1f1f', 'border-bottom:1px solid #f3c2c2',
      'padding:9px 14px', 'font-size:12.5px', 'line-height:1.5',
      'font-family:inherit', 'white-space:pre-wrap', 'word-break:break-word',
    ].join(';');
    doc.body.appendChild(el);
  }
  el.textContent = `${S.crash_banner}\n${detail}`;
}

/** Arm the boundary: Vue render/watcher errors, plain JS errors, and rejected
 *  promises all land in the forensic log and on screen. `doc` is injectable so
 *  the behaviour is testable without a real window. */
export function installErrorBoundary(app: App, doc: Document = document): void {
  const report = (err: unknown, context: string): void => {
    const detail = describeError(err, context);
    // Forensic first — it must be recorded even if painting the banner fails.
    try {
      appendForensic('ui', `UNCAUGHT ${detail}`);
    } catch {
      /* the log is best-effort; never let it mask the original error */
    }
    try {
      showBanner(doc, detail);
    } catch {
      /* ditto */
    }
    // Keep the console record for a devtools session.
    console.error('[flowmic] uncaught', err);
  };

  app.config.errorHandler = (err, _instance, info): void => {
    report(err, `vue:${info}`);
  };
  window.addEventListener('error', (ev: ErrorEvent) => {
    report(ev.error ?? ev.message, 'window.onerror');
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    report(ev.reason, 'unhandledrejection');
  });
}
