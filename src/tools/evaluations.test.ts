/**
 * Unit tests for the MCP `evaluations_create` tool.
 *
 * Focus: the v0.7.x behaviour change that stopped auto-filling default
 * autousers. The tool now surfaces structured warnings when the create
 * payload is incoherent (AI-method without selectedAutousers) and hard-
 * fails when the caller asks status='Running' in that same state.
 *
 * The `ok` / `okEval` / `fail` helpers from `../lib/helpers.js` are NOT
 * mocked — we let them run and assert against their structured output
 * (`{ content, structuredContent, isError? }`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api, AutousersApiError } from "../client.js";
import { evalRowShape, genericObjectShape } from "../lib/output-shapes.js";
import { registerEvaluations } from "./evaluations.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../client.js", async (importOriginal) => {
  // Keep the real `AutousersApiError` (used by `fail()` for instanceof checks)
  // and `MissingApiKeyError`; only stub the network entry-point.
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    api: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Harness — capture the `evaluations_create` handler off a stub server.
// ---------------------------------------------------------------------------

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function buildHandler(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      }
    ),
  } as unknown as McpServer;
  registerEvaluations(server);
  const handler = handlers.get("evaluations_create");
  if (!handler) throw new Error("evaluations_create handler not registered");
  return handler;
}

const apiMock = api as unknown as Mock;

beforeEach(() => {
  apiMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evaluations_create", () => {
  describe("ai method without selectedAutousers (Draft)", () => {
    it("persists the eval with a structured warning and no fan-out", async () => {
      const handler = buildHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          id: "eval_abc",
          name: "Homepage AI eval",
          type: "SSE",
          status: "Draft",
          links: {
            preview: "https://app.autousers.ai/evaluations/eval_abc/preview",
            review: "https://app.autousers.ai/evaluations/eval_abc/review",
            edit: "https://app.autousers.ai/evaluations/eval_abc/edit",
            results: "https://app.autousers.ai/evaluations/eval_abc/results",
          },
        },
        requestId: "req_test_1",
      });

      const result = await handler({
        name: "Homepage AI eval",
        type: "SSE",
        evaluationMethod: "ai",
        selectedAutousers: [],
        status: "Draft",
      });

      // Exactly one upstream call, hitting the create route — never /run-autousers.
      expect(apiMock).toHaveBeenCalledTimes(1);
      const [path, init] = apiMock.mock.calls[0]!;
      expect(path).toBe("/api/v1/evaluations");
      expect((init as { method?: string }).method).toBe("POST");

      // Body is forwarded verbatim — no auto-filled autousers.
      const body = JSON.parse((init as { body: string }).body) as Record<
        string,
        unknown
      >;
      expect(body.evaluationMethod).toBe("ai");
      expect(body.selectedAutousers).toEqual([]);

      // Warnings are surfaced via structuredContent.
      expect(result.isError).toBeFalsy();
      const warnings = (result.structuredContent as { warnings?: unknown[] })
        ?.warnings;
      expect(Array.isArray(warnings)).toBe(true);
      expect(warnings).toHaveLength(1);
      const [warning] = warnings as Array<{ code: string; message: string }>;
      expect(warning.code).toBe("ai_eval_without_autousers");
      expect(typeof warning.message).toBe("string");
      expect(warning.message.length).toBeGreaterThan(0);
    });
  });

  describe("ai method without selectedAutousers (Running)", () => {
    it("hard-fails before any upstream call", async () => {
      const handler = buildHandler();

      const result = await handler({
        name: "Homepage AI eval",
        type: "SSE",
        evaluationMethod: "ai",
        selectedAutousers: [],
        status: "Running",
      });

      // No upstream call at all — the validation throws first.
      expect(apiMock).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const text = result.content
        .map((c) => ("text" in c ? c.text : ""))
        .join("\n");
      expect(text).toContain("selectedAutousers");
    });
  });

  describe("manual method without autousers", () => {
    it("persists cleanly with no warnings and no fan-out", async () => {
      const handler = buildHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          id: "eval_manual",
          name: "Manual eval",
          type: "SSE",
          status: "Draft",
          links: {
            preview: "https://app.autousers.ai/evaluations/eval_manual/preview",
            review: "https://app.autousers.ai/evaluations/eval_manual/review",
            edit: "https://app.autousers.ai/evaluations/eval_manual/edit",
            results: "https://app.autousers.ai/evaluations/eval_manual/results",
          },
        },
        requestId: "req_test_2",
      });

      const result = await handler({
        name: "Manual eval",
        type: "SSE",
        evaluationMethod: "manual",
        // Note: no selectedAutousers field at all.
      });

      // Exactly one call, to the create route. Never to /run-autousers.
      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(apiMock.mock.calls[0]?.[0]).toBe("/api/v1/evaluations");

      // Response shape: no `warnings` field, no `autousersQueued`.
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).not.toHaveProperty("warnings");
      expect(structured).not.toHaveProperty("autousersQueued");
    });
  });

  describe("dryRun preview with incoherent ai+empty shape", () => {
    it("returns the preview with warnings and makes no upstream call", async () => {
      const handler = buildHandler();

      const result = await handler({
        name: "Homepage AI eval",
        type: "SSE",
        evaluationMethod: "ai",
        selectedAutousers: [],
        status: "Draft",
        dryRun: true,
      });

      // dryRun is side-effect free — no upstream calls at all.
      expect(apiMock).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();

      const structured = result.structuredContent as {
        dryRun?: boolean;
        persisted?: boolean;
        warnings?: Array<{ code: string }>;
      };
      expect(structured.dryRun).toBe(true);
      expect(structured.persisted).toBe(false);
      expect(structured.warnings).toBeDefined();
      expect(structured.warnings).toHaveLength(1);
      expect(structured.warnings?.[0]?.code).toBe("ai_eval_without_autousers");
    });

    // Regression: prior to the fix, evaluations_create registered
    // outputSchema: evalRowShape, which requires `id: string` at the top
    // level. The dryRun branch returns a synthetic preview with no `id`,
    // so the MCP SDK rejected every dryRun response with
    //   -32602 Output validation error: Required at "id".
    // Live testing in claude.ai surfaced this; the unit harness above
    // missed it because it calls the handler directly and bypasses the
    // SDK's outputSchema validation.
    it("dryRun structuredContent satisfies the registered output schema", async () => {
      const handler = buildHandler();
      const result = await handler({
        name: "preview eval",
        type: "SxS",
        comparisonPairs: [
          {
            id: "p1",
            currentUrl: "https://a.com",
            variantUrl: "https://b.com",
          },
        ],
        dryRun: true,
      });
      expect(apiMock).not.toHaveBeenCalled();
      expect(() =>
        genericObjectShape.parse(result.structuredContent)
      ).not.toThrow();
      // Pin the regression: the dryRun preview deliberately has no `id`,
      // so the old evalRowShape would (and did) reject it.
      expect(() => evalRowShape.parse(result.structuredContent)).toThrow();
    });
  });

  describe("happy path: ai + selectedAutousers + Running", () => {
    it("persists then fans out to /run-autousers with no warnings", async () => {
      const handler = buildHandler();
      apiMock
        .mockResolvedValueOnce({
          data: {
            id: "eval_happy",
            name: "Happy path eval",
            type: "SSE",
            status: "Running",
            links: {
              preview:
                "https://app.autousers.ai/evaluations/eval_happy/preview",
              review: "https://app.autousers.ai/evaluations/eval_happy/review",
              edit: "https://app.autousers.ai/evaluations/eval_happy/edit",
              results:
                "https://app.autousers.ai/evaluations/eval_happy/results",
            },
          },
          requestId: "req_test_3",
        })
        .mockResolvedValueOnce({
          data: {
            runs: [
              { id: "run_1", autouserId: "novice" },
              { id: "run_2", autouserId: "power-user" },
            ],
          },
          requestId: "req_test_4",
        });

      const result = await handler({
        name: "Happy path eval",
        type: "SSE",
        evaluationMethod: "ai",
        selectedAutousers: [
          { autouserId: "novice", agentCount: 1 },
          { autouserId: "power-user", agentCount: 1 },
        ],
        status: "Running",
        designUrls: [{ id: "d1", url: "https://example.com" }],
      });

      // Two upstream calls in order: create then run-autousers.
      expect(apiMock).toHaveBeenCalledTimes(2);
      expect(apiMock.mock.calls[0]?.[0]).toBe("/api/v1/evaluations");
      expect((apiMock.mock.calls[0]?.[1] as { method?: string }).method).toBe(
        "POST"
      );
      expect(apiMock.mock.calls[1]?.[0]).toBe(
        "/api/v1/evaluations/eval_happy/run-autousers"
      );
      expect((apiMock.mock.calls[1]?.[1] as { method?: string }).method).toBe(
        "POST"
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.autousersQueued).toBe(true);
      expect(structured).not.toHaveProperty("warnings");
    });

    /**
     * The fan-out response is the assistant's ONLY view of how the runs will
     * actually execute. `/run-autousers` warns when the stored browser engine
     * is not the engine the agent runner can launch; the alternative report is
     * a line on the worker pod's stdout, which nobody reads. Dropping it here
     * would let the assistant tell the user "started your runs" while the runs
     * quietly execute under different conditions than the eval records.
     */
    it("forwards enqueue-time warnings from /run-autousers to the caller", async () => {
      const handler = buildHandler();
      apiMock
        .mockResolvedValueOnce({
          data: {
            id: "eval_legacy",
            name: "Legacy engine eval",
            type: "SSE",
            status: "Running",
            links: {
              preview:
                "https://app.autousers.ai/evaluations/eval_legacy/preview",
              review: "https://app.autousers.ai/evaluations/eval_legacy/review",
              edit: "https://app.autousers.ai/evaluations/eval_legacy/edit",
              results:
                "https://app.autousers.ai/evaluations/eval_legacy/results",
            },
          },
          requestId: "req_test_5",
        })
        .mockResolvedValueOnce({
          data: {
            runs: [{ id: "run_1", autouserId: "novice" }],
            warnings: [
              {
                code: "unsupported_browser_engine_substituted",
                message: "…will execute in Chrome…",
              },
              // Malformed entries are dropped rather than forwarded as junk —
              // this is an upstream HTTP payload, not a local value.
              { code: 42 },
              "nope",
            ],
          },
          requestId: "req_test_6",
        });

      const result = await handler({
        name: "Legacy engine eval",
        type: "SSE",
        evaluationMethod: "ai",
        selectedAutousers: [{ autouserId: "novice", agentCount: 1 }],
        status: "Running",
        designUrls: [{ id: "d1", url: "https://example.com" }],
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.warnings).toEqual([
        {
          code: "unsupported_browser_engine_substituted",
          message: "…will execute in Chrome…",
        },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// evaluations_update — unified scalar + wizard field handler
// ---------------------------------------------------------------------------
//
// The MCP partitions input into wizard fields (selectedAutousers,
// customDimensions, etc — routed to PATCH /draft) and scalar fields (name,
// status, share* — routed to PATCH /evaluations/[id]). Mixed payloads call
// both. A status transition to Running with autousers attached also fans
// out runs to /run-autousers, mirroring the create-time behaviour so the
// assistant can attach + publish in one tool call.
// ---------------------------------------------------------------------------

function buildUpdateHandler(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      }
    ),
  } as unknown as McpServer;
  registerEvaluations(server);
  const handler = handlers.get("evaluations_update");
  if (!handler) throw new Error("evaluations_update handler not registered");
  return handler;
}

describe("evaluations_update", () => {
  describe("wizard-field-only payload (selectedAutousers)", () => {
    it("routes to PATCH /draft only — does not call the main PATCH", async () => {
      const handler = buildUpdateHandler();
      apiMock.mockResolvedValueOnce({
        data: { id: "eval_w1", config: { preQualification: "{}" } },
        requestId: "req_w1",
      });

      const result = await handler({
        id: "eval_w1",
        selectedAutousers: [{ autouserId: "novice", agentCount: 1 }],
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(apiMock.mock.calls[0]?.[0]).toBe(
        "/api/v1/evaluations/eval_w1/draft"
      );
      const init = apiMock.mock.calls[0]?.[1] as {
        method?: string;
        body?: string;
      };
      expect(init.method).toBe("PATCH");
      const body = JSON.parse(init.body ?? "{}");
      expect(body).toEqual({
        selectedAutousers: [{ autouserId: "novice", agentCount: 1 }],
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe("scalar-field-only payload (status)", () => {
    it("routes to PATCH /evaluations/[id] only — does not call /draft", async () => {
      const handler = buildUpdateHandler();
      apiMock.mockResolvedValueOnce({
        // No autousers in metadata → no fan-out should fire.
        data: {
          id: "eval_s1",
          config: {
            preQualification: JSON.stringify({
              evaluationMethod: "manual",
              selectedAutousers: [],
            }),
          },
        },
        requestId: "req_s1",
      });

      const result = await handler({ id: "eval_s1", status: "Ended" });

      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(apiMock.mock.calls[0]?.[0]).toBe("/api/v1/evaluations/eval_s1");
      const init = apiMock.mock.calls[0]?.[1] as {
        method?: string;
        body?: string;
      };
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body ?? "{}")).toEqual({ status: "Ended" });
      expect(result.isError).toBeFalsy();
    });
  });

  describe("mixed payload (wizard + scalar)", () => {
    it("calls /draft first, then the main PATCH (wizard before status flip)", async () => {
      const handler = buildUpdateHandler();
      apiMock
        .mockResolvedValueOnce({
          data: { id: "eval_m1", config: { preQualification: "{}" } },
          requestId: "req_m1_draft",
        })
        .mockResolvedValueOnce({
          // Final eval state after publish — manual method so no fan-out.
          data: {
            id: "eval_m1",
            status: "Running",
            config: {
              preQualification: JSON.stringify({
                evaluationMethod: "manual",
                selectedAutousers: [],
              }),
            },
          },
          requestId: "req_m1_main",
        });

      await handler({
        id: "eval_m1",
        selectedAutousers: [{ autouserId: "novice", agentCount: 1 }],
        status: "Running",
      });

      expect(apiMock).toHaveBeenCalledTimes(2);
      // Wizard PATCH fires FIRST so the publish sees fresh selectedAutousers.
      expect(apiMock.mock.calls[0]?.[0]).toBe(
        "/api/v1/evaluations/eval_m1/draft"
      );
      expect(apiMock.mock.calls[1]?.[0]).toBe("/api/v1/evaluations/eval_m1");
    });
  });

  describe("Running transition with autousers attached", () => {
    it("auto-fans-out to /run-autousers using the post-update metadata", async () => {
      const handler = buildUpdateHandler();
      apiMock
        // PATCH /evaluations/[id] returns the updated row whose config blob
        // already carries the autousers + ai method (set by an earlier
        // /draft call this test doesn't need to repeat).
        .mockResolvedValueOnce({
          data: {
            id: "eval_r1",
            status: "Running",
            config: {
              preQualification: JSON.stringify({
                evaluationMethod: "ai",
                selectedAutousers: [
                  { autouserId: "novice", agentCount: 2 },
                  { autouserId: "power-user", agentCount: 1 },
                ],
              }),
            },
          },
          requestId: "req_r1",
        })
        .mockResolvedValueOnce({
          data: { runs: [{ id: "run1" }, { id: "run2" }, { id: "run3" }] },
          requestId: "req_r1_runs",
        });

      const result = await handler({ id: "eval_r1", status: "Running" });

      expect(apiMock).toHaveBeenCalledTimes(2);
      expect(apiMock.mock.calls[1]?.[0]).toBe(
        "/api/v1/evaluations/eval_r1/run-autousers"
      );
      const runInit = apiMock.mock.calls[1]?.[1] as {
        method?: string;
        body?: string;
      };
      expect(runInit.method).toBe("POST");
      const runBody = JSON.parse(runInit.body ?? "{}") as {
        autouserIds: string[];
      };
      // 2 novice + 1 power-user = 3 expanded ids in order.
      expect(runBody.autouserIds).toEqual(["novice", "novice", "power-user"]);

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.autousersQueued).toBe(true);
    });

    /**
     * THE DOUBLING INCIDENT, from this tool's side.
     *
     * `wantsRunningTransition` means "the caller asked for Running", not "the
     * status changed" — so this branch also fires on an eval that is ALREADY
     * Running with runs in flight, and it re-sends the entire persona set.
     * That is one of the paths that queued a customer's evaluation twice.
     *
     * The route now refuses it (`runs_already_queued`). The PATCH above still
     * succeeded, so failing the whole tool would tell the assistant a status
     * change had not landed when it had, and invite it to retry.
     */
    it("reports a refused fan-out as a warning, not a failed update", async () => {
      const handler = buildUpdateHandler();
      apiMock
        .mockResolvedValueOnce({
          data: {
            id: "eval_r3",
            status: "Running",
            config: {
              preQualification: JSON.stringify({
                evaluationMethod: "ai",
                selectedAutousers: [{ autouserId: "novice", agentCount: 1 }],
              }),
            },
          },
          requestId: "req_r3",
        })
        .mockRejectedValueOnce(
          new AutousersApiError(
            "Nothing was queued. Every autouser in this request is already running on these designs: novice (1 run).",
            400,
            "req_r3_runs",
            "invalid_request_error",
            "autouserIds",
            "runs_already_queued"
          )
        );

      const result = await handler({ id: "eval_r3", status: "Running" });

      // The update succeeded, so the tool succeeded.
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.id).toBe("eval_r3");
      // But it says plainly that nothing was queued, and why — the assistant
      // must not conclude a second batch is now running.
      expect(structured.autousersQueued).toBe(false);
      expect(structured.runs).toEqual([]);
      const warnings = structured.warnings as Array<{
        code: string;
        message: string;
      }>;
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe("runs_already_queued");
      expect(warnings[0].message).toMatch(/already running/);
    });

    it("still fails the tool when the fan-out fails for any other reason", async () => {
      // Graceful degradation is scoped to the one refusal it understands. A
      // quota cap or a publish failure must still reach the caller as an error.
      const handler = buildUpdateHandler();
      apiMock
        .mockResolvedValueOnce({
          data: {
            id: "eval_r4",
            status: "Running",
            config: {
              preQualification: JSON.stringify({
                evaluationMethod: "ai",
                selectedAutousers: [{ autouserId: "novice", agentCount: 1 }],
              }),
            },
          },
          requestId: "req_r4",
        })
        .mockRejectedValueOnce(
          new AutousersApiError(
            "You have used all of your free autouser runs.",
            429,
            "req_r4_runs",
            "rate_limit_error",
            undefined,
            "INSUFFICIENT_QUOTA"
          )
        );

      const result = await handler({ id: "eval_r4", status: "Running" });
      expect(result.isError).toBe(true);
    });
  });

  describe("Running transition without autousers", () => {
    it("does NOT fan out runs (no /run-autousers call)", async () => {
      const handler = buildUpdateHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          id: "eval_r2",
          status: "Running",
          // Manual method — even if autousers were somehow attached, fan-out
          // shouldn't fire when method != ai/both.
          config: {
            preQualification: JSON.stringify({
              evaluationMethod: "manual",
              selectedAutousers: [{ autouserId: "novice", agentCount: 1 }],
            }),
          },
        },
        requestId: "req_r2",
      });

      const result = await handler({ id: "eval_r2", status: "Running" });

      // Only the main PATCH; no fan-out.
      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(apiMock.mock.calls[0]?.[0]).toBe("/api/v1/evaluations/eval_r2");

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).not.toHaveProperty("autousersQueued");
    });
  });
});

// ---------------------------------------------------------------------------
// Custom dimension id rewrite
// ---------------------------------------------------------------------------
describe("evaluations_create — dimensionIdMap passthrough", () => {
  it("keeps the id map in structuredContent and renders it in the text", async () => {
    // The rewrite is unavoidable (a Dimension row's PK is a server cuid), so
    // the create response is the one place a caller can learn it. If this
    // stops reaching structuredContent, an assistant joining these results to
    // an external dataset keyed on `clues-*` ids silently gets nothing.
    const handler = buildHandler();
    apiMock.mockResolvedValueOnce({
      data: {
        id: "eval_map",
        name: "CLUES validation",
        type: "SxS",
        status: "Draft",
        links: { review: "https://app.autousers.ai/evals/eval_map/review" },
        dimensionIdMap: { "clues-helpful": "cmtp2kx0q0009jx04feuptc4l" },
        selectedDimensionIds: ["overall", "cmtp2kx0q0009jx04feuptc4l"],
      },
      requestId: "req_map",
    });

    const result = await handler({
      name: "CLUES validation",
      type: "SxS",
      selectedDimensionIds: ["overall", "clues-helpful"],
      customDimensions: [{ id: "clues-helpful", name: "Helpfulness" }],
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.dimensionIdMap).toEqual({
      "clues-helpful": "cmtp2kx0q0009jx04feuptc4l",
    });
    expect(structured.selectedDimensionIds).toEqual([
      "overall",
      "cmtp2kx0q0009jx04feuptc4l",
    ]);
    // Rendered too, not just buried in JSON — the assistant has to notice it
    // in order to relay it.
    expect(result.content[0]?.text).toContain("`clues-helpful`");
  });
});
