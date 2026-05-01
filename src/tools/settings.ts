/**
 * Settings tool registry — wraps `/api/v1/teams/*` and `/api/v1/usage`.
 *
 * Tools here let an MCP host introspect the caller's account context:
 * which teams they belong to, who's on each team, and current usage
 * counters. Useful for "switch context to my work team" and "how many
 * autouser runs have I burned this month" prompts.
 *
 * Phase 2 scope: read-only. No team mutation, no member invites — those
 * are sensitive enough to keep web-app-gated. There is also no `me`
 * tool because there is no /api/v1/me route today (intentionally
 * deferred — would be an API-side change), and api-keys (the surface
 * that mints MCP credentials in the first place) is intentionally NOT
 * exposed via MCP to avoid the obvious circular dependency.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { ok, fail, buildQuery } from "../lib/helpers.js";
import {
  paginatedListShape,
  genericObjectShape,
} from "../lib/output-shapes.js";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

const teamsListShape = {};

const teamsGetShape = {
  id: z.string().min(1).describe("Team id."),
};

const teamMembersListShape = {
  teamId: z.string().min(1).describe("Team id."),
};

const usageGetShape = {
  range: z
    .enum(["7d", "30d", "90d"])
    .optional()
    .describe("Time window for the usage rollup. Defaults to '30d'."),
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSettings(server: McpServer): void {
  // -------------------------------------------------------------------
  // teams_list
  // -------------------------------------------------------------------
  server.registerTool(
    "teams_list",
    {
      title: "List teams",
      description:
        "List every team the caller belongs to (id, name, role, member count). Example: {} — no params.",
      inputSchema: teamsListShape,
      outputSchema: paginatedListShape({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const { data, requestId } = await api(`/api/v1/teams`);
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // teams_get
  // -------------------------------------------------------------------
  server.registerTool(
    "teams_get",
    {
      title: "Get a team",
      description:
        "Fetch one team's detail including the full member list. Example: { id: 'team_abc123' }.",
      inputSchema: teamsGetShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/teams/${encodeURIComponent(id)}`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // team_members_list
  // -------------------------------------------------------------------
  server.registerTool(
    "team_members_list",
    {
      title: "List team members",
      description:
        "List members of a team (id, role, user profile). Example: { teamId: 'team_abc123' }.",
      inputSchema: teamMembersListShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ teamId }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/teams/${encodeURIComponent(teamId)}/members`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // usage_get
  // -------------------------------------------------------------------
  server.registerTool(
    "usage_get",
    {
      title: "Get usage rollup",
      description:
        "Returns the team's prepaid free-run pool AND incurred Gemini-token spend over the requested window. The response distinguishes two separate concepts that must NOT be conflated: (1) `freeRunsRemaining` / `freeRunsTotal` — a fixed pool of prepaid autouser runs that covers Gemini token costs for ratings; once exhausted, every additional rating bills Gemini tokens to the team. (2) `costUsd` / per-run cost fields — the actual Gemini-token spend already incurred. A response showing $0 spent does NOT mean usage is free forever — it means either (a) no runs have happened in the window, or (b) the runs that did happen consumed the prepaid free pool. Once free runs are exhausted, each rating costs ~$0.091 (URL stimulus, SSE) to ~$0.137 (URL stimulus, SxS) based on stimulus type and eval type; one rating = one autouser × one comparison. When summarising this for a user, ALWAYS state both `freeRunsRemaining` and `costUsd` separately and explain that future runs will bill at the per-rating rate once the free pool is exhausted. Example: { range: '30d' }.",
      inputSchema: usageGetShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/usage${buildQuery(input)}`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );
}
