#!/usr/bin/env node
// scripts/ship-env.mjs — everything scripts/ship.mjs needs to know about the
// machine it is spawning children on. Split out of ship.mjs VERBATIM on
// 2026-09-18 when that file crossed the 800-line cap; nothing here changed in
// the move, and ship.mjs re-exports the three public ones so no caller had to.
//
// They belong together because they answer one question in four parts: what
// does a child actually need in order to run at all on this box. Each of the
// four was written the day something here lied — the missing ProgramFiles(x86),
// the extensionless pnpm shim, the PATH that empties itself mid-session, and
// Node refusing to spawn a .cmd. Their drills are scripts/ship-orchestrator.
// test.mjs sections 8 and 9.

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

// ── environment ──────────────────────────────────────────────────────────────
//
// `ProgramFiles(x86)`: the flutter toolchain dies instantly without it, and a
// POSIX shell cannot even spell the name (a variable name may not contain
// parentheses), so a chain launched from Git Bash can hand its children an
// environment that never carried it. Measured twice: the 2026-09-16 round lost
// a whole NY deploy to it. Read it from the registry, fall back to the
// documented default, and set it for every child — never assume the parent has
// it just because THIS process can see one.
export function resolveProgramFilesX86(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return null;
  const existing = env['ProgramFiles(x86)'];
  if (existing) return existing;
  const q = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', '/v', 'ProgramFilesDir (x86)'],
    { encoding: 'utf8', windowsHide: true });
  const m = q.status === 0 ? /ProgramFilesDir \(x86\)\s+REG_SZ\s+(.+)/.exec(q.stdout || '') : null;
  if (m) return m[1].trim();
  return `${env.SystemDrive || 'C:'}\\Program Files (x86)`;
}

/** Absolute paths for every tool the plan will spawn, resolved ONCE (CLAUDE.md:
 *  the user PATH on this machine has been observed to drop cargo/Python mid
 *  session). Children are handed the absolute path AND the directory on PATH. */
export function resolveTools(names, { platform = process.platform, run = null } = {}) {
  const runner = run ?? ((exe, args) => spawnSync(exe, args, { encoding: 'utf8', windowsHide: true }));
  const out = {};
  for (const name of names) {
    const r = platform === 'win32' ? runner('where', [name]) : runner('which', [name]);
    const hits = r && r.status === 0 ? String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
    // 🔴 On Windows the FIRST hit is not always spawnable. `where pnpm` on this
    // machine answers `C:\nvm4w\nodejs\pnpm` (the extensionless POSIX shim)
    // before `pnpm.CMD`; CreateProcess cannot run a file with no executable
    // extension, so spawning it dies with ENOENT — which reads as "pnpm is not
    // installed" on a machine where `pnpm --version` works in every shell.
    // [measured 2026-09-18, dev-pc-a: spawnSync of that exact path
    // returns error ENOENT while pnpm.CMD beside it runs.] So prefer a hit
    // Windows can actually execute; fall back to the first only when none of
    // them carries one, so the failure is still "we found nothing usable"
    // rather than a silent skip.
    const spawnable = platform === 'win32'
      ? hits.find((h) => /\.(com|exe|cmd|bat|ps1)$/i.test(h))
      : hits[0];
    out[name] = spawnable || hits[0] || null;
  }
  return out;
}

export function childEnv({ tools, extra = {}, platform = process.platform }) {
  const env = { ...process.env, ...extra };
  const pfx86 = resolveProgramFilesX86(env, platform);
  if (pfx86) env['ProgramFiles(x86)'] = pfx86;
  const dirs = Object.values(tools).filter(Boolean).map((p) => dirname(p));
  const sep = platform === 'win32' ? ';' : ':';
  const seen = new Set((env.PATH || env.Path || '').split(sep));
  const add = dirs.filter((d) => !seen.has(d));
  if (add.length > 0) env.PATH = [...add, env.PATH || env.Path || ''].join(sep);
  return env;
}

/** Spawn one child without a shell, in a way that survives being launched from
 *  PowerShell, cmd or Git Bash alike: a `.cmd`/`.bat` shim (which is what pnpm
 *  and make are on Windows) is handed to ComSpec explicitly instead of being
 *  handed to `spawn` — Node refuses the latter outright since 20.12. Nothing is
 *  ever string-concatenated into a command line, so quoting rules never apply. */
export function spawnPlan(file, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] };
  }
  if (platform === 'win32' && /\.ps1$/i.test(file)) {
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args] };
  }
  return { file, args };
}
