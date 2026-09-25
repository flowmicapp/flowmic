// Disposable local bench. Production bootstrap/router/socket/STT adapter run
// unchanged; ONLY the external ASR provider returns fixture text.
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../..");
const { values } = parseArgs({
  options: { "web-root": { type: "string" }, "state-dir": { type: "string" } },
});
if (!values["web-root"] || !path.isAbsolute(values["web-root"]))
  throw new Error("--web-root must name the absolute client checkout");
const WEB = path.resolve(values["web-root"]);
const STATE = path.resolve(
  values["state-dir"] ?? path.join(SERVER, ".local/local-web-bench"),
);
if (!STATE.startsWith(path.resolve(SERVER, ".local") + path.sep))
  throw new Error("--state-dir must stay under server-core/.local");
if (path.parse(WEB).root !== path.parse(SERVER).root)
  throw new Error(
    "client checkout and all bench state must use the repository volume",
  );
mkdirSync(STATE, { recursive: true });
const BUNDLE = path.join(WEB, "packages/sdk/dist/flowmic-sdk.v1.js");
const ALLOW = path.join(STATE, "approved-sdk.sha256");
const META = path.join(STATE, "meta.json");
const TEXT = "local relay fixture words🙂";
const frames = [],
  asrRequests = [],
  roomRequests = [];
let holdAsr = false;
let departureDelayMs = 0;
const heldAsr = new Set();
const keyA = `fmpk_${randomBytes(16).toString("hex")}`;
const keyB = `fmpk_${randomBytes(16).toString("hex")}`;
const sessionId = randomBytes(5).toString("hex");
const ownerA = `owner-a-${sessionId}`,
  ownerB = `owner-b-${sessionId}`;
const controlSecret = randomBytes(24).toString("hex");
let relay, hostAUrl, hostBUrl;
const netSockets = new Set();
const listen = (server, port = 0, host = "127.0.0.1") =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
    server.on("connection", (s) => {
      netSockets.add(s);
      s.on("close", () => netSockets.delete(s));
    });
  });
const json = (res, value, status = 200) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const bytes = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const sha = (data) => createHash("sha256").update(data).digest("hex");
function sdkReady() {
  return (
    existsSync(ALLOW) &&
    existsSync(BUNDLE) &&
    readFileSync(ALLOW, "utf8").trim() === sha(readFileSync(BUNDLE))
  );
}
function pcmFacts(buffer) {
  let energy = 0,
    samples = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const v = buffer.readInt16LE(i);
    energy += v * v;
    samples++;
  }
  return {
    bytes: buffer.length,
    samples,
    rms: samples ? Math.sqrt(energy / samples) : 0,
  };
}
const asr = httpServer(async (req, res) => {
  if (req.url !== "/v1/audio/transcriptions")
    return json(res, { data: [{ id: "fixture" }] });
  const body = await bytes(req);
  const riff = body.indexOf(Buffer.from("RIFF"));
  let facts = { bytes: 0, samples: 0, rms: 0 };
  if (riff >= 0) {
    const wavLength = body.readUInt32LE(riff + 4) + 8;
    const wav = body.subarray(riff, riff + wavLength);
    const dataAt = wav.indexOf(Buffer.from("data"));
    if (dataAt >= 0)
      facts = pcmFacts(
        wav.subarray(dataAt + 8, dataAt + 8 + wav.readUInt32LE(dataAt + 4)),
      );
  }
  const observation = {
    at: Date.now(),
    path: req.url,
    requestBytes: body.length,
    ...facts,
  };
  asrRequests.push(observation);
  if (facts.samples === 0 || facts.rms === 0)
    return json(res, { error: "fixture received no nonzero PCM" }, 422);
  if (holdAsr) await new Promise((resolve) => heldAsr.add(resolve));
  // The fixture responds ONLY after receiving a real production adapter WAV.
  json(res, { text: TEXT });
});
const asrPort = await listen(asr);

// Nothing inherited can turn this fixture into a production-connected relay.
for (const name of Object.keys(process.env))
  if (name.startsWith("FLOWMIC_")) delete process.env[name];
// loadConfig.trustedProxies only declares posture. The production per-request
// trust reader uses this env, and accepts literal peers rather than CIDRs.
process.env.FLOWMIC_TRUSTED_PROXIES = "127.0.0.1";
process.env.FLOWMIC_STT_POOL = JSON.stringify([
  {
    id: "b-local-fixture",
    provider: "custom-openai-compatible",
    api: `http://127.0.0.1:${asrPort}/v1`,
    api_key: "",
    model: "fixture",
    enabled: true,
    priority: 1,
  },
]);
const built = JSON.parse(
  readFileSync(path.join(STATE, "build-evidence.json"), "utf8"),
);
if (
  sha(readFileSync(path.join(STATE, "bootstrap.mjs"))) !== built.bundleSha256 ||
  built.inputs.some(
    (input) =>
      !existsSync(input.path) || sha(readFileSync(input.path)) !== input.sha256,
  )
) {
  throw new Error(
    "local relay bundle is stale; rerun local-web-bench/build.mjs against the current source",
  );
}
const { startServer, loadConfig, countMobileDevices, isRealPc } = await import(
  pathToFileURL(path.join(STATE, "bootstrap.mjs")).href
);
relay = await startServer(
  loadConfig({
    mode: "saas",
    port: 0,
    host: "127.0.0.1",
    dbPath: path.join(STATE, `bench-${sessionId}.sqlite`),
    secret: randomBytes(32).toString("hex"),
    mockBilling: false,
    // The TLS facade below IS a loopback reverse proxy. Its forwarded protocol
    // lets production room mint publish the correct WSS origin.
    trustedProxies: ["127.0.0.1"],
  }),
);
const relayUrl = `http://127.0.0.1:${relay.port}`;
relay.io.engine.on("connection", (socket) =>
  console.log(
    "ENGINE_ORIGIN " +
      JSON.stringify({
        origin: socket.request.headers.origin ?? null,
        host: socket.request.headers.host ?? null,
      }),
  ),
);
relay.io.on("connection", (socket) => {
  // Delay only a departure the production disconnect handler really emitted.
  // No fixture creates a left event; the original payload and socket survive.
  const emit = socket.emit.bind(socket);
  socket.emit = (event, ...args) => {
    if (event === "pc:mobile-left" && departureDelayMs > 0) {
      const delay = departureDelayMs;
      frames.push({
        at: Date.now(),
        direction: "observed",
        socket: socket.id,
        event: "bench:departure-held",
        payload: { delayMs: delay, mobileId: args[0]?.mobile_id },
      });
      setTimeout(() => emit(event, ...args), delay);
      return true;
    }
    return emit(event, ...args);
  };

  socket.onAny((event, payload) => {
    let value = payload;
    if (event === "audio:chunk")
      value = {
        seq: payload?.seq,
        ...pcmFacts(Buffer.from(payload?.data_b64 ?? "", "base64")),
      };
    else if (payload && typeof payload === "object")
      value = Object.fromEntries(
        Object.entries(payload).filter(
          ([k]) =>
            !["token", "mobile_token", "room_token", "authorization"].includes(
              k,
            ),
        ),
      );
    frames.push({
      at: Date.now(),
      direction: "in",
      socket: socket.id,
      event,
      payload: value,
    });
  });
  socket.onAnyOutgoing((event, payload) =>
    frames.push({
      at: Date.now(),
      direction: "out",
      socket: socket.id,
      event,
      payload,
    }),
  );
});
function snapshot() {
  return {
    healthy: true,
    sdkReady: sdkReady(),
    text: TEXT,
    frames,
    asrRequests,
    roomRequests,
    heldAsr: heldAsr.size,
    rooms: relay.db.raw
      .prepare("SELECT id,user_id,room_kind,is_online,pcid FROM pc_devices")
      .all(),
    mobiles: relay.db.raw
      .prepare(
        "SELECT id,pc_device_id,user_id,client,device_uid FROM mobile_pairings",
      )
      .all(),
    // Read the same arithmetic as the production ceiling and account console.
    mobileSlots: [ownerA, ownerB].map((id) => ({
      id,
      count: countMobileDevices(
        relay.db.pcs.listByUser(id).filter(isRealPc),
        relay.db.mobiles,
      ),
    })),
    usage: relay.db.raw
      .prepare("SELECT user_id,stt_minutes FROM usage_records")
      .all(),
    keys: [ownerA, ownerB].map((id) => {
      const row = relay.db.integratorKeys.findById(id);
      return { id, used_ms: row?.used_ms };
    }),
  };
}
const contentTypes = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
function serveFile(res, filename) {
  if (existsSync(filename) && statSync(filename).isDirectory())
    filename = path.join(filename, "index.html");
  if (!existsSync(filename))
    return json(res, { error: "fixture asset missing", filename }, 404);
  res.writeHead(200, {
    "content-type": contentTypes[path.extname(filename)] ?? "text/html",
    "cache-control": "no-store",
  });
  res.end(readFileSync(filename));
}
function host(key) {
  return httpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return json(res, snapshot());
    if (url.pathname === "/control/departure" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${controlSecret}`)
        return json(res, { error: "unauthorized" }, 401);
      const body = JSON.parse((await bytes(req)).toString("utf8"));
      if (![0, 150, 2000].includes(body.delayMs))
        return json(res, { error: "delay must be 0, 150 or 2000 ms" }, 400);
      departureDelayMs = body.delayMs;
      return json(res, { delayMs: departureDelayMs });
    }
    if (url.pathname === "/control/asr" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${controlSecret}`)
        return json(res, { error: "unauthorized" }, 401);
      const body = JSON.parse((await bytes(req)).toString("utf8"));
      holdAsr = body.hold === true;
      if (!holdAsr) {
        for (const resume of heldAsr) resume();
        heldAsr.clear();
      }
      return json(res, { hold: holdAsr, held: heldAsr.size });
    }
    if (url.pathname === "/control/drop-target" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${controlSecret}`)
        return json(res, { error: "unauthorized" }, 401);
      const targets = [...relay.io.sockets.sockets.values()].filter(
        (s) => s.data.auth?.kind === "pc",
      );
      for (const target of targets) target.disconnect(true);
      return json(res, { dropped: targets.length });
    }
    if (url.pathname === "/sdk.js") {
      if (!sdkReady())
        return json(
          res,
          { error: "waiting for explicitly approved current SDK bundle" },
          503,
        );
      return serveFile(res, BUNDLE);
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local B Integration</title></head><body>
  <h1>Local B Integration</h1><textarea id="host-notes" style="width:min(720px,90vw);height:120px">typed:</textarea><div id="slot"></div>
  <script>window.__events=[];</script>
  <script src="/sdk.js" data-publishable-key="${url.searchParams.get("wrongkey") === "1" ? keyA : key}" data-lang="en" data-target="#host-notes" data-mode="append" data-mount="#slot" data-endpoint="https://flowmic.app"></script>
  <script>if(window.flowmic) for(const name of ['ready','text','budget','error']) window.flowmic.on(name,payload=>window.__events.push({name,payload}));</script>
  </body></html>`);
  });
}
const hostA = host(keyA),
  hostB = host(keyB);
hostAUrl = `http://127.0.0.1:${await listen(hostA)}`;
hostBUrl = `http://127.0.0.1:${await listen(hostB)}`;
for (const [id, key, origin] of [
  [ownerA, keyA, hostAUrl],
  [ownerB, keyB, hostBUrl],
]) {
  relay.db.users.insert({
    id,
    display_name: "Local integration fixture",
    plan: "free",
  });
  relay.db.integratorKeys.insert({
    id,
    user_id: id,
    publishable_key: key,
    origins: [origin],
    quota_minutes: 10,
    label: "Local B Integration",
    created_at: Date.now(),
  });
}

const { ensureDevCert } = await import(
  pathToFileURL(path.join(WEB, "e2e/harness/tls.mjs")).href
);
const tls = httpsServer(ensureDevCert(), (req, res) => {
  const url = new URL(req.url ?? "/", "https://flowmic.app");
  if (url.pathname.startsWith("/target/")) {
    const base = path.join(WEB, "apps/target/dist");
    const filename = path.resolve(base, url.pathname.slice("/target/".length));
    if (
      filename !== path.resolve(base) &&
      !filename.startsWith(path.resolve(base) + path.sep)
    )
      return json(res, { error: "invalid path" }, 400);
    return serveFile(
      res,
      existsSync(filename) ? filename : path.join(base, "index.html"),
    );
  }
  if (url.pathname.startsWith("/go/") || url.pathname.startsWith("/assets/")) {
    const relative = url.pathname.startsWith("/go/")
      ? url.pathname.slice(4)
      : url.pathname.slice(1);
    const base = path.join(WEB, "apps/mic/dist");
    const filename = path.resolve(base, relative);
    if (
      filename !== path.resolve(base) &&
      !filename.startsWith(path.resolve(base) + path.sep)
    )
      return json(res, { error: "invalid path" }, 400);
    return serveFile(
      res,
      existsSync(filename) ? filename : path.join(base, "index.html"),
    );
  }
  if (url.pathname === "/api/web/rooms")
    roomRequests.push({
      at: Date.now(),
      method: req.method,
      origin: req.headers.origin ?? null,
    });
  const proxy = httpRequest(
    {
      host: "127.0.0.1",
      port: relay.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: "flowmic.app",
        "x-forwarded-proto": "https",
      },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxy.on("error", (error) => json(res, { error: error.message }, 502));
  req.pipe(proxy);
});
tls.on("upgrade", (req, socket, head) => {
  console.log(
    "TLS_UPGRADE_ORIGIN " +
      JSON.stringify({
        origin: req.headers.origin ?? null,
        host: req.headers.host ?? null,
      }),
  );
  const proxy = httpRequest({
    host: "127.0.0.1",
    port: relay.port,
    path: req.url,
    headers: {
      ...req.headers,
      host: "flowmic.app",
      "x-forwarded-proto": "https",
    },
  });
  proxy.on("upgrade", (response, upstream, upHead) => {
    socket.write(
      `HTTP/1.1 ${response.statusCode} Switching Protocols\r\n` +
        Object.entries(response.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("") +
        "\r\n",
    );
    if (head.length) upstream.write(head);
    if (upHead.length) socket.write(upHead);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  proxy.on("error", () => socket.destroy());
  proxy.end();
});
await listen(tls, 443, "127.0.0.44");
const meta = {
  pid: process.pid,
  sessionId,
  relayUrl,
  publicRelay: "https://flowmic.app",
  loopbackTls: "127.0.0.44:443",
  hostA: hostAUrl,
  hostB: hostBUrl,
  keyA,
  keyB,
  ownerA,
  ownerB,
  controlSecret,
  text: TEXT,
  asrPort,
  approvedSdkFile: ALLOW,
};
writeFileSync(META, JSON.stringify(meta, null, 2));
console.log(
  "LOCAL_B_READY " +
    JSON.stringify({
      pid: process.pid,
      hostA: hostAUrl,
      hostB: hostBUrl,
      relayUrl,
      loopbackTls: meta.loopbackTls,
      sdkReady: sdkReady(),
    }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  writeFileSync(
    path.join(STATE, "last-observations.json"),
    JSON.stringify(snapshot(), null, 2),
  );
  for (const s of netSockets) s.destroy();
  for (const s of [hostA, hostB, tls, asr]) s.close();
  await relay.close();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
