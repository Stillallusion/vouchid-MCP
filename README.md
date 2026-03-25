# @vouchid/mcp

Identity verification middleware for MCP servers. Verifies every incoming tool call before your handler runs — and optionally enforces your backend policies (rate limits, amount limits, human approval) automatically.

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
4. _(If `enforcePolicy: true`)_ Calls `POST /v1/agents/check-permission` on your backend
5. _(If the backend requires human approval)_ Polls `GET /v1/approvals/:id/status` until a human acts
6. Calls your handler — or throws `AgentIDError` if any check fails

Your handler only ever runs if everything passes. No boilerplate in your server code.

---

## Quick start

```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AgentIDMiddleware, getAgentIdentity } from "@vouchid/mcp";

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

## Policy enforcement and human approval

Set `enforcePolicy: true` to have the middleware automatically call your backend's `check-permission` endpoint before every tool call. This enforces rate limits, amount limits, and human approval rules configured in your VouchID dashboard — with zero extra code in your server.

```js
const middleware = new AgentIDMiddleware({
  apiUrl: process.env.VOUCHID_API_URL,
  apiKey: process.env.VOUCHID_API_KEY,
  toolCapabilities: {
    read_file: "read:filesystem",
    write_file: "write:filesystem",
  },
  enforcePolicy: true, // enable policy enforcement
  approvalTimeoutMs: 300_000, // wait up to 5 min for a human (default)
  approvalPollMs: 3_000, // poll every 3 seconds (default)
});

server.setRequestHandler(
  CallToolRequestSchema,
  middleware.wrap(async (request) => {
    // Only reaches here if:
    //   ✓ token is valid
    //   ✓ agent has the required capability
    //   ✓ backend policy allows the action (or a human approved it)
    const agent = getAgentIdentity(request);
    // ... your tool logic
  }),
);
```

When a tool call requires human approval, the middleware blocks and polls automatically. The calling agent stays paused until a human approves or denies the action in the VouchID dashboard, or the timeout is reached.

---

## Attaching a token (client side)

The calling agent attaches its token inside the tool arguments using `@vouchid/sdk`:

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
    _agentid_token: token, // middleware picks this up and strips it automatically
  },
});
```

For HTTP transports you can alternatively pass the token as an `x-agent-token` request header.

---

## API reference

### `new AgentIDMiddleware(options)`

| Option              | Type           | Default   | Description                                                                               |
| ------------------- | -------------- | --------- | ----------------------------------------------------------------------------------------- |
| `apiUrl`            | `string`       | —         | **Required.** Your VouchID backend URL.                                                   |
| `apiKey`            | `string`       | —         | **Required.** Your org API key.                                                           |
| `toolCapabilities`  | `object`       | `{}`      | Map of tool name → required capability string. Unlisted tools require only a valid token. |
| `strict`            | `boolean`      | `true`    | Reject requests with no token. Set `false` to allow unauthenticated requests through.     |
| `enforcePolicy`     | `boolean`      | `false`   | Call `check-permission` automatically and handle approval polling.                        |
| `approvalTimeoutMs` | `number`       | `300000`  | How long to wait for human approval before throwing `APPROVAL_TIMEOUT`.                   |
| `approvalPollMs`    | `number`       | `3000`    | How often to poll the approval status endpoint.                                           |
| `timeoutMs`         | `number`       | `8000`    | Per-request timeout for verify/policy API calls.                                          |
| `maxRetries`        | `number`       | `2`       | Retry attempts on 429 / 5xx and network errors.                                           |
| `logger`            | `object\|null` | `console` | Custom logger with `.warn()` and `.error()`. Pass `null` to silence.                      |

---

### `middleware.wrap(handler)`

Wraps your MCP request handler. Runs identity verification (and optionally policy enforcement) first, then calls your handler only if all checks pass.

```js
server.setRequestHandler(
  CallToolRequestSchema,
  middleware.wrap(async (request) => {
    // only reached if agent is verified and all policies pass
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

| Code                 | Cause                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `MISSING_TOKEN`      | No token on request and `strict: true`.                               |
| `INVALID_TOKEN`      | Token expired, revoked, or malformed.                                 |
| `MISSING_CAPABILITY` | Agent lacks the capability required for this tool.                    |
| `POLICY_DENIED`      | Backend policy denied the action (rate limit, amount exceeded, etc.). |
| `APPROVAL_DENIED`    | A human reviewer denied the approval request.                         |
| `APPROVAL_TIMEOUT`   | No human response within `approvalTimeoutMs`.                         |
| `API_ERROR`          | VouchID backend returned an error.                                    |
| `API_UNREACHABLE`    | Backend unreachable after all retries.                                |

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
