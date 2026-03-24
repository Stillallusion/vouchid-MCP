/**
 * @agentid/mcp — AgentID Identity Middleware for MCP Servers
 *
 * Intercepts every MCP tool call and verifies the calling agent's identity
 * before the request reaches your server. Drop-in, zero-config for most setups.
 *
 * @example
 *   import { AgentIDMiddleware } from "@agentid/mcp";
 *
 *   const middleware = new AgentIDMiddleware({
 *     apiUrl: process.env.AGENTID_API_URL,
 *     apiKey: process.env.AGENTID_API_KEY,
 *     toolCapabilities: {
 *       read_file:  "read:filesystem",
 *       write_file: "write:filesystem",
 *     },
 *   });
 *
 *   server.setRequestHandler(CallToolRequestSchema, middleware.wrap(async (req) => {
 *     const agent = getAgentIdentity(req); // { id, name, capabilities, … }
 *     // … your handler
 *   }));
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum token length accepted (prevents oversized payloads / ReDoS). */
const MAX_TOKEN_LENGTH = 2048;

/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 8_000;

/** Default number of retry attempts for transient network errors. */
const DEFAULT_MAX_RETRIES = 2;

/** Base delay (ms) for exponential back-off between retries. */
const RETRY_BASE_DELAY_MS = 200;

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

// ─── AgentIDMiddleware ────────────────────────────────────────────────────────

export class AgentIDMiddleware {
  /**
   * @param {object}  options
   * @param {string}  options.apiUrl                - Base URL of your AgentID backend.
   * @param {string}  options.apiKey                - Org API key used to authenticate outbound verify calls.
   * @param {object}  [options.toolCapabilities={}] - Map of tool name → required capability string.
   * @param {boolean} [options.strict=true]         - When true, requests without a token are rejected.
   * @param {number}  [options.timeoutMs]           - Per-request timeout in ms (default 8 000).
   * @param {number}  [options.maxRetries]          - Retry attempts on transient errors (default 2).
   * @param {object}  [options.logger]              - Custom logger. Must expose `.warn()` and `.error()`.
   *                                                  Pass `null` to silence all output.
   */
  constructor(options = {}) {
    if (!options.apiUrl)
      throw new Error("[AgentIDMiddleware] apiUrl is required");
    if (!options.apiKey)
      throw new Error("[AgentIDMiddleware] apiKey is required");

    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.toolCapabilities = options.toolCapabilities ?? {};
    this.strict = options.strict !== false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.logger =
      options.logger === null
        ? _noopLogger
        : (options.logger ?? _defaultLogger);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Verify the calling agent's identity.
   *
   * Resolves with `{ allowed: true, verified: boolean, agent: AgentInfo | null }`.
   * Throws `AgentIDError` on any failure.
   *
   * @param {object} request - Raw MCP request object.
   * @returns {Promise<VerifyResult>}
   */
  async verifyRequest(request) {
    const token = _extractToken(request);

    // ── No token ────────────────────────────────────────────────────────────
    if (!token) {
      if (this.strict) {
        throw new AgentIDError(
          "MISSING_TOKEN",
          "No agent token provided. Pass _agentid_token in params or X-Agent-Token header.",
        );
      }
      return { allowed: true, verified: false, agent: null };
    }

    // ── Basic token sanity check ────────────────────────────────────────────
    if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
      throw new AgentIDError("INVALID_TOKEN", "Token format is invalid.");
    }

    // ── Remote verification ─────────────────────────────────────────────────
    const verifyResult = await this._callVerifyAPI(token);

    if (!verifyResult.valid) {
      throw new AgentIDError(
        "INVALID_TOKEN",
        verifyResult.reason || "Agent token is invalid or expired.",
      );
    }

    // ── Capability check ────────────────────────────────────────────────────
    const toolName = request?.method ?? request?.params?.name;
    const requiredCap = this.toolCapabilities[toolName];

    if (requiredCap) {
      const agentCaps = Array.isArray(verifyResult.capabilities)
        ? verifyResult.capabilities
        : [];

      if (!agentCaps.includes(requiredCap)) {
        throw new AgentIDError(
          "MISSING_CAPABILITY",
          `Tool "${toolName}" requires capability "${requiredCap}". ` +
            `Agent capabilities: [${agentCaps.join(", ")}].`,
        );
      }
    }

    return {
      allowed: true,
      verified: true,
      agent: _buildAgentInfo(verifyResult),
    };
  }

  /**
   * Wrap an MCP request handler with automatic identity verification.
   *
   * The verified `AgentInfo` is available inside your handler via
   * `getAgentIdentity(request)` — it is attached as a non-enumerable
   * property so it does not appear in JSON serialization.
   *
   * @template T
   * @param {(request: object) => Promise<T>} handler
   * @returns {(request: object) => Promise<T>}
   */
  wrap(handler) {
    if (typeof handler !== "function") {
      throw new TypeError("[AgentIDMiddleware] wrap() expects a function.");
    }

    return async (request) => {
      const identity = await this.verifyRequest(request);

      // Attach as non-enumerable so it doesn't bleed into JSON serialization.
      Object.defineProperty(request, "_identity", {
        value: identity,
        writable: false,
        enumerable: false,
        configurable: false,
      });

      return handler(request);
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * POST to /v1/agents/verify with exponential back-off retry for transient
   * network errors and 5xx / 429 responses.
   *
   * @param {string} token
   * @returns {Promise<object>}
   */
  async _callVerifyAPI(token) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await _sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(`${this.apiUrl}/v1/agents/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ token }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        // Retry on server-side / rate-limit errors
        if (RETRYABLE_STATUS_CODES.has(res.status)) {
          lastError = new AgentIDError(
            "API_ERROR",
            `AgentID API returned ${res.status}. Retrying…`,
          );
          continue;
        }

        // Any other non-2xx is a hard failure — don't retry
        if (!res.ok) {
          let reason = "";
          try {
            reason = (await res.json()).error ?? "";
          } catch {
            /* ignore */
          }
          throw new AgentIDError(
            "API_ERROR",
            `AgentID API error (${res.status})${reason ? `: ${reason}` : "."}`,
          );
        }

        return await res.json();
      } catch (err) {
        clearTimeout(timer);

        if (err instanceof AgentIDError) throw err; // hard failures propagate immediately

        const isTimeout = err.name === "AbortError";
        lastError = new AgentIDError(
          "API_UNREACHABLE",
          isTimeout
            ? `AgentID API timed out after ${this.timeoutMs}ms.`
            : `Could not reach AgentID API: ${err.message}`,
        );

        this.logger.warn(
          `[AgentIDMiddleware] Attempt ${attempt + 1} failed — ${lastError.message}`,
        );
      }
    }

    throw lastError;
  }
}

// ─── AgentIDError ─────────────────────────────────────────────────────────────

/**
 * Thrown by AgentIDMiddleware on all identity/auth failures.
 * Catch this specifically to handle AgentID errors without catching everything.
 *
 * @property {string} code - Machine-readable error code.
 */
export class AgentIDError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentIDError";
    this.code = code;

    // Preserve stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AgentIDError);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a token from an MCP request.
 * Checks `params._agentid_token` first, then `X-Agent-Token` header.
 *
 * @param {object} request
 * @returns {string|null}
 */
function _extractToken(request) {
  const fromParams = request?.params?._agentid_token;
  const fromHeader = request?.headers?.["x-agent-token"];
  return (fromParams || fromHeader) ?? null;
}

/**
 * Build a clean, serialisable AgentInfo object from the raw API response.
 * Only known fields are included — no raw API bleed-through.
 *
 * @param {object} raw
 * @returns {AgentInfo}
 */
function _buildAgentInfo(raw) {
  return {
    id: raw.agent_id ?? null,
    name: raw.agent_name ?? null,
    org: raw.owner_org ?? null,
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    trustLevel: raw.trust_level ?? "untrusted",
    trustScore: raw.trust_score ?? 0,
  };
}

/**
 * Returns the verified AgentInfo attached to the request by `wrap()`.
 * Returns `null` if verification was skipped (non-strict mode, no token).
 *
 * @param {object} request - The request object passed to your handler.
 * @returns {AgentInfo|null}
 */
export function getAgentIdentity(request) {
  return request._identity?.agent ?? null;
}

/** @param {number} ms */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const _noopLogger = { warn: () => {}, error: () => {} };
const _defaultLogger = {
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

// ─── JSDoc typedefs ───────────────────────────────────────────────────────────

/**
 * @typedef {object} AgentInfo
 * @property {string|null}   id           - Unique agent ID.
 * @property {string|null}   name         - Human-readable agent name.
 * @property {string|null}   org          - Owning organisation ID.
 * @property {string[]}      capabilities - Granted capability strings.
 * @property {string}        trustLevel   - "untrusted" | "low" | "medium" | "high".
 * @property {number}        trustScore   - Numeric trust score (0–100).
 */

/**
 * @typedef {object} VerifyResult
 * @property {true}           allowed  - Always true (throws on failure).
 * @property {boolean}        verified - Whether a token was verified.
 * @property {AgentInfo|null} agent    - Verified agent info, or null if unverified.
 */
