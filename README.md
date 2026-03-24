# @vouchid/mcp

VouchID identity middleware for MCP servers. Verifies every incoming tool call before your handler runs.

```bash
npm install @vouchid/mcp
```

---

## Quick Start

```js
import { AgentIDMiddleware, getAgentIdentity } from "@vouchid/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const middleware = new AgentIDMiddleware({
  apiUrl: process.env.AGENTID_API_URL,
  apiKey: process.env.AGENTID_API_KEY,
  toolCapabilities: {
    read_file: "read:filesystem",
    write_file: "write:filesystem",
  },
});

const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.setRequestHandler(
  CallToolRequestSchema,
  middleware.wrap(async (request) => {
    const agent = getAgentIdentity(request);
    console.log(`Called by: ${agent.name} (trust score: ${agent.trustScore})`);

    // your handler code here
  }),
);
```

---

## How It Works

Every incoming tool call passes through the middleware before reaching your handler:

1. Extracts the agent token from `request.params._agentid_token` or the `x-agent-token` header
2. Verifies it against the VouchID backend
3. Checks the calling agent has the capability required for that specific tool
4. Attaches the verified agent identity to the request
5. Calls your handler — or throws `AgentIDError` if any check fails

---

## API Reference

### `new AgentIDMiddleware(options)`

| Option             | Default   | Description                                                                               |
| ------------------ | --------- | ----------------------------------------------------------------------------------------- |
| `apiUrl`           | —         | **Required.** Your VouchID backend URL.                                                   |
| `apiKey`           | —         | **Required.** Your org API key. Sent on every verify call.                                |
| `toolCapabilities` | `{}`      | Map of tool name → required capability string. Unlisted tools require only a valid token. |
| `strict`           | `true`    | Reject requests with no token. Set `false` to allow unauthenticated requests through.     |
| `timeoutMs`        | `8000`    | Verify call timeout in ms.                                                                |
| `maxRetries`       | `2`       | Retry attempts on 429/5xx and network errors.                                             |
| `logger`           | `console` | Custom logger with `.warn/.error`. Pass `null` to silence.                                |

---

### `middleware.wrap(handler)`

Wraps your existing MCP request handler. Returns a new function that runs identity verification first, then calls your handler only if all checks pass.

```js
server.setRequestHandler(
  CallToolRequestSchema,
  middleware.wrap(async (request) => {
    // agent is verified before this runs
  }),
);
```

---

### `getAgentIdentity(request)`

Call this inside your wrapped handler to read the verified agent info.

```js
const agent = getAgentIdentity(request);

agent.id; // "agent_01jk2m3n4p5q6r7s"
agent.name; // "my-data-bot"
agent.org; // "acmecorp"
agent.capabilities; // ["read:filesystem"]
agent.trustLevel; // "verified"
agent.trustScore; // 0.91
```

Returns `null` only in non-strict mode when no token was provided.

---

## Error Handling

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

## Token Attachment

The calling agent attaches its token using the `@vouchid/sdk`:

```js
import { AgentID } from "@vouchid/sdk";

const agentid = new AgentID({ apiKey: process.env.AGENTID_API_KEY });
const agent = await agentid.register({
  name: "my-bot",
  capabilities: ["read:filesystem"],
});
const token = await agent.getToken();

await mcpClient.callTool({
  name: "read_file",
  arguments: {
    path: "/data/report.csv",
    _agentid_token: token,
  },
});
```

For the full client SDK, see [`@vouchid/sdk`](https://www.npmjs.com/package/@vouchid/sdk).

---

## Requirements

- Node.js 18 or later
- ESM (`"type": "module"`) or a bundler that handles ESM

---

## License

MIT
