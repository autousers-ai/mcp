/**
 * `templates_draft_from_prompt` — chat-driven evaluation-template generator.
 *
 * Wraps the SSE-streaming `POST /api/v1/templates/draft-from-prompt`
 * endpoint. The user describes what they want to evaluate (e.g. "trust
 * signals on a SaaS landing page"); the server streams reasoning prose
 * (`event: chunk`) and finally emits a structured template proposal
 * (`event: proposal`) the host can pipe into `templates_create`.
 *
 * Wire format (matches the route in
 * `app/api/v1/templates/draft-from-prompt/route.ts`):
 *
 *   event: chunk     data: { delta: "<token text>" }
 *   event: proposal  data: { name, description, suggestedDimensions, suggestedRubrics?, scoringScale }
 *   event: done      data: {}
 *   event: error     data: { message, code }
 *
 * Output shape — same dual-content pattern as `autousers_draft_from_prompt`:
 * the prose for human / LLM reading, plus the validated proposal JSON for
 * downstream tool calls.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiStream, AutousersApiError } from "../client.js";
import { fail } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Input shape — mirrors lib/schemas/template.ts:TemplateDraftFromPromptSchema
// ---------------------------------------------------------------------------

const draftTemplateShape = {
  prompt: z
    .string()
    .min(10, "Prompt must be at least 10 characters")
    .max(2000, "Prompt must be at most 2000 characters")
    .describe(
      "Free-text description of the evaluation focus (10..2000 chars). Example: 'trust signals on a SaaS landing page', 'checkout-flow friction on mobile', 'accessibility audit of a docs site'."
    ),
};

// ---------------------------------------------------------------------------
// Output shape — `draft` mirrors TemplateDraftSchema (passthrough for forward
// compat), plus `prose` for the live reasoning text.
// ---------------------------------------------------------------------------

const scoringScaleShape = z
  .object({
    scaleType: z.enum(["THREE_POINT", "FIVE_POINT", "SEVEN_POINT"]),
    scaleMin: z.number().int(),
    scaleMax: z.number().int(),
    scaleLabels: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const dimensionRubricShape = z
  .object({
    name: z.string(),
    description: z.string(),
  })
  .passthrough();

const suggestedDimensionShape = z
  .object({
    name: z.string(),
    description: z.string(),
    scoringScale: scoringScaleShape,
    rubrics: z.array(dimensionRubricShape).optional(),
  })
  .passthrough();

const templateDraftOutputShape = z
  .object({
    prose: z.string(),
    draft: z
      .object({
        name: z.string(),
        description: z.string(),
        suggestedDimensions: z.array(suggestedDimensionShape),
        suggestedRubrics: z.array(dimensionRubricShape).optional(),
        scoringScale: scoringScaleShape,
      })
      .passthrough(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// SSE parser — same minimal splitter as draft-autouser.ts.
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
    if (line.startsWith(":")) continue;
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

export function registerDraftTemplate(server: McpServer): void {
  server.registerTool(
    "templates_draft_from_prompt",
    {
      title: "Draft an evaluation template from a natural-language prompt",
      description:
        "Generate a structured evaluation template (rubric of dimensions) from a free-text description. The server streams reasoning prose and a final JSON proposal; this tool buffers the stream and returns BOTH so the host can show the reasoning AND act on the structured draft. The draft is NOT persisted — pipe `draft.name`, `draft.description`, and `draft.scoringScale` into `templates_create` (one create call per template; suggestedDimensions are guidance for follow-up edits — the templates create endpoint persists a single dimension at a time today). Example prompt: 'trust signals on a SaaS pricing page'.",
      inputSchema: draftTemplateShape,
      outputSchema: templateDraftOutputShape.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt }) => {
      try {
        const res = await apiStream(`/api/v1/templates/draft-from-prompt`, {
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
        if (err instanceof AutousersApiError) return fail(err);
        return fail(err);
      }
    }
  );
}
