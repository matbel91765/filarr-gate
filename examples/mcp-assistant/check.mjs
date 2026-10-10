// Talk to the MCP server of Filarr Gate over HTTP, as an AI assistant does (Node 20+).
//
//   FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_… node check.mjs
//
// The gate needs `mcp` switched on (FILARR_GATE_MCP=true); the app key needs the MCP right
// (and the SQL right for run_sql). Everything is read only.

const GATE = process.env.FILARR_GATE_URL ?? 'http://127.0.0.1:8443';
const KEY = process.env.FILARR_GATE_KEY;
if (!KEY) throw new Error('Set FILARR_GATE_KEY to an app key with the MCP right (gk_…)');

let session = null;
let nextId = 1;

// region rpc
/** One JSON-RPC 2.0 call to POST /mcp. */
async function rpc(method, params) {
  const res = await fetch(`${GATE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  session = res.headers.get('mcp-session-id') ?? session;
  const msg = await res.json();
  if (msg.error) throw new Error(`${msg.error.code} ${msg.error.message}`);
  return msg.result;
}
// endregion

// region session
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
console.log(`server: ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}`);

const { tools } = await rpc('tools/list');
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

const bases = await rpc('tools/call', { name: 'list_bases', arguments: {} });
for (const b of bases.structuredContent.bases) console.log(`base ${b.slug}: ${b.fields.map((f) => f.name).join(', ')}`);

const view = await rpc('tools/call', { name: 'query_view', arguments: { base: 'clients', view: 'clients-actifs', limit: 10 } });
console.log(`active customers: ${view.structuredContent.rows.map((r) => r.nom).join(', ')}`);

const sql = await rpc('tools/call', { name: 'run_sql', arguments: { sql: 'SELECT count(*) AS n FROM clients' } });
console.log(`customers: ${sql.structuredContent.rows[0][0]}`);

// A refused tool call is a result with isError, not a JSON-RPC error: the assistant reads why
const refused = await rpc('tools/call', { name: 'query_view', arguments: { base: 'nope' } });
console.log(`refused: ${refused.isError} ${refused.content[0].text.split(' ')[0]}`);
// endregion
