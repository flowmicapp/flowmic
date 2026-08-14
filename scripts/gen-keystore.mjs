#!/usr/bin/env node
/**
 * FlowMic — generate a new internal self-signed Android release keystore.
 * Node 22 ESM, stdlib only. Never commit the output (.local/ is gitignored).
 *
 * Usage (from repo root):
 *   node scripts/gen-keystore.mjs
 *   node scripts/gen-keystore.mjs --force
 */

import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, '.local', 'keystore');
const JKS_REL = '.local/keystore/flowmic-release.jks';
const JKS_PATH = join(REPO_ROOT, JKS_REL);
const PROPS_PATH = join(OUT_DIR, 'key.properties');
const ALIAS = 'flowmic';
const DNAME = process.env.FLOWMIC_KEYSTORE_DNAME ?? 'CN=FlowMic, OU=FlowMic, O=FlowMic';
const FORCE = process.argv.includes('--force');
const IS_WIN = platform() === 'win32';

function fail(zh, en) {
  console.error(`Error: ${zh}`);
  console.error(`Error: ${en}`);
  process.exit(1);
}

function tryWhich(cmd) {
  try {
    const bin = IS_WIN ? 'where.exe' : 'which';
    const out = execFileSync(bin, [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function candidateKeytools() {
  const list = [];

  // 1) PATH
  const onPath = tryWhich('keytool');
  if (onPath) list.push(onPath);
  if (IS_WIN) {
    const onPathExe = tryWhich('keytool.exe');
    if (onPathExe) list.push(onPathExe);
  }

  // 2) JAVA_HOME
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    list.push(
      join(javaHome, 'bin', IS_WIN ? 'keytool.exe' : 'keytool'),
    );
  }

  // 3) Flutter SDK adjacent / bundled JBR
  const flutterBin = tryWhich('flutter') || tryWhich('flutter.bat');
  if (flutterBin) {
    // .../flutter/bin/flutter → SDK root = .../flutter
    const flutterSdk = resolve(dirname(flutterBin), '..');
    list.push(join(flutterSdk, 'jbr', 'bin', IS_WIN ? 'keytool.exe' : 'keytool'));
    // Literal request: ..\jbr relative to SDK (sibling of flutter tree)
    list.push(join(flutterSdk, '..', 'jbr', 'bin', IS_WIN ? 'keytool.exe' : 'keytool'));
  }

  // 4) Common Android Studio JBR locations (Windows + macOS/Linux)
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  if (IS_WIN) {
    list.push(
      join(programFiles, 'Android', 'Android Studio', 'jbr', 'bin', 'keytool.exe'),
      join(programFiles, 'Android', 'Android Studio', 'jre', 'bin', 'keytool.exe'),
      join(programFilesX86, 'Android', 'Android Studio', 'jbr', 'bin', 'keytool.exe'),
      join(localAppData, 'Programs', 'Android Studio', 'jbr', 'bin', 'keytool.exe'),
      join(localAppData, 'Android', 'Sdk', 'jbr', 'bin', 'keytool.exe'),
    );
  } else {
    list.push(
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool',
      '/Applications/Android Studio.app/Contents/jre/Contents/Home/bin/keytool',
      join(home, 'Applications', 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home', 'bin', 'keytool'),
    );
  }

  // Deduplicate while preserving order
  const seen = new Set();
  return list.filter((p) => {
    const norm = resolve(p);
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
}

function resolveKeytool() {
  for (const cand of candidateKeytools()) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function genPassword() {
  return randomBytes(24).toString('base64url');
}

function main() {
  const keytool = resolveKeytool();
  if (!keytool) {
    fail(
      'keytool not found. Install a JDK, set JAVA_HOME, or install Android Studio / Flutter with a bundled JBR so keytool is available.',
      'keytool not found. Install a JDK, set JAVA_HOME, or install Android Studio / Flutter with a bundled JBR so keytool is available.',
    );
  }

  if (existsSync(JKS_PATH)) {
    if (!FORCE) {
      fail(
        `keystore already exists, refuse to overwrite: ${JKS_REL} (pass --force to regenerate)`,
        `keystore already exists, refuse to overwrite: ${JKS_REL} (pass --force to regenerate)`,
      );
    }
    // keytool would otherwise append into the existing store and die on
    // "alias already exists" — force means a clean regeneration.
    rmSync(JKS_PATH);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // PKCS12 does not support distinct store/key passwords — keytool silently
  // forces keypass = storepass, so a separately generated keyPassword would
  // desync key.properties from the actual keystore. One password, used twice.
  const storePassword = genPassword();
  const keyPassword = storePassword;

  const args = [
    '-genkeypair',
    '-v',
    '-storetype', 'PKCS12',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-alias', ALIAS,
    '-dname', DNAME,
    '-keystore', JKS_PATH,
    '-storepass:env', 'FLOWMIC_GEN_STOREPASS',
  ];

  console.log(`keytool: ${keytool}`);
  console.log(`Generating keystore → ${JKS_REL}`);

  // Password travels via env var, not argv — keeps it out of process lists.
  const result = spawnSync(keytool, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FLOWMIC_GEN_STOREPASS: storePassword },
  });

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    fail(
      `keytool generation failed (exit ${result.status})${detail ? `:\n${detail}` : ''}`,
      `keytool generation failed (exit ${result.status})${detail ? `:\n${detail}` : ''}`,
    );
  }
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  if (result.stderr?.trim()) console.log(result.stderr.trim());

  const props = [
    `# Generated by scripts/gen-keystore.mjs — DO NOT COMMIT`,
    `storePassword=${storePassword}`,
    `keyPassword=${keyPassword}`,
    `keyAlias=${ALIAS}`,
    `storeFile=${JKS_REL.replace(/\\/g, '/')}`,
    '',
  ].join('\n');

  writeFileSync(PROPS_PATH, props, { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('========== Summary ==========');
  console.log(`keystore : ${JKS_REL}`);
  console.log(`properties: .local/keystore/key.properties`);
  console.log(`alias     : ${ALIAS}`);
  console.log(`dname     : ${DNAME}`);
  console.log(`keytool   : ${keytool}`);
  console.log('====================================');
  console.log('');
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log('!!  The keystore and key.properties are gitignored — NEVER commit them.');
  console.log('!!  Passwords exist only on this machine; loss is irreversible.');
  console.log('!!  Back up .local/keystore/ securely yourself.');
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
}

main();
