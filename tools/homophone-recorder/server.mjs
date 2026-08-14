#!/usr/bin/env node
/**
 * Local web recorder for C1 homophone / idiom corpus.
 * Serves UI on loopback; writes audio + manifest under .local/homophone-corpus/
 * (gitignored). Corpus must never be committed.
 *
 * Usage: node tools/homophone-recorder/server.mjs
 * Optional: FLOWMIC_CORPUS_PORT=8797 FLOWMIC_CORPUS_DIR=...
 *
 * ⚠️ Port 8787 is taken by tools/owner-ruling-desk ("待您拍板"). Do not reuse it.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PUBLIC = path.join(__dirname, 'public');
const SCRIPTS_PATH = path.join(__dirname, 'scripts.json');
const PORT = Number(process.env.FLOWMIC_CORPUS_PORT || 8797);
const CORPUS_DIR = path.resolve(
  process.env.FLOWMIC_CORPUS_DIR || path.join(REPO_ROOT, '.local', 'homophone-corpus'),
);
const MANIFEST = path.join(CORPUS_DIR, 'manifest.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

async function ensureCorpusLayout() {
  await fsp.mkdir(CORPUS_DIR, { recursive: true });
  const readme = path.join(CORPUS_DIR, 'README.md');
  if (!fs.existsSync(readme)) {
    await fsp.writeFile(
      readme,
      [
        '# Homophone / idiom corpus (C1)',
        '',
        'Managed by `tools/homophone-recorder`. **Do not commit audio.**',
        '',
        '- `manifest.json` — index of takes',
        '- `seg-NN/` — one folder per script: `script.txt`, `take-*.webm`, `meta.json`',
        '',
        'Adopt a take by copying it into the eval harness path when A2-8 opens.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  if (!fs.existsSync(MANIFEST)) {
    await fsp.writeFile(
      MANIFEST,
      JSON.stringify({ version: 1, corpusDir: CORPUS_DIR, takes: [] }, null, 2) + '\n',
      'utf8',
    );
  }
}

async function readManifest() {
  await ensureCorpusLayout();
  return JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));
}

async function writeManifest(m) {
  await fsp.writeFile(MANIFEST, JSON.stringify(m, null, 2) + '\n', 'utf8');
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function parseMultipart(buf, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buf.indexOf(sep) + sep.length;
  while (start < buf.length) {
    if (buf[start] === 45 && buf[start + 1] === 45) break; // --
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
    const next = buf.indexOf(sep, start);
    if (next < 0) break;
    let part = buf.subarray(start, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      start = next + sep.length;
      continue;
    }
    const header = part.subarray(0, headerEnd).toString('utf8');
    const body = part.subarray(headerEnd + 4);
    const nameM = /name="([^"]+)"/.exec(header);
    const fileM = /filename="([^"]+)"/.exec(header);
    parts.push({
      name: nameM?.[1] || '',
      filename: fileM?.[1] || '',
      body,
    });
    start = next + sep.length;
  }
  return parts;
}

async function handleUpload(req, res) {
  const ctype = req.headers['content-type'] || '';
  const m = /boundary=(.+)$/i.exec(ctype);
  if (!m) return sendJson(res, 400, { ok: false, error: 'expected multipart' });
  const parts = parseMultipart(await readBody(req), m[1].trim());
  const file = parts.find((p) => p.name === 'audio' && p.body.length > 0);
  const segId = parts.find((p) => p.name === 'seg_id')?.body.toString('utf8').trim();
  const label = parts.find((p) => p.name === 'label')?.body.toString('utf8').trim() || '';
  const script = parts.find((p) => p.name === 'script')?.body.toString('utf8') || '';
  if (!file || !segId || !/^seg-\d{2}$/.test(segId)) {
    return sendJson(res, 400, { ok: false, error: 'need audio + seg_id (seg-NN)' });
  }
  const ext = (path.extname(file.filename || '') || '.webm').toLowerCase();
  const safeExt = ['.webm', '.wav', '.ogg', '.mp4'].includes(ext) ? ext : '.webm';
  const segDir = path.join(CORPUS_DIR, segId);
  await fsp.mkdir(segDir, { recursive: true });
  await fsp.writeFile(path.join(segDir, 'script.txt'), script || '', 'utf8');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const takeName = `take-${stamp}${safeExt}`;
  const takePath = path.join(segDir, takeName);
  await fsp.writeFile(takePath, file.body);

  const meta = {
    seg_id: segId,
    label,
    file: takeName,
    bytes: file.body.length,
    recorded_at: new Date().toISOString(),
    relative_path: path.join(segId, takeName).replace(/\\/g, '/'),
  };
  await fsp.writeFile(path.join(segDir, 'meta-latest.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

  const manifest = await readManifest();
  manifest.takes = manifest.takes.filter(
    (t) => !(t.seg_id === segId && t.file === takeName),
  );
  manifest.takes.push(meta);
  manifest.updated_at = new Date().toISOString();
  await writeManifest(manifest);

  return sendJson(res, 200, {
    ok: true,
    corpusDir: CORPUS_DIR,
    ...meta,
  });
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel === '/scripts.json') {
    const raw = await fsp.readFile(SCRIPTS_PATH);
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Length': raw.length });
    return res.end(raw);
  }
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ''));
  if (!filePath.startsWith(PUBLIC)) return sendJson(res, 403, { ok: false });
  try {
    const raw = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': raw.length });
    res.end(raw);
  } catch {
    sendJson(res, 404, { ok: false, error: 'not found' });
  }
}

await ensureCorpusLayout();

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && u.pathname === '/api/status') {
      const manifest = await readManifest();
      return sendJson(res, 200, {
        ok: true,
        corpusDir: CORPUS_DIR,
        takeCount: manifest.takes.length,
        takes: manifest.takes,
      });
    }
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      return await handleUpload(req, res);
    }
    if (req.method === 'GET') return await serveStatic(req, res, u.pathname);
    sendJson(res, 405, { ok: false, error: 'method' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Homophone recorder: http://127.0.0.1:${PORT}/`);
  console.log(`Corpus directory:   ${CORPUS_DIR}`);
  console.log('(loopback only; audio stays under .local/ — never commit)');
});
