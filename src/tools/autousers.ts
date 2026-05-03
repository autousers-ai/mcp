/**
 * Autousers tool registry — wraps `/api/v1/autousers/*` and the
 * autouser-run subroutes under `/api/v1/evaluations/[id]/`.
 *
 * Autousers are AI personas with calibrated rubrics. They render judgments
 * for an evaluation by hitting Gemini → producing ratings that show up in
 * the same `ratings` list as humans.
 *
 * Phase 2 scope: list (existing) + get/create/update/delete/duplicate,
 * run/stop, status, run-detail, run-turns, calibration start/status/freeze/
 * optimize.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { ok, fail, buildQuery, okAutouserList } from "../lib/helpers.js";
import {
  estimateRunCost,
  pickDominantStimulusType,
  type StimulusType,
} from "../lib/cost-estimate.js";
import {
  paginatedListShape,
  autouserRowShape,
  autouserRowRawShape,
  genericObjectShape,
  deleteResultShape,
} from "../lib/output-shapes.js";

// ---------------------------------------------------------------------------
// Shared sub-shapes (mirror lib/schemas/autouser.ts at the API boundary).
// We re-declare here so this package stays standalone (no app/ imports).
// ---------------------------------------------------------------------------

const BehaviorProfileSchema = z
  .object({
    patience: z.number().min(1).max(10),
    techSavviness: z.number().min(1).max(10),
    style: z.string().max(500),
    shortcuts: z.string().max(500),
    errors: z.string().max(500).optional(),
  })
  .describe("How the persona behaves while interacting with the product.");

const EnvironmentInfoSchema = z
  .object({
    device: z.string().max(200),
    network: z.string().max(200),
    input: z.string().max(200),
  })
  .describe("Synthetic device/network/input context for the persona.");

const AutouserCapabilitiesSchema = z
  .object({
    detailedDescription: z.string().max(5000).optional(),
    focusAreas: z.array(z.string().max(200)).max(50).optional(),
    behaviorProfile: BehaviorProfileSchema.optional(),
    environmentInfo: EnvironmentInfoSchema.optional(),
  })
  .describe("Persona metadata bundle (stored in `capabilities` JSON column).");

const AutouserConfigSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    model: z.string().max(200).optional(),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    keyboardOnly: z.boolean().optional(),
    screenReader: z.boolean().optional(),
    networkCondition: z.enum(["fast", "slow", "3g"]).optional(),
  })
  .describe("Runtime model config (stored in `config` JSON column).");

const AutouserStatusEnum = z.enum(["draft", "published"]);
const AutouserVisibilityEnum = z.enum(["private", "public"]);

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

const autousersListShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max items to return (1-100, default 20)."),
  teamId: z
    .string()
    .optional()
    .describe(
      "Optional: restrict to autousers owned by this team. Caller must be a Viewer+ on that team."
    ),
  includeSystem: z
    .boolean()
    .optional()
    .describe(
      "Include built-in (system) autousers in the list. Defaults to true. Set to false to see only custom team-owned autousers — useful when a caller asks 'what autousers have I created' and you do not want the canonical built-ins ('Power User', 'Casual User', etc.) to crowd the response."
    ),
  visibility: z
    .enum(["private", "public"])
    .optional()
    .describe("Optional: filter to public or private autousers only."),
  status: z
    .enum(["draft", "published"])
    .optional()
    .describe("Optional: filter by autouser status."),
};

const autousersGetShape = {
  id: z.string().min(1).describe("Autouser id."),
};

const autousersCreateShape = {
  teamId: z
    .string()
    .min(1)
    .describe("Owning team id (caller must be Editor+)."),
  name: z.string().min(1).max(200).describe("Display name for the persona."),
  description: z.string().max(2000).optional(),
  role: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Short role label, defaults to 'autouser'."),
  avatar: z.string().max(500).optional(),
  systemPrompt: z
    .string()
    .min(1)
    .max(50_000)
    .describe("System prompt fed to Gemini at run time."),
  status: AutouserStatusEnum.optional().describe("Defaults to 'published'."),
  visibility: AutouserVisibilityEnum.optional().describe(
    "Defaults to 'private'."
  ),
  capabilities: AutouserCapabilitiesSchema.optional(),
  config: AutouserConfigSchema.optional(),
};

const autousersUpdateShape = {
  id: z.string().min(1).describe("Autouser id (URL path param)."),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  role: z.string().min(1).max(200).optional(),
  avatar: z.string().max(500).optional(),
  systemPrompt: z.string().min(1).max(50_000).optional(),
  status: AutouserStatusEnum.optional(),
  visibility: AutouserVisibilityEnum.optional(),
  capabilities: AutouserCapabilitiesSchema.optional(),
  config: AutouserConfigSchema.optional(),
};

const autousersDeleteShape = {
  id: z.string().min(1).describe("Autouser id."),
};

const autousersDuplicateShape = {
  id: z.string().min(1).describe("Source autouser id to clone."),
  teamId: z
    .string()
    .min(1)
    .optional()
    .describe("Destination team id; defaults to the caller's active team."),
};

const autousersRunShape = {
  evaluationId: z
    .string()
    .min(1)
    .describe("Evaluation id to run autousers on."),
  autouserIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Ordered list of autouser ids; duplicates produce distinct runs."
    ),
  comparisonIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional: subset of comparison ids on this eval; omit to fan out to all."
    ),
  replaceRunId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional: terminal-state run id to replace in-place (used by retry)."
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "PREVIEW ONLY. When true, NO autouser runs are queued and NO Gemini cost is incurred. Returns `costEstimate` and `wouldRun` so the caller can confirm spend before committing. The caller MUST re-issue this tool WITHOUT dryRun to actually queue the runs. Do NOT report runs as 'queued', 'started', 'kicked off', or 'running' on a dryRun response — by definition nothing was queued."
    ),
};

const autousersRunStopShape = {
  evaluationId: z.string().min(1).describe("Evaluation id."),
  runIds: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      "Optional: subset of run ids to cancel; omit to cancel all active runs."
    ),
};

const autouserStatusGetShape = {
  evaluationId: z.string().min(1).describe("Evaluation id."),
};

const autouserRunGetShape = {
  evaluationId: z.string().min(1).describe("Evaluation id (URL path)."),
  runId: z.string().min(1).describe("Autouser run id (URL path)."),
};

const autouserRunTurnsListShape = {
  evaluationId: z.string().min(1).describe("Evaluation id (URL path)."),
  runId: z.string().min(1).describe("Autouser run id (URL path)."),
};

const calibrationStartShape = {
  id: z.string().min(1).describe("Autouser id."),
  evaluationId: z
    .string()
    .min(1)
    .describe("Evaluation id whose human ratings drive the kappa calc."),
  rubricId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional: specific rubric version id; defaults to active."),
  sampleSize: z.number().int().min(1).max(10_000).optional(),
  rubricOverride: z
    .string()
    .min(1)
    .max(50_000)
    .optional()
    .describe(
      "Optional: human-edited rubric text to grade against (persisted as new version)."
    ),
};

const calibrationStatusGetShape = {
  id: z.string().min(1).describe("Autouser id."),
  includeEvals: z
    .boolean()
    .optional()
    .describe(
      "When true, also return availableEvals[] for the wizard's eval picker."
    ),
};

const calibrationFreezeShape = {
  id: z.string().min(1).describe("Autouser id."),
  rubricId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional: rubric version id to freeze; defaults to current activeRubricId."
    ),
  commitMessage: z.string().max(500).optional(),
};

const calibrationOptimizeShape = {
  id: z.string().min(1).describe("Autouser id."),
  disagreements: z
    .array(
      z.object({
        ratingId: z.string().min(1),
        dimensionId: z.string().min(1).optional(),
        autouserScore: z.number().optional(),
        humanScore: z.number().optional(),
        humanReasoning: z.string().max(5000).optional(),
        exclude: z.boolean().optional(),
      })
    )
    .min(1)
    .max(500)
    .describe("Disagreement payload sent to Gemini for rubric suggestions."),
  manualRubricEdit: z.string().max(50_000).optional(),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function registerAutousers(server: McpServer): void {
  // -------------------------------------------------------------------
  // autousers_list
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_list",
    {
      title: "List autousers",
      description:
        "List autousers (synthetic personas) available to the caller. By default this returns BOTH the canonical built-in personas (e.g. 'Power User', 'Casual User' — every account sees these) AND the caller's custom team-owned autousers. Each row carries a `source` field ('built-in' or 'custom') and an `isSystem` boolean to disambiguate; built-ins are NOT duplicates of custom autousers even when names overlap. Pass `includeSystem:false` to hide built-ins. Pass `teamId` to scope to one team. Each `id` appears exactly once. Example: { includeSystem: false, limit: 50 } for 'show me only the autousers I have created'.",
      inputSchema: autousersListShape,
      outputSchema: paginatedListShape(autouserRowRawShape),
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
          `/api/v1/autousers${buildQuery(input)}`
        );
        // Render with a Source column (built-in vs custom) so power users
        // can tell stock personas from their calibrated team-owned ones.
        return okAutouserList(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_get
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_get",
    {
      title: "Get an autouser by ID",
      description:
        "Fetch a single autouser by id. Example: id from autousers_list.",
      inputSchema: autousersGetShape,
      outputSchema: autouserRowShape,
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
          `/api/v1/autousers/${encodeURIComponent(id)}`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_create
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_create",
    {
      title: "Create a custom autouser",
      description:
        "Create a team-scoped custom autouser. Example: { teamId, name: 'Skeptic', systemPrompt: 'You are...' }.",
      inputSchema: autousersCreateShape,
      outputSchema: autouserRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { data, requestId } = await api(`/api/v1/autousers`, {
          method: "POST",
          body: JSON.stringify(input),
        });
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_update
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_update",
    {
      title: "Update an autouser",
      description:
        "PATCH a custom autouser; only supplied fields change. Example: { id, systemPrompt: 'Updated...' }.",
      inputSchema: autousersUpdateShape,
      outputSchema: autouserRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, ...body }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}`,
          { method: "PATCH", body: JSON.stringify(body) }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_delete
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_delete",
    {
      title: "Delete an autouser",
      description:
        "Soft-delete a custom autouser (Admin+ on team). Example: { id: 'au_123' }.",
      inputSchema: autousersDeleteShape,
      outputSchema: deleteResultShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}`,
          { method: "DELETE" }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_duplicate
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_duplicate",
    {
      title: "Duplicate an autouser",
      description:
        "Deep-clone a visible autouser into a team. Example: { id: 'au_123', teamId: 'team_456' }.",
      inputSchema: autousersDuplicateShape,
      outputSchema: autouserRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, ...body }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}/duplicate`,
          { method: "POST", body: JSON.stringify(body) }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_run
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_run",
    {
      title: "Run autousers on an evaluation",
      description:
        "Queue autouser runs against an evaluation. SPENDS Gemini tokens (real money) — once queued, cost is incurred. Each rating costs ~$0.091 (URL stimulus, SSE) to ~$0.137 (URL stimulus, SxS); one rating = one autouser × one comparison. With dryRun:true this tool is PREVIEW ONLY — NO runs are queued, NO cost is incurred. The dryRun response carries `dryRun:true`, `queued:false`, `costEstimate`, and `wouldRun`; the caller MUST re-issue this tool WITHOUT dryRun to actually queue the runs. Do not describe a dryRun response as 'kicked off', 'queued', or 'running'. Example: { evaluationId, autouserIds: ['au_1','au_2'] }.",
      inputSchema: autousersRunShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ evaluationId, dryRun, ...body }) => {
      try {
        // We always need the eval shape (SSE/SxS) and stimulus type to
        // estimate honestly — and the comparison count when the caller
        // didn't restrict to a subset. One fetch covers all three.
        const evalRes = await api(
          `/api/v1/evaluations/${encodeURIComponent(evaluationId)}`,
          { method: "GET" }
        );
        const evalRow = evalRes.data as {
          type?: "SSE" | "SxS";
          metadata?: {
            designUrls?: { stimulusType?: StimulusType }[];
            comparisonPairs?: {
              sideAType?: StimulusType;
              sideBType?: StimulusType;
            }[];
          };
        };
        const meta = evalRow?.metadata ?? {};
        const evalType: "SSE" | "SxS" = evalRow?.type ?? "SSE";

        let comparisonCount = body.comparisonIds?.length ?? 0;
        if (!comparisonCount) {
          const designUrls = meta.designUrls?.length ?? 0;
          const comparisonPairs = meta.comparisonPairs?.length ?? 0;
          comparisonCount = Math.max(1, designUrls + comparisonPairs);
        }

        const stimulusType: StimulusType =
          evalType === "SxS"
            ? pickDominantStimulusType(
                (meta.comparisonPairs ?? []).flatMap((p) => [
                  p.sideAType,
                  p.sideBType,
                ])
              )
            : pickDominantStimulusType(
                (meta.designUrls ?? []).map((d) => d.stimulusType)
              );

        const costEstimate = estimateRunCost({
          autouserCount: body.autouserIds.length,
          comparisonCount,
          evalType,
          stimulusType,
        });

        if (dryRun) {
          return ok(
            {
              dryRun: true,
              queued: false,
              costEstimate,
              wouldRun: {
                autouserCount: body.autouserIds.length,
                comparisonCount,
                totalRuns: body.autouserIds.length * comparisonCount,
              },
            },
            null
          );
        }

        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(evaluationId)}/run-autousers`,
          { method: "POST", body: JSON.stringify(body) }
        );
        return ok({ ...(data as object), costEstimate }, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_run_stop
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_run_stop",
    {
      title: "Stop autouser runs on an evaluation",
      description:
        "Cancel pending/running runs. Example: { evaluationId } (omit runIds to cancel all).",
      inputSchema: autousersRunStopShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ evaluationId, ...body }) => {
      try {
        const hasBody = Object.keys(body).length > 0;
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(evaluationId)}/stop-autousers`,
          {
            method: "POST",
            ...(hasBody ? { body: JSON.stringify(body) } : {}),
          }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autouser_status_get
  // -------------------------------------------------------------------
  server.registerTool(
    "autouser_status_get",
    {
      title: "Get autouser run status snapshot",
      description:
        "Return run statuses + summary counts for an evaluation. Example: { evaluationId: 'ev_123' }.",
      inputSchema: autouserStatusGetShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ evaluationId }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(evaluationId)}/autouser-status`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autouser_run_get
  // -------------------------------------------------------------------
  server.registerTool(
    "autouser_run_get",
    {
      title: "Get a single autouser run",
      description:
        "Fetch one autouser run with autouser+evaluation summaries. The response includes a `viewUrl` deep-link to open the run (with session replay) directly in the Autousers app. Example: { evaluationId, runId }.",
      inputSchema: autouserRunGetShape,
      outputSchema: z
        .object({ viewUrl: z.string().url().optional() })
        .passthrough(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ evaluationId, runId }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(evaluationId)}/autouser-runs/${encodeURIComponent(runId)}`
        );

        const appBase =
          process.env.NEXT_PUBLIC_APP_URL ?? "https://app.autousers.ai";
        const viewUrl = `${appBase}/evals/${encodeURIComponent(evaluationId)}/results/autousers?inspectRun=${encodeURIComponent(runId)}`;

        const base = ok({ ...(data as object), viewUrl }, requestId);

        return {
          ...base,
          content: [
            ...base.content,
            {
              type: "text" as const,
              text: `▶ View this run with session replay: ${viewUrl}`,
            },
            {
              type: "resource_link" as const,
              uri: viewUrl,
              name: `Run #${runId}`,
              mimeType: "text/html",
              description: "Open in Autousers (sign-in required)",
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autouser_run_turns_list
  // -------------------------------------------------------------------
  server.registerTool(
    "autouser_run_turns_list",
    {
      title: "List per-turn telemetry for an autouser run",
      description:
        "Return per-turn token+cost telemetry for a run. Example: { evaluationId, runId }.",
      inputSchema: autouserRunTurnsListShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ evaluationId, runId }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(evaluationId)}/autouser-runs/${encodeURIComponent(runId)}/turns`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_calibration_start
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_calibration_start",
    {
      title: "Start autouser calibration against an evaluation",
      description:
        "Compute Cohen's Kappa vs human ratings. Example: { id: 'au_1', evaluationId: 'ev_2' }.",
      inputSchema: calibrationStartShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, ...body }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}/calibration/start`,
          { method: "POST", body: JSON.stringify(body) }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_calibration_status_get
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_calibration_status_get",
    {
      title: "Get autouser calibration status",
      description:
        "Return calibration status; pass includeEvals to also list pickable evals. Example: { id: 'au_1' }.",
      inputSchema: calibrationStatusGetShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, includeEvals }) => {
      try {
        const qs = includeEvals ? `?include=evals` : "";
        const { data, requestId } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}/calibration${qs}`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_calibration_freeze
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_calibration_freeze",
    {
      title: "Freeze an autouser rubric version",
      description:
        "Mark a rubric as frozen and set it as active. Example: { id: 'au_1', commitMessage: 'v3 final' }.",
      inputSchema: calibrationFreezeShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, ...body }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}/calibration/freeze`,
          { method: "POST", body: JSON.stringify(body) }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers_calibration_optimize
  // -------------------------------------------------------------------
  server.registerTool(
    "autousers_calibration_optimize",
    {
      title: "Optimize autouser rubric from disagreements",
      description:
        "Send disagreements to Gemini for rubric suggestions. Example: { id, disagreements: [{ ratingId, humanReasoning }] }.",
      inputSchema: calibrationOptimizeShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, ...body }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}/calibration/optimize`,
          { method: "POST", body: JSON.stringify(body) }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );
}
