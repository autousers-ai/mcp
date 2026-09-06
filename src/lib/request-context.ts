/**
 * Per-request context for the MCP server, carried across async work via
 * Node's `AsyncLocalStorage`.
 *
 * Why this exists
 * ---------------
 * Up through v0.7.x the server only ran in **stdio** mode: one MCP host
 * spawned one Node process and wedged a single `AUTOUSERS_API_KEY` into the
 * env. `client.ts` read that env var directly on every API call. That works
 * for stdio, but it doesn't generalise:
 *
 *   - In **HTTP** mode (`https://mcp.autousers.ai/mcp`, Wave 2) one process
 *     serves many concurrent users, each carrying their own bearer in the
 *     `Authorization` header. There is no single "the API key" — there are
 *     N of them at once.
 *   - In **OAuth** mode (Wave 3) the bearer is a server-issued JWT that
 *     resolves to a `{ userId, teamId }` tuple after verification.
 *
 * The fix: a per-request store. The HTTP transport wraps each MCP request
 * handler in `requestContext.run({ bearer }, fn)`; tool handlers and the
 * thin `client.ts` fetch wrapper read `requestContext.getStore()?.bearer`
 * inside their own async stack frames. `AsyncLocalStorage` carries the
 * value across `await` boundaries without a thread-the-needle parameter
 * dance through every register*() call site.
 *
 * Stdio mode never calls `requestContext.run()`. `getStore()` returns
 * `undefined`, and `client.ts` falls back to `process.env.AUTOUSERS_API_KEY`
 * — preserving v0.7.x behaviour byte-for-byte.
 *
 * Spec context (forward-looking)
 * ------------------------------
 * In Wave 3 the JWT verifier will populate this same store with
 * `{ bearer, scopes, userId, teamId }`. Adding fields here is non-breaking
 * — `getStore()?.bearer` continues to work for all transports.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /**
   * Bearer credential for the upstream `/api/v1` call.
   *
   * - Stdio: never set (handler chain doesn't enter `run()`); env fallback wins.
   * - HTTP + API key: the raw `ak_live_*` from the request `Authorization` header.
   * - HTTP + OAuth (Wave 3): a server-issued JWT that `lib/api-auth.ts`
   *   resolves on the backend; the MCP transport just relays it.
   */
  bearer: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  /**
   * Run `fn` with `ctx` available to every nested async frame. The HTTP
   * transport wraps each MCP request invocation; stdio never calls this.
   */
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },

  /**
   * Read the active context. Returns `undefined` outside a `run()` scope —
   * which is the normal case under stdio.
   */
  getStore(): RequestContext | undefined {
    return storage.getStore();
  },
};
