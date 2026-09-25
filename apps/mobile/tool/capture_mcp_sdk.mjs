// Captures actual official SDK HTTP responses, not hand-authored protocol fixtures.
// Run from the repository root after the pinned install documented in the matrix.
// The HTTP listener is loopback-only and only synthetic text is submitted.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../..');
const modules = resolve(root, '.local/mcp-sdk/node_modules');
const modern = await import(pathToFileURL(resolve(modules, '@modelcontextprotocol/server/dist/index.mjs')));
const legacy = await import(pathToFileURL(resolve(modules, '@modelcontextprotocol/sdk/dist/esm/server/mcp.js')));
const { ListToolsRequestSchema } = await import(pathToFileURL(resolve(modules, '@modelcontextprotocol/sdk/dist/esm/types.js')));
const { WebStandardStreamableHTTPServerTransport } = await import(pathToFileURL(resolve(modules, '@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js')));
const { z } = await import(pathToFileURL(resolve(modules, 'zod/index.js')));

function define(Server) {
  const server = new Server({ name: 'flowmic-interoperability-fixture', version: '1.0.0' });
  server.registerTool('submit', {
    inputSchema: z.object({ payload: z.object({ text: z.string() }), kind: z.enum(['record', 'task']) }),
  }, async () => ({ content: [{ type: 'text', text: 'fixture-tool-result' }] }));
  server.registerTool('refuse', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'fixture-tool-refusal' }], isError: true,
  }));
  return server;
}
const handler = modern.createMcpHandler(() => define(modern.McpServer), { legacy: 'reject' });
const streamHandler = modern.createMcpHandler(() => define(modern.McpServer), { legacy: 'reject', responseMode: 'sse' });
const oldServer = define(legacy.McpServer);
const oldTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'fixture-session', enableJsonResponse: true });
await oldServer.connect(oldTransport);

const service = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method, headers: req.headers, body: Buffer.concat(chunks),
    });
    const response = req.url === '/legacy' ? await oldTransport.handleRequest(request)
      : req.url === '/auth' ? modern.bearerAuthChallengeResponse(new modern.OAuthError(modern.OAuthErrorCode.InvalidToken, 'fixture-token-required'), { resourceMetadataUrl: 'https://fixture.invalid/.well-known/oauth-protected-resource' })
      : await (req.url === '/sse' ? streamHandler : handler).fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});
await new Promise(done => service.listen(0, '127.0.0.1', done));
const address = `http://127.0.0.1:${service.address().port}`;
const exchanges = [];
let id = 0;
async function capture(name, path, method, params, { version, session, notification = false } = {}) {
  const request = { jsonrpc: '2.0', ...(!notification && { id: ++id }), method, params };
  if (version && version !== '2025-11-25') request.params = {
    ...params, _meta: {
      [modern.PROTOCOL_VERSION_META_KEY]: version,
      [modern.CLIENT_INFO_META_KEY]: { name: 'flowmic-fixture-capture', version: '1.0.0' },
      [modern.CLIENT_CAPABILITIES_META_KEY]: {},
    },
  };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'Mcp-Method': method, ...(params.name && { 'Mcp-Name': params.name }),
    ...(version && { 'MCP-Protocol-Version': version }), ...(session && { 'Mcp-Session-Id': session }) };
  const response = await fetch(address + path, { method: 'POST', headers, body: JSON.stringify(request), signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  exchanges.push({ name, request, requestHeaders: headers, status: response.status,
    headers: Object.fromEntries([...response.headers].filter(([key]) => !['date', 'connection', 'keep-alive'].includes(key))), body });
  return response;
}
try {
  await capture('modern-discover', '/modern', 'server/discover', {}, { version: '2026-07-28' });
  await capture('modern-tools', '/modern', 'tools/list', {}, { version: '2026-07-28' });
  await capture('modern-success', '/modern', 'tools/call', { name: 'submit', arguments: { payload: { text: 'synthetic-only' }, kind: 'record' } }, { version: '2026-07-28' });
  await capture('modern-refusal', '/modern', 'tools/call', { name: 'refuse', arguments: {} }, { version: '2026-07-28' });
  await capture('unsupported-version', '/modern', 'server/discover', {}, { version: '2099-01-01' });
  await capture('modern-sse', '/sse', 'tools/call', { name: 'submit', arguments: { payload: { text: 'synthetic-only' }, kind: 'task' } }, { version: '2026-07-28' });
  await capture('auth-required', '/auth', 'server/discover', {}, { version: '2026-07-28' });
  await capture('legacy-discover-probe', '/legacy', 'server/discover', {}, { version: '2026-07-28' });
  const init = await capture('legacy-initialize', '/legacy', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'flowmic-fixture-capture', version: '1.0.0' } });
  const session = init.headers.get('mcp-session-id');
  await capture('legacy-initialized', '/legacy', 'notifications/initialized', {}, { version: '2025-11-25', session, notification: true });
  await capture('legacy-tools', '/legacy', 'tools/list', {}, { version: '2025-11-25', session });
  const listed = JSON.parse(exchanges.at(-1).body).result.tools;
  // Pagination is application-owned; serve the registered SDK tools through
  // the SDK request handler rather than constructing replay response bytes.
  oldServer.server.setRequestHandler(ListToolsRequestSchema, async request => ({
    tools: [listed[request.params?.cursor === 'second-page' ? 1 : 0]],
    ...(request.params?.cursor ? {} : { nextCursor: 'second-page' }),
  }));
  await capture('legacy-tools-page-one', '/legacy', 'tools/list', {}, { version: '2025-11-25', session });
  await capture('legacy-tools-page-two', '/legacy', 'tools/list', { cursor: 'second-page' }, { version: '2025-11-25', session });
  const lock = JSON.parse(await readFile(resolve(root, '.local/mcp-sdk/package-lock.json'), 'utf8'));
  const dependencies = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => /node_modules\/@modelcontextprotocol\/(sdk|server|core)$/.test(key)).map(([key, value]) => [key, { version: value.version, integrity: value.integrity }]));
  const target = resolve(root, 'apps/mobile/test/fixtures/mcp_sdk_responses.json');
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, JSON.stringify({ capturedAt: new Date().toISOString(), dependencies, exchanges }, null, 2) + '\n');
  for (const row of exchanges) console.log(`${row.name}: HTTP ${row.status} ${row.headers['content-type']}`);
} finally {
  await handler.close(); await streamHandler.close(); await oldServer.close();
  service.closeAllConnections(); await new Promise(done => service.close(done));
}
