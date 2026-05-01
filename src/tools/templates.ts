/**
 * Templates tool registry — wraps `/api/v1/templates/*` routes.
 *
 * Templates are reusable question sets (the "rubric" of dimensions
 * humans + autousers score against during an evaluation).
 *
 * Phase 2 scope: list/get + CRUD (create/update/delete/duplicate).
 * Versions/revert are deferred to Phase 3 — niche surface, large schema.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { ok, fail, buildQuery, okTemplateList } from "../lib/helpers.js";
import { paginationShape } from "../lib/shapes.js";
import {
  paginatedListShape,
  templateRowShape,
  templateRowRawShape,
  deleteResultShape,
} from "../lib/output-shapes.js";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

const templatesListShape = { ...paginationShape };

const templatesGetShape = {
  id: z.string().min(1).describe("Template id."),
};

// ---------------------------------------------------------------------------
// Create / update shared building blocks (mirrors lib/schemas/dimension.ts)
// ---------------------------------------------------------------------------

const TemplateTypeSchema = z.enum([
  "TEXT_SXS",
  "TEXT_SSE",
  "MEDIA_SXS",
  "MEDIA_SSE",
]);
const TemplateScaleTypeSchema = z.enum([
  "THREE_POINT",
  "FIVE_POINT",
  "SEVEN_POINT",
]);
const TemplateScoringModeSchema = z.enum(["holistic", "rubric"]);
const TemplateContextSchema = z.enum([
  "ui-ux",
  "llm-ai",
  "design-system",
  "generic",
]);

const TemplateFactorSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  description: z.string().max(2000),
});

const TemplateAnchorSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  description: z.string().max(2000),
  weight: z.number().min(0).max(10).optional(),
});

const TemplateCustomQuestionSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().min(1).max(1000),
  category: z.string().max(100).optional(),
});

const templatesCreateShape = {
  teamId: z
    .string()
    .min(1)
    .describe(
      "REQUIRED. Team id (cuid) that will own the template. Must be a team the caller is an Editor+ on. If you do not know the teamId, call teams_list first; do NOT guess or invent one — an invalid teamId returns a 400/404 and the template is NOT persisted."
    ),
  name: z.string().min(1).max(200).describe("Human-readable template name."),
  description: z.string().max(2000).optional(),

  type: TemplateTypeSchema.optional().describe(
    "Stimulus + mode (default TEXT_SXS)."
  ),
  scaleType: TemplateScaleTypeSchema.optional(),
  scaleMin: z.number().int().optional(),
  scaleMax: z.number().int().optional(),
  scaleLabels: z
    .record(z.string(), z.string())
    .optional()
    .describe("Map of score value (string) → label, e.g. {'1':'Bad'}."),

  guidelines: z.string().max(50_000).optional(),
  criteria: z.array(TemplateFactorSchema).optional(),

  icon: z.string().min(1).max(100).optional(),
  scaleQuestion: z.string().max(500).optional(),
  sseQuestion: z.string().max(500).optional(),

  factors: z.array(TemplateFactorSchema).optional(),
  sseCriteria: z.array(TemplateFactorSchema).optional(),
  sseScaleLabels: z.array(z.string().max(500)).nullable().optional(),
  sxsScaleLabels: z.array(z.string().max(500)).nullable().optional(),
  sseScaleDescriptions: z.array(z.string().max(2000)).nullable().optional(),
  sxsScaleDescriptions: z.array(z.string().max(2000)).nullable().optional(),

  contexts: z.array(TemplateContextSchema).optional(),

  scoringMode: TemplateScoringModeSchema.optional(),
  sseAnchors: z.array(TemplateAnchorSchema).optional(),
  sseAnchorLabels: z.array(z.string().max(500)).optional(),
  sseAnchorDescriptions: z.array(z.string().max(2000)).optional(),

  sxsScoringMode: TemplateScoringModeSchema.optional(),
  sxsAnchors: z.array(TemplateAnchorSchema).optional(),
  sxsAnchorLabels: z.array(z.string().max(500)).optional(),
  sxsAnchorDescriptions: z.array(z.string().max(2000)).optional(),

  isPrimary: z.boolean().optional(),
  sourceBuiltInId: z.string().max(200).optional(),

  openTextEnabled: z.boolean().optional(),
  customQuestions: z.array(TemplateCustomQuestionSchema).optional(),
};

const templatesUpdateShape = {
  id: z.string().min(1).describe("Template id."),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),

  type: TemplateTypeSchema.optional(),
  scaleType: TemplateScaleTypeSchema.optional(),
  scaleMin: z.number().int().optional(),
  scaleMax: z.number().int().optional(),
  scaleLabels: z.record(z.string(), z.string()).optional(),

  guidelines: z.string().max(50_000).optional(),
  criteria: z.array(TemplateFactorSchema).optional(),

  icon: z.string().min(1).max(100).optional(),
  scaleQuestion: z.string().max(500).optional(),
  sseQuestion: z.string().max(500).optional(),

  factors: z.array(TemplateFactorSchema).optional(),
  sseCriteria: z.array(TemplateFactorSchema).optional(),
  sseScaleLabels: z.array(z.string().max(500)).nullable().optional(),
  sxsScaleLabels: z.array(z.string().max(500)).nullable().optional(),
  sseScaleDescriptions: z.array(z.string().max(2000)).nullable().optional(),
  sxsScaleDescriptions: z.array(z.string().max(2000)).nullable().optional(),

  contexts: z.array(TemplateContextSchema).optional(),

  scoringMode: TemplateScoringModeSchema.optional(),
  sseAnchors: z.array(TemplateAnchorSchema).optional(),
  sseAnchorLabels: z.array(z.string().max(500)).optional(),
  sseAnchorDescriptions: z.array(z.string().max(2000)).optional(),

  sxsScoringMode: TemplateScoringModeSchema.optional(),
  sxsAnchors: z.array(TemplateAnchorSchema).optional(),
  sxsAnchorLabels: z.array(z.string().max(500)).optional(),
  sxsAnchorDescriptions: z.array(z.string().max(2000)).optional(),

  isPrimary: z.boolean().optional(),
  openTextEnabled: z.boolean().optional(),
  customQuestions: z.array(TemplateCustomQuestionSchema).optional(),
};

const templatesDeleteShape = {
  id: z.string().min(1).describe("Template id."),
};

const templatesDuplicateShape = {
  id: z.string().min(1).describe("Source template id to clone."),
  teamId: z
    .string()
    .optional()
    .describe(
      "Optional destination team id; defaults to caller's active team."
    ),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function registerTemplates(server: McpServer): void {
  // -------------------------------------------------------------------
  // templates_list
  // -------------------------------------------------------------------
  server.registerTool(
    "templates_list",
    {
      title: "List question templates",
      description:
        "List evaluation templates available to the caller. Example: 'show me my templates' — call with no args.",
      inputSchema: templatesListShape,
      outputSchema: paginatedListShape(templateRowRawShape),
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
          `/api/v1/templates${buildQuery(input)}`
        );
        // Render with a Source column (built-in vs custom) — built-ins
        // have null teamId / isSystem=true, so they're trivial to spot
        // in the table even though they look identical in the JSON dump.
        return okTemplateList(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // templates_get
  // -------------------------------------------------------------------
  server.registerTool(
    "templates_get",
    {
      title: "Get a template by ID",
      description:
        "Fetch a single template by id. Example: id 'tpl_abc123' returns the template's full config.",
      inputSchema: templatesGetShape,
      outputSchema: templateRowShape,
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
          `/api/v1/templates/${encodeURIComponent(id)}`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // templates_create
  // -------------------------------------------------------------------
  server.registerTool(
    "templates_create",
    {
      title: "Create a template",
      description:
        "Create and persist a team-scoped template (rubric of dimensions). REQUIRES `teamId` and `name` — call teams_list first if you do not know the teamId. The template is persisted only if this tool returns a success response (no `isError`) AND the response object contains a non-empty `id` field. Verify both before reporting success to the user. If the response carries `isError: true` OR is missing an `id`, the template was NOT created — surface the error message verbatim instead of claiming success. Example: { teamId: 'cmoi…', name: 'UX heuristics', type: 'TEXT_SSE' }.",
      inputSchema: templatesCreateShape,
      outputSchema: templateRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { data, requestId } = await api(`/api/v1/templates`, {
          method: "POST",
          body: JSON.stringify(input),
        });
        // Defensive guard: the API contract says POST returns the created
        // row with an `id`. If the upstream ever returns 2xx without an id
        // (network shim, broken proxy, mocked client), we MUST surface that
        // as an error rather than claim success — live testing showed
        // assistants reporting "template created" on an empty response.
        const created = data as { id?: unknown } | null;
        if (!created || typeof created.id !== "string" || !created.id) {
          return fail(
            new Error(
              "templates_create: upstream returned 2xx but no `id` — template was NOT persisted. Treat this as a failure and re-check inputs (teamId, name, scaleType bounds)."
            )
          );
        }
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // templates_update
  // -------------------------------------------------------------------
  server.registerTool(
    "templates_update",
    {
      title: "Update a template",
      description:
        "Patch a template by id; only included fields change. Example: { id: 'tpl_abc', name: 'Renamed' }.",
      inputSchema: templatesUpdateShape,
      outputSchema: templateRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { id, ...body } = input;
        const { data, requestId } = await api(
          `/api/v1/templates/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify(body),
          }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // templates_delete
  // -------------------------------------------------------------------
  server.registerTool(
    "templates_delete",
    {
      title: "Delete a template",
      description:
        "Hard-delete a team-scoped template. Refuses if attached to an evaluation. Example: { id: 'tpl_abc' }.",
      inputSchema: templatesDeleteShape,
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
          `/api/v1/templates/${encodeURIComponent(id)}`,
          { method: "DELETE" }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // templates_duplicate
  // -------------------------------------------------------------------
  server.registerTool(
    "templates_duplicate",
    {
      title: "Duplicate a template",
      description:
        "Deep-clone a template into a destination team. Example: { id: 'tpl_abc', teamId: 'team_xyz' }.",
      inputSchema: templatesDuplicateShape,
      outputSchema: templateRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { id, ...body } = input;
        const { data, requestId } = await api(
          `/api/v1/templates/${encodeURIComponent(id)}/duplicate`,
          {
            method: "POST",
            body: JSON.stringify(body),
          }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );
}
