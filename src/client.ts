/**
 * Thin wrapper around fetch() for the Autousers v1 API.
 *
 * Auth is checked lazily — the previous implementation threw on module load
 * when `AUTOUSERS_API_KEY` was unset, which killed the MCP handshake before
 * the host could render a useful error. The host would simply report "MCP
 * server failed to start" with no clue that an env var was missing.
 *
 * Now we throw a typed {@link MissingApiKeyError} on first API call. Tool
 * handlers in `tools.ts` catch it and surface a friendly message via the
 * MCP `isError: true` content channel, so the host displays the fix
 * (mint a key, add it to env) inline in the chat.
 *
 * `AUTOUSERS_BASE_URL` defaults to local dev; production deployments set it
 * via the MCP host's env block.
 */

import pkg from "../package.json" with { type: "json" };
import { requestContext } from "./lib/request-context.js";

/**
 * Resolve the upstream `/api/v1` base URL.
 *
 * Resolution order:
 *
 *   1. `AUTOUSERS_BASE_URL` — explicit override. Stdio hosts (Claude Code,
 *      Cursor, …) running against a custom dev cluster set this; CI fixtures
 *      pin it to a mock server.
 *   2. `NEXT_PUBLIC_APP_URL` — the canonical app origin. Auto-set by Vercel
 *      from the project's primary domain on every deploy, so the prod
 *      Next.js process can call its own `/api/v1` without an explicit
 *      AUTOUSERS_BASE_URL. Without this fallback the in-process /mcp route
 *      defaulted to a missing host and 100% of upstream calls 5xx'd.
 *   3. `https://app.autousers.ai` — production fallback. Chosen because the
 *      99% case for `npx -y @autousers/mcp` (stdio bin) is end users
 *      pointing at production from a local terminal, not developers of
 *      this package. Local dev points at `http://localhost:3000` by
 *      setting AUTOUSERS_BASE_URL explicitly in `.env.local`.
 */
const BASE_URL =
  process.env.AUTOUSERS_BASE_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "https://app.autousers.ai";

export const baseUrl = BASE_URL;

/**
 * Resolve the bearer credential for an outbound `/api/v1` call.
 *
 * Resolution order (Wave 1 of MCP_HARDENING_PLAN.md):
 *
 *   1. Per-request context store (set by the HTTP transport in Wave 2 / OAuth
 *      verifier in Wave 3). Carries the user's bearer through `await` chains
 *      via `AsyncLocalStorage`, so concurrent HTTP requests don't fight over
 *      a single global.
 *   2. `process.env.AUTOUSERS_API_KEY` — the v0.7.x stdio path. Hosts spawn
 *      a process per user with the env wired up; nothing else exists.
 *
 * Returns `null` rather than throwing — the caller (`api()`) wraps the
 * `null` case in a typed {@link MissingApiKeyError} so tool handlers can
 * surface a friendly recovery hint instead of crashing the server.
 */
function resolveBearer(): string | null {
  return (
    requestContext.getStore()?.bearer ?? process.env.AUTOUSERS_API_KEY ?? null
  );
}

/**
 * Thrown by {@link api} when `AUTOUSERS_API_KEY` is unset at request time.
 *
 * Tool handlers should catch this specifically and return an MCP
 * `{isError: true, content: [...]}` result so the host displays the
 * recovery instructions (mint a key, paste into env) instead of failing
 * the entire server.
 *
 * TODO: Phase 1A — catch MissingApiKeyError in tool handlers in
 * `mcp/src/tools.ts` and return `{ isError: true, content: [...] }`
 * instead of letting it bubble as an uncaught exception.
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      `AUTOUSERS_API_KEY is not set. Mint one at ${BASE_URL}/settings/api-keys ` +
        `and add it to your MCP host config (env block).`
    );
    this.name = "MissingApiKeyError";
  }
}

export class AutousersApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly type?: string,
    public readonly param?: string
  ) {
    super(message);
    this.name = "AutousersApiError";
  }
}

export interface AutousersApiErrorBody {
  error?: {
    message?: string;
    type?: string;
    param?: string;
  };
}

/** Stable identifier in our outbound `User-Agent` so the API can attribute
 * traffic to the MCP server (and pin support to a specific version when
 * a customer reports an issue). The version is sourced from
 * `mcp/package.json` so we don't hand-maintain a string here. */
const USER_AGENT = `autousers-mcp/${pkg.version}`;

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<{ data: T; requestId: string | null }> {
  const apiKey = resolveBearer();
  if (!apiKey) throw new MissingApiKeyError();

  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(init.headers ?? {}),
    },
  });
  const requestId = res.headers.get("x-request-id");
  if (!res.ok) {
    let body: AutousersApiErrorBody | null = null;
    try {
      body = (await res.json()) as AutousersApiErrorBody;
    } catch {
      // body wasn't JSON — fall through with status text below
    }
    const message =
      body?.error?.message ?? `HTTP ${res.status} ${res.statusText}`;
    throw new AutousersApiError(
      message,
      res.status,
      requestId,
      body?.error?.type,
      body?.error?.param
    );
  }
  // Some 204 responses have no body — guard accordingly.
  let data: T;
  if (res.status === 204) {
    data = undefined as unknown as T;
  } else {
    data = (await res.json()) as T;
  }
  return { data, requestId };
}
