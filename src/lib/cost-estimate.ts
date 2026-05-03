/**
 * Pre-flight cost estimation for autouser runs.
 *
 * The MCP can fan out runs across many autousers × comparisons, and a careless
 * call can rack up Gemini spend without warning. We compute a conservative
 * estimate from the live per-rating cost decomposition documented in
 * `docs/PRICING.md` §3 and surface it in tool responses so the caller (and
 * the LLM driving it) sees the spend before it happens.
 *
 * Numbers below are anchored on `gemini-3-flash-preview` (the only Gemini
 * model with native Computer Use) for navigation + `gemini-3.1-pro-preview`
 * for dimensional judging — the same combination the autouser runner uses
 * in production. Source of truth lives in `lib/gemini-pricing.ts` in the
 * main app and `docs/PRICING.md` §3 for the loaded per-rating cost. Keep
 * this file in step when either changes.
 */

export const STIMULUS_TYPES = ["URL", "IMAGE", "VIDEO", "GIF"] as const;
export type StimulusType = (typeof STIMULUS_TYPES)[number];

export type EvalType = "SSE" | "SxS";

/**
 * Per-rating cost basis (USD), today's fully loaded numbers from
 * `docs/PRICING.md` §3. URL is the most expensive because Computer Use
 * navigation runs against `gemini-3-flash-preview`. IMAGE skips navigation
 * entirely (no browser turn loop) so cost collapses to judging + system
 * overhead. VIDEO and GIF pay for video-token input at the judging step.
 */
export const COST_ESTIMATE_BASIS = {
  models: {
    navigation: "gemini-3-flash-preview",
    judging: "gemini-3.1-pro-preview",
    compliance: "gemini-2.5-flash",
  },
  /**
   * Loaded USD per autouser × comparison. URL value matches PRICING.md §3
   * exactly. IMAGE / VIDEO / GIF derive from the same components with the
   * navigation step removed or replaced by media-token input.
   */
  perRatingUsdByStimulus: {
    URL: 0.091, // navigation $0.044 + judging $0.042 + compliance $0.001 + GKE $0.003 + logs $0.001
    IMAGE: 0.047, // judging $0.042 + compliance $0.001 + GKE $0.003 + logs $0.001 (no navigation)
    VIDEO: 0.067, // judging $0.042 + ~30s video tokens $0.020 + compliance $0.001 + GKE $0.003 + logs $0.001
    GIF: 0.06, // judging $0.042 + ~10s GIF tokens $0.013 + compliance $0.001 + GKE $0.003 + logs $0.001
  } satisfies Record<StimulusType, number>,
  /**
   * SxS requires the navigator to view BOTH stimuli in a single rating.
   * Empirically that is roughly +50% on top of the per-stimulus cost — not
   * 2× because judging is shared and the second navigation often hits the
   * prompt-cache warmed by the first.
   */
  sxsMultiplier: 1.5,
  /**
   * Token approximations per autouser × comparison, used for the
   * `totalTokensApprox` rollup. URL ~= 35k navigation + 13k judging.
   */
  approxTokensByStimulus: {
    URL: 51_000,
    IMAGE: 16_000,
    VIDEO: 24_000,
    GIF: 22_000,
  } satisfies Record<StimulusType, number>,
  /**
   * §3 cost-down target after prompt caching + multi-run pods land
   * (SSE URL). Surfaced in the response so the caller knows the trajectory.
   */
  postOptimisationTargetUsdSseUrl: 0.06,
} as const;

export interface CostEstimate {
  /** Models the rating pipeline routes through. */
  models: typeof COST_ESTIMATE_BASIS.models;
  /** Eval shape (SSE/SxS) the estimate was computed for. */
  evalType: EvalType;
  /** Stimulus type the estimate was computed for (the most-expensive one when mixed). */
  stimulusType: StimulusType;
  /** Number of distinct autouser runs (already expanded by agentCount). */
  autouserCount: number;
  /** Number of comparison rows on the evaluation. */
  comparisonCount: number;
  /** Total ratings = autouserCount × comparisonCount. */
  totalRatings: number;
  /** Per-rating USD (loaded). */
  perRatingUsd: number;
  /** Total USD across all queued runs. */
  totalUsd: number;
  /** Approximate total Gemini tokens (input + output across nav + judge). */
  totalTokensApprox: number;
  /** Human-readable basis string for surfacing in tool output. */
  basis: string;
  /** Caveats; tool callers should print this. */
  note: string;
  /** Forecast cost after the §3 optimisations land (SSE URL only). */
  postOptimisationTotalUsd: number | null;
}

interface EstimateInput {
  autouserCount: number;
  comparisonCount: number;
  evalType?: EvalType;
  stimulusType?: StimulusType;
}

/**
 * Compute a conservative spend estimate. Pass the EXPANDED autouser count
 * (i.e. after applying each selection's `agentCount`) so the math reflects
 * what `/run-autousers` will actually queue.
 */
export function estimateRunCost(input: EstimateInput): CostEstimate {
  const evalType: EvalType = input.evalType ?? "SSE";
  const stimulusType: StimulusType = input.stimulusType ?? "URL";

  const autouserCount = Math.max(1, input.autouserCount);
  const comparisonCount = Math.max(1, input.comparisonCount);
  const totalRatings = autouserCount * comparisonCount;

  const baseUsd = COST_ESTIMATE_BASIS.perRatingUsdByStimulus[stimulusType];
  const perRatingUsd =
    evalType === "SxS" ? baseUsd * COST_ESTIMATE_BASIS.sxsMultiplier : baseUsd;

  const totalUsd = totalRatings * perRatingUsd;
  const totalTokens =
    totalRatings * COST_ESTIMATE_BASIS.approxTokensByStimulus[stimulusType];

  const postOptimisationTotalUsd =
    evalType === "SSE" && stimulusType === "URL"
      ? totalRatings * COST_ESTIMATE_BASIS.postOptimisationTargetUsdSseUrl
      : null;

  return {
    models: COST_ESTIMATE_BASIS.models,
    evalType,
    stimulusType,
    autouserCount,
    comparisonCount,
    totalRatings,
    perRatingUsd: round4(perRatingUsd),
    totalUsd: round4(totalUsd),
    totalTokensApprox: totalTokens,
    basis:
      `${evalType} ${stimulusType} stimulus, $${perRatingUsd.toFixed(3)}/rating ` +
      `× ${totalRatings} ratings = $${totalUsd.toFixed(3)} ` +
      `(navigation on ${COST_ESTIMATE_BASIS.models.navigation}, judging on ${COST_ESTIMATE_BASIS.models.judging})`,
    note:
      "Estimate only. Actual cost varies with page complexity, autouser turn count, and final input/output token mix. " +
      "Source: docs/PRICING.md §3.",
    postOptimisationTotalUsd:
      postOptimisationTotalUsd === null
        ? null
        : round4(postOptimisationTotalUsd),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Pick the dominant (most expensive) stimulus type from a wizard payload so
 * the estimate doesn't under-quote a mixed eval. URL > VIDEO > GIF > IMAGE
 * by per-rating cost.
 */
export function pickDominantStimulusType(
  stimulusTypes: ReadonlyArray<StimulusType | undefined>
): StimulusType {
  const ranked: StimulusType[] = ["URL", "VIDEO", "GIF", "IMAGE"];
  const present = new Set(
    stimulusTypes.filter((t): t is StimulusType => Boolean(t))
  );
  for (const candidate of ranked) {
    if (present.has(candidate)) return candidate;
  }
  return "URL";
}
