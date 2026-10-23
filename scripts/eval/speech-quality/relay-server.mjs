// scripts/eval/speech-quality/relay-server.mjs — start ONE local server-core
// process for run-relay.mjs (card EVAL-2), with managed STT = Soniox (TEST key)
// and managed LLM = DeepSeek, set ONLY in that child's environment.
//
// 🔴 LOCAL ONLY. The child binds 127.0.0.1 on an ephemeral port, runs in
// `standalone` mode on a throwaway FLOWMIC_HOME + database under the run
// directory, and inherits NO FLOWMIC_* / SONIOX* variable from the parent shell
// (a stray FLOWMIC_DB_PATH or a production key exported in the shell must not
// reach it). Nothing here talks to a production relay.
//
// Every stderr line is kept with the harness's own monotonic arrival time, so
// run-relay.mjs can cut out the lines that belong to one utterance. The log
// format is apps/server-core/src/log.ts `line()`: `[ISO] LEVEL msg {json}`.
//
// NOT A GATE. See README.md.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const LINE = /^\[([^\]]+)\] (\w+) (.*?)(?: (\{.*\}))?$/;

export function parseLogLine(text) {
  const m = LINE.exec(text);
  if (!m) return { raw: text };
  let fields = null;
  if (m[4]) { try { fields = JSON.parse(m[4]); } catch { fields = { _unparsed: m[4] }; } }
  return { iso: m[1], level: m[2], msg: m[3], fields };
}

/**
 * @param serverCoreDir apps/server-core of the build under test (its dist/ is run)
 * @param sttCloudDir packages/stt-cloud whose dist/index.cjs is the Soniox adapter
 * @param home          throwaway directory for FLOWMIC_HOME and the database
 * @param keys          { sonioxKey, sonioxEndpoint, deepseekKey, deepseekModel }
 */
export function startRelay({ serverCoreDir, sttCloudDir, home, keys, extraEnv = {} }) {
  mkdirSync(home, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FLOWMIC_|SONIOX)/i.test(k)) env[k] = v;
  Object.assign(env, {
    FLOWMIC_MODE: 'standalone',
    FLOWMIC_HOST: '127.0.0.1',
    FLOWMIC_PORT: '0',
    FLOWMIC_HOME: home,
    FLOWMIC_DB_PATH: join(home, 'flowmic-eval.db'),
    FLOWMIC_SETTINGS_SECRET: 'eval-relay-secret-32-bytes-minimum-xx',
    // The private Soniox adapter: server-core loads it by specifier at runtime
    // (stt/engine-factory.ts `cloudSpecifier`), and a lane worktree has no
    // node_modules link for it, so name the built package directly.
    FLOWMIC_STT_CLOUD_MODULE: join(resolve(sttCloudDir), 'dist', 'index.cjs'),
    FLOWMIC_MANAGED_STT_ENABLED: '1',
    FLOWMIC_MANAGED_STT_ENGINE: 'soniox',
    FLOWMIC_MANAGED_STT_ENDPOINT: keys.sonioxEndpoint,
    FLOWMIC_MANAGED_STT_API_KEY: keys.sonioxKey,
    FLOWMIC_MANAGED_LLM_ENABLED: '1',
    FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
    FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
    FLOWMIC_MANAGED_LLM_MODEL: keys.deepseekModel,
    FLOWMIC_MANAGED_LLM_API_KEY: keys.deepseekKey,
    FLOWMIC_LLM_VENDOR_BODY: '{"thinking":{"type":"disabled"}}',
    ...extraEnv,
  });
  const dist = join(resolve(serverCoreDir), 'dist', 'index.js');
  const child = spawn(process.execPath, [dist], { cwd: resolve(serverCoreDir), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    errBuf += d;
    let nl;
    while ((nl = errBuf.indexOf('\n')) >= 0) {
      const text = errBuf.slice(0, nl).replace(/\r$/, '');
      errBuf = errBuf.slice(nl + 1);
      if (text) lines.push({ t: performance.now(), ...parseLogLine(text) });
    }
  });
  const ready = new Promise((resolveP, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('local relay start timeout (20 s)')), 20_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m) { clearTimeout(timer); resolveP(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`local relay exited early (${code}); last stderr: ${lines.slice(-5).map((l) => l.msg ?? l.raw).join(' | ')}`)); });
  });
  return {
    child,
    pid: child.pid,
    lines,
    ready,
    /** Lines that arrived in [from, to] (harness monotonic ms). */
    between: (from, to) => lines.filter((l) => l.t >= from && l.t <= to),
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
