/**
 * Stdio transport entry point.
 *
 * Wave 1 split of the original `index.ts`: this module owns the stdio
 * bootstrap path. The dispatcher (`index.ts`) imports and calls
 * `runStdio()` when no subcommand is supplied — preserving the existing
 * `npx -y @autousers/mcp` UX byte-for-byte.
 *
 * Auth
 * ----
 * Stdio is single-tenant by design — the host (Claude Desktop, Claude Code,
 * Cursor, …) spawns one process per connected user and wires the bearer in
 * via `env: { AUTOUSERS_API_KEY: "ak_live_..." }`. We **do not** populate
 * the request-context store here; the per-call fallback in `client.ts`
 * reads `process.env.AUTOUSERS_API_KEY` directly. Result: no behaviour
 * change for v0.7.x users.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./server-factory.js";

export async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
