# MCP : un assistant IA qui lit vos bases

[Read in English](mcp.md)

La boîte noire est un serveur Model Context Protocol : un assistant (Claude Desktop, un IDE, un agent) peut lister vos
bases ouvertes, lire une vue, une ligne, ou exécuter une requête SQL en lecture seule, avec les droits d'une clé
d'application. Rien ne s'écrit par MCP. Exemple : [examples/mcp-assistant](../../examples/mcp-assistant), exécuté par
la suite d'essais (en HTTP, et par le relais stdio du fichier de configuration).

**Palier :** tous les paliers (MCP lit dans la copie de la boîte noire).

## L'allumer

1. `FILARR_GATE_MCP=true` (ou `mcp = true` dans `gate.toml`, ou l'écran de mise en route, ou **Réglages**) : éteint
   d'office.
2. Une clé d'application qui a le droit **MCP** (et le droit **SQL** pour `run_sql`), limitée à ce que l'assistant peut
   lire :

   ```sh
   filarr-gate keys create --name assistant --mcp --sql
   ```

   (ou **Clés des applications › Nouvelle clé**, « Serveur MCP (assistants IA) »). Ce que la clé ne peut pas lire,
   l'assistant ne le peut pas non plus.

## Brancher un assistant

**Par stdio** (les assistants qui lancent une commande), avec `filarr-gate mcp`, qui relaie chaque message vers
`POST /mcp` d'une boîte noire en marche :

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

`--gate` (ou `FILARR_GATE_URL`) est l'API locale de la boîte noire, `--key` (ou `FILARR_GATE_KEY`) la clé
d'application. Tant que la boîte noire n'est pas publiée sur npm, employez `"command": "node"` avec
`"args": ["/chemin/vers/filarr-gate/packages/cli/dist/cli.js", "mcp", …]`.

**Par HTTP** (HTTP en flux, réponses JSON), pour les clients qui prennent une URL et des en-têtes :

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

## Les outils

| outil | arguments | rend |
|---|---|---|
| `list_bases` | aucun | les bases que la clé peut lire, avec leurs champs (nom JSON, nom de colonne, type, options) et leurs vues |
| `query_view` | `base` (slug), `view` (slug, facultatif), `limit` (de 1 à 200, 50 par défaut), `cursor`, `search`, `filters` (`{ "champ[op]": "valeur" }`), `sort` | une page de lignes, comme `GET /v1/<base>[/<vue>]` |
| `get_row` | `base`, `id` | une ligne |
| `run_sql` | `sql` | `{ columns, rows, ms, scanned, truncated }` d'un `SELECT` sur les bases que lit la clé |

Un appel refusé (base inconnue, vue que la clé ne peut pas lire, erreur SQL) est un résultat d'outil avec
`isError: true` et un texte comme `base_not_found : …`, pour que l'assistant puisse lire pourquoi ; une requête mal
formée est une erreur JSON-RPC.

## Le protocole, à la main

Un appel JSON-RPC 2.0 à `POST /mcp` :

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

Une session : `initialize`, la liste des outils, puis chaque outil ; un appel refusé est un résultat avec `isError`,
pas une erreur JSON-RPC, et l'assistant lit pourquoi :

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

Versions du protocole `2025-06-18`, `2025-03-26`, `2024-11-05` ; `initialize` rend un `Mcp-Session-Id`.

## Ce que voit le fournisseur de l'assistant

Ce que l'assistant lit par MCP entre dans sa conversation, et donc chez le fournisseur qui fait tourner le modèle. Ne
donnez à la clé de l'assistant que les bases et les vues que vous colleriez dans cette conversation.
