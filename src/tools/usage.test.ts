/**
 * Unit tests for the MCP `get_usage` tool.
 *
 * The tool wraps `/api/v1/usage` (and optionally `/api/v1/settings/byok`)
 * and renders one of three messages depending on the user's state:
 * healthy / exhausted, BYOK active, or betaUnlimited. We assert on the
 * exact phrases and structured payload because those phrases are part of
 * the contract — a downstream LLM keys off the `/settings/keys` URL and
 * the "BYOK active" wording when deciding what to tell the user.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "../client.js";
import { registerUsage } from "./usage.js";

// ---------------------------------------------------------------------------
// Mocks — match the convention used in `evaluations.test.ts`.
// ---------------------------------------------------------------------------

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    api: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Harness — capture the `get_usage` handler off a stub server.
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
  registerUsage(server);
  const handler = handlers.get("get_usage");
  if (!handler) throw new Error("get_usage handler not registered");
  return handler;
}

const apiMock = api as unknown as Mock;

beforeEach(() => {
  apiMock.mockReset();
});

function textOf(result: Awaited<ReturnType<ToolHandler>>): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("get_usage", () => {
  describe("healthy free-tier state (BYOK off, used < limit)", () => {
    it("returns formatted text + structured data and skips the BYOK lookup", async () => {
      const handler = buildHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          range: "30d",
          byok: false,
          byokConfigured: false,
          freeQuota: { used: 5, limit: 25 },
          totals: {
            runs: 5,
            inputTokens: 10000,
            outputTokens: 2000,
            costUsd: 0.4567,
            evaluations: 2,
            autousersUsed: 3,
          },
          byEval: [
            {
              evaluationId: "eval_a",
              evaluationName: "Homepage redesign",
              runs: 3,
              tokens: 7000,
              costUsd: 0.3,
            },
            {
              evaluationId: "eval_b",
              evaluationName: "Checkout flow",
              runs: 2,
              tokens: 5000,
              costUsd: 0.1567,
            },
          ],
          daily: [],
          perRun: { medianCost: 0.0912, meanCost: 0.0913, medianTokens: 2400 },
        },
        requestId: "req_usage_1",
      });

      const result = await handler({});

      // Exactly one upstream call — BYOK detail is only fetched when byok=true.
      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(apiMock.mock.calls[0]?.[0]).toBe("/api/v1/usage?range=30d");
      expect(result.isError).toBeFalsy();

      const text = textOf(result);
      expect(text).toContain("5 / 25 free autouser runs");
      expect(text).toContain("20 remaining");
      // No upgrade prompt for a healthy user.
      expect(text).not.toContain("/settings/keys");
      // Recent cost is included so the LLM can reason about it.
      expect(text).toContain("$0.4567");
      // Median per-run cost is surfaced.
      expect(text).toContain("$0.0912");
      // Top evals are surfaced (not all of them — top 3 max).
      expect(text).toContain("Homepage redesign");
      expect(text).toContain("Checkout flow");

      // Structured payload contains the keys downstream callers depend on.
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.byok).toBe(false);
      expect(structured.byokConfigured).toBe(false);
      expect(structured.unlimited).toBe(false);
      expect(structured.freeQuota).toEqual({ used: 5, limit: 25 });
      expect((structured.totals as { runs: number }).runs).toBe(5);
      expect((structured.perRun as { medianCost: number }).medianCost).toBe(
        0.0912
      );
      expect(Array.isArray(structured.byEvalTop3)).toBe(true);
      expect((structured.byEvalTop3 as unknown[]).length).toBe(2);
      expect(structured).not.toHaveProperty("byokDetail");
    });
  });

  describe("quota exhausted (used >= limit, BYOK off)", () => {
    it("includes the upgrade prompt and the /settings/keys URL", async () => {
      const handler = buildHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          range: "30d",
          byok: false,
          freeQuota: { used: 25, limit: 25 },
          totals: {
            runs: 25,
            inputTokens: 50000,
            outputTokens: 10000,
            costUsd: 2.275,
            evaluations: 8,
            autousersUsed: 6,
          },
          byEval: [],
          daily: [],
          perRun: { medianCost: 0.091, meanCost: 0.091, medianTokens: 2400 },
        },
        requestId: "req_usage_exhaust",
      });

      const result = await handler({ range: "30d" });

      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      // The exact upgrade-prompt phrasing the spec asks for.
      expect(text).toContain("You've used 25 / 25 free runs");
      expect(text).toContain("https://app.autousers.ai/settings/keys");
      expect(text).toContain("Add a Gemini API key");
      expect(text).toContain("contact support");

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.byok).toBe(false);
      expect(structured.unlimited).toBe(false);
      expect(structured.freeQuota).toEqual({ used: 25, limit: 25 });
    });
  });

  describe("BYOK saved but inactive (parked key)", () => {
    it("renders the parked-key message and does NOT fetch BYOK detail", async () => {
      const handler = buildHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          range: "30d",
          // byok=false because toggle is off, but byokConfigured=true.
          byok: false,
          byokConfigured: true,
          freeQuota: { used: 7, limit: 25 },
          totals: {
            runs: 7,
            inputTokens: 14000,
            outputTokens: 2800,
            costUsd: 0.6,
            evaluations: 3,
            autousersUsed: 4,
          },
          byEval: [],
          daily: [],
          perRun: { medianCost: 0.085, meanCost: 0.085, medianTokens: 2300 },
        },
        requestId: "req_usage_parked",
      });

      const result = await handler({});

      // Only one call — no BYOK detail fetch when byok=false.
      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(result.isError).toBeFalsy();

      const text = textOf(result);
      // The exact phrasing the spec asks for.
      expect(text).toContain("Bring-your-own-key is configured but inactive");
      expect(text).toContain("runs are using your free quota");
      expect(text).toContain("https://app.autousers.ai/settings/usage");
      // Used / limit still surfaced — user is on the free path.
      expect(text).toContain("7 / 25 free autouser runs");
      // The "Add a Gemini API key" upgrade prompt MUST NOT appear when a
      // key is already on file.
      expect(text).not.toContain("Add a Gemini API key");

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.byok).toBe(false);
      expect(structured.byokConfigured).toBe(true);
      expect(structured.unlimited).toBe(false);
      expect(structured).not.toHaveProperty("byokDetail");
    });

    it("surfaces the activate-to-recover hint when free quota is also exhausted", async () => {
      const handler = buildHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          range: "30d",
          byok: false,
          byokConfigured: true,
          freeQuota: { used: 25, limit: 25 },
          totals: {
            runs: 25,
            inputTokens: 50000,
            outputTokens: 10000,
            costUsd: 2.275,
            evaluations: 8,
            autousersUsed: 6,
          },
          byEval: [],
          daily: [],
          perRun: { medianCost: 0.091, meanCost: 0.091, medianTokens: 2400 },
        },
        requestId: "req_usage_parked_exhausted",
      });

      const result = await handler({});
      const text = textOf(result);
      expect(text).toContain("Bring-your-own-key is configured but inactive");
      // The "activate to keep running" hint, not the "add a key" hint.
      expect(text).toContain(
        "Activating your saved key would let you keep running"
      );
      expect(text).not.toContain("Add a Gemini API key");
    });
  });

  describe("BYOK active", () => {
    it("renders the BYOK message with hint + added-on date and tags structuredContent", async () => {
      const handler = buildHandler();
      apiMock
        // /api/v1/usage
        .mockResolvedValueOnce({
          data: {
            range: "30d",
            byok: true,
            byokConfigured: true,
            // The free quota is meaningless here, but the API still ships it.
            freeQuota: { used: 25, limit: 25 },
            totals: {
              runs: 12,
              inputTokens: 24000,
              outputTokens: 4800,
              costUsd: 1.092,
              evaluations: 4,
              autousersUsed: 5,
            },
            byEval: [
              {
                evaluationId: "eval_x",
                evaluationName: "Pricing page A/B",
                runs: 6,
                tokens: 12000,
                costUsd: 0.6,
              },
            ],
            daily: [],
            perRun: { medianCost: 0.091, meanCost: 0.091, medianTokens: 2400 },
          },
          requestId: "req_usage_byok",
        })
        // /api/v1/settings/byok
        .mockResolvedValueOnce({
          data: {
            byok: true,
            hint: "••••AB12",
            addedAt: "2026-04-15T12:34:56.000Z",
          },
          requestId: "req_byok_detail",
        });

      const result = await handler({});

      // Two calls: the usage rollup, then the BYOK detail.
      expect(apiMock).toHaveBeenCalledTimes(2);
      expect(apiMock.mock.calls[0]?.[0]).toBe("/api/v1/usage?range=30d");
      expect(apiMock.mock.calls[1]?.[0]).toBe("/api/v1/settings/byok");

      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("Bring-your-own-key is active");
      expect(text).toContain("••••AB12");
      expect(text).toContain("2026-04-15");
      expect(text).toContain("Free quota does not apply");
      // The exhausted-message must NOT appear when BYOK is on, even though
      // used >= limit in the upstream response.
      expect(text).not.toContain("/settings/keys");

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.byok).toBe(true);
      expect(structured.byokConfigured).toBe(true);
      expect(structured.unlimited).toBe(false);
      const byokDetail = structured.byokDetail as {
        hint: string;
        addedAt: string;
      };
      expect(byokDetail.hint).toBe("••••AB12");
      expect(byokDetail.addedAt).toBe("2026-04-15T12:34:56.000Z");
    });
  });

  describe("betaUnlimited (limit: null)", () => {
    it("surfaces the unlimited message and avoids the upgrade prompt", async () => {
      const handler = buildHandler();
      apiMock.mockResolvedValueOnce({
        data: {
          range: "7d",
          byok: false,
          // Limit is null — caller is on betaUnlimited.
          freeQuota: { used: 142, limit: null },
          totals: {
            runs: 142,
            inputTokens: 280000,
            outputTokens: 56000,
            costUsd: 12.93,
            evaluations: 30,
            autousersUsed: 9,
          },
          byEval: [
            {
              evaluationId: "eval_z",
              evaluationName: "Onboarding redesign",
              runs: 50,
              tokens: 100000,
              costUsd: 4.55,
            },
          ],
          daily: [],
          perRun: { medianCost: 0.091, meanCost: 0.091, medianTokens: 2400 },
        },
        requestId: "req_usage_unlimited",
      });

      const result = await handler({ range: "7d" });

      // No BYOK lookup — byok is false.
      expect(apiMock).toHaveBeenCalledTimes(1);
      expect(apiMock.mock.calls[0]?.[0]).toBe("/api/v1/usage?range=7d");

      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("You have unlimited beta quota");
      expect(text).not.toContain("/settings/keys");
      expect(text).not.toContain("free runs");
      expect(text).toContain("142 run(s)");

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.unlimited).toBe(true);
      expect(structured.byok).toBe(false);
    });
  });

  describe("API error (5xx)", () => {
    it("returns a graceful error message via fail() rather than crashing", async () => {
      const handler = buildHandler();
      // Use the real AutousersApiError constructor so `fail()` formats it
      // the same way it does in production.
      const { AutousersApiError } = await import("../client.js");
      apiMock.mockRejectedValueOnce(
        new AutousersApiError(
          "Internal server error",
          500,
          "req_usage_err",
          "api_error"
        )
      );

      const result = await handler({});

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("Autousers API error (500)");
      expect(text).toContain("Internal server error");
      // The handler did not throw — we got a clean ToolResult back.
      expect(result.content.length).toBeGreaterThan(0);
    });
  });
});
