import { describe, expect, it } from "vitest";

import { COST_ESTIMATE_BASIS, estimateRunCost } from "./cost-estimate.js";

describe("MCP cost estimate basis", () => {
  it("mirrors the app's Gemini 3.7 loaded rates", () => {
    expect(COST_ESTIMATE_BASIS.models.navigation).toBe("gemini-3.7-flash");
    expect(COST_ESTIMATE_BASIS.perRatingUsdByStimulus).toEqual({
      URL: 0.085,
      IMAGE: 0.02,
      VIDEO: 0.028,
      GIF: 0.025,
    });
    expect(COST_ESTIMATE_BASIS.postOptimisationTargetUsdSseUrl).toBe(0.07);
  });

  it("returns the current SSE and SxS URL bands", () => {
    const sse = estimateRunCost({
      autouserCount: 1,
      comparisonCount: 1,
      evalType: "SSE",
      stimulusType: "URL",
    });
    const sxs = estimateRunCost({
      autouserCount: 1,
      comparisonCount: 1,
      evalType: "SxS",
      stimulusType: "URL",
    });

    expect(sse.perRatingUsd).toBe(0.085);
    expect(sse.postOptimisationTotalUsd).toBe(0.07);
    expect(sxs.perRatingUsd).toBe(0.1275);
    expect(sxs.postOptimisationTotalUsd).toBeNull();
  });
});
