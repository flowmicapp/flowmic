// scripts/loadtest/lib/process-sampler.mjs
//
// Polls the server-under-test's OWN process CPU% and RSS while a run is in
// flight.
//
// TWO BACKENDS, because this tool is run on two different operating systems and
// the S0a task needs the SAME columns from both: the dev workstation is Windows
// (CLAUDE.md environment section) and the machine whose ceiling the owner
// actually asked about is a Linux VPS (README "Running S0a on the VPS").
//
// 🔴 The Linux branch is not a nicety — WITHOUT it this sampler does not fail
// loudly on Linux, it fails QUIETLY: `execFile('powershell.exe', …)` errors with
// ENOENT, `psQuery` maps every error to `null`, and `createProcessSampler`
// documents null samples as "skipped, not zero-filled". The run would therefore
// complete, report `cpu% max = n/a` / `rss MB max = n/a`, and look like a
// successful measurement that simply had nothing to say — the exact shape this
// repo calls a façade (a column that answers "we didn't look" in the same voice
// it would answer "we looked and it was fine"). A VPS run is the one place those
// two columns matter most, so the platform branch is load-bearing.
//
// ⚠️ MEASUREMENT OVERHEAD IS REAL AND NAMED, not hidden — and it is NOT the same
// on both platforms:
//   • Windows: each sample spawns a powershell.exe process, which itself costs
//     on the order of 100-300ms of wall time and some CPU. That is why the
//     default interval is a relatively coarse 2s rather than something
//     sub-second — a sampler that perturbs the very CPU number it is trying to
//     read would be the "measure your own ruler" mistake this repo has a named
//     memory entry for.
//   • Linux: two small `readFile`s from procfs, no subprocess at all. The
//     overhead argument above simply does not apply there; the interval stays
//     the same only so the two platforms' numbers are sampled comparably, not
//     because Linux needs the slack.
// The report this tool writes says what interval and which backend it used, so
// a reader can judge for themselves; it does not pretend to be a profiler.
//
// CPU% is computed from the process's cumulative CPU-seconds delta divided by
// wall-clock delta between two samples, times 100 — this is "percent of one
// core", so on a multi-core box a fully busy multi-threaded process can read
// well above 100. Both backends feed that same formula; only the way they read
// "cumulative CPU-seconds" and "RSS bytes" differs.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function psQuery(pid) {
  // -ErrorAction SilentlyContinue: the process may have exited between the
  // last successful sample and this one (e.g. the harness is shutting the
  // server down) — that is an expected end-of-run condition, not a fault, so
  // the caller reads "null" rather than seeing a PowerShell stack trace.
  const script = `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; `
    + `[pscustomobject]@{ cpu_seconds = $p.CPU; rss_bytes = $p.WorkingSet64 } | ConvertTo-Json -Compress } `
    + `catch { '' }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const text = stdout.trim();
        if (!text) return resolve(null);
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed.cpu_seconds !== 'number' || typeof parsed.rss_bytes !== 'number') return resolve(null);
          resolve(parsed);
        } catch { resolve(null); }
      });
  });
}

// ── Linux backend ───────────────────────────────────────────────────────────
//
// USER_HZ (the unit /proc/<pid>/stat reports utime/stime in) is 100 on every
// mainstream Linux build, but it is a compile-time kernel constant, not a
// guarantee — and a wrong divisor here would not look wrong, it would look like
// a plausible CPU number that is off by a constant factor. So it is ASKED FOR
// once per process (`getconf CLK_TCK`) instead of assumed, and the fallback is
// named rather than silent: `clkTckSource` rides into the report so a reader can
// see which of the two produced the numbers they are reading.
let clkTckPromise = null;
let clkTckSource = 'unresolved';
function clockTicksPerSecond() {
  clkTckPromise ??= new Promise((resolve) => {
    execFile('getconf', ['CLK_TCK'], { timeout: 5000 }, (err, stdout) => {
      const n = Number(String(stdout).trim());
      if (!err && Number.isFinite(n) && n > 0) { clkTckSource = 'getconf'; resolve(n); return; }
      clkTckSource = 'fallback-100';
      resolve(100);
    });
  });
  return clkTckPromise;
}

async function procQuery(pid) {
  try {
    // comm (field 2) is the executable name IN PARENTHESES and may itself
    // contain spaces and parens, so the only safe split point is the LAST ')'
    // — splitting on whitespace from the left is the classic /proc/stat parsing
    // bug and would silently shift every field after it.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    // fields[0] is `state` (field 3), so utime (field 14) is fields[11] and
    // stime (field 15) is fields[12].
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    const hz = await clockTicksPerSecond();

    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!m) return null;

    return { cpu_seconds: (utime + stime) / hz, rss_bytes: Number(m[1]) * 1024 };
  } catch {
    // ENOENT here is the same expected end-of-run condition the Windows branch
    // documents: the process can exit between two samples while the harness is
    // shutting the server down. Same contract — the caller reads null and skips.
    return null;
  }
}

/** Which backend this process will use. Exported so the report can STATE it
 *  rather than leaving the reader to infer it from the platform — and so the
 *  third case is visible instead of masquerading as the second. macOS has
 *  neither PowerShell nor procfs, so on darwin this sampler genuinely cannot
 *  measure anything; saying `unsupported:darwin` in the report is the difference
 *  between "we looked and saw nothing" and "we could not look". */
export const SAMPLER_BACKEND = process.platform === 'win32'
  ? 'powershell/Get-Process'
  : (process.platform === 'linux' ? 'linux/procfs' : `unsupported:${process.platform}`);

function queryProcess(pid) {
  if (process.platform === 'win32') return psQuery(pid);
  if (process.platform === 'linux') return procQuery(pid);
  return Promise.resolve(null);
}

/** Creates a sampler for `pid`. Call `.start()` once, `.stop()` at run end,
 *  `.summary()` for the aggregate this tool writes into the report. Samples
 *  that fail (process gone, powershell hiccup) are skipped, not zero-filled —
 *  a zero-filled CPU sample would silently understate load during exactly the
 *  window most likely to matter (the server struggling). */
export function createProcessSampler(pid, { intervalMs = 2000 } = {}) {
  const samples = []; // { t_ms, cpu_percent, rss_mb }
  let prev = null; // { atMs, cpuSeconds }
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const atMs = Date.now();
    const q = await queryProcess(pid);
    if (q) {
      const rssMb = Math.round((q.rss_bytes / (1024 * 1024)) * 100) / 100;
      let cpuPercent = null;
      if (prev) {
        const dtSeconds = (atMs - prev.atMs) / 1000;
        const dCpu = q.cpu_seconds - prev.cpuSeconds;
        if (dtSeconds > 0) cpuPercent = Math.round((dCpu / dtSeconds) * 10000) / 100;
      }
      prev = { atMs, cpuSeconds: q.cpu_seconds };
      samples.push({ t_ms: atMs, cpu_percent: cpuPercent, rss_mb: rssMb });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  return {
    start() { timer = setTimeout(tick, 0); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    samples,
    summary() {
      const cpuVals = samples.map((s) => s.cpu_percent).filter((v) => v !== null);
      const rssVals = samples.map((s) => s.rss_mb).filter((v) => v !== null);
      const pct = (arr, p) => {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
      };
      return {
        interval_ms: intervalMs,
        backend: SAMPLER_BACKEND,
        // Only meaningful on the procfs backend; null elsewhere rather than a
        // number that would imply this run divided by something it never used.
        clk_tck_source: SAMPLER_BACKEND === 'linux/procfs' ? clkTckSource : null,
        sample_count: samples.length,
        skipped_count: samples.filter((s) => s.cpu_percent === null).length,
        cpu_percent: {
          max: cpuVals.length ? Math.max(...cpuVals) : null,
          p95: pct(cpuVals, 95),
          mean: cpuVals.length ? Math.round((cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length) * 100) / 100 : null,
        },
        rss_mb: {
          max: rssVals.length ? Math.max(...rssVals) : null,
          mean: rssVals.length ? Math.round((rssVals.reduce((a, b) => a + b, 0) / rssVals.length) * 100) / 100 : null,
        },
      };
    },
  };
}
