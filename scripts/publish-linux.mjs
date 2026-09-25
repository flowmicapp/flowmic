// Linux staging for publish.mjs, after its shared release/NOTICE gates and
// before its shared upload/manifest gates. The isolated producer validates
// build stamps, both installer contents, the Node pin, and portable permissions.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stageLinuxArtifacts } from './package-linux-local.mjs';

export function publishLinuxArtifacts({ root, outDir, version, log = console.log }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Linux publication requires linux-x64');
  }
  const staging = join(root, '.local', 'linux-publish', version);
  const result = stageLinuxArtifacts({ repoRoot: root, version,
    targetDir: resolve(process.env.CARGO_TARGET_DIR ?? join(root, 'apps/desktop/src-tauri/target')),
    outDir: staging, log });
  mkdirSync(outDir, { recursive: true });
  // Copy only the three validated artifacts and their hashes; never clean the
  // multi-platform publish directory or replace another platform's artifacts.
  for (const name of [result.appImage.name, result.deb.name, result.portable.zipName]) {
    for (const suffix of ['', '.sha256']) {
      copyFileSync(join(staging, name + suffix), join(outDir, name + suffix));
    }
    log(`Linux artifact staged: ${name}`);
  }
  return result;
}
