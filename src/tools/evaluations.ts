/**
 * Evaluations tool registry — wraps `/api/v1/evaluations/*` routes.
 *
 * The eval is the central object: SSE (single-stimulus) or SxS (side-by-side),
 * with a lifecycle Draft → Running → Ended. Every response carries a `links`
 * block (preview/review/edit/results/share) that we surface as markdown via
 * `okEval` / `okEvalList`.
 *
 * Phase 2 scope: list/get/create/ratings_list (existing) + update/delete,
 * results_get, agreement_get, ai_insights_get, share_create, shares_list,
 * transfer, save_draft, export_get.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../client.js";
import { ok, okEval, okEvalList, fail, buildQuery } from "../lib/helpers.js";
import {
  paginationShape,
  DesignUrlSchema,
  ComparisonPairSchema,
  AutouserSelectionSchema,
  CustomDimensionSchema,
} from "../lib/shapes.js";
import {
  paginatedListShape,
  evalRowShape,
  evalRowRawShape,
  genericObjectShape,
  deleteResultShape,
} from "../lib/output-shapes.js";
import {
  estimateRunCost,
  pickDominantStimulusType,
  type StimulusType,
} from "../lib/cost-estimate.js";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

const evaluationsListShape = {
  ...paginationShape,
  teamId: z
    .string()
    .optional()
    .describe("Optional: scope to a specific team id."),
};

const evaluationsGetShape = {
  id: z.string().min(1).describe("Evaluation id."),
};

const ratingsListShape = {
  evaluationId: z.string().min(1).describe("Evaluation id."),
};

const evaluationsCreateShape = {
  teamId: z.string().optional(),
  name: z.string().min(1).max(200).describe("Human-readable evaluation name."),
  description: z.string().max(2000).optional(),
  type: z
    .enum(["SSE", "SxS"])
    .optional()
    .describe("SSE = single-stimulus eval, SxS = side-by-side."),
  status: z
    .enum(["Draft", "Running", "Ended", "Archived"])
    .optional()
    .describe(
      "STRONGLY PREFER omitting this field — the server defaults to 'Draft' and that is the right choice for ~99% of evals. A Draft eval can be iteratively refined: add/remove dimensions, swap autousers, edit instructions, all without delete-and-recreate. Once the user is satisfied, flip status to 'Running' via evaluations_update — that promotes the eval AND auto-promotes any draft custom dimensions to active. Setting status:'Running' on creation locks the eval into the published state immediately and forces destructive recreate for any iteration. Only pass 'Running' when the user explicitly says 'publish now' / 'launch immediately' / 'start running it' with no expectation of further edits."
    ),
  shareAccess: z
    .enum(["TEAM_ONLY", "ANYONE_WITH_LINK", "PASSWORD_PROTECTED"])
    .optional(),
  sharePassword: z.string().min(1).optional(),
  shareRequireEmail: z.boolean().optional(),
  shareRequireName: z.boolean().optional(),
  shareAllowAnon: z.boolean().optional(),
  shareExpiry: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp; share link expires after this."),
  allowMultipleRatings: z.boolean().optional(),

  designUrls: z
    .array(DesignUrlSchema)
    .optional()
    .describe(
      "SSE only: list of design stimuli. Each item: {id, url?, label?, stimulusType?, fileId?, fileUrl?}."
    ),
  comparisonPairs: z
    .array(ComparisonPairSchema)
    .optional()
    .describe(
      "SxS only: list of A/B pairs. Each item: {id, currentUrl?, variantUrl?, label?, sideAType?, sideBType?, ...}."
    ),
  selectedDimensionIds: z
    .array(z.string())
    .optional()
    .describe(
      "Dimension ids the rating UI scores on. Defaults to ['overall'] when omitted or empty. Prefer built-in ids: 'overall', 'usability', 'visual-design', 'accessibility', 'content', 'helpfulness', 'accuracy', 'safety', 'design-system'. For team-specific dimensions, call templates_list first and reuse the ids it returns. Every id in customDimensions[] MUST also appear here — the API rejects mismatches."
    ),
  customDimensions: z
    .array(CustomDimensionSchema)
    .optional()
    .describe(
      "Free-form custom dimensions for this eval. Each item MUST include `id` plus a display `name` (or `label`); every id here MUST also appear in selectedDimensionIds.\n\nWHEN TO USE THIS vs templates_create:\n  - DEFAULT path: inline customDimensions here. The server auto-saves each dimension as a team-scoped template row in the same transaction as the eval. Dimensions appear on /templates as soon as the eval transitions to Running (status='Running' on create, OR a later evaluations_update that flips status to 'Running'). Until then they're saved as drafts (visible on /templates with the Drafts filter). Use this for ANY flow where the user is creating an eval — explicit, draft, ad-hoc, reusable, all of them. Do NOT call `templates_create` separately for each dimension before this — it will create duplicate template rows.\n  - Use `templates_create` ONLY when the user explicitly says they want a STANDALONE template with NO eval yet. For example: 'create a template for design-system compliance and save it' / 'add this dimension to my library, I'll use it later' with no mention of running an eval. That endpoint creates the dim row directly without an eval reference.\n\nALWAYS include 4 contributing factors per dimension (3 minimum, 5 absolute max — only exceed 4 if the user explicitly insists, decision fatigue degrades rating quality past that). For SxS evals supply `factors[]`; for SSE supply `sseCriteria[]` (or both if you don't know which the eval will use).\n\nEach factor/criterion shape: `{id, label, description}` where `id` is a stable snake-case slug like `search-relevance-noise`, `label` is 1–3 words shown as the checkbox text (e.g. 'Signal vs noise'), and `description` is one sentence explaining what the rater is looking for. Match the style of built-in dimensions: factors are the *contributors* to the rating, not synonyms of the dimension itself.\n\nExample for a custom 'Search relevance' dimension on an SxS eval:\n  factors: [\n    {id:'search-relevance-match', label:'Intent match', description:'Results align with what the user actually wants to buy.'},\n    {id:'search-relevance-noise', label:'Signal vs noise', description:'Filters out irrelevant or distracting results.'},\n    {id:'search-relevance-coverage', label:'Coverage', description:'Captures the relevant breadth without obvious gaps.'},\n    {id:'search-relevance-confidence', label:'Confidence', description:'Helps the rater feel confident the answer is correct.'},\n  ]\n\nIf you skip factors/sseCriteria, the server fills 4 generic-but-honest fallbacks derived from the dimension name + description — but those are markedly less useful than dimension-specific ones, so always supply real ones when you have enough context."
    ),
  selectedAutousers: z
    .array(AutouserSelectionSchema)
    .optional()
    .describe(
      "Autousers (AI personas) to run, plus per-autouser agentCount. The MCP NEVER picks personas for you — selection is contextual to what the user is evaluating, and generic defaults pollute the team's library and misrepresent the eval. Workflow:\n\n1. **Decide the rating method first.** If the user only wants human raters (manual UX testing, sharing with a team, etc.), set `evaluationMethod: 'manual'` and OMIT this field. No autousers will be attached and that's the right outcome — don't pretend the eval needs them.\n2. **For AI or hybrid evals**, propose 1–4 personas tailored to the eval's domain. ALWAYS call `autousers_list` first to surface the team's custom personas — domain-specific autousers (e.g. a 'Tokyo bilingual commuter' the team already calibrated) almost always beat generic built-ins. Then fall back to built-ins (`novice`, `power-user`, `mobile-user`, `design-critic`, `keyboard-navigator`, `senior-user`, `slow-network`, `screen-reader`) only as needed to round out perspectives.\n3. **Preview-then-confirm.** Use `dryRun: true` first to show the user the proposed config + cost estimate + persona picks, then re-issue without dryRun once they confirm. Don't ship to Running on the first call — leave status='Draft' so the user can iterate.\n\nValidation: when `evaluationMethod` is 'ai'/'both' and this field is empty, the response includes a `warnings: [{ code: 'ai_eval_without_autousers' }]` entry — address it on the next turn (attach personas or switch to manual). Trying to set `status: 'Running'` in that state hard-fails."
    ),
  evaluationMethod: z.enum(["manual", "ai", "both"]).optional(),
  instructions: z.string().max(8000).optional(),
  scenario: z.string().max(8000).optional(),
  skipPreQualification: z.boolean().optional(),
  hideSlider: z.boolean().optional(),
  hideOpenTextQuestions: z.boolean().optional(),
  defaultLayout: z.enum(["side", "stacked"]).optional(),
  ratingFlow: z
    .enum(["stepped", "combined"])
    .optional()
    .describe(
      "DO NOT pass this field unless the user explicitly requests 'step-by-step' or 'one question at a time' wording — the server defaults to 'combined' and that is the right choice for ~99% of evals. Combined renders the rating slider, contributing factors, and open-text inline on a single screen per dimension; stepped fragments those into 3 sub-steps (rating → factors → open-text) and is only useful when each dimension has 5+ open-text questions to amortize the extra clicks. Passing 'stepped' on a normal-sized eval makes the rater click through empty intermediate screens — actively bad UX."
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "PREVIEW ONLY. When true, NO database write occurs and NO evaluation is created — the response is a config preview plus a cost estimate. The caller MUST re-issue this tool WITHOUT dryRun to actually persist the evaluation. Do NOT report the eval as 'created', 'live', 'started', or 'queued' on a dryRun response — by definition nothing was persisted."
    ),
};

// ---------------------------------------------------------------------------
// Phase 2 input shapes — mirror the route-side zod schemas verbatim.
// ---------------------------------------------------------------------------

/**
 * Mirrors `UpdateEvaluationSchema` in `lib/schemas/evaluation.ts`. All fields
 * are optional — a missing field means "don't change it", not "reset to
 * default". Browser/proxy/model fields accept `null` to clear the override
 * and re-inherit the user default.
 */
const evaluationsUpdateShape = {
  id: z.string().min(1).describe("Evaluation id (path param)."),
  teamId: z
    .string()
    .optional()
    .describe("Admin+ only — move the eval to a different team."),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  type: z.enum(["SSE", "SxS"]).optional().describe("Admin+ only."),
  status: z.enum(["Draft", "Running", "Ended", "Archived"]).optional(),
  shareAccess: z
    .enum(["TEAM_ONLY", "ANYONE_WITH_LINK", "PASSWORD_PROTECTED"])
    .optional()
    .describe("Admin+ only."),
  sharePassword: z
    .string()
    .min(1)
    .optional()
    .describe("Admin+ only. Min 4 chars when shareAccess=PASSWORD_PROTECTED."),
  shareRequireEmail: z.boolean().optional(),
  shareRequireName: z.boolean().optional(),
  shareAllowAnon: z.boolean().optional(),
  shareExpiry: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp; pass empty string or omit to clear."),
  allowMultipleRatings: z.boolean().optional(),
  browserEngine: z
    .enum(["chrome", "camoufox"])
    .nullable()
    .optional()
    .describe("null clears the override → inherits user default."),
  useProxy: z
    .boolean()
    .nullable()
    .optional()
    .describe("null clears the override → inherits user default."),
  proxyRegion: z
    .string()
    .nullable()
    .optional()
    .describe("Proxy region id; null clears the override."),
  modelId: z
    .string()
    .nullable()
    .optional()
    .describe("Gemini model id; null clears the override."),

  // ---------------------------------------------------------------------
  // Wizard fields — internally routed to PATCH /api/v1/evaluations/[id]/draft
  //
  // These fields live on EvaluationConfig.preQualification, not on the
  // Evaluation row itself, so the upstream PATCH route doesn't accept
  // them. Rather than force assistants to learn a two-tool distinction
  // ("scalar fields go via _update, wizard fields go via _save_draft"),
  // we accept them here and the handler partitions them server-side. An
  // assistant calling evaluations_update with a mix of scalar + wizard
  // fields gets a single coherent response.
  // ---------------------------------------------------------------------
  selectedAutousers: z
    .array(AutouserSelectionSchema)
    .optional()
    .describe(
      "Autousers to attach (replaces the existing list). Pass an array of {autouserId, agentCount}. Internally routed to /draft. To remove all autousers, pass []."
    ),
  selectedDimensionIds: z
    .array(z.string())
    .optional()
    .describe(
      "Dimension ids the rating UI scores on (replaces the existing list). Internally routed to /draft."
    ),
  customDimensions: z
    .array(CustomDimensionSchema)
    .optional()
    .describe(
      "Custom dimensions for this eval (replaces the existing list). Each id MUST also appear in selectedDimensionIds. Internally routed to /draft."
    ),
  designUrls: z
    .array(DesignUrlSchema)
    .optional()
    .describe(
      "SSE only — replaces the design list. Internally routed to /draft."
    ),
  comparisonPairs: z
    .array(ComparisonPairSchema)
    .optional()
    .describe(
      "SxS only — replaces the A/B pairs. Internally routed to /draft."
    ),
  evaluationMethod: z
    .enum(["manual", "ai", "both"])
    .optional()
    .describe("Internally routed to /draft."),
  instructions: z
    .string()
    .max(8000)
    .optional()
    .describe("Internally routed to /draft."),
  scenario: z
    .string()
    .max(8000)
    .optional()
    .describe("Internally routed to /draft."),
  skipPreQualification: z
    .boolean()
    .optional()
    .describe("Internally routed to /draft."),
  hideSlider: z.boolean().optional().describe("Internally routed to /draft."),
  hideOpenTextQuestions: z
    .boolean()
    .optional()
    .describe("Internally routed to /draft."),
  defaultLayout: z
    .enum(["side", "stacked"])
    .optional()
    .describe("Internally routed to /draft."),
  ratingFlow: z
    .enum(["stepped", "combined"])
    .optional()
    .describe("Internally routed to /draft."),
};

// Fields that live on EvaluationConfig.preQualification and must be
// routed to PATCH /api/v1/evaluations/[id]/draft instead of the main
// evaluation PATCH. Keep this list in sync with `evaluationsUpdateShape`
// — adding a new wizard field above and forgetting to list it here will
// silently route it to the wrong endpoint and the upstream will reject.
const WIZARD_FIELD_KEYS = [
  "selectedAutousers",
  "selectedDimensionIds",
  "customDimensions",
  "designUrls",
  "comparisonPairs",
  "evaluationMethod",
  "instructions",
  "scenario",
  "skipPreQualification",
  "hideSlider",
  "hideOpenTextQuestions",
  "defaultLayout",
  "ratingFlow",
] as const;

/**
 * Parse the (possibly stringified) `EvaluationConfig.preQualification`
 * blob. The GET route returns it as a parsed object on the `metadata`
 * key; the PATCH responses return the raw `config` row where it's still
 * a JSON string. This helper handles both.
 */
function parsePreQualMeta(raw: unknown): {
  evaluationMethod?: string;
  selectedAutousers?: unknown;
} {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * The `draft` route (PATCH) accepts a free-form merge into the wizard's
 * `preQualification` blob — every field below is optional and is shallow-
 * merged on top of the existing metadata. Touching `designUrls` /
 * `comparisonPairs` regenerates the Comparison rows.
 */
const evaluationsSaveDraftShape = {
  id: z.string().min(1).describe("Evaluation id (path param)."),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  type: z.string().optional(),
  designUrls: z
    .array(DesignUrlSchema)
    .optional()
    .describe("SSE only — replaces the draft's design list."),
  comparisonPairs: z
    .array(ComparisonPairSchema)
    .optional()
    .describe("SxS only — replaces the draft's A/B pairs."),
  selectedDimensionIds: z.array(z.string()).optional(),
  customDimensions: z.array(CustomDimensionSchema).optional(),
  selectedAutousers: z.array(AutouserSelectionSchema).optional(),
  evaluationMethod: z.enum(["manual", "ai", "both"]).optional(),
  instructions: z.string().optional(),
  scenario: z.string().optional(),
  templateId: z.string().optional(),
  customQuestions: z.unknown().optional(),
  selectedPersonas: z.unknown().optional(),
  agentCount: z.number().int().min(0).optional(),
  sideAUrl: z.string().optional(),
  sideBUrl: z.string().optional(),
  skipPreQualification: z.boolean().optional(),
  hideSlider: z.boolean().optional(),
  hideOpenTextQuestions: z.boolean().optional(),
  defaultLayout: z.enum(["side", "stacked"]).optional(),
  ratingFlow: z.enum(["stepped", "combined"]).optional(),
};

const evaluationsExportShape = {
  id: z.string().min(1).describe("Evaluation id."),
  format: z
    .enum(["json", "csv"])
    .optional()
    .describe("Defaults to 'json'. CSV emits one row per rating × dimension."),
};

const evaluationsShareCreateShape = {
  id: z.string().min(1).describe("Evaluation id (path param)."),
  userId: z
    .string()
    .min(1)
    .describe("Target user's CUID — must be an existing User."),
  permission: z
    .enum(["VIEWER", "EDITOR", "OWNER"])
    .describe("Role to grant on this evaluation."),
};

/**
 * Route schema is `{ userId }` — the spec mentioned `targetTeamId`, but the
 * transfer is per-user (promotes target to OWNER share, demotes caller to
 * EDITOR). It does not move the eval between teams.
 */
const evaluationsTransferShape = {
  id: z.string().min(1).describe("Evaluation id (path param)."),
  userId: z
    .string()
    .min(1)
    .describe("User id to promote to OWNER. Must not equal the caller."),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function registerEvaluations(server: McpServer): void {
  // -------------------------------------------------------------------
  // evaluations_list
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_list",
    {
      title: "List evaluations",
      description:
        "List evaluations the caller can see. Example: 'show me my running evals' — call with no args.",
      inputSchema: evaluationsListShape,
      outputSchema: paginatedListShape(evalRowRawShape),
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
          `/api/v1/evaluations${buildQuery(input)}`
        );
        return okEvalList(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_get
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_get",
    {
      title: "Get an evaluation by ID",
      description:
        "Fetch a single evaluation by id (includes config, comparisons, autouser selections). Example: id from evaluations_list.",
      inputSchema: evaluationsGetShape,
      outputSchema: evalRowShape,
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
          `/api/v1/evaluations/${encodeURIComponent(id)}`
        );
        return okEval(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_create
  //
  // Behaviour: when called WITHOUT dryRun, persists the eval via
  // POST /api/v1/evaluations, then — when status='Running' and
  // selectedAutousers carries at least one entry and evaluationMethod
  // is not 'manual' — automatically fans those out to
  // POST /api/v1/evaluations/[id]/run-autousers. The upstream create
  // route only stores selectedAutousers in the config blob; nothing
  // else creates AutouserRun rows. We do that fan-out here so the MCP
  // contract matches the documented "set status to Running and pick
  // autousers" intent.
  //
  // dryRun:true is PREVIEW ONLY — no DB write, no eval row, no runs.
  // We compute the cost estimate from the input alone and return a
  // synthetic preview object so the caller can confirm intent before
  // re-issuing without dryRun. Live testing surfaced confused
  // assistants reporting "your eval is live" on dryRun responses
  // because the previous implementation persisted the row; the v0.7.x
  // semantics flip that so dryRun is unambiguously side-effect-free.
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_create",
    {
      title: "Create an evaluation",
      description:
        "Create a new evaluation (SSE or SxS) and persist it to the database.\n\nDEFAULT POLICY — preview, then confirm:\n  1. First call with `dryRun: true` to show the user the proposed config + cost estimate + the personas you'd suggest. Do NOT describe a dryRun response as 'created', 'live', or 'started' — by definition nothing was persisted.\n  2. Wait for the user to confirm or adjust (dimensions, autousers, instructions, scenario).\n  3. Re-issue WITHOUT dryRun, almost always with status='Draft'. Drafts are iteratively editable via evaluations_update.\n  4. Only set status='Running' when the user explicitly says to launch and the eval is fully configured (including selectedAutousers if evaluationMethod is 'ai'/'both').\n\nWhen status='Running' AND selectedAutousers is non-empty AND evaluationMethod is 'ai'/'both', this ALSO queues autouser runs and returns a cost estimate.\n\nAutousers: NEVER pick personas yourself; they're contextual. See `selectedAutousers` field docs for the right workflow (autousers_list first, custom personas before built-ins, propose then confirm). If the user wants only human raters, use `evaluationMethod: 'manual'` and omit selectedAutousers — that's a fully valid eval, not a misconfiguration.\n\nDimensions: selectedDimensionIds defaults to ['overall'] when omitted/empty; prefer built-in ids ('overall', 'usability', 'visual-design', 'accessibility', 'content', 'helpfulness', 'accuracy', 'safety', 'design-system') or ids from templates_list. Any id in customDimensions[] MUST also appear in selectedDimensionIds, and each customDimension MUST have an `id` and a `name` (or `label`).\n\nExample (preview): { dryRun: true, name: 'Homepage redesign', type: 'SxS', comparisonPairs: [{id:'p1', currentUrl:'https://a.com', variantUrl:'https://b.com'}], selectedDimensionIds: ['overall', 'usability'], evaluationMethod: 'ai', selectedAutousers: [{autouserId:'novice', agentCount:1}] }.",
      inputSchema: evaluationsCreateShape,
      // Heterogeneous response: dryRun returns a preview envelope (no `id`);
      // live returns evalRowShape, optionally extended with autousersQueued/
      // runs/costEstimate/warnings. A strict evalRowShape rejects the dryRun
      // branch with -32602 at the SDK layer.
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const { dryRun, ...createBody } = input;

        // ----------------------------------------------------------------
        // Coherence checks (don't mutate; warn).
        //
        // The MCP no longer auto-fills default autousers. Persona choice
        // is contextual — generic defaults pollute team libraries and
        // misrepresent the eval to the user. Instead we surface
        // structured warnings in the response so the assistant can fix
        // the payload in the next turn (or ask the user). Two flavours:
        //
        //   - `ai_eval_without_autousers` — evaluationMethod is
        //     'ai'/'both' but selectedAutousers is empty. The eval can
        //     be created (Draft is fine) but it cannot run until the
        //     assistant adds personas via evaluations_update.
        //   - `running_without_autousers` — caller asked status='Running'
        //     while the eval is unrunnable for the same reason. We hard
        //     fail here so the assistant can't tell the user "I started
        //     the eval" when no runs will ever queue.
        // ----------------------------------------------------------------
        const wantsAi =
          createBody.evaluationMethod === "ai" ||
          createBody.evaluationMethod === "both";
        const hasAutousers = (createBody.selectedAutousers ?? []).length > 0;
        const warnings: { code: string; message: string }[] = [];
        if (wantsAi && !hasAutousers) {
          warnings.push({
            code: "ai_eval_without_autousers",
            message:
              "evaluationMethod is 'ai' or 'both' but selectedAutousers is empty. The eval was saved as a Draft but cannot run until you attach personas.\n\nNext step: call evaluations_update with { id, selectedAutousers: [...] } to attach personas. Suggest 1–4 autousers based on the eval's domain — call autousers_list first to surface the team's custom personas (those almost always beat generic built-ins), then fall back to built-ins (novice, power-user, mobile-user, design-critic, keyboard-navigator, senior-user, slow-network, screen-reader) only as needed. Confirm the picks with the user before flipping status to 'Running'.\n\nTo attach AND publish in a single call: evaluations_update with { id, selectedAutousers: [...], status: 'Running' }. Do NOT use evaluations_save_draft for this — evaluations_update handles wizard fields including selectedAutousers via internal routing.",
          });
        }
        if (createBody.status === "Running" && wantsAi && !hasAutousers) {
          throw new Error(
            "evaluations_create: status='Running' with evaluationMethod='ai'/'both' requires selectedAutousers. Either (a) keep status='Draft' and let the user confirm autousers, or (b) attach selectedAutousers in this call. The eval would otherwise be 'Running' with zero queued runs — which is misleading to the user."
          );
        }

        // Compute the cost estimate from the input alone — used for both
        // the dryRun preview (no DB write) and the live response.
        const expandedAutouserIds: string[] = [];
        for (const sel of createBody.selectedAutousers ?? []) {
          for (let i = 0; i < sel.agentCount; i++) {
            expandedAutouserIds.push(sel.autouserId);
          }
        }

        const comparisonCount =
          createBody.type === "SxS"
            ? (createBody.comparisonPairs?.length ?? 0)
            : (createBody.designUrls?.length ?? 0);

        const stimulusType: StimulusType =
          createBody.type === "SxS"
            ? pickDominantStimulusType(
                (createBody.comparisonPairs ?? []).flatMap((p) => [
                  p.sideAType,
                  p.sideBType,
                ])
              )
            : pickDominantStimulusType(
                (createBody.designUrls ?? []).map((d) => d.stimulusType)
              );

        const wouldFanOutRuns =
          createBody.status === "Running" &&
          expandedAutouserIds.length > 0 &&
          createBody.evaluationMethod !== "manual";

        const costEstimate = wouldFanOutRuns
          ? estimateRunCost({
              autouserCount: expandedAutouserIds.length,
              comparisonCount: Math.max(1, comparisonCount),
              evalType: createBody.type ?? "SSE",
              stimulusType,
            })
          : null;

        // -----------------------------------------------------------------
        // dryRun branch — NO upstream call, NO DB write. Return a synthetic
        // preview so the caller can confirm cost + shape before committing.
        // -----------------------------------------------------------------
        if (dryRun) {
          return ok(
            {
              dryRun: true,
              persisted: false,
              autousersQueued: false,
              wouldCreate: createBody,
              wouldRun: wouldFanOutRuns
                ? {
                    autouserCount: expandedAutouserIds.length,
                    comparisonCount: Math.max(1, comparisonCount),
                    totalRuns:
                      expandedAutouserIds.length * Math.max(1, comparisonCount),
                  }
                : null,
              costEstimate,
              warnings: warnings.length ? warnings : undefined,
              note: "PREVIEW ONLY — this evaluation has NOT been created. Show the user the proposed config + cost estimate and confirm before re-issuing evaluations_create WITHOUT dryRun:true. If `warnings` is present, address each item (e.g. attach selectedAutousers) before persisting.",
            },
            null
          );
        }

        // -----------------------------------------------------------------
        // Live branch — persist the eval, then optionally fan out runs.
        // -----------------------------------------------------------------
        const { data: createdEval, requestId } = await api(
          `/api/v1/evaluations`,
          {
            method: "POST",
            body: JSON.stringify(createBody),
          }
        );

        if (!wouldFanOutRuns) {
          return okEval(
            warnings.length
              ? { ...(createdEval as object), warnings }
              : createdEval,
            requestId
          );
        }

        const evalId = (createdEval as { id?: string }).id;
        if (!evalId) {
          // Should never happen — the create route always returns an id —
          // but fail loud rather than silently skipping the fan-out.
          throw new Error(
            "evaluations_create: upstream returned no id; cannot fan out autouser runs"
          );
        }

        const { data: runData } = await api(
          `/api/v1/evaluations/${encodeURIComponent(evalId)}/run-autousers`,
          {
            method: "POST",
            body: JSON.stringify({ autouserIds: expandedAutouserIds }),
          }
        );

        return okEval(
          {
            ...(createdEval as object),
            autousersQueued: true,
            runs: (runData as { runs?: unknown[] })?.runs ?? [],
            costEstimate,
            ...(warnings.length && { warnings }),
          },
          requestId
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_ratings_list
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_ratings_list",
    {
      title: "List ratings for an evaluation",
      description:
        "List ratings (human + autouser) for one evaluation. Example: evaluationId from evaluations_list.",
      inputSchema: ratingsListShape,
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
          `/api/v1/evaluations/${encodeURIComponent(evaluationId)}/ratings`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_update — PATCH /api/v1/evaluations/[id]
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_update",
    {
      title: "Update an evaluation",
      description:
        "Patch any subset of an eval's fields. This is the single tool to use for editing an existing eval — pass scalar fields (name/description/status/share*), wizard fields (selectedAutousers, selectedDimensionIds, customDimensions, designUrls, comparisonPairs, instructions, scenario, evaluationMethod, defaultLayout, ratingFlow, etc.), or a mix. The MCP partitions the input internally and calls both PATCH /evaluations/[id] and PATCH /evaluations/[id]/draft as needed; you do NOT need to call evaluations_save_draft separately.\n\nCommon pattern after evaluations_create returns a Draft with `warnings: [{ code: 'ai_eval_without_autousers' }]`: re-issue this tool with the chosen autousers, e.g. { id, selectedAutousers: [{autouserId:'novice', agentCount:1}, ...] }. To then publish: { id, status: 'Running' }. To do both at once: { id, selectedAutousers: [...], status: 'Running' }.\n\nAuth: Editor+ for most fields; Admin+ for type/teamId/shareAccess/sharePassword.",
      inputSchema: evaluationsUpdateShape,
      outputSchema: evalRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const { id, ...body } = input;

        // Partition the input: wizard fields go to /draft (which writes to
        // EvaluationConfig.preQualification), everything else goes to the
        // main PATCH (which writes to the Evaluation row). We have to
        // route them separately because the upstream routes have
        // different schemas — sending wizard fields to the main PATCH
        // makes it 400 with "unrecognized_keys".
        const wizardBody: Record<string, unknown> = {};
        const scalarBody: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined) continue;
          if ((WIZARD_FIELD_KEYS as readonly string[]).includes(k)) {
            wizardBody[k] = v;
          } else {
            scalarBody[k] = v;
          }
        }

        const hasWizard = Object.keys(wizardBody).length > 0;
        const hasScalar = Object.keys(scalarBody).length > 0;

        // Order matters when both are present: persist wizard fields
        // first so a follow-on `status: 'Running'` flip sees the latest
        // selectedAutousers/selectedDimensionIds. Otherwise the publish
        // could fan out runs against a stale autouser list.
        let lastData: unknown = null;
        let lastRequestId: string | null = null;

        if (hasWizard) {
          const { data, requestId } = await api(
            `/api/v1/evaluations/${encodeURIComponent(id)}/draft`,
            { method: "PATCH", body: JSON.stringify(wizardBody) }
          );
          lastData = data;
          lastRequestId = requestId;
        }

        if (hasScalar) {
          const { data, requestId } = await api(
            `/api/v1/evaluations/${encodeURIComponent(id)}`,
            { method: "PATCH", body: JSON.stringify(scalarBody) }
          );
          lastData = data;
          lastRequestId = requestId;
        }

        if (!hasWizard && !hasScalar) {
          // Caller passed only `id` — refresh the eval as a no-op so the
          // assistant gets a current snapshot back.
          const { data, requestId } = await api(
            `/api/v1/evaluations/${encodeURIComponent(id)}`
          );
          lastData = data;
          lastRequestId = requestId;
        }

        // ---------------------------------------------------------------
        // Auto-fan-out runs when transitioning to Running.
        //
        // The upstream PATCH route only flips the status — it does NOT
        // queue autouser runs. Without this branch, an assistant calling
        // evaluations_update({ id, status: 'Running' }) on an eval with
        // attached personas leaves the eval "Running" with zero queued
        // runs — exactly the misleading state we hard-fail in
        // evaluations_create. Mirror the create-time fan-out here so the
        // unified update tool produces the same coherent end state.
        // ---------------------------------------------------------------
        const wantsRunningTransition = scalarBody.status === "Running";
        if (wantsRunningTransition && lastData) {
          const evalRow = lastData as {
            id?: string;
            config?: { preQualification?: unknown } | null;
          };
          const meta = parsePreQualMeta(evalRow.config?.preQualification);
          const method = meta.evaluationMethod;
          const selections = Array.isArray(meta.selectedAutousers)
            ? (meta.selectedAutousers as Array<{
                autouserId: string;
                agentCount: number;
              }>)
            : [];
          const expanded: string[] = [];
          for (const sel of selections) {
            for (let i = 0; i < (sel.agentCount ?? 0); i++) {
              expanded.push(sel.autouserId);
            }
          }
          if (
            (method === "ai" || method === "both") &&
            expanded.length > 0 &&
            evalRow.id
          ) {
            const { data: runData } = await api(
              `/api/v1/evaluations/${encodeURIComponent(evalRow.id)}/run-autousers`,
              {
                method: "POST",
                body: JSON.stringify({ autouserIds: expanded }),
              }
            );
            return okEval(
              {
                ...(lastData as object),
                autousersQueued: true,
                runs: (runData as { runs?: unknown[] })?.runs ?? [],
              },
              lastRequestId
            );
          }
        }

        return okEval(lastData, lastRequestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_delete — DELETE /api/v1/evaluations/[id]
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_delete",
    {
      title: "Delete an evaluation",
      description:
        "Hard-delete an evaluation and its dependent rows (cascades to comparisons/ratings). Admin+ required. Example: { id: 'eval_…' }.",
      inputSchema: evaluationsGetShape,
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
          `/api/v1/evaluations/${encodeURIComponent(id)}`,
          { method: "DELETE" }
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_save_draft — PATCH /api/v1/evaluations/[id]/draft
  //
  // Note: the spec called this POST but the live route is PATCH (it shallow-
  // merges into the existing wizard metadata blob). We use PATCH to match.
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_save_draft",
    {
      title: "Save evaluation draft (wizard progress)",
      description:
        "Merge wizard fields into a Draft/Ended eval's metadata (regenerates Comparison rows when designUrls/comparisonPairs change). Example: { id, designUrls: [...] }.",
      inputSchema: evaluationsSaveDraftShape,
      outputSchema: evalRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { id, ...body } = input;
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}/draft`,
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
  // evaluations_export_get — GET /api/v1/evaluations/[id]/export
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_export_get",
    {
      title: "Export evaluation results",
      description:
        "Download an eval's results as JSON (default) or CSV (one row per rating × dimension). Example: { id, format: 'csv' }.",
      inputSchema: evaluationsExportShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, ...rest }) => {
      try {
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}/export${buildQuery(
            rest
          )}`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_results_get — GET /api/v1/evaluations/[id]/results
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_results_get",
    {
      title: "Get evaluation results",
      description:
        "Aggregate stats + per-rater summaries + pairwise Kappa agreement (when 2 raters overlap). Example: { id }.",
      inputSchema: evaluationsGetShape,
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
          `/api/v1/evaluations/${encodeURIComponent(id)}/results`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_agreement_get — GET /api/v1/evaluations/[id]/agreement
  //
  // Note: there are two sibling routes, /agreement and /agreement-insights.
  // We use /agreement here — it returns the structured cohort numbers
  // (overall κ, per-pair κ, agreementPercent, interpretation, sample size,
  // insufficient flag). /agreement-insights is the AI narrative on top of
  // those numbers and is exposed separately as evaluations_ai_insights_get
  // is for the holistic results summary.
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_agreement_get",
    {
      title: "Get inter-rater agreement (Cohen's Kappa)",
      description:
        "Pairwise Cohen's Kappa across raters with cache-version-aware results. Returns null/insufficient when <2 raters overlap. Example: { id }.",
      inputSchema: evaluationsGetShape,
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
          `/api/v1/evaluations/${encodeURIComponent(id)}/agreement`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_ai_insights_get — GET /api/v1/evaluations/[id]/ai-insights
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_ai_insights_get",
    {
      title: "Get AI-generated evaluation insights",
      description:
        "Gemini-authored summary + key findings + recommendations from aggregate scores and per-dimension averages. 503 when Gemini is unconfigured. Example: { id }.",
      inputSchema: evaluationsGetShape,
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
          `/api/v1/evaluations/${encodeURIComponent(id)}/ai-insights`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_share_create — POST /api/v1/evaluations/[id]/shares
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_share_create",
    {
      title: "Grant a per-user share on an evaluation",
      description:
        "Upsert an EvaluationShare granting a user VIEWER/EDITOR/OWNER access. Admin+ required. Example: { id, userId, permission: 'VIEWER' }.",
      inputSchema: evaluationsShareCreateShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const { id, ...body } = input;
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}/shares`,
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

  // -------------------------------------------------------------------
  // evaluations_shares_list — GET /api/v1/evaluations/[id]/shares
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_shares_list",
    {
      title: "List per-user shares on an evaluation",
      description:
        "List explicit EvaluationShare rows (VIEWER/EDITOR/OWNER) for one eval. Admin+ required. Example: { id }.",
      inputSchema: evaluationsGetShape,
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
          `/api/v1/evaluations/${encodeURIComponent(id)}/shares`
        );
        return ok(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // -------------------------------------------------------------------
  // evaluations_transfer — POST /api/v1/evaluations/[id]/transfer
  //
  // Note: the route schema is `{ userId }` (not the spec's `targetTeamId`).
  // Transfer promotes target user to OWNER share + demotes caller to EDITOR;
  // it does not move the eval between teams.
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_transfer",
    {
      title: "Transfer evaluation ownership to another user",
      description:
        "Promote a user to OWNER share on this eval and demote the caller to EDITOR. Admin+ required. Example: { id, userId }.",
      inputSchema: evaluationsTransferShape,
      outputSchema: evalRowShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const { id, ...body } = input;
        const { data, requestId } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}/transfer`,
          {
            method: "POST",
            body: JSON.stringify(body),
          }
        );
        return okEval(data, requestId);
      } catch (err) {
        return fail(err);
      }
    }
  );
}
