/**
 * Barrel for Autousers MCP resources.
 *
 * Resources are how a host attaches Autousers data (an evaluation, a
 * persona, a template) into a conversation as first-class context, separate
 * from tool-call orchestration. See each module for the URI templates
 * registered.
 *
 * Wire this up from `src/index.ts` after the `McpServer` is constructed
 * and ensure the server's `capabilities` block advertises `resources`
 * alongside `tools` — without that, hosts won't enumerate templates.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEvaluationResources } from "./evaluations.js";
import { registerAutouserResources } from "./autousers.js";
import { registerTemplateResources } from "./templates.js";

export function registerResources(server: McpServer): void {
  registerEvaluationResources(server);
  registerAutouserResources(server);
  registerTemplateResources(server);
}
