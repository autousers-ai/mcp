/**
 * Shared helpers used by every tool module under `mcp/src/tools/*`.
 *
 * Anything that more than one domain registry needs lives here:
 *   - `ok` / `okEval` / `okEvalList` for response shaping
 *   - `fail` for typed error → MCP `isError` content
 *   - `buildQuery` for URLSearchParams
 *   - eval `links` rendering helpers (every Evaluation API response carries
 *     a `links` block per `lib/api/eval-links.ts` in the autousers app)
 */

import { AutousersApiError } from "../client.js";

export type ToolContent =
  | { type: "text"; text: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string;
      description?: string;
    };

export type ToolResult = {
  content: ToolContent[];
  /**
   * MCP `structuredContent` — the parsed-JSON object the host can render
   * directly (tables, cards) without round-tripping through the LLM. The
   * SDK validates this against any declared `outputSchema` on the tool;
   * if the schema is set and `structuredContent` is missing, the SDK
   * raises `InvalidParams`. We therefore populate it whenever a handler
   * returns successfully.
   *
   * Spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Coerce arbitrary `data` to the object shape MCP `structuredContent`
 * expects. Bare arrays / primitives get wrapped under `{ data: ... }`
 * so the field is always a plain object.
 */
function toStructured(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { data };
}

// ---------------------------------------------------------------------------
// Plain JSON response
// ---------------------------------------------------------------------------

export function ok(data: unknown, requestId: string | null): ToolResult {
  const payload = JSON.stringify(data, null, 2);
  const trailer = requestId ? `\n\n(request_id: ${requestId})` : "";
  return {
    content: [{ type: "text", text: payload + trailer }],
    structuredContent: toStructured(data),
  };
}

// ---------------------------------------------------------------------------
// Eval-aware response shaping (renders the `links` block as markdown)
// ---------------------------------------------------------------------------

export interface EvalLinks {
  preview?: string;
  review?: string;
  edit?: string;
  results?: string;
  share?: string;
}

export interface EvalRow {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  links?: EvalLinks;
}

interface MaybeEnvelope<T> {
  data?: T;
}

export function isEvalRow(value: unknown): value is EvalRow {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && typeof v.links === "object" && v.links !== null
  );
}

export function renderEvalSummary(ev: EvalRow): string {
  const header = `**${ev.name ?? ev.id ?? "Evaluation"}**${
    ev.type || ev.status
      ? ` (${[ev.type, ev.status].filter(Boolean).join(", ")})`
      : ""
  }`;
  const links = ev.links ?? {};
  const lines = [
    header,
    links.preview ? `- Preview: ${links.preview}` : null,
    links.review ? `- Review (owner): ${links.review}` : null,
    links.share ? `- Public review: ${links.share}` : null,
    links.edit ? `- Edit: ${links.edit}` : null,
    links.results ? `- Results: ${links.results}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export function renderEvalListSummary(rows: EvalRow[]): string {
  if (rows.length === 0) return "_No evaluations._";
  const header = "| Name | Type | Status | Links |\n| --- | --- | --- | --- |";
  const body = rows
    .map((ev) => {
      const links = ev.links ?? {};
      const linkCells = [
        links.preview ? `[preview](${links.preview})` : null,
        links.review ? `[review](${links.review})` : null,
        links.share ? `[share](${links.share})` : null,
        links.edit ? `[edit](${links.edit})` : null,
        links.results ? `[results](${links.results})` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const name = (ev.name ?? ev.id ?? "—").replace(/\|/g, "\\|");
      return `| ${name} | ${ev.type ?? "—"} | ${ev.status ?? "—"} | ${
        linkCells || "—"
      } |`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

export function okEval(data: unknown, requestId: string | null): ToolResult {
  const candidate =
    (data as MaybeEnvelope<unknown>)?.data !== undefined
      ? (data as MaybeEnvelope<unknown>).data
      : data;
  const payload = JSON.stringify(data, null, 2);
  const trailer = requestId ? `\n\n(request_id: ${requestId})` : "";
  if (isEvalRow(candidate)) {
    const summary = renderEvalSummary(candidate);
    return {
      content: [
        {
          type: "text",
          text: `${summary}\n\n\`\`\`json\n${payload}\n\`\`\`${trailer}`,
        },
      ],
      structuredContent: toStructured(data),
    };
  }
  return {
    content: [{ type: "text", text: payload + trailer }],
    structuredContent: toStructured(data),
  };
}

export function okEvalList(
  data: unknown,
  requestId: string | null
): ToolResult {
  const payload = JSON.stringify(data, null, 2);
  const trailer = requestId ? `\n\n(request_id: ${requestId})` : "";
  const rows = (data as { data?: unknown[] })?.data;
  if (Array.isArray(rows)) {
    const evalRows = rows.filter(isEvalRow);
    if (evalRows.length === rows.length && rows.length > 0) {
      const summary = renderEvalListSummary(evalRows);
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n\`\`\`json\n${payload}\n\`\`\`${trailer}`,
          },
        ],
        structuredContent: toStructured(data),
      };
    }
  }
  return {
    content: [{ type: "text", text: payload + trailer }],
    structuredContent: toStructured(data),
  };
}

// ---------------------------------------------------------------------------
// Autouser-list response shaping
// ---------------------------------------------------------------------------
//
// `autousers_list` rows mix built-in (system) personas and custom team-owned
// personas. The two are visually indistinguishable in a raw JSON dump, which
// caused real friction in v0.6.0 smoke testing — Power User looked the same
// as a calibrated custom autouser. We render a tight markdown table with an
// explicit Source column so the host (Claude Code, etc.) shows the
// distinction without the LLM having to round-trip through the JSON.
// ---------------------------------------------------------------------------

interface AutouserRow {
  id?: string;
  name?: string;
  status?: string;
  visibility?: string;
  isSystem?: boolean;
  source?: string | null;
}

function isAutouserRow(value: unknown): value is AutouserRow {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string";
}

function autouserSource(row: AutouserRow): string {
  if (row.isSystem === true) return "built-in";
  if (row.source === "built-in") return "built-in";
  return "custom";
}

function renderAutouserListSummary(rows: AutouserRow[]): string {
  if (rows.length === 0) return "_No autousers._";
  const header =
    "| Name | Source | Status | Visibility |\n| --- | --- | --- | --- |";
  const body = rows
    .map((au) => {
      const name = (au.name ?? au.id ?? "—").replace(/\|/g, "\\|");
      return `| ${name} | ${autouserSource(au)} | ${au.status ?? "—"} | ${
        au.visibility ?? "—"
      } |`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

export function okAutouserList(
  data: unknown,
  requestId: string | null
): ToolResult {
  const payload = JSON.stringify(data, null, 2);
  const trailer = requestId ? `\n\n(request_id: ${requestId})` : "";
  const rows = (data as { data?: unknown[] })?.data;
  if (Array.isArray(rows)) {
    const auRows = rows.filter(isAutouserRow);
    if (auRows.length === rows.length && rows.length > 0) {
      const summary = renderAutouserListSummary(auRows);
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n\`\`\`json\n${payload}\n\`\`\`${trailer}`,
          },
        ],
        structuredContent: toStructured(data),
      };
    }
  }
  return {
    content: [{ type: "text", text: payload + trailer }],
    structuredContent: toStructured(data),
  };
}

// ---------------------------------------------------------------------------
// Template-list response shaping
// ---------------------------------------------------------------------------
//
// Templates are either system-owned (`teamId === null`, also flagged
// `isSystem: true`) or team-owned (`teamId` non-null). We surface that
// distinction in a Source column so users can tell their custom rubric
// apart from the canonical "UX heuristics" built-ins.
// ---------------------------------------------------------------------------

interface TemplateRow {
  id?: string;
  name?: string;
  type?: string;
  scaleType?: string;
  teamId?: string | null;
  isSystem?: boolean;
}

function isTemplateRow(value: unknown): value is TemplateRow {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string";
}

function templateSource(row: TemplateRow): string {
  if (row.isSystem === true) return "built-in";
  if (row.teamId === null || row.teamId === undefined) return "built-in";
  return "custom";
}

function renderTemplateListSummary(rows: TemplateRow[]): string {
  if (rows.length === 0) return "_No templates._";
  const header = "| Name | Source | Type | Scale |\n| --- | --- | --- | --- |";
  const body = rows
    .map((tpl) => {
      const name = (tpl.name ?? tpl.id ?? "—").replace(/\|/g, "\\|");
      return `| ${name} | ${templateSource(tpl)} | ${tpl.type ?? "—"} | ${
        tpl.scaleType ?? "—"
      } |`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

export function okTemplateList(
  data: unknown,
  requestId: string | null
): ToolResult {
  const payload = JSON.stringify(data, null, 2);
  const trailer = requestId ? `\n\n(request_id: ${requestId})` : "";
  const rows = (data as { data?: unknown[] })?.data;
  if (Array.isArray(rows)) {
    const tplRows = rows.filter(isTemplateRow);
    if (tplRows.length === rows.length && rows.length > 0) {
      const summary = renderTemplateListSummary(tplRows);
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n\`\`\`json\n${payload}\n\`\`\`${trailer}`,
          },
        ],
        structuredContent: toStructured(data),
      };
    }
  }
  return {
    content: [{ type: "text", text: payload + trailer }],
    structuredContent: toStructured(data),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function fail(err: unknown): ToolResult {
  if (err instanceof AutousersApiError) {
    const parts = [
      `Autousers API error (${err.status}): ${err.message}`,
      err.type ? `Type: ${err.type}` : null,
      err.param ? `Param: ${err.param}` : null,
      `Request ID: ${err.requestId ?? "<none>"}`,
    ].filter(Boolean);
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Querystring builder
// ---------------------------------------------------------------------------

export function buildQuery(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
}
