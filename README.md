# @vouchid/mcp

Identity verification middleware for MCP servers. Verifies every incoming tool call before your handler runs — one function wraps your entire server.

```
npm install @vouchid/mcp
```

Node.js 18+ required. ESM only (`"type": "module"` in your `package.json`).

---

## How it works

Every tool call passes through the middleware before reaching your handler:

1. Extracts the agent token from `arguments._agentid_token` or the `x-agent-token` header
2. Verifies it against your VouchID backend
3. Checks the agent holds the capability required for that specific tool
4. Attaches the verified identity to the request
5. Calls your handler — or throws `AgentIDError` if any check fails

---

## Quick start

```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AgentIDMiddleware,
  getAgentIdentity,
  AgentIDError,
} from "@vouchid/mcp";

const middleware = new AgentIDMiddleware({
  apiUrl: process.env.VOUCHID_API_URL,
  apiKey: process.env.VOUCHID_API_KEY,
  toolCapabilities: {
    read_file: "read:filesystem",
    write_file: "write:filesystem",
  },
});

// Use the low-level Server class — it exposes setRequestHandler
const server = new Server(
  { name: "my-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_file",
      description: "Read a file from disk",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
}));

// middleware.wrap() handles all verification — no boilerplate in your handler
server.setRequestHandler(
  CallToolRequestSchema,
  middleware.wrap(async (request) => {
    const agent = getAgentIdentity(request);
    console.log(`Called by: ${agent.name} (trust score: ${agent.trustScore})`);

    const { name, arguments: args } = request.params;

    if (name === "read_file") {
      const { readFile } = await import("fs/promises");
      const text = await readFile(args.path, "utf8");
      return { content: [{ type: "text", text }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

> **Note:** Use `Server` from `@modelcontextprotocol/sdk/server/index.js`, not `McpServer`. `McpServer` does not expose `setRequestHandler`.

---

## Attaching a token (client side)

The calling agent attaches its token inside the tool arguments using the `@vouchid/sdk`:

```js
import { AgentID } from "@vouchid/sdk";

const vouchid = new AgentID({
  apiUrl: process.env.VOUCHID_API_URL,
  apiKey: process.env.VOUCHID_API_KEY,
});

const agent = await vouchid.register({
  name: "my-bot",
  capabilities: ["read:filesystem"],
});

const token = await agent.getToken(); // auto-refreshes near expiry

await mcpClient.callTool({
  name: "read_file",
  arguments: {
    path: "/data/report.csv",
    _agentid_token: token, // middleware picks this up automatically
  },
});
```

The middleware strips `_agentid_token` from the arguments before your handler runs, so your tool logic never sees it.

For HTTP transports you can alternatively pass the token as an `x-agent-token` request header instead.

---

## API reference

### `new AgentIDMiddleware(options)`

| Option             | Type           | Default   | Description                                                                               |
| ------------------ | -------------- | --------- | ----------------------------------------------------------------------------------------- |
| `apiUrl`           | `string`       | —         | **Required.** Your VouchID backend URL.                                                   |
| `apiKey`           | `string`       | —         | **Required.** Your org API key.                                                           |
| `toolCapabilities` | `object`       | `{}`      | Map of tool name → required capability string. Unlisted tools require only a valid token. |
| `strict`           | `boolean`      | `true`    | Reject requests with no token. Set `false` to allow unauthenticated requests through.     |
| `timeoutMs`        | `number`       | `8000`    | Verify call timeout in ms.                                                                |
| `maxRetries`       | `number`       | `2`       | Retry attempts on 429 / 5xx and network errors.                                           |
| `logger`           | `object\|null` | `console` | Custom logger with `.warn()` and `.error()`. Pass `null` to silence.                      |

---

### `middleware.wrap(handler)`

Wraps your MCP request handler. Runs identity verification first, then calls your handler only if all checks pass.

```js
server.setRequestHandler(
  CallToolRequestSchema,
  middleware.wrap(async (request) => {
    // only reached if agent is verified and has the required capability
  }),
);
```

---

### `getAgentIdentity(request)`

Returns the verified agent info attached to the request. Call this inside a wrapped handler.

```js
const agent = getAgentIdentity(request);

agent.id; // "agent_01jk2m3n4p5q6r7s"
agent.name; // "my-data-bot"
agent.org; // "acmecorp"
agent.capabilities; // ["read:filesystem"]
agent.trustLevel; // "verified"
agent.trustScore; // 91
```

Returns `null` only in non-strict mode when no token was provided.

---

## Error handling

The middleware throws `AgentIDError` on all failures. Each error has a `code` property for programmatic handling.

| Code                 | Cause                                              |
| -------------------- | -------------------------------------------------- |
| `MISSING_TOKEN`      | No token on request and `strict: true`.            |
| `INVALID_TOKEN`      | Token expired, revoked, or malformed.              |
| `MISSING_CAPABILITY` | Agent lacks the capability required for this tool. |
| `API_ERROR`          | VouchID backend returned an error.                 |
| `API_UNREACHABLE`    | Backend unreachable after all retries.             |

```js
import { AgentIDError } from "@vouchid/mcp";

server.onerror = (err) => {
  if (err instanceof AgentIDError) {
    console.error(`[${err.code}] ${err.message}`);
  }
};
```

---

## License

MIT
