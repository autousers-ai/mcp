/**
 * Transport-agnostic builder for the Autousers `McpServer`.
 *
 * Wave 1 of the MCP hardening plan: extract the McpServer construction +
 * `register*()` calls out of the stdio entrypoint so HTTP (Wave 2) and any
 * future transport (custom test harness, in-process Inspector, …) can reuse
 * the same wiring without forking the tool surface.
 *
 * Contract
 * --------
 *   const server = createMcpServer();
 *   await server.connect(transport);   // caller picks the transport
 *
 * The factory is **pure** w.r.t. transport: it does not read env vars, does
 * not open sockets, and does not assume any auth source. Auth is resolved
 * lazily by `lib/request-context.ts` + `client.ts` per-call, so the same
 * server instance can serve concurrent HTTP requests with distinct bearers
 * once Wave 2 lands.
 *
 * Adding a tool/resource/prompt module: do it inside the appropriate
 * `register*()` import below; the dispatcher and transports stay untouched.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import pkg from "../package.json" with { type: "json" };

import { registerTemplates } from "./tools/templates.js";
import { registerEvaluations } from "./tools/evaluations.js";
import { registerAutousers } from "./tools/autousers.js";
import { registerSettings } from "./tools/settings.js";
import { registerResources } from "./resources/index.js";
import { registerAll as registerPrompts } from "./prompts.js";

/**
 * Server-level routing instructions surfaced to the host LLM. Same string
 * for stdio and HTTP transports — there is one Autousers server, not two.
 *
 * Re-exported so the Next.js HTTP route (Wave 2) can pass it to
 * `createMcpHandler`'s `serverOptions.instructions` without duplicating
 * the prose. Update in one place.
 */
export const SERVER_INSTRUCTIONS = `Use this server to inspect, create, and manage Autousers evaluations
(UX research studies that ask AI personas + human raters to rate designs
against templates of dimensions like Usability, Visual Design,
Accessibility). Evaluations have a \`type\` (\`SSE\` for single design review,
\`SxS\` for side-by-side comparison) and a lifecycle (\`Draft\` → \`Running\`
→ \`Ended\`). Templates are reusable question sets composed of Dimensions.
Autousers are AI personas with calibrated rubrics.

Common workflows: (1) "Evaluate this URL" → create an SSE eval against
the URL, run autousers, surface the results. (2) "Show me results" → fetch
results + agreement summary + AI insights. (3) "Compare these two designs"
→ create an SxS eval. (4) "Calibrate this autouser" → start a calibration
run, watch status, freeze when stable.

Every Evaluation response includes a \`links\` object with absolute URLs
to the preview, review, edit, results, and public-share pages. Surface
these as clickable links rather than raw IDs.`;

/**
 * Register the full Autousers tool/resource/prompt surface on a caller-
 * supplied `McpServer`. Used by Wave 2's HTTP route, where `mcp-handler`
 * constructs the server itself and hands it to a callback — we don't get
 * to call `new McpServer()` ourselves there.
 *
 * Stdio uses {@link createMcpServer} which wraps this same call; both
 * transports therefore expose an identical surface, by construction.
 */
export function registerAllOn(server: McpServer): void {
  registerTemplates(server);
  registerEvaluations(server);
  registerAutousers(server);
  registerSettings(server);
  registerResources(server);
  registerPrompts(server);
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "autousers", title: "Autousers", version: pkg.version },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  registerAllOn(server);

  return server;
}
