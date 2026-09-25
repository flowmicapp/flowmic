/** Bundle the actual server into ignored local state; never a production launch. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../..");
const { values } = parseArgs({ options: { "state-dir": { type: "string" } } });
const STATE = path.resolve(
  values["state-dir"] ?? path.join(SERVER, ".local/local-web-bench"),
);
if (!STATE.startsWith(path.resolve(SERVER, ".local") + path.sep))
  throw new Error("--state-dir must stay under server-core/.local");
mkdirSync(STATE, { recursive: true });
const require = createRequire(path.join(SERVER, "package.json"));
const build = createRequire(require.resolve("tsup"))("esbuild").build;
const outfile = path.join(STATE, "bootstrap.mjs");
const result = await build({
  absWorkingDir: SERVER,
  entryPoints: [path.join(HERE, "entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["socket.io", "sherpa-onnx-node", "ws"],
  outfile,
  metafile: true,
});
const sha = (data) => createHash("sha256").update(data).digest("hex");
writeFileSync(
  path.join(STATE, "build-evidence.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      bundleSha256: sha(readFileSync(outfile)),
      inputs: Object.keys(result.metafile.inputs).map((name) => ({
        path: path.resolve(SERVER, name),
        sha256: sha(readFileSync(path.resolve(SERVER, name))),
      })),
    },
    null,
    2,
  ),
);
console.log("LOCAL_WEB_BENCH_BUILT " + outfile);
