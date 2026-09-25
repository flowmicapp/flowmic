// Local-only device drill receiver. Real pinned official SDK handlers; synthetic
// records only. Never shipped or deployed. HTTPS trust is pinned in the separate
// drill target, not weakened in production. Control file faults are labelled.
import { createServer } from 'node:https';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../..');
const folder = resolve(process.argv[2] ?? '');
if (!isAbsolute(folder) || !folder.startsWith(resolve(root, '.local') + '\\')) throw new Error('Use this worktree .local drill directory');
const modules = resolve(root, '.local/mcp-sdk/node_modules');
const modern = await import(pathToFileURL(resolve(modules, '@modelcontextprotocol/server/dist/index.mjs')));
const legacy = await import(pathToFileURL(resolve(modules, '@modelcontextprotocol/sdk/dist/esm/server/mcp.js')));
const { WebStandardStreamableHTTPServerTransport } = await import(pathToFileURL(resolve(modules, '@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js')));
const { z } = await import(pathToFileURL(resolve(modules, 'zod/index.js')));
const identity = JSON.parse(await readFile(resolve(folder, 'identity.json'), 'utf8'));
const log = async value => appendFile(resolve(folder, 'receipts.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
function define(Server) {
  const server = new Server({ name: 'flowmic-device-drill', version: '1.0.0' });
  server.registerTool('submit', { inputSchema: z.object({ payload: z.object({ text: z.string() }), kind: z.enum(['record', 'task']) }) }, async args => {
    await log({ event: 'tool_received', tool: 'submit', arguments: args });
    return { content: [{ type: 'text', text: 'fixture-tool-result' }] };
  });
  server.registerTool('refuse', { inputSchema: z.object({}) }, async () => {
    await log({ event: 'tool_received', tool: 'refuse' });
    return { content: [{ type: 'text', text: 'fixture-tool-refusal' }], isError: true };
  });
  return server;
}
const handler = modern.createMcpHandler(() => define(modern.McpServer), { legacy: 'reject' });
const stream = modern.createMcpHandler(() => define(modern.McpServer), { legacy: 'reject', responseMode: 'sse' });
const oldServer = define(legacy.McpServer);
const oldTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
await oldServer.connect(oldTransport);
const service = createServer({ cert: identity.certPem, key: identity.keyPem }, async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const rpc = JSON.parse(bytes.toString('utf8'));
    const { mode } = JSON.parse(await readFile(resolve(folder, 'control.json'), 'utf8'));
    await log({ event: 'request', method: rpc.method, id: rpc.id, mode,
      protocol: req.headers['mcp-protocol-version'], hasSession: Boolean(req.headers['mcp-session-id']) });
    const request = new Request(`https://localhost${req.url}`, { method: req.method, headers: req.headers, body: bytes });
    const response = mode === '401' ? modern.bearerAuthChallengeResponse(new modern.OAuthError(modern.OAuthErrorCode.InvalidToken, 'fixture-token-required'),
      { resourceMetadataUrl: 'https://fixture.invalid/.well-known/oauth-protected-resource' })
      : mode === 'legacy' ? await oldTransport.handleRequest(request)
      : await (mode === 'sse' ? stream : handler).fetch(request);
    // SDK already executed and persisted its receipt. This fault withholds the
    // response to prove why a broken stream cannot be auto-retried as unsent.
    if (mode === 'drop-after-call' && rpc.method === 'tools/call') {
      await log({ event: 'fault_drop_after_call', id: rpc.id }); res.destroy(); return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch {
    await log({ event: 'fixture_error' });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise(done => service.listen(8879, '127.0.0.1', done));
console.log('MCP_DEVICE_SDK_READY host=127.0.0.1 port=8879 modern=2.0.0 legacy=1.30.0');
process.on('SIGINT', async () => {
  await handler.close(); await stream.close(); await oldServer.close();
  service.closeAllConnections(); service.close();
});
