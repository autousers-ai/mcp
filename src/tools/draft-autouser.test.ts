/**
 * Unit tests for the MCP `autousers_draft_from_prompt` tool.
 *
 * The tool wraps the SSE-streaming `POST /api/v1/autousers/draft-from-prompt`
 * route. It is the only tool surface that consumes a server-sent-events
 * stream, so we exercise the SSE framing edge cases here:
 *
 *   - chunk events accumulate into `prose`
 *   - proposal event is captured into `draft`
 *   - error events surface via `fail()` / `isError: true`
 *   - missing-proposal completion is a structured failure
 *   - HTTP errors raised by `apiStream` are reported via `fail()`
 *
 * `apiStream` is mocked at the module boundary; we hand-build the SSE
 * payload as a single ReadableStream so the parser sees real bytes
 * (including chunk-spanning frame boundaries in one of the tests).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { apiStream, AutousersApiError } from "../client.js";
import { registerDraftAutouser } from "./draft-autouser.js";

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    apiStream: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Harness
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
  registerDraftAutouser(server);
  const handler = handlers.get("autousers_draft_from_prompt");
  if (!handler) {
    throw new Error("autousers_draft_from_prompt handler not registered");
  }
  return handler;
}

const apiStreamMock = apiStream as unknown as Mock;

beforeEach(() => {
  apiStreamMock.mockReset();
});

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

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
  // Real Response would do — but jsdom's Response works fine with a
  // ReadableStream and a Headers init. We construct it once to keep the
  // tests grounded in the same shape `apiStream` returns at runtime.
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autousers_draft_from_prompt", () => {
  it("accumulates chunk deltas and captures the proposal", async () => {
    const handler = buildHandler();

    const proposal = {
      name: "Busy Parent",
      description: "Phone-only, low patience",
      persona: "A working parent who scans email between meetings...",
      criteria: "- responsive UI\n- no walls of text\n- big tap targets",
      suggestedTemplates: ["Mobile-first heuristics"],
    };

    const body = streamFromChunks([
      sseEvent("chunk", { delta: "A working parent" }),
      sseEvent("chunk", { delta: " who scans email" }),
      sseEvent("proposal", proposal),
      sseEvent("done", {}),
    ]);

    apiStreamMock.mockResolvedValueOnce(
      fakeResponse(body, { "x-request-id": "req_test_a1" })
    );

    const result = await handler({ prompt: "a busy parent on a phone" });

    expect(apiStreamMock).toHaveBeenCalledTimes(1);
    expect(apiStreamMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/autousers/draft-from-prompt"
    );
    expect(apiStreamMock.mock.calls[0]?.[1]).toEqual({
      prompt: "a busy parent on a phone",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toMatchObject({
      prose: "A working parent who scans email",
      draft: proposal,
    });

    // Two content entries: prose then JSON code-fenced draft.
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.text).toContain("A working parent");
    expect(result.content[1]?.text).toContain('"name": "Busy Parent"');
    expect(result.content[1]?.text).toContain("req_test_a1");
  });

  it("re-assembles frames split across read boundaries", async () => {
    const handler = buildHandler();
    const proposal = {
      name: "Skeptical Reviewer",
      description: "Reads the fine print",
      persona: "A cautious user who hovers tooltips and...",
      criteria: "- clear pricing\n- visible refund policy",
    };
    const wholeStream =
      sseEvent("chunk", { delta: "A cautious user" }) +
      sseEvent("chunk", { delta: " who hovers" }) +
      sseEvent("proposal", proposal) +
      sseEvent("done", {});

    // Slice deliberately mid-frame to exercise the buffer-merge logic.
    const split = wholeStream.length / 2;
    const body = streamFromChunks([
      wholeStream.slice(0, Math.floor(split)),
      wholeStream.slice(Math.floor(split)),
    ]);

    apiStreamMock.mockResolvedValueOnce(fakeResponse(body));

    const result = await handler({
      prompt: "a cautious user reading the fine print",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      prose: "A cautious user who hovers",
      draft: proposal,
    });
  });

  it("returns an error result when the stream emits an error event", async () => {
    const handler = buildHandler();
    const body = streamFromChunks([
      sseEvent("chunk", { delta: "starting..." }),
      sseEvent("error", {
        message: "Model did not emit a structured proposal",
        code: "no_proposal",
      }),
    ]);
    apiStreamMock.mockResolvedValueOnce(fakeResponse(body));

    const result = await handler({ prompt: "this prompt is fine" });

    expect(result.isError).toBe(true);
    const text = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    expect(text).toContain("Model did not emit a structured proposal");
  });

  it("returns an error result when the stream ends without a proposal", async () => {
    const handler = buildHandler();
    const body = streamFromChunks([
      sseEvent("chunk", { delta: "lots of prose..." }),
      // No `proposal` event — stream just ends.
    ]);
    apiStreamMock.mockResolvedValueOnce(fakeResponse(body));

    const result = await handler({ prompt: "describe a tester" });

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
        "Too many draft requests",
        429,
        "req_rl_1",
        "rate_limit_error"
      )
    );

    const result = await handler({ prompt: "describe a power user" });

    expect(apiStreamMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    const text = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    expect(text).toContain("Autousers API error (429)");
    expect(text).toContain("Too many draft requests");
  });
});
