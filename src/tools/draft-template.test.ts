/**
 * Unit tests for the MCP `templates_draft_from_prompt` tool.
 *
 * Mirrors the autouser draft tool tests — same SSE wire format, same
 * dual-content output. The proposal payload is a `TemplateDraft` with a
 * `suggestedDimensions` array; we assert that survives the stream parser
 * and lands intact on `structuredContent.draft`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { apiStream, AutousersApiError } from "../client.js";
import { registerDraftTemplate } from "./draft-template.js";

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    apiStream: vi.fn(),
  };
});

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
  registerDraftTemplate(server);
  const handler = handlers.get("templates_draft_from_prompt");
  if (!handler) {
    throw new Error("templates_draft_from_prompt handler not registered");
  }
  return handler;
}

const apiStreamMock = apiStream as unknown as Mock;

beforeEach(() => {
  apiStreamMock.mockReset();
});

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function fakeResponse(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

describe("templates_draft_from_prompt", () => {
  it("accumulates chunk deltas and captures the proposal", async () => {
    const handler = buildHandler();

    const proposal = {
      name: "Trust Signals",
      description: "Evaluate credibility cues on a SaaS pricing page.",
      suggestedDimensions: [
        {
          name: "Social proof",
          description: "Customer logos, testimonials, case studies.",
          scoringScale: {
            scaleType: "FIVE_POINT" as const,
            scaleMin: 1,
            scaleMax: 5,
          },
          rubrics: [
            {
              name: "Logos visible above fold",
              description: "At least 3 customer logos visible without scroll.",
            },
          ],
        },
      ],
      scoringScale: {
        scaleType: "FIVE_POINT" as const,
        scaleMin: 1,
        scaleMax: 5,
      },
    };

    const body = streamFromChunks([
      sseEvent("chunk", { delta: "Pricing pages need" }),
      sseEvent("chunk", { delta: " strong social proof" }),
      sseEvent("proposal", proposal),
      sseEvent("done", {}),
    ]);

    apiStreamMock.mockResolvedValueOnce(
      fakeResponse(body, { "x-request-id": "req_test_t1" })
    );

    const result = await handler({
      prompt: "trust signals on a SaaS pricing page",
    });

    expect(apiStreamMock).toHaveBeenCalledTimes(1);
    expect(apiStreamMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/templates/draft-from-prompt"
    );
    expect(apiStreamMock.mock.calls[0]?.[1]).toEqual({
      prompt: "trust signals on a SaaS pricing page",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      prose: "Pricing pages need strong social proof",
      draft: proposal,
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).toContain("Pricing pages need");
    expect(result.content[1]?.text).toContain('"name": "Trust Signals"');
    expect(result.content[1]?.text).toContain("req_test_t1");
  });

  it("returns an error result when the stream emits an error event", async () => {
    const handler = buildHandler();
    const body = streamFromChunks([
      sseEvent("error", {
        message: "AI request failed",
        code: "ai_request_failed",
      }),
    ]);
    apiStreamMock.mockResolvedValueOnce(fakeResponse(body));

    const result = await handler({
      prompt: "evaluate something specific",
    });

    expect(result.isError).toBe(true);
    const text = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    expect(text).toContain("AI request failed");
  });

  it("returns an error result when the stream ends without a proposal", async () => {
    const handler = buildHandler();
    const body = streamFromChunks([
      sseEvent("chunk", { delta: "thinking out loud..." }),
    ]);
    apiStreamMock.mockResolvedValueOnce(fakeResponse(body));

    const result = await handler({
      prompt: "checkout flow friction",
    });

    expect(result.isError).toBe(true);
    const text = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    expect(text.toLowerCase()).toContain("proposal");
  });

  it("surfaces upstream HTTP errors via fail()", async () => {
    const handler = buildHandler();
    apiStreamMock.mockRejectedValueOnce(
      new AutousersApiError(
        "Too many template draft requests",
        429,
        "req_rl_2",
        "rate_limit_error"
      )
    );

    const result = await handler({
      prompt: "describe a homepage rubric",
    });

    expect(result.isError).toBe(true);
    const text = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    expect(text).toContain("Autousers API error (429)");
    expect(text).toContain("Too many template draft requests");
  });
});
