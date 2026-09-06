/**
 * `renderDimensionIdMap` / `renderEvalSummary` — surfacing the custom
 * dimension id rewrite in the MCP create response.
 *
 * WHY. `evaluations_create` accepts caller-supplied custom dimension ids, but
 * each one is saved as a real `Dimension` row whose primary key is a
 * server-issued cuid. The pilot passed `clues-helpful` and got results keyed
 * `cmtp2kx0q0009jx04feuptc4l`; nothing in the response said so, so an external
 * dataset keyed on the caller's own ids silently failed to join. The rewrite
 * cannot be avoided — the cuid is what ratings, results and agreement key on —
 * so the response has to state it, in the turn where the assistant can still
 * relay it to the user.
 */
import { describe, it, expect } from "vitest";
import { renderDimensionIdMap, renderEvalSummary } from "./helpers.js";

describe("renderDimensionIdMap", () => {
  it("renders a join table for every rewritten id", () => {
    const table = renderDimensionIdMap({
      "clues-helpful": "cmtp2kx0q0009jx04feuptc4l",
      "clues-accurate": "cmtp2kx0q000ajx04abcd1234",
    });
    expect(table).toContain("rewritten");
    expect(table).toContain("`clues-helpful`");
    expect(table).toContain("`cmtp2kx0q0009jx04feuptc4l`");
    expect(table).toContain("`clues-accurate`");
  });

  it("says nothing when no id actually changed", () => {
    // An id that survived is not news. Rendering identity rows would bury the
    // rewritten ones — the only rows a caller has to act on.
    expect(renderDimensionIdMap({ usability: "usability" })).toBeNull();
    expect(renderDimensionIdMap({})).toBeNull();
    expect(renderDimensionIdMap(undefined)).toBeNull();
  });
});

describe("renderEvalSummary", () => {
  it("appends the id map to the summary a create response renders", () => {
    const summary = renderEvalSummary({
      id: "e1",
      name: "CLUES validation",
      type: "SxS",
      status: "Draft",
      links: { review: "https://app.autousers.ai/evals/e1/review" },
      dimensionIdMap: { "clues-helpful": "cmtp2kx0q0009jx04feuptc4l" },
    });
    expect(summary).toContain("**CLUES validation**");
    expect(summary).toContain("- Review (owner):");
    expect(summary).toContain("`clues-helpful`");
  });

  it("is unchanged for responses that carry no map (get, list, update)", () => {
    const summary = renderEvalSummary({
      id: "e1",
      name: "Plain",
      links: { results: "https://app.autousers.ai/evals/e1/results" },
    });
    expect(summary).toBe(
      "**Plain**\n- Results: https://app.autousers.ai/evals/e1/results"
    );
  });
});
