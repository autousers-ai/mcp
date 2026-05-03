/**
 * `autousers_draft_from_prompt` — chat-driven autouser persona generator.
 *
 * Wraps the SSE-streaming `POST /api/v1/autousers/draft-from-prompt`
 * endpoint. The user describes a persona in plain English; the server
 * streams reasoning prose (`event: chunk`) and finally emits a structured
 * proposal (`event: proposal`) the host can pipe into `autousers_create`.
 *
 * Wire format (matches the route in
 * `app/api/v1/autousers/draft-from-prompt/route.ts`):
 *
 *   event: chunk     data: { delta: "<token text>" }
 *   event: proposal  data: { name, description, persona, criteria, suggestedRubrics?, suggestedTemplates? }
 *   event: done      data: {}
 *   event: error     data: { message, code }
 *
 * Output shape — to keep the tool useful both for autonomous LLM hosts
 * (Claude, Cursor) and for human reading, we return TWO content entries:
 *
 *   1. The accumulated prose (raw chunks concatenated). Lets the host
 *      surface the reasoning to the user without re-rendering JSON.
 *   2. The pretty-printed proposal JSON. The host's LLM can act on this
 *      directly: extract name/persona, call `autousers_create`, etc.
 *
 * `structuredContent` carries the validated proposal under `draft` plus
 * the prose under `prose` so MCP hosts that render structured-content can
 * key on stable fields.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiStream, AutousersApiError } from "../client.js";
import { fail } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Input shape — mirrors lib/schemas/autouser.ts:DraftFromPromptSchema
// ---------------------------------------------------------------------------

const draftAutouserShape = {
  prompt: z
    .string()
    .min(10, "Prompt must be at least 10 characters")
    .max(2000, "Prompt must be at most 2000 characters")
    .describe(
      "Free-text description of the persona to generate (10..2000 chars). Example: 'a busy parent juggling email on a phone, low patience for friction, prefers visuals over walls of text'."
    ),
};

// ---------------------------------------------------------------------------
// Output shape — `draft` mirrors AutouserDraftSchema (passthrough so future
// fields don't break the contract), plus `prose` for the live reasoning text.
// ---------------------------------------------------------------------------

const suggestedRubricShape = z
  .object({
    name: z.string(),
    criteriaText: z.string(),
    rationale: z.string().optional(),
  })
  .passthrough();

const autouserDraftOutputShape = z
  .object({
    prose: z.string(),
    draft: z
      .object({
        name: z.string(),
        description: z.string(),
        persona: z.string(),
        criteria: z.string(),
        suggestedRubrics: z.array(suggestedRubricShape).optional(),
        suggestedTemplates: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// SSE parser — minimal frame splitter shared with draft-template.ts shape.
// We intentionally re-implement here (rather than centralising) so the
// tool is self-contained for anyone reading the registration site; the
// implementation is small enough that the duplication is cheaper than the
// indirection.
// ---------------------------------------------------------------------------

interface SseEvent {
  name: string;
  data: unknown;
}

function parseFrame(frame: string): SseEvent | null {
  let eventName: string | null = null;
  const dataChunks: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    if (line.startsWith(":")) continue; // SSE comment
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataChunks.push(line.slice("data:".length).trim());
    }
  }
  if (!eventName || dataChunks.length === 0) return null;
  try {
    return { name: eventName, data: JSON.parse(dataChunks.join("\n")) };
  } catch {
    return null;
  }
}

interface DraftResult {
  prose: string;
  draft: Record<string, unknown>;
}

async function consumeStream(res: Response): Promise<DraftResult> {
  if (!res.body) {
    throw new Error("Draft endpoint returned no response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let prose = "";
  let draft: Record<string, unknown> | null = null;
  let streamError: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) {
        if (ev.name === "chunk") {
          const delta = (ev.data as { delta?: string })?.delta;
          if (typeof delta === "string") prose += delta;
        } else if (ev.name === "proposal") {
          draft = ev.data as Record<string, unknown>;
        } else if (ev.name === "error") {
          const data = ev.data as { message?: string; code?: string };
          streamError = data?.message ?? "Draft failed";
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }

  if (streamError) throw new Error(streamError);
  if (!draft) throw new Error("Draft stream ended without a proposal event.");
  return { prose, draft };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDraftAutouser(server: McpServer): void {
  server.registerTool(
    "autousers_draft_from_prompt",
    {
      title: "Draft an autouser from a natural-language prompt",
      description:
        "Generate a structured autouser (synthetic persona) draft from a free-text description. The server streams reasoning prose and a final JSON proposal; this tool buffers the stream and returns BOTH so the host can show the reasoning AND act on the structured draft. The draft is NOT persisted — pass `draft.name`, `draft.description`, `draft.persona` (→ systemPrompt), and `draft.criteria` to `autousers_create` to save it. Example prompt: 'a methodical accessibility-focused tester on a Pixel 7, screen reader on, slow 3G'.",
      inputSchema: draftAutouserShape,
      outputSchema: autouserDraftOutputShape.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt }) => {
      try {
        const res = await apiStream(`/api/v1/autousers/draft-from-prompt`, {
          prompt,
        });
        const { prose, draft } = await consumeStream(res);
        const requestId = res.headers.get("x-request-id");
        const trailer = requestId ? `\n\n(request_id: ${requestId})` : "";
        return {
          content: [
            { type: "text", text: prose || "(no reasoning prose returned)" },
            {
              type: "text",
              text: `\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\`${trailer}`,
            },
          ],
          structuredContent: { prose, draft },
        };
      } catch (err) {
        // Re-shape network failures so the host gets the same one-line
        // "Autousers API error (status): message" surface as every other tool.
        if (err instanceof AutousersApiError) return fail(err);
        return fail(err);
      }
    }
  );
}
