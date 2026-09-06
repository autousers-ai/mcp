/**
 * Shared Zod input shapes used across multiple tool modules.
 *
 * These mirror `lib/schemas/evaluation.ts` from the autousers app — copied
 * here (not imported) because this package is intentionally standalone.
 * Keep in sync.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Pagination (Stripe-style cursor)
// ---------------------------------------------------------------------------

export const paginationShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max items to return (1-100, default 20)."),
  starting_after: z
    .string()
    .optional()
    .describe("Cursor: id of the last item from the previous page."),
};

// ---------------------------------------------------------------------------
// Evaluation building blocks
// ---------------------------------------------------------------------------

export const StimulusTypeSchema = z
  .enum(["URL", "IMAGE", "VIDEO", "GIF"])
  .optional();

export const DesignUrlSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  label: z.string().optional(),
  stimulusType: StimulusTypeSchema,
  fileId: z.string().optional(),
  fileUrl: z.string().optional(),
  /** What the rater is here to do FOR THIS DESIGN. Falls back to the eval-wide
   *  instructions/scenario when unset. Use it when the designs answer DIFFERENT
   *  questions — a validation study where each stimulus had its own task, say —
   *  because otherwise every design inherits one shared framing and a score
   *  difference may just be a difference in what was asked. */
  context: z.string().max(8000).optional(),
});

export const ComparisonPairSchema = z.object({
  id: z.string(),
  currentUrl: z.string().optional(),
  variantUrl: z.string().optional(),
  label: z.string().optional(),
  sideAType: StimulusTypeSchema,
  sideAFileId: z.string().optional(),
  sideAFileUrl: z.string().optional(),
  sideBType: StimulusTypeSchema,
  sideBFileId: z.string().optional(),
  sideBFileUrl: z.string().optional(),
});

export const AutouserSelectionSchema = z.object({
  autouserId: z.string(),
  agentCount: z.number().int().min(1).max(50),
});

/**
 * Mirrors `CustomDimensionInputSchema` in `lib/schemas/evaluation.ts`.
 *
 * `id` plus a display name (`name` or `label`) are required; the rating
 * UI cannot render a dimension without a name. Other Dimension fields
 * are optional but typed so the eval builder LLM gets schema hints
 * rather than `z.unknown()`.
 *
 * The route schema rejects:
 *   - dimensions whose id isn't also in `selectedDimensionIds`
 *   - dimensions with neither `name` nor `label`
 */
export const CustomDimensionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe(
        "Stable id for this dimension. MUST also appear in selectedDimensionIds."
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Display name shown on the review/rating page (required if `label` is omitted)."
      ),
    label: z
      .string()
      .min(1)
      .optional()
      .describe("Alternative to `name`; review page falls back to this."),
    description: z.string().optional(),
    icon: z.string().optional(),
    scaleQuestion: z
      .string()
      .optional()
      .describe("Comparative question shown for SxS evals."),
    sseQuestion: z
      .string()
      .optional()
      .describe("Absolute rating question shown for SSE evals."),
    factors: z.array(z.unknown()).optional(),
    sseCriteria: z.array(z.unknown()).optional(),
    contexts: z.array(z.string()).optional(),
    isCustom: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
    sseScaleLabels: z.array(z.string()).optional(),
    sxsScaleLabels: z.array(z.string()).optional(),
    sseScaleDescriptions: z.array(z.string()).optional(),
    sxsScaleDescriptions: z.array(z.string()).optional(),
    openTextEnabled: z.boolean().optional(),
    customQuestions: z.array(z.unknown()).optional(),
    scoringMode: z.enum(["holistic", "rubric"]).optional(),
    sseAnchors: z.array(z.unknown()).optional(),
    sxsScoringMode: z.enum(["holistic", "rubric"]).optional(),
    sxsAnchors: z.array(z.unknown()).optional(),
  })
  .passthrough();
