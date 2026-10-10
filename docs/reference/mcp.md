# MCP: an AI assistant that reads your databases

[Lire en français](mcp.fr.md)

The gate is a Model Context Protocol server: an assistant (Claude Desktop, an IDE, an agent) can list your opened
databases, read a view, a row, or run a read-only SQL query, with the rights of one app key. Nothing is written
through MCP. Example: [examples/mcp-assistant](../../examples/mcp-assistant), run by the test suite (over HTTP, and
through the stdio relay of the configuration file).

**Plan:** every plan (MCP reads from the gate's copy).

## Switch it on

1. `FILARR_GATE_MCP=true` (or `mcp = true` in `gate.toml`, or the setup screen, or **Settings**): off by default.
2. An app key with the **MCP** right (and the **SQL** right for `run_sql`), limited to what the assistant may read:

   ```sh
   filarr-gate keys create --name assistant --mcp --sql
   ```

   (or **App keys › New key**, "MCP server (AI assistants)"). What the key cannot read, the assistant cannot either.

## Connect an assistant

**Over stdio** (assistants that launch a command), with `filarr-gate mcp`, which relays each message to a running
gate's `POST /mcp`:

<!-- snippet: examples/mcp-assistant/claude_desktop_config.json -->
```json
{
  "mcpServers": {
    "filarr": {
      "command": "npx",
      "args": ["filarr-gate", "mcp", "--gate", "http://127.0.0.1:8443"],
      "env": { "FILARR_GATE_KEY": "gk_mcp_replace_with_your_key" }
    }
  }
}
```

`--gate` (or `FILARR_GATE_URL`) is the gate's local API, `--key` (or `FILARR_GATE_KEY`) the app key. Until the gate is
published on npm, use `"command": "node"` with `"args": ["/path/to/filarr-gate/packages/cli/dist/cli.js", "mcp", …]`.

**Over HTTP** (streamable HTTP, JSON answers), for clients that take a URL and headers:

<!-- snippet: examples/mcp-assistant/mcp-http.json -->
```json
{
  "mcpServers": {
    "filarr": {
      "type": "http",
      "url": "http://127.0.0.1:8443/mcp",
      "headers": { "Authorization": "Bearer gk_mcp_replace_with_your_key" }
    }
  }
}
```

## Tools

| tool | arguments | returns |
|---|---|---|
| `list_bases` | none | the databases the key can read, with their fields (JSON name, column name, type, options) and views |
| `query_view` | `base` (slug), `view` (slug, optional), `limit` (1 to 200, 50 by default), `cursor`, `search`, `filters` (`{ "field[op]": "value" }`), `sort` | a page of rows, as `GET /v1/<base>[/<view>]` |
| `get_row` | `base`, `id` | one row |
| `run_sql` | `sql` | `{ columns, rows, ms, scanned, truncated }` of a `SELECT` over the databases the key reads |

A refused call (unknown database, a view the key cannot read, an SQL error) is a tool result with `isError: true` and a
text such as `base_not_found : …`, so the assistant can read why; a malformed request is a JSON-RPC error.

## The protocol, by hand

<!-- snippet: examples/mcp-assistant/check.mjs#rpc -->
```js
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
```

<!-- snippet: examples/mcp-assistant/check.mjs#session -->
```js
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
```

Protocol versions `2025-06-18`, `2025-03-26`, `2024-11-05`; `initialize` returns an `Mcp-Session-Id`.

## What the assistant's provider sees

Whatever the assistant reads through MCP goes into its conversation, and therefore to the provider that runs the
model. Give the assistant's key only the databases and views you would paste into that conversation.
