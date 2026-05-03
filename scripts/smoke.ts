#!/usr/bin/env tsx
/**
 * Autousers MCP smoke harness.
 *
 * Spawns the BUILT MCP server (`dist/index.js`) as a subprocess, speaks
 * JSON-RPC over stdio via the official MCP Client SDK, and exercises every
 * read-only tool with a minimal-but-valid input. The point: catch the class
 * of bug where an agent-authored MCP `inputSchema` doesn't match the
 * route-side zod schema (wrong field name, missing required field, type
 * mismatch). Each tool is reported PASS / FAIL / SKIP with the request_id
 * parsed from `ok()`'s trailer (see `mcp/src/lib/helpers.ts`).
 *
 * Usage:
 *   AUTOUSERS_API_KEY=uxr_... npx tsx scripts/smoke.ts
 *   AUTOUSERS_API_KEY=uxr_... npx tsx scripts/smoke.ts --include-writes
 *
 * Recommended npm script: `"smoke": "tsx scripts/smoke.ts"`.
 *
 * The script does NOT import from `src/` — it deliberately tests the built
 * artifact (`dist/index.js`) so the smoke matches what the host actually
 * spawns.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------------------------------------------------------------------------
// Setup / preflight
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = resolve(MCP_ROOT, "dist/index.js");

const includeWrites = process.argv.includes("--include-writes");

if (!process.env.AUTOUSERS_API_KEY) {
  console.error(
    [
      "AUTOUSERS_API_KEY is not set.",
      "",
      "Mint a key at http://localhost:3000/settings/api-keys (or your",
      "deployed app), then re-run:",
      "",
      "  AUTOUSERS_API_KEY=uxr_... npx tsx scripts/smoke.ts",
    ].join("\n")
  );
  process.exit(2);
}

if (!existsSync(SERVER_ENTRY)) {
  console.error(
    [
      `MCP server build not found at ${SERVER_ENTRY}.`,
      "",
      "Build the server first:",
      "  cd mcp && npm run build",
    ].join("\n")
  );
  process.exit(2);
}

const BASE_URL = process.env.AUTOUSERS_BASE_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

type Status = "PASS" | "FAIL" | "SKIP";
interface Row {
  tool: string;
  status: Status;
  notes: string;
}
const rows: Row[] = [];

function pushRow(tool: string, status: Status, notes: string): void {
  rows.push({ tool, status, notes });
}

// Parse `(request_id: 01ABCD...)` from an `ok()` trailer.
function parseRequestId(text: string): string | null {
  const m = text.match(/\(request_id:\s*([^)]+)\)/);
  return m ? m[1].trim() : null;
}

// Pull the leading JSON payload out of a tool result's text content. `okEval`
// wraps the JSON in a fenced block (```json ... ```); plain `ok` just dumps
// the JSON. Try both.
function extractJson(text: string): unknown | null {
  const fenced = text.match(/```json\n([\s\S]*?)\n```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
  // Otherwise, strip the trailer and parse the leading object.
  const stripped = text.replace(/\n\n\(request_id:[^)]+\)\s*$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function summarizeData(data: unknown): string {
  if (data === null || data === undefined) return "no data";
  // API responses are typically `{ data: ... }` envelopes.
  const inner = (data as { data?: unknown }).data ?? data;
  if (Array.isArray(inner)) return `${inner.length} results`;
  if (typeof inner === "object" && inner !== null) {
    const keys = Object.keys(inner as Record<string, unknown>);
    return `object{${keys.slice(0, 3).join(",")}${keys.length > 3 ? "..." : ""}}`;
  }
  return typeof inner;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

const stderrChunks: string[] = [];

const transport = new StdioClientTransport({
  command: process.execPath, // current `node`
  args: [SERVER_ENTRY],
  env: {
    AUTOUSERS_API_KEY: process.env.AUTOUSERS_API_KEY,
    AUTOUSERS_BASE_URL: BASE_URL,
    PATH: process.env.PATH ?? "",
  },
  stderr: "pipe",
});

const client = new Client({ name: "autousers-mcp-smoke", version: "0.0.1" });

let stderrStream: NodeJS.ReadableStream | null = null;
try {
  await client.connect(transport);
  stderrStream = transport.stderr as NodeJS.ReadableStream | null;
  stderrStream?.on("data", (buf: Buffer) => {
    stderrChunks.push(buf.toString("utf8"));
  });
} catch (err) {
  console.error("Failed to start MCP server subprocess:");
  console.error(stderrChunks.join("") || (err as Error).message);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Enumerate tools
// ---------------------------------------------------------------------------

const { tools } = await client.listTools();

interface ToolInfo {
  name: string;
  readOnly: boolean;
}
const toolList: ToolInfo[] = tools.map((t) => ({
  name: t.name,
  readOnly: t.annotations?.readOnlyHint === true,
}));
const toolNames = new Set(toolList.map((t) => t.name));
const readOnlyNames = new Set(
  toolList.filter((t) => t.readOnly).map((t) => t.name)
);

// ---------------------------------------------------------------------------
// Helper to call a tool and turn the result into a Row
// ---------------------------------------------------------------------------

interface CallOutcome {
  ok: boolean;
  text: string;
  requestId: string | null;
  data: unknown | null;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<CallOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text =
    result.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n") ?? "";
  return {
    ok: !result.isError,
    text,
    requestId: parseRequestId(text),
    data: extractJson(text),
  };
}

async function smokeTool(
  name: string,
  args: Record<string, unknown>,
  noteFromData?: (data: unknown, requestId: string | null) => string
): Promise<CallOutcome | null> {
  if (!toolNames.has(name)) {
    pushRow(name, "SKIP", "tool not registered (culled?)");
    return null;
  }
  try {
    const outcome = await callTool(name, args);
    if (outcome.ok) {
      const note = noteFromData
        ? noteFromData(outcome.data, outcome.requestId)
        : `${summarizeData(outcome.data)}, request_id=${outcome.requestId ?? "<none>"}`;
      pushRow(name, "PASS", note);
    } else {
      // Trim multi-line stack traces to one line for the table.
      const firstLine = outcome.text.split("\n").find((l) => l.trim()) ?? "";
      pushRow(name, "FAIL", firstLine.slice(0, 240));
    }
    return outcome;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushRow(name, "FAIL", msg.slice(0, 240));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache: ids harvested from list calls so subsequent get/detail calls have
// something valid to pass.
// ---------------------------------------------------------------------------

interface IdCache {
  templateId?: string;
  evaluationId?: string;
  autouserId?: string;
  teamId?: string;
  runId?: string;
}
const cache: IdCache = {};

function firstId(data: unknown): string | undefined {
  if (!data) return undefined;
  const inner = (data as { data?: unknown }).data ?? data;
  if (!Array.isArray(inner) || inner.length === 0) return undefined;
  const first = inner[0] as { id?: string };
  return typeof first?.id === "string" ? first.id : undefined;
}

// ---------------------------------------------------------------------------
// Phase 1: list calls (harvest ids)
// ---------------------------------------------------------------------------

const listResults = await Promise.all([
  smokeTool("templates_list", {}, (data, rid) => {
    cache.templateId = firstId(data);
    return `${summarizeData(data)}${cache.templateId ? `, first id=${cache.templateId}` : ""}, request_id=${rid ?? "<none>"}`;
  }),
  smokeTool("evaluations_list", {}, (data, rid) => {
    cache.evaluationId = firstId(data);
    return `${summarizeData(data)}${cache.evaluationId ? `, first id=${cache.evaluationId}` : ""}, request_id=${rid ?? "<none>"}`;
  }),
  smokeTool("autousers_list", {}, (data, rid) => {
    cache.autouserId = firstId(data);
    return `${summarizeData(data)}${cache.autouserId ? `, first id=${cache.autouserId}` : ""}, request_id=${rid ?? "<none>"}`;
  }),
  smokeTool("teams_list", {}, (data, rid) => {
    cache.teamId = firstId(data);
    return `${summarizeData(data)}${cache.teamId ? `, first id=${cache.teamId}` : ""}, request_id=${rid ?? "<none>"}`;
  }),
]);
void listResults;

// ---------------------------------------------------------------------------
// Phase 2: get-by-id calls (depend on Phase 1 cache)
// ---------------------------------------------------------------------------

if (cache.templateId) {
  await smokeTool("templates_get", { id: cache.templateId });
} else {
  if (toolNames.has("templates_get"))
    pushRow("templates_get", "SKIP", "no templates available");
}

if (cache.evaluationId) {
  await smokeTool("evaluations_get", { id: cache.evaluationId });
} else if (toolNames.has("evaluations_get")) {
  pushRow("evaluations_get", "SKIP", "no evaluations available");
}

if (cache.autouserId) {
  await smokeTool("autousers_get", { id: cache.autouserId });
} else if (toolNames.has("autousers_get")) {
  pushRow("autousers_get", "SKIP", "no autousers available");
}

if (cache.teamId) {
  await smokeTool("teams_get", { id: cache.teamId });
  await smokeTool("team_members_list", { teamId: cache.teamId });
} else {
  if (toolNames.has("teams_get"))
    pushRow("teams_get", "SKIP", "no teams available");
  if (toolNames.has("team_members_list"))
    pushRow("team_members_list", "SKIP", "no teams available");
}

// ---------------------------------------------------------------------------
// Phase 3: per-evaluation read-only fan-out
// ---------------------------------------------------------------------------

const evalScopedReadOnly = [
  "evaluations_ratings_list",
  "evaluations_results_get",
  "evaluations_agreement_get",
  "evaluations_ai_insights_get",
  "evaluations_shares_list",
  "evaluations_export_get",
];

if (cache.evaluationId) {
  // ratings_list uses { evaluationId }; others use { id }.
  await smokeTool("evaluations_ratings_list", {
    evaluationId: cache.evaluationId,
  });
  for (const tool of [
    "evaluations_results_get",
    "evaluations_agreement_get",
    "evaluations_ai_insights_get",
    "evaluations_shares_list",
    "evaluations_export_get",
  ]) {
    if (toolNames.has(tool)) {
      await smokeTool(tool, { id: cache.evaluationId });
    }
  }

  // autouser_status_get → harvest first runId for run-detail tools.
  const statusOutcome = await smokeTool(
    "autouser_status_get",
    { evaluationId: cache.evaluationId },
    (data, rid) => {
      const inner = (data as { data?: { runs?: Array<{ id?: string }> } })
        ?.data;
      const runs = inner?.runs;
      if (Array.isArray(runs) && runs.length > 0) {
        const first = runs[0];
        if (typeof first?.id === "string") cache.runId = first.id;
      }
      return `${runs ? `${runs.length} runs` : "no runs field"}${cache.runId ? `, first run=${cache.runId}` : ""}, request_id=${rid ?? "<none>"}`;
    }
  );
  void statusOutcome;

  for (const tool of ["autouser_run_get", "autouser_run_turns_list"]) {
    if (!toolNames.has(tool)) continue;
    if (cache.runId) {
      await smokeTool(tool, {
        evaluationId: cache.evaluationId,
        runId: cache.runId,
      });
    } else {
      pushRow(tool, "SKIP", `no runs available on eval ${cache.evaluationId}`);
    }
  }
} else {
  for (const tool of [
    ...evalScopedReadOnly,
    "autouser_status_get",
    "autouser_run_get",
    "autouser_run_turns_list",
  ]) {
    if (toolNames.has(tool)) {
      pushRow(tool, "SKIP", "no evaluations available");
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4: autouser-scoped reads (calibration status)
// ---------------------------------------------------------------------------

if (toolNames.has("autousers_calibration_status_get")) {
  if (cache.autouserId) {
    const outcome = await callTool("autousers_calibration_status_get", {
      id: cache.autouserId,
    });
    if (outcome.ok) {
      pushRow(
        "autousers_calibration_status_get",
        "PASS",
        `${summarizeData(outcome.data)}, request_id=${outcome.requestId ?? "<none>"}`
      );
    } else if (/404|not found/i.test(outcome.text)) {
      pushRow(
        "autousers_calibration_status_get",
        "SKIP",
        "404 — autouser has no calibration record"
      );
    } else {
      const firstLine = outcome.text.split("\n").find((l) => l.trim()) ?? "";
      pushRow(
        "autousers_calibration_status_get",
        "FAIL",
        firstLine.slice(0, 240)
      );
    }
  } else {
    pushRow(
      "autousers_calibration_status_get",
      "SKIP",
      "no autousers available"
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 5: usage_get (no inputs needed)
// ---------------------------------------------------------------------------

if (toolNames.has("usage_get")) {
  await smokeTool("usage_get", {});
}

// ---------------------------------------------------------------------------
// Phase 6: catch any read-only tool we forgot to wire up explicitly.
// ---------------------------------------------------------------------------

const handledTools = new Set(rows.map((r) => r.tool));
for (const t of toolList) {
  if (!t.readOnly) continue;
  if (handledTools.has(t.name)) continue;
  pushRow(
    t.name,
    "SKIP",
    "no smoke recipe — add to scripts/smoke.ts when adopting this tool"
  );
}

// ---------------------------------------------------------------------------
// Phase 7 (optional): reversible writes (--include-writes)
// ---------------------------------------------------------------------------

const writeTools = toolList.filter((t) => !t.readOnly).map((t) => t.name);
const writesAttempted: string[] = [];

if (includeWrites) {
  // templates_duplicate — clones a template into the caller's active team.
  if (toolNames.has("templates_duplicate") && cache.templateId) {
    writesAttempted.push("templates_duplicate");
    await smokeTool("templates_duplicate", { id: cache.templateId });
  } else if (toolNames.has("templates_duplicate")) {
    pushRow("templates_duplicate", "SKIP", "no template to clone");
  }

  // autousers_duplicate — clones an autouser into a team.
  if (
    toolNames.has("autousers_duplicate") &&
    cache.autouserId &&
    cache.teamId
  ) {
    writesAttempted.push("autousers_duplicate");
    await smokeTool("autousers_duplicate", {
      id: cache.autouserId,
      teamId: cache.teamId,
    });
  } else if (toolNames.has("autousers_duplicate")) {
    pushRow(
      "autousers_duplicate",
      "SKIP",
      "missing autouser or team for clone target"
    );
  }
}

const skippedWrites = writeTools.filter((n) => !writesAttempted.includes(n));

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

await client.close().catch(() => {
  /* swallow — the subprocess will exit with the transport */
});

// ---------------------------------------------------------------------------
// Render report
// ---------------------------------------------------------------------------

const ICONS: Record<Status, string> = {
  PASS: "✅ PASS",
  FAIL: "❌ FAIL",
  SKIP: "⏭ SKIP",
};

console.log("");
console.log("| Tool | Status | Notes |");
console.log("| --- | --- | --- |");
for (const row of rows.sort((a, b) => a.tool.localeCompare(b.tool))) {
  const safeNotes = row.notes.replace(/\|/g, "\\|").replace(/\n/g, " ");
  console.log(`| ${row.tool} | ${ICONS[row.status]} | ${safeNotes} |`);
}

const counts = rows.reduce(
  (acc, r) => {
    acc[r.status] += 1;
    return acc;
  },
  { PASS: 0, FAIL: 0, SKIP: 0 } as Record<Status, number>
);

console.log("");
console.log(
  `${rows.length} tools tested: ${counts.PASS} PASS, ${counts.SKIP} SKIP, ${counts.FAIL} FAIL`
);

if (!includeWrites) {
  console.log(
    `Skipped ${writeTools.length} write-tools (run separately with --include-writes when ready).`
  );
} else {
  console.log(
    `Wrote ${writesAttempted.length} reversible tool(s): ${writesAttempted.join(", ") || "<none>"}.`
  );
  if (skippedWrites.length > 0) {
    console.log(
      `Skipped ${skippedWrites.length} non-reversible write-tools (cost money, send email, or destructive): ${skippedWrites.join(", ")}.`
    );
  }
}

if (stderrChunks.length > 0 && counts.FAIL > 0) {
  console.log("");
  console.log("--- subprocess stderr ---");
  console.log(stderrChunks.join(""));
}

process.exit(counts.FAIL > 0 ? 1 : 0);
