/**
 * Autousers MCP server — Prompts surface.
 *
 * MCP **Prompts** are user-invokable canned workflows the host (Claude.ai,
 * Claude Code, Cursor, …) exposes via a slash menu. The host calls
 * `prompts/list` to enumerate available prompts and `prompts/get` (with
 * user-supplied args) to materialise the starting messages of a turn.
 *
 * We ship 5 happy-path workflows so users don't have to scan ~40 tool
 * descriptions to figure out the canonical way to evaluate a URL, compare
 * two designs, etc. Each prompt returns a single `user` text message that
 * tells the host LLM exactly which Autousers tools to call, in what order,
 * with which arguments — the args the user supplied are baked into the
 * message via template literals.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
 *
 * NOTE: The orchestrator (whoever owns `index.ts`) must:
 *   1. Add `prompts: { listChanged: false }` to the server `capabilities` block.
 *   2. `import { registerAll as registerPrompts } from "./prompts.js";`
 *   3. Call `registerPrompts(server);` after the tool registrations.
 *
 * --- v0.7.1 — smart prompt resolvers ---------------------------------------
 *
 * Three of the 5 prompts (`analyze-results`, `calibrate-autouser`,
 * `triage-low-agreement`) take an evaluation/autouser id-or-name. Earlier
 * versions emitted instructions telling Claude to "call evaluations_list and
 * ask the user" — that costs a tool call + 2 conversation turns before the
 * picker shows up. v0.7.1 instead pre-fetches the list at prompt-resolution
 * time (server-side, inside the prompt handler) and bakes the rendered
 * markdown table directly into the user message, so Claude renders the
 * picker on turn 1.
 *
 * The resolver also accepts magic shortcuts: `latest` / `recent` / `1`–`99` /
 * `running` / `ended` / `list` / `pick`, plus transparent cuid-vs-name
 * detection on the first positional arg (Claude Code passes the user's free
 * text into `evaluationId` whether or not it's actually a cuid; we sniff the
 * pattern and fall through to name lookup without a wasted round-trip).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { api, AutousersApiError, MissingApiKeyError } from "./client.js";

// ---------------------------------------------------------------------------
// Prompt 1 — evaluate-url
// ---------------------------------------------------------------------------

const evaluateUrlArgs = {
  url: z
    .string()
    .url()
    .describe("Public URL of the design/page to evaluate (must be reachable)."),
  instructions: z
    .string()
    .optional()
    .describe(
      "Optional extra instructions for the autouser (e.g. 'focus on checkout flow')."
    ),
  autouserId: z
    .string()
    .optional()
    .describe("Optional autouser id. Defaults to 'power-user' if omitted."),
};

// ---------------------------------------------------------------------------
// Prompt 2 — compare-designs
// ---------------------------------------------------------------------------

const compareDesignsArgs = {
  urlA: z.string().url().describe("URL of design A (the 'current' side)."),
  urlB: z.string().url().describe("URL of design B (the 'variant' side)."),
  labelA: z.string().optional().describe("Optional label for design A."),
  labelB: z.string().optional().describe("Optional label for design B."),
  autouserId: z
    .string()
    .optional()
    .describe("Optional autouser id. Defaults to 'power-user' if omitted."),
};

// ---------------------------------------------------------------------------
// Prompt 3 — analyze-results
// ---------------------------------------------------------------------------
//
// `evaluationId` and `evaluationName` are both optional and both routed
// through the smart resolver — see `resolveEntity` for the full grammar
// (cuid, magic shortcut, list position, fuzzy name).
// ---------------------------------------------------------------------------

const analyzeResultsArgs = {
  evaluationId: z
    .string()
    .optional()
    .describe(
      "Evaluation cuid (e.g., cmofs...). Or pass any string here if you don't have an id — it'll be treated as a name lookup."
    ),
  evaluationName: z
    .string()
    .optional()
    .describe(
      "Name to fuzzy-match against. Or magic values: 'latest' / 'recent', 'list' / 'pick', '1'–'99' (list position), or status names like 'running' / 'ended'."
    ),
};

// ---------------------------------------------------------------------------
// Prompt 4 — calibrate-autouser
// ---------------------------------------------------------------------------

const calibrateAutouserArgs = {
  autouserId: z
    .string()
    .optional()
    .describe(
      "Autouser id (e.g., 'power-user'). Or pass any string here if you don't have an id — it'll be treated as a name lookup."
    ),
  autouserName: z
    .string()
    .optional()
    .describe(
      "Name to fuzzy-match against. Or magic values: 'latest' / 'recent', 'list' / 'pick', '1'–'99' (list position)."
    ),
  evaluationId: z
    .string()
    .optional()
    .describe(
      "Evaluation cuid (e.g., cmofs...). Or pass any string here if you don't have an id — it'll be treated as a name lookup."
    ),
  evaluationName: z
    .string()
    .optional()
    .describe(
      "Name to fuzzy-match against. Or magic values: 'latest' / 'recent', 'list' / 'pick', '1'–'99' (list position), or status names like 'running' / 'ended'."
    ),
  commitOnFinish: z
    .boolean()
    .optional()
    .describe(
      "If true, automatically freeze the rubric once kappa stabilises. Default: false (ask user first)."
    ),
};

// ---------------------------------------------------------------------------
// Prompt 5 — triage-low-agreement
// ---------------------------------------------------------------------------

const triageLowAgreementArgs = {
  evaluationId: z
    .string()
    .optional()
    .describe(
      "Evaluation cuid (e.g., cmofs...). Or pass any string here if you don't have an id — it'll be treated as a name lookup."
    ),
  evaluationName: z
    .string()
    .optional()
    .describe(
      "Name to fuzzy-match against. Or magic values: 'latest' / 'recent', 'list' / 'pick', '1'–'99' (list position), or status names like 'running' / 'ended'."
    ),
};

// ---------------------------------------------------------------------------
// Smart resolver — `resolveEntity`
// ---------------------------------------------------------------------------
//
// Routes the user's `*Id` and `*Name` args to one of:
//   • verbatim cuid → { resolvedId: id, preamble: "" }
//   • magic shortcut ("latest", "1", "running", "list") → fetch + resolve
//   • fuzzy name match → fetch + filter; pick if unique, else picker
//   • nothing supplied → render the inline picker
//
// The preamble is markdown that gets prepended to the user message. The
// resolver swallows API errors and renders a graceful "couldn't fetch" line
// rather than throwing — a flaky API shouldn't break the prompt.
// ---------------------------------------------------------------------------

type EntityKind = "evaluation" | "autouser";

interface ResolvedEntity {
  /** Markdown to inject at the top of the user message. May be empty. */
  preamble: string;
  /** When non-null, the resolver picked an id and the prompt body should use it. */
  resolvedId: string | null;
}

interface EvaluationRow {
  id: string;
  name: string;
  type?: string;
  status?: string;
  ratingsCount?: number;
  updatedAt?: string;
}

interface AutouserRow {
  id: string;
  name: string;
  description?: string | null;
  visibility?: string;
  source?: "built-in" | "custom";
  isSystem?: boolean;
}

/**
 * Cuid pattern. Prisma cuids start with 'c' and are 20+ chars of [a-z0-9].
 * Built-in autouser ids (e.g. "power-user", "screen-reader") deliberately
 * do NOT match this — they fall through to name resolution, which finds them
 * by id-as-name (the substring match is permissive enough).
 */
const CUID_RE = /^c[a-z0-9]{20,}$/i;

/** Words that mean "show me the list and let me pick". */
const PICKER_WORDS = new Set([
  "list",
  "pick",
  "show",
  "which",
  "choose",
  "select",
  "menu",
]);

/** Words that mean "give me the most recent one". */
const LATEST_WORDS = new Set([
  "latest",
  "recent",
  "most recent",
  "newest",
  "last",
]);

/** Evaluation status values that double as filter shortcuts. */
const EVAL_STATUSES = new Set(["running", "ended", "draft", "archived"]);

async function resolveEntity(
  kind: EntityKind,
  rawId: string | undefined,
  rawName: string | undefined
): Promise<ResolvedEntity> {
  // (a) Verbatim cuid — happy path, no preamble, no API call.
  if (rawId && CUID_RE.test(rawId.trim())) {
    return { preamble: "", resolvedId: rawId.trim() };
  }

  // (b) Misrouted positional arg — Claude Code stuffs the user's text into
  // the first schema slot (`*Id`) regardless of whether it's actually an
  // id. If it doesn't match the cuid pattern, demote it to a name lookup so
  // we don't fail an `evaluations_get` round-trip just to discover the
  // string was a name all along.
  const queryRaw = (rawName ?? rawId ?? "").trim();

  // (d) Nothing supplied — render the picker.
  if (!queryRaw) {
    return renderPicker(kind);
  }

  const queryLower = queryRaw.toLowerCase();

  // (c1) Picker shortcuts.
  if (PICKER_WORDS.has(queryLower)) {
    return renderPicker(kind);
  }

  // (c2) "latest" / "recent" / "newest" — first row of the default-ordered list.
  if (LATEST_WORDS.has(queryLower)) {
    const list = await fetchList(kind);
    if (list.error) return errorPreamble(list.error);
    if (list.rows.length === 0) {
      return {
        preamble: emptyListPreamble(kind, `No ${pluralLabel(kind)} found.`),
        resolvedId: null,
      };
    }
    const first = list.rows[0];
    return {
      preamble: `Resolved "${queryRaw}" → **${first.name}** (id \`${first.id}\`) — most recently updated.`,
      resolvedId: first.id,
    };
  }

  // (c3) Numeric — list position (1-indexed).
  if (/^\d{1,2}$/.test(queryRaw)) {
    const idx = Number(queryRaw) - 1;
    const list = await fetchList(kind);
    if (list.error) return errorPreamble(list.error);
    if (list.rows.length === 0) {
      return {
        preamble: emptyListPreamble(kind, `No ${pluralLabel(kind)} found.`),
        resolvedId: null,
      };
    }
    if (idx < 0 || idx >= list.rows.length) {
      const picker = renderPickerFromRows(kind, list.rows);
      return {
        preamble: `⚠️ Position ${queryRaw} is out of range (${list.rows.length} ${pluralLabel(kind)} available).\n\n${picker}`,
        resolvedId: null,
      };
    }
    const picked = list.rows[idx];
    return {
      preamble: `Resolved position ${queryRaw} → **${picked.name}** (id \`${picked.id}\`).`,
      resolvedId: picked.id,
    };
  }

  // (c4) Status filter (evaluation only).
  if (kind === "evaluation" && EVAL_STATUSES.has(queryLower)) {
    const list = await fetchList(kind);
    if (list.error) return errorPreamble(list.error);
    const matches = (list.rows as EvaluationRow[]).filter(
      (r) => (r.status ?? "").toLowerCase() === queryLower
    );
    if (matches.length === 0) {
      return {
        preamble: `No evaluations with status \`${queryLower}\` found.\n\n${renderPickerFromRows(kind, list.rows)}`,
        resolvedId: null,
      };
    }
    if (matches.length === 1) {
      const m = matches[0];
      return {
        preamble: `Resolved status "${queryLower}" → **${m.name}** (id \`${m.id}\`) — the only ${queryLower} evaluation.`,
        resolvedId: m.id,
      };
    }
    return {
      preamble: `Multiple evaluations have status \`${queryLower}\` — pick one:\n\n${renderPickerFromRows(kind, matches)}`,
      resolvedId: null,
    };
  }

  // (c5) Fuzzy name match — substring, case-insensitive.
  const list = await fetchList(kind);
  if (list.error) return errorPreamble(list.error);
  const matches = list.rows.filter((r) =>
    r.name.toLowerCase().includes(queryLower)
  );
  if (matches.length === 1) {
    const m = matches[0];
    return {
      preamble: `Resolved "${queryRaw}" → **${m.name}** (id \`${m.id}\`).`,
      resolvedId: m.id,
    };
  }
  if (matches.length === 0) {
    return {
      preamble: `No ${singularLabel(kind)} matched "${queryRaw}". Pick from the list:\n\n${renderPickerFromRows(kind, list.rows)}`,
      resolvedId: null,
    };
  }
  return {
    preamble: `Multiple ${pluralLabel(kind)} matched "${queryRaw}" — pick one:\n\n${renderPickerFromRows(kind, matches)}`,
    resolvedId: null,
  };
}

// ---------------------------------------------------------------------------
// List fetcher — wraps `api()` and normalises the rows into the table shape.
// ---------------------------------------------------------------------------

interface ListFetchResult {
  /** Heterogeneous — narrow to EvaluationRow[] or AutouserRow[] at the call
   *  site by branching on `kind`. The picker renderer does this implicitly
   *  by reading only the fields each shape exposes. */
  rows: Array<EvaluationRow | AutouserRow>;
  error: string | null;
}

async function fetchList(kind: EntityKind): Promise<ListFetchResult> {
  const path =
    kind === "evaluation"
      ? "/api/v1/evaluations?limit=20"
      : "/api/v1/autousers?limit=20";
  try {
    const { data } = await api<{ data: unknown }>(path);
    const rows = Array.isArray(data?.data) ? (data.data as unknown[]) : [];
    return { rows: rows as Array<EvaluationRow | AutouserRow>, error: null };
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return { rows: [], error: "AUTOUSERS_API_KEY is not set" };
    }
    if (err instanceof AutousersApiError) {
      return { rows: [], error: `${err.status} ${err.message}` };
    }
    return {
      rows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Picker rendering
// ---------------------------------------------------------------------------

async function renderPicker(kind: EntityKind): Promise<ResolvedEntity> {
  const list = await fetchList(kind);
  if (list.error) return errorPreamble(list.error);
  if (list.rows.length === 0) {
    return {
      preamble: emptyListPreamble(kind, `No ${pluralLabel(kind)} found.`),
      resolvedId: null,
    };
  }
  return {
    preamble: renderPickerFromRows(kind, list.rows),
    resolvedId: null,
  };
}

function renderPickerFromRows(
  kind: EntityKind,
  rows: Array<EvaluationRow | AutouserRow>
): string {
  if (kind === "evaluation") {
    const evals = rows as EvaluationRow[];
    const header =
      "**Pick an evaluation** (reply with its number, name, or id):\n\n" +
      "| # | Name | Type | Status | Ratings | Updated |\n" +
      "| --- | --- | --- | --- | --- | --- |";
    const body = evals
      .slice(0, 20)
      .map((e, i) =>
        [
          i + 1,
          escapeCell(e.name),
          escapeCell(e.type ?? "—"),
          escapeCell(e.status ?? "—"),
          e.ratingsCount ?? 0,
          formatRelative(e.updatedAt),
        ].join(" | ")
      )
      .map((line) => `| ${line} |`)
      .join("\n");
    return `${header}\n${body}`;
  }
  const autousers = rows as AutouserRow[];
  const header =
    "**Pick an autouser** (reply with its number, name, or id):\n\n" +
    "| # | Name | Source | Visibility | Description |\n" +
    "| --- | --- | --- | --- | --- |";
  const body = autousers
    .slice(0, 20)
    .map((a, i) =>
      [
        i + 1,
        escapeCell(a.name),
        escapeCell(a.source ?? (a.isSystem ? "built-in" : "custom")),
        escapeCell(a.visibility ?? "—"),
        escapeCell(truncate(a.description ?? "", 60)),
      ].join(" | ")
    )
    .map((line) => `| ${line} |`)
    .join("\n");
  return `${header}\n${body}`;
}

function emptyListPreamble(kind: EntityKind, msg: string): string {
  const label = singularLabel(kind);
  return `${msg} You can still pass an ${label} id or name explicitly when you have one.`;
}

function errorPreamble(err: string): ResolvedEntity {
  return {
    preamble: `⚠️ Couldn't fetch the list (\`${err}\`). You can still pass an id or name explicitly.`,
    resolvedId: null,
  };
}

// ---------------------------------------------------------------------------
// Tiny formatting helpers
// ---------------------------------------------------------------------------

function singularLabel(kind: EntityKind): string {
  return kind === "evaluation" ? "evaluation" : "autouser";
}

function pluralLabel(kind: EntityKind): string {
  return kind === "evaluation" ? "evaluations" : "autousers";
}

function escapeCell(s: string): string {
  // Markdown table cells: pipes break the layout, newlines ditto.
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * "Just now" / "5m ago" / "2h ago" / "3d ago" / "Apr 12" / "—".
 * Cutoffs:
 *   • < 60s        → "just now"
 *   • < 60min      → "<n>m ago"
 *   • < 24h        → "<n>h ago"
 *   • < 30d        → "<n>d ago"
 *   • else         → ISO date (YYYY-MM-DD) — anything older than a month is
 *                    rare on a hot list, and an exact date is more useful
 *                    than "32d ago" once we cross that boundary.
 */
function formatRelative(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

/**
 * Glue helper: concatenate a resolver preamble with the prompt body. Adds a
 * markdown rule between the two so the picker/resolution-note feels like a
 * separate block from the workflow instructions.
 */
function joinPreambles(...preambles: string[]): string {
  const nonEmpty = preambles.filter((p) => p && p.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  return `${nonEmpty.join("\n\n")}\n\n---\n\n`;
}

/**
 * When the resolver returned `resolvedId: null` we don't have an id to bake
 * into the workflow body — but we still want to ship the workflow text so
 * Claude has context once the user picks. This helper picks the right
 * lead-in sentence depending on whether resolution succeeded.
 */
function workflowLeadIn(resolvedId: string | null, label: string): string {
  if (resolvedId) {
    return `Run the ${label} workflow on \`${resolvedId}\`.`;
  }
  // CRITICAL — when the resolver returned a picker preamble, Claude reads
  // the whole prompt as context and tends to summarise it ("Waiting for
  // your pick") instead of echoing the markdown table verbatim. The
  // capitalised directives below force a literal copy of the table to the
  // user as the first chat output, then a single clarifying question, then
  // a hard stop pending the reply.
  return `**RESPOND TO THE USER NOW** by copying the markdown picker table above into your reply EXACTLY AS WRITTEN — preserve every header, column, row, and divider. Do NOT paraphrase, summarise, or condense it.

Below the table, write a single short line such as: "Reply with a number (1, 2, …), the name, or the id."

Do NOT call any tools yet. Do NOT continue the workflow. After the user replies with their pick, resolve it to an id and THEN run the ${label} workflow on that selection.`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function registerAll(server: McpServer): void {
  // -------------------------------------------------------------------------
  // 1. evaluate-url
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "evaluate-url",
    {
      title: "Evaluate URL",
      description:
        "Run a single-stimulus Autousers evaluation against a URL and surface the score breakdown.",
      argsSchema: evaluateUrlArgs,
    },
    ({ url, instructions, autouserId }) => {
      const chosenAutouser = autouserId ?? "power-user";
      const extra = instructions
        ? `\n\nAdditional instructions from the user: ${instructions}`
        : "";
      const text = `The user wants to evaluate the design at ${url} using the Autousers MCP server. Execute this workflow end-to-end:

1. Call \`evaluations_create\` with these arguments:
   - \`type\`: "SSE"
   - \`name\`: "Eval: ${url}"
   - \`status\`: "Running"
   - \`designUrls\`: [{ "id": "d1", "url": "${url}" }]
   - \`selectedAutousers\`: [{ "autouserId": "${chosenAutouser}", "agentCount": 1 }]

2. From the response, extract the new evaluation \`id\`. Then call \`autousers_run\` with:
   - \`evaluationId\`: <id from step 1>
   - \`autouserIds\`: ["${chosenAutouser}"]

3. Poll \`autouser_status_get\` (passing the evaluation id and autouser id) every ~10 seconds until the status is \`Completed\` or \`Failed\`. If it stays \`Running\` for more than ~3 minutes, surface a status update to the user but keep polling.

4. Once complete, call \`evaluations_results_get\` with the evaluation id.

5. Surface a concise summary to the user: overall score, top-scoring dimension, lowest-scoring dimension, and the \`links.results\` URL from the eval response so they can open the full report.${extra}`;

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // 2. compare-designs
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "compare-designs",
    {
      title: "Compare Designs",
      description:
        "Run a side-by-side Autousers evaluation between two URLs and explain which design won per dimension.",
      argsSchema: compareDesignsArgs,
    },
    ({ urlA, urlB, labelA, labelB, autouserId }) => {
      const chosenAutouser = autouserId ?? "power-user";
      const lblA = labelA ?? "Design A";
      const lblB = labelB ?? "Design B";
      const pairLabel = `${lblA} vs ${lblB}`;
      const text = `The user wants to compare two designs head-to-head using the Autousers MCP server (side-by-side, SxS). Execute this workflow end-to-end:

1. Call \`evaluations_create\` with these arguments:
   - \`type\`: "SxS"
   - \`name\`: "SxS: ${pairLabel}"
   - \`status\`: "Running"
   - \`comparisonPairs\`: [{
       "id": "p1",
       "currentUrl": "${urlA}",
       "variantUrl": "${urlB}",
       "label": "${pairLabel}"
     }]
   - \`selectedAutousers\`: [{ "autouserId": "${chosenAutouser}", "agentCount": 1 }]

2. From the response, extract the new evaluation \`id\`. Then call \`autousers_run\` with:
   - \`evaluationId\`: <id from step 1>
   - \`autouserIds\`: ["${chosenAutouser}"]

3. Poll \`autouser_status_get\` until the run is \`Completed\` or \`Failed\` (every ~10s; warn after ~3 minutes).

4. Once complete, call \`evaluations_results_get\` with the evaluation id.

5. For each dimension in the results, determine the winner (${lblA}, ${lblB}, or tie) and surface a per-dimension breakdown plus an overall recommendation. Include the \`links.results\` URL so the user can drill in.`;

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // 3. analyze-results
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "analyze-results",
    {
      title: "Analyze Results",
      description:
        "Pull eval results, agreement, and AI insights for an evaluation and produce an executive summary.",
      argsSchema: analyzeResultsArgs,
    },
    async ({ evaluationId, evaluationName }) => {
      const ev = await resolveEntity(
        "evaluation",
        evaluationId,
        evaluationName
      );
      const idForBody =
        ev.resolvedId ??
        "<the id of the evaluation the user picked from the table above>";
      const lead = workflowLeadIn(ev.resolvedId, "analyze-results");

      const text = `${joinPreambles(ev.preamble)}${lead}

The user wants an executive summary of an Autousers evaluation. Execute this workflow:

1. Call \`evaluations_get\` with \`id\`: "${idForBody}" to load the eval's name, type, status, and configuration. Use this for context only — don't recite it back.

2. In parallel, fetch the analytical surfaces:
   - \`evaluations_results_get\` with \`id\`: "${idForBody}"
   - \`evaluations_agreement_get\` with \`id\`: "${idForBody}"
   - \`evaluations_ai_insights_get\` with \`id\`: "${idForBody}"

3. Synthesise a short executive summary (≤ 8 bullet points):
   - **Top finding** — the single most important thing the AI insights or results call out.
   - **Biggest gap** — the lowest-scoring dimension (or the SxS dimension with the largest delta).
   - **Kappa interpretation** — overall inter-rater agreement, in plain English: < 0.2 = poor, 0.2–0.4 = fair, 0.4–0.6 = moderate, 0.6–0.8 = substantial, > 0.8 = almost perfect. Call out any dimension whose kappa is below 0.4.
   - **Two actionable recommendations** — concrete next steps (e.g. "tighten the rubric for Visual Hierarchy", "add a follow-up SxS against the proposed redesign").
   - The \`links.results\` URL from the eval response so the user can open the full report.

Keep it tight and skimmable — this is a briefing, not a transcript.`;

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // 4. calibrate-autouser
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "calibrate-autouser",
    {
      title: "Calibrate Autouser",
      description:
        "Start a calibration run for an autouser, watch kappa stabilise, then optimize or freeze the rubric.",
      argsSchema: calibrateAutouserArgs,
    },
    async ({
      autouserId,
      autouserName,
      evaluationId,
      evaluationName,
      commitOnFinish,
    }) => {
      const [au, ev] = await Promise.all([
        resolveEntity("autouser", autouserId, autouserName),
        resolveEntity("evaluation", evaluationId, evaluationName),
      ]);
      const auId =
        au.resolvedId ??
        "<the id of the autouser the user picked from the table above>";
      const evId =
        ev.resolvedId ??
        "<the id of the evaluation the user picked from the table above>";

      const lead = (() => {
        if (au.resolvedId && ev.resolvedId) {
          return `Run the calibrate-autouser workflow with autouser \`${auId}\` against evaluation \`${evId}\`.`;
        }
        return `**Wait for the user to make their selection(s) from the table(s) above before proceeding.** Once both an autouser and an evaluation are chosen, run the calibrate-autouser workflow on them. Do NOT proceed past this step until both are picked.`;
      })();

      const finishStep = commitOnFinish
        ? `5. The user has pre-authorised committing on finish. Once kappa is stable for two consecutive polls (delta < 0.02), call \`autousers_calibration_freeze\` with \`autouserId\`: "${auId}" and \`evaluationId\`: "${evId}" to lock the current rubric. Surface the final kappa per dimension and confirm the freeze succeeded.`
        : `5. Cluster the disagreements by dimension (which dimensions have the lowest kappa? where does the autouser systematically diverge from the human raters?). Surface the top 2-3 problem dimensions to the user.

6. Ask the user how they'd like to proceed:
   - **Optimize** — call \`autousers_calibration_optimize\` (uses Gemini to refine the rubric and re-run). Best when disagreements look like rubric ambiguity.
   - **Freeze** — call \`autousers_calibration_freeze\` to lock the current rubric. Best when kappa is already acceptable (≥ 0.6) and further tuning would overfit.
   - **Neither** — let them iterate manually via the UI.

   Do NOT call optimize or freeze without an explicit user confirmation.`;

      const text = `${joinPreambles(au.preamble, ev.preamble)}${lead}

The user wants to calibrate an autouser against an evaluation using the Autousers MCP server. Execute this workflow:

1. Call \`autousers_calibration_start\` with:
   - \`autouserId\`: "${auId}"
   - \`evaluationId\`: "${evId}"

2. Poll \`autousers_calibration_status_get\` (with the same \`autouserId\` and \`evaluationId\`) every ~15 seconds. Track the overall kappa value across polls.

3. Consider kappa "stable" when its absolute change across two consecutive polls is less than 0.02, OR when the calibration status returns \`Completed\`/\`Failed\`. If it's been polling for more than ~5 minutes without convergence, surface a status update.

4. Once stable, surface the per-dimension kappa breakdown to the user with plain-English bands: < 0.2 = poor, 0.2–0.4 = fair, 0.4–0.6 = moderate, 0.6–0.8 = substantial, > 0.8 = almost perfect.

${finishStep}`;

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // 5. triage-low-agreement
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "triage-low-agreement",
    {
      title: "Triage Low Agreement",
      description:
        "Identify low-kappa dimensions in an evaluation and propose rubric clarifications to reduce ambiguity.",
      argsSchema: triageLowAgreementArgs,
    },
    async ({ evaluationId, evaluationName }) => {
      const ev = await resolveEntity(
        "evaluation",
        evaluationId,
        evaluationName
      );
      const idForBody =
        ev.resolvedId ??
        "<the id of the evaluation the user picked from the table above>";
      const lead = workflowLeadIn(ev.resolvedId, "triage-low-agreement");

      const text = `${joinPreambles(ev.preamble)}${lead}

The user wants to triage low-agreement dimensions in an Autousers evaluation. Execute this workflow:

1. Call \`evaluations_agreement_get\` with \`id\`: "${idForBody}". Identify every dimension whose kappa is below 0.4 (poor agreement). If none are below 0.4, tell the user agreement is healthy and stop here.

2. For context, call \`evaluations_ratings_list\` with \`evaluationId\`: "${idForBody}" to load the per-rater ratings. For each low-kappa dimension from step 1:
   - Compute the per-rater spread (which raters scored high, which scored low).
   - Look for patterns: is one rater consistently an outlier? Are scores bimodal (suggests an ambiguous rubric)? Do humans diverge from the autouser systematically?

3. For each low-kappa dimension, draft 2-3 specific, actionable rubric clarifications. Examples of the right shape:
   - "Define what counts as 'cluttered' — currently raters disagree on density vs. hierarchy."
   - "Add a worked example for score 3 vs. score 4 on Visual Hierarchy."
   - "Specify whether mobile responsiveness counts toward the Accessibility score."

4. Surface the findings to the user as a structured table or bullet list (dimension → kappa → diagnosis → proposed clarifications).

5. Offer to apply the rubric clarifications by calling \`templates_update\` (you'll need the template id, which you can find via \`evaluations_get\` for "${idForBody}"). **Do NOT call \`templates_update\` without explicit user confirmation** — they may want to edit the wording first.`;

      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text },
          },
        ],
      };
    }
  );
}
