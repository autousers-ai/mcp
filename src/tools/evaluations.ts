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
import { api, AutousersApiError } from "../client.js";
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

  // ---------------------------------------------------------------------
  // Agent-runtime overrides. These were accepted by POST /api/v1/evaluations
  // from the start but were not exposed here, so an MCP caller could not
  // turn the proxy on at the moment they created a URL-stimulus eval — the
  // only moment they know whether the target is a third-party site. The
  // omission is not cosmetic: a run against a bot-protected site from a
  // datacentre IP gets an interstitial, the judge scores the unviewable
  // side at the floor, and those ratings are indistinguishable from real
  // ones in the aggregate.
  // ---------------------------------------------------------------------
  useProxy: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Route this eval's agent runs through a residential IP. TURN THIS ON (true) whenever the stimuli are URLs pointing at a public third-party site you do not control — Google, Amazon, news sites, anything behind Cloudflare. Runs originate from a cloud datacentre IP by default, which those sites rate-limit or answer with a bot interstitial; the agent then rates a page it never saw, and that rating looks exactly like a real one in the results. Leave it null (inherit) or false for your own staging/localhost URLs and for image/file stimuli, where it only adds latency and bandwidth cost. null = inherit the account default."
    ),
  proxyRegion: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Where proxy-enabled runs originate, as '<ISO-3166-alpha-2>-<city>' — e.g. 'US-sanfrancisco', 'GB-london', 'DE-berlin', 'JP-tokyo', 'AU-sydney', 'BR-saopaulo'. Only meaningful when useProxy is true. Set it when the eval is about a geo-specific experience (localised pricing, regional catalogue, language routing); otherwise leave null to inherit the account default. Unknown ids are rejected with a 400."
    ),
  modelId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Gemini model id for this eval's agent runs. null = inherit the account default. Only pass it when the user names a model."
    ),
  useWebgl: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Render WebGL in software (SwiftShader) for this eval's agent runs. Set true ONLY when a stimulus draws itself with WebGL/three.js/a 3D canvas — award-site hero scenes, product configurators, map or globe experiences. Agent runs have no GPU, so those pages otherwise render as their own 'WebGL is not supported' error screen and the judge honestly scores THAT, producing floor ratings that look like a real verdict on the design. The cost, which you must state to the user before enabling it: SwiftShader is a known headless fingerprint, so this makes the browser easier to detect as automated — the opposite of what useProxy buys. Never set it 'just in case', and never on a site known to block automation. null = inherit the account default (which is off)."
    ),

  designUrls: z
    .array(DesignUrlSchema)
    .optional()
    .describe(
      "SSE only: list of design stimuli. Each item: {id, url?, label?, stimulusType?, fileId?, fileUrl?, context?}. `context` gives THIS design its own task framing and overrides the eval-wide instructions — use it when the designs answer different questions, so a score difference cannot be a difference in what was asked."
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
      "Dimension ids the rating UI scores on. Defaults to ['overall'] when omitted or empty. Prefer built-in ids: 'overall', 'usability', 'visual-design', 'accessibility', 'content', 'helpfulness', 'accuracy', 'safety', 'design-system'. For team-specific dimensions, call templates_list first and reuse the ids it returns. Every id in customDimensions[] MUST also appear here — the API rejects mismatches.\n\nNOTE ON IDS: any id here that belongs to a customDimensions[] entry is REWRITTEN on save to the server-issued cuid of the Dimension row that entry became — ratings, results and agreement all key on that cuid, so the caller's own string cannot be kept. The create response returns `dimensionIdMap` ({ your id: persisted id }) and `selectedDimensionIds` (the persisted list, in your original order). Record the map if you are joining these results back to an external dataset keyed on your ids; built-in ids and ids you got from templates_list are never rewritten."
    ),
  customDimensions: z
    .array(CustomDimensionSchema)
    .optional()
    .describe(
      "Free-form custom dimensions for this eval. Each item MUST include `id` plus a display `name` (or `label`); every id here MUST also appear in selectedDimensionIds.\n\nWHEN TO USE THIS vs templates_create:\n  - DEFAULT path: inline customDimensions here. The server auto-saves each dimension as a team-scoped template row in the same transaction as the eval. Dimensions appear on /templates as soon as the eval transitions to Running (status='Running' on create, OR a later evaluations_update that flips status to 'Running'). Until then they're saved as drafts (visible on /templates with the Drafts filter). Use this for ANY flow where the user is creating an eval — explicit, draft, ad-hoc, reusable, all of them. Do NOT call `templates_create` separately for each dimension before this — it will create duplicate template rows.\n  - Use `templates_create` ONLY when the user explicitly says they want a STANDALONE template with NO eval yet. For example: 'create a template for design-system compliance and save it' / 'add this dimension to my library, I'll use it later' with no mention of running an eval. That endpoint creates the dim row directly without an eval reference.\n\nALWAYS include 4 contributing factors per dimension (3 minimum, 5 absolute max — only exceed 4 if the user explicitly insists, decision fatigue degrades rating quality past that). For SxS evals supply `factors[]`; for SSE supply `sseCriteria[]` (or both if you don't know which the eval will use).\n\nEach factor/criterion shape: `{id, label, description}` where `id` is a stable snake-case slug like `search-relevance-noise`, `label` is 1–3 words shown as the checkbox text (e.g. 'Signal vs noise'), and `description` is one sentence explaining what the rater is looking for. Match the style of built-in dimensions: factors are the *contributors* to the rating, not synonyms of the dimension itself.\n\nExample for a custom 'Search relevance' dimension on an SxS eval:\n  factors: [\n    {id:'search-relevance-match', label:'Intent match', description:'Results align with what the user actually wants to buy.'},\n    {id:'search-relevance-noise', label:'Signal vs noise', description:'Filters out irrelevant or distracting results.'},\n    {id:'search-relevance-coverage', label:'Coverage', description:'Captures the relevant breadth without obvious gaps.'},\n    {id:'search-relevance-confidence', label:'Confidence', description:'Helps the rater feel confident the answer is correct.'},\n  ]\n\nIf you skip factors/sseCriteria, the server fills 4 generic-but-honest fallbacks derived from the dimension name + description — but those are markedly less useful than dimension-specific ones, so always supply real ones when you have enough context.\n\nIDS ARE REWRITTEN: each entry is saved as a real Dimension row whose primary key is a server cuid, so the `id` you pass here (e.g. 'clues-helpful') is NOT the id the results are keyed on. The create response returns `dimensionIdMap` mapping every id you sent to the id that was persisted — capture it before you discard the response if you intend to join these results to a dataset of your own. \n\nLIMIT: at most 25 inline customDimensions per create. Each one costs 5 database round trips inside the create transaction; past that the transaction cannot finish and the whole create fails. For a larger rubric, create the dimensions once with `templates_create` and pass the returned ids in selectedDimensionIds — referencing an existing dimension costs no writes at all."
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
    .enum(["CHROME"])
    .nullable()
    .optional()
    .describe(
      "CHROME is the only engine the agent runner can launch; there is no Firefox/Camoufox binary in the image. Pass null to clear a legacy override and inherit the account default. (This field previously advertised lower-case 'chrome'/'camoufox' — both were rejected by the API with a 400, and 'camoufox' named a browser that never ran. To get past bot protection use useProxy, not this.)"
    ),
  useProxy: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Route this eval's agent runs through a residential IP; null clears the override and inherits the account default. Set true when the stimuli are URLs on public third-party sites — a datacentre IP gets rate-limited or served a bot interstitial, and the agent then rates a page it never saw."
    ),
  proxyRegion: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Proxy region id as '<ISO-3166-alpha-2>-<city>' (e.g. 'US-sanfrancisco', 'GB-london', 'JP-tokyo'); null clears the override. Only meaningful when useProxy is true."
    ),
  modelId: z
    .string()
    .nullable()
    .optional()
    .describe("Gemini model id; null clears the override."),
  useWebgl: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Render WebGL in software (SwiftShader) for this eval's agent runs; null clears the override and inherits the account default. Set true only when a stimulus needs WebGL to draw itself — without it the agent's GPU-less Chrome shows the site's own 'WebGL is not supported' screen and the judge scores that. It also makes the browser easier to detect as automated, so say so before turning it on."
    ),

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
 * Pull the `{ code, message }[]` warnings off a `run-autousers` response.
 *
 * The route emits these when the batch will not execute the way the stored
 * configuration reads — today that is a saved browser engine the agent-runner
 * image cannot launch, which runs as Chrome. Dropping them here would leave
 * the worker pod's stdout as the only record, so the assistant would report a
 * clean launch for a run whose conditions differ from what the eval says.
 *
 * Defensive about the shape because it is an upstream HTTP payload, not a
 * local value: anything that isn't a well-formed warning object is ignored
 * rather than forwarded as junk.
 */
function runWarnings(runData: unknown): { code: string; message: string }[] {
  const raw = (runData as { warnings?: unknown } | null | undefined)?.warnings;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (w): w is { code: string; message: string } =>
      typeof w === "object" &&
      w !== null &&
      typeof (w as { code?: unknown }).code === "string" &&
      typeof (w as { message?: unknown }).message === "string"
  );
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
        "Create a new evaluation (SSE or SxS) and persist it to the database.\n\nDEFAULT POLICY — preview, then confirm:\n  1. First call with `dryRun: true` to show the user the proposed config + cost estimate + the personas you'd suggest. Do NOT describe a dryRun response as 'created', 'live', or 'started' — by definition nothing was persisted.\n  2. Wait for the user to confirm or adjust (dimensions, autousers, instructions, scenario).\n  3. Re-issue WITHOUT dryRun, almost always with status='Draft'. Drafts are iteratively editable via evaluations_update.\n  4. Only set status='Running' when the user explicitly says to launch and the eval is fully configured (including selectedAutousers if evaluationMethod is 'ai'/'both').\n\nWhen status='Running' AND selectedAutousers is non-empty AND evaluationMethod is 'ai'/'both', this ALSO queues autouser runs and returns a cost estimate.\n\nAutousers: NEVER pick personas yourself; they're contextual. See `selectedAutousers` field docs for the right workflow (autousers_list first, custom personas before built-ins, propose then confirm). If the user wants only human raters, use `evaluationMethod: 'manual'` and omit selectedAutousers — that's a fully valid eval, not a misconfiguration.\n\nIds you pass in customDimensions[] are rewritten to server-issued cuids on save; the response carries `dimensionIdMap` ({ your id: persisted id }) plus the persisted `selectedDimensionIds`. Surface that mapping to the user whenever they supplied their own dimension ids — anything they analyse externally has to join on the persisted id.\n\nDimensions: selectedDimensionIds defaults to ['overall'] when omitted/empty; prefer built-in ids ('overall', 'usability', 'visual-design', 'accessibility', 'content', 'helpfulness', 'accuracy', 'safety', 'design-system') or ids from templates_list. Any id in customDimensions[] MUST also appear in selectedDimensionIds, and each customDimension MUST have an `id` and a `name` (or `label`).\n\nResidential proxy: when the stimuli are URLs on public third-party sites (Google, Amazon, news, anything behind Cloudflare), pass `useProxy: true`. Agent runs originate from a cloud datacentre IP otherwise, and large sites answer those with a rate-limit or bot interstitial — the agent then rates a page it never saw, and that rating is indistinguishable from a real one in the results. Leave it unset for your own staging/localhost URLs and for image/file stimuli. Say so in the dryRun preview so the user can veto the added cost.\n\nSoftware WebGL: when a stimulus draws itself with WebGL (three.js scenes, 3D product configurators, map/globe experiences, most award-site hero pages), pass `useWebgl: true`. Agent runs have no GPU, so those pages otherwise render as the site's own 'WebGL is not supported' error screen, and the judge scores that screen — floor ratings that read like a verdict on the design. It cuts the other way from useProxy: software rendering is a known headless fingerprint and makes the run EASIER to detect, so never enable it speculatively, never on a site that already blocks automation, and always name the trade-off in the dryRun preview.\n\nExample (preview): { dryRun: true, name: 'Homepage redesign', type: 'SxS', comparisonPairs: [{id:'p1', currentUrl:'https://a.com', variantUrl:'https://b.com'}], useProxy: true, selectedDimensionIds: ['overall', 'usability'], evaluationMethod: 'ai', selectedAutousers: [{autouserId:'novice', agentCount:1}] }.",
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

        // Fold the enqueue-time warnings in rather than dropping them. They
        // describe how the runs will actually execute (e.g. a stored browser
        // engine the agent runner cannot launch), and this response is the
        // only place the assistant will ever see them — the alternative
        // report is a line on the worker pod's stdout.
        for (const w of runWarnings(runData)) warnings.push(w);

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
        "List ratings (human + autouser) for one evaluation. Example: evaluationId from evaluations_list.\n\n" +
        // The description is the ONLY thing an assistant reads before deciding
        // what to do with these rows, and the rows are raw: `skipReason` comes
        // back as an unexplained `automation_failure:bot_blocked — ...` token.
        // An assistant that does not know what that means averages the row —
        // and a bot-blocked scrape is scored at the FLOOR of every dimension by
        // design, so the resulting number reports a scraper failure as a bad
        // design. Naming the field here is what stops that.
        "IMPORTANT — check `skipReason` on every row before you compute anything. " +
        "A row with a non-empty `skipReason` was recorded but is NOT a judgement about the design, and its " +
        "`dimensionRatings` must be excluded from every average, win rate, distribution and agreement figure you report.\n" +
        "- `skipReason` starting `automation_failure:` — the automated session failed. `bot_blocked` means the site " +
        "served a bot/Cloudflare interstitial (remedy: re-run through a residential proxy); `no_session` means the " +
        "browser crashed before the first turn (remedy: check the run's logs). In BOTH cases the judge floored every " +
        "dimension to the minimum, so these rows look like a scathing review and are nothing of the kind.\n" +
        "- Any other non-empty `skipReason` — a human rater skipped at pre-qualification. Also not a measurement.\n" +
        "- Empty or null `skipReason` — a real rating. These are the only rows to aggregate.\n" +
        'Always report the excluded count alongside the usable count ("8 usable ratings, 2 excluded: 2 blocked by bot ' +
        'protection") rather than silently dropping them — the count is what tells the user to fix their run. ' +
        "For a pre-computed, already-filtered summary use evaluations_results_get or evaluations_agreement_get instead.",
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
            // `wantsRunningTransition` means "the caller asked for Running",
            // NOT "the status changed" — so this branch also fires on an eval
            // that was ALREADY Running with runs already in flight, and it
            // re-sends the whole persona set. That is one of the paths that
            // produced the doubling incident, and the route now refuses it
            // with `runs_already_queued` rather than queueing a second batch.
            //
            // A refusal there must not fail this tool. The PATCH above already
            // succeeded — the evaluation IS updated — and reporting failure
            // would leave the assistant retrying a status change that already
            // landed. Report what actually happened instead: the update, plus
            // the reason nothing new was queued, in the route's own words.
            let runData: unknown;
            try {
              ({ data: runData } = await api(
                `/api/v1/evaluations/${encodeURIComponent(evalRow.id)}/run-autousers`,
                {
                  method: "POST",
                  body: JSON.stringify({ autouserIds: expanded }),
                }
              ));
            } catch (runErr) {
              if (
                runErr instanceof AutousersApiError &&
                runErr.code === "runs_already_queued"
              ) {
                return okEval(
                  {
                    ...(lastData as object),
                    autousersQueued: false,
                    runs: [],
                    warnings: [
                      {
                        code: "runs_already_queued",
                        message: runErr.message,
                      },
                    ],
                  },
                  lastRequestId
                );
              }
              throw runErr;
            }
            // Same reasoning as the create-time fan-out: an engine
            // substitution decided at enqueue time has no other route to the
            // assistant, so carry it through instead of discarding it.
            const fanoutWarnings = runWarnings(runData);
            return okEval(
              {
                ...(lastData as object),
                autousersQueued: true,
                runs: (runData as { runs?: unknown[] })?.runs ?? [],
                ...(fanoutWarnings.length && { warnings: fanoutWarnings }),
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
        "Download an eval's results as JSON (default) or CSV (one row per rating × dimension). Every row ships, marked rather than dropped, under TWO INDEPENDENT flags — a row can be flagged by both. (1) `excluded`/`exclusion_reason`: the row is not a judgement about the design at all (a bot interstitial, a rater's skip). Filter these out before averaging anything. (2) `run_finished`: whether the row's rater is a PEER of the others, derived from BOTH `run_status` and `run_stop_reason` — it is NOT the same as 'the run finished'. A run is routinely `run_status: 'completed'` with `run_finished: false`, because the pipeline wrote every row around a browser session an infrastructure error (`run_stop_reason: 'api-error'`) cut off at an arbitrary turn; conversely `run_stop_reason: 'max-turns'` and `'blocked'` still count as peers, because a turn budget applies to every run alike and a block is already marked per-rating by `excluded`. Those scores ARE real judgements of what the rater saw and belong in a mean; what they are not is comparable, so that rater is left out of every agreement statistic. To reconstruct the exact set /agreement computed over: `WHERE run_finished <> 'false' AND excluded = 'false' AND score <> ''` — `<> 'false'` rather than `= 'true'` because all three run columns are blank for a human rating, which has no run. Example: { id, format: 'csv' }.",
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
        "Aggregate stats, per-rater summaries, and the headline agreement block. The agreement block is `{ unit, percentAgreement, kappa, kappaIsMean, label, pairs, raterPairs, raterCount, itemCount, excludedRows, incompleteRunRatings, excludedRaters, notComputable }`: `percentAgreement` is direct-count agreement over (design, dimension) items, `kappa` is null rather than 0 when undefined, `kappaIsMean` marks a weighted mean of several kappas, and `notComputable` carries a reason and a remedy when no figure exists. There is no two-rater gate — any two raters sharing an item produce a figure. NOTE THE ASYMMETRY: ratings from an autouser run that was cancelled or failed are REAL judgements and stay in the per-design averages and per-rater summaries, but their rater is withdrawn from agreement — `incompleteRunRatings` counts them and `excludedRaters` names them, so an unbalanced panel is visible rather than implied. The full breakdown lives on evaluations_agreement_get. Example: { id }.",
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
  // (overall κ, per-pair κ, agreementPercent, interpretation, sample size).
  // /agreement-insights is the AI narrative on top of those numbers and is
  // exposed separately as evaluations_ai_insights_get is for the holistic
  // results summary.
  //
  // Two fields on that payload changed MEANING at cache_version 8 without
  // changing name, so the description below spells out the current semantics
  // rather than leaving a model to infer them from a field called
  // "insufficient": it now marks "no figure of any kind", not "no kappa".
  // `kappa_available` is the field that carries the old signal. (Version 6 is
  // what came before — 7 was never released.)
  // -------------------------------------------------------------------
  server.registerTool(
    "evaluations_agreement_get",
    {
      title: "Get inter-rater agreement (Cohen's Kappa)",
      description:
        "Inter-rater agreement for an evaluation: overall + per-pair kappa, exact-match agreement percent, per-dimension and per-scale breakdowns, and replicate (intra-rater) agreement. A rater is one agent instance that FINISHED — a run that was cancelled, failed, or is still in flight contributes no rater, so its partial ratings never enter a kappa, the pairwise matrix or intra-rater; `excludedRaters` names each withdrawn rater with a reason and a remedy, and `exclusions` splits `excluded_rows` into `skipped` (never a measurement) and `incompleteRuns` (real scores, unfinished rater). A persona run with agentCount 3 reports `rater_count` 3 and `independent_rater_count` 1 — use the latter for 'how many points of view'. TWO KAPPAS, NOT A CONTRADICTION: `pair_kappa[].kappa` is UNWEIGHTED (`weighting` says so) and `pairwiseKappa.matrix` is the QUADRATIC-weighted kappa for the same pairs, which is normally higher; `pairwiseKappa.mean` is weighted by shared items. `overallAgreementPercent` is direct-count agreement (not a rescaled kappa) and is null exactly when `notComputable` is set; `insufficient` mirrors that, while `kappa_available` says whether a chance-corrected number exists — a unanimous panel has agreement but no kappa. `overall_kappa_is_mean` (and `kappa.isMean`) is true when the headline kappa is an item-count-weighted mean of several kappas rather than one Cohen's kappa, which is the normal case. Interpretation bands are Landis & Koch: poor (<0) / slight (<0.21) / fair (<0.41) / moderate (<0.61) / substantial (<0.81) / near_perfect. Example: { id }.",
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
