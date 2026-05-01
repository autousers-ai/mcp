/**
 * HTTP transport entry point — placeholder for Wave 2.
 *
 * The hardening plan splits HTTP work into a dedicated wave:
 *
 *   Wave 2 — `mcp.autousers.ai` HTTP server (API-key auth only)
 *     - StreamableHTTPServerTransport mounted at `/mcp`
 *     - Upstash Redis session store keyed by `Mcp-Session-Id`
 *     - `Authorization: Bearer ak_live_*` extracted, run through
 *       `lib/api-auth.ts`, stashed on the per-request context store
 *     - `--fluid` `maxDuration: 800` on the route
 *
 * This file exists in Wave 1 so the directory layout — and any future
 * imports of `./http-entry.js` — is settled. Throwing immediately keeps
 * an accidental Wave-2 tag from shipping a broken HTTP path.
 *
 * Implementation reference (when we get there):
 *   docs/MCP_HARDENING_PLAN.md § Wave 2 → `app/(mcp)/mcp/route.ts`,
 *   `lib/mcp/session-store.ts`, `lib/mcp/http-server.ts`.
 */

export async function runHttp(): Promise<never> {
  throw new Error(
    [
      "HTTP transport is not implemented in this build (Wave 2 is unshipped).",
      "Use stdio for now: `npx -y @autousers/mcp` with AUTOUSERS_API_KEY in env.",
      "Track Wave 2 progress in docs/MCP_HARDENING_PLAN.md.",
    ].join("\n")
  );
}
