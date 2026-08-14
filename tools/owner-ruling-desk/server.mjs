#!/usr/bin/env node
/**
 * Owner ruling desk — local web form for decisions that need a human owner.
 *
 * Serves the page and persists each submit under:
 *   docs/decisions/owner-web-rulings/latest.{json,md}
 *   docs/decisions/owner-web-rulings/submissions/<stamp>.{json,md}
 *
 * Usage (from repo root or this folder):
 *   node tools/owner-ruling-desk/server.mjs
 * Then open http://127.0.0.1:8787/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(__dirname, 'public');
const CATALOG = path.join(__dirname, 'catalog.json');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'decisions', 'owner-web-rulings');
const SUB_DIR = path.join(OUT_DIR, 'submissions');
const HOST = process.env.OWNER_RULING_HOST || '127.0.0.1';
const PORT = Number(process.env.OWNER_RULING_PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function ensureDirs() {
  fs.mkdirSync(SUB_DIR, { recursive: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
}

function labelFor(catalog, itemId, value) {
  for (const section of catalog.sections) {
    for (const item of section.items) {
      if (item.id !== itemId) continue;
      if (item.kind === 'note') return value;
      if (item.kind === 'multi' && Array.isArray(value)) {
        return value
          .map((v) => item.options?.find((o) => o.value === v)?.label || v)
          .join('；');
      }
      return item.options?.find((o) => o.value === value)?.label || String(value);
    }
  }
  return String(value);
}

function questionFor(catalog, itemId) {
  for (const section of catalog.sections) {
    for (const item of section.items) {
      if (item.id === itemId) return { section, item };
    }
  }
  return null;
}

function toMarkdown(payload, catalog) {
  const lines = [];
  lines.push('# Owner 网页裁定结果');
  lines.push('');
  lines.push(`> 提交时间：${payload.submittedAt}`);
  lines.push(`> 提交人：${payload.submitter || '（未填）'}`);
  lines.push(`> 来源：owner-ruling-desk · ${payload.host || HOST}`);
  lines.push('');
  if (payload.globalNote?.trim()) {
    lines.push('## 总备注');
    lines.push('');
    lines.push(payload.globalNote.trim());
    lines.push('');
  }
  for (const section of catalog.sections) {
    lines.push(`## ${section.eyebrow} · ${section.title}`);
    lines.push('');
    for (const item of section.items) {
      const raw = payload.answers?.[item.id];
      const skipped =
        raw === undefined ||
        raw === null ||
        raw === '' ||
        (Array.isArray(raw) && raw.length === 0);
      lines.push(`### ${item.question}`);
      lines.push('');
      if (skipped) {
        lines.push('- **裁定**：本次跳过（不视为默许）');
      } else if (item.kind === 'note') {
        lines.push(`- **备注**：${String(raw).trim()}`);
      } else {
        lines.push(`- **裁定**：${labelFor(catalog, item.id, raw)}`);
        lines.push(`- **选项值**：\`${Array.isArray(raw) ? raw.join(',') : raw}\``);
      }
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(
    '机器可读副本：同目录 `latest.json` 与 `submissions/<stamp>.json`。' +
      '开发侧读这两份即可；未选题不得当成批准。',
  );
  lines.push('');
  return lines.join('\n');
}

function persist(payload) {
  ensureDirs();
  const catalog = loadCatalog();
  const enriched = {
    ...payload,
    submittedAt: new Date().toISOString(),
    host: `${HOST}:${PORT}`,
    catalogTitle: catalog.title,
  };
  // Attach human labels for agent readability.
  const labeled = {};
  for (const [id, value] of Object.entries(enriched.answers || {})) {
    const hit = questionFor(catalog, id);
    labeled[id] = {
      question: hit?.item.question || id,
      section: hit ? `${hit.section.eyebrow} · ${hit.section.title}` : '',
      value,
      label: labelFor(catalog, id, value),
      kind: hit?.item.kind || 'unknown',
    };
  }
  enriched.labeled = labeled;

  const id = stamp();
  const jsonPath = path.join(SUB_DIR, `${id}.json`);
  const mdPath = path.join(SUB_DIR, `${id}.md`);
  const latestJson = path.join(OUT_DIR, 'latest.json');
  const latestMd = path.join(OUT_DIR, 'latest.md');
  const jsonText = JSON.stringify(enriched, null, 2) + '\n';
  const mdText = toMarkdown(enriched, catalog);
  fs.writeFileSync(jsonPath, jsonText, 'utf8');
  fs.writeFileSync(mdPath, mdText, 'utf8');
  fs.writeFileSync(latestJson, jsonText, 'utf8');
  fs.writeFileSync(latestMd, mdText, 'utf8');
  return {
    id,
    paths: {
      latestJson: path.relative(REPO_ROOT, latestJson).replace(/\\/g, '/'),
      latestMd: path.relative(REPO_ROOT, latestMd).replace(/\\/g, '/'),
      submissionJson: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/'),
      submissionMd: path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/'),
    },
  };
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(res, 404, 'Not found');
    return;
  }
  const ext = path.extname(filePath);
  send(res, 200, fs.readFileSync(filePath), MIME[ext] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      send(res, 200, fs.readFileSync(CATALOG), MIME['.json']);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/latest') {
      const latest = path.join(OUT_DIR, 'latest.json');
      if (!fs.existsSync(latest)) {
        send(res, 200, JSON.stringify({ empty: true }), MIME['.json']);
        return;
      }
      send(res, 200, fs.readFileSync(latest), MIME['.json']);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/submit') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        send(res, 400, JSON.stringify({ ok: false, error: 'invalid_json' }), MIME['.json']);
        return;
      }
      if (!payload.answers || typeof payload.answers !== 'object') {
        send(res, 400, JSON.stringify({ ok: false, error: 'answers_required' }), MIME['.json']);
        return;
      }
      const result = persist(payload);
      send(res, 200, JSON.stringify({ ok: true, ...result }), MIME['.json']);
      return;
    }

    if (req.method === 'GET') {
      let rel = url.pathname === '/' ? '/index.html' : url.pathname;
      rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(PUBLIC, rel);
      if (!filePath.startsWith(PUBLIC)) {
        send(res, 403, 'Forbidden');
        return;
      }
      serveFile(res, filePath);
      return;
    }

    send(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    send(res, 500, JSON.stringify({ ok: false, error: String(err) }), MIME['.json']);
  }
});

ensureDirs();
server.listen(PORT, HOST, () => {
  console.log(`Owner ruling desk → http://${HOST}:${PORT}/`);
  console.log(`Writes to ${path.relative(REPO_ROOT, OUT_DIR)}`);
});
