/**
 * Usage tool registry — wraps `/api/v1/usage` (and, when available, the
 * BYOK detail endpoint at `/api/v1/settings/byok`).
 *
 * Why this exists separately from `usage_get` in `settings.ts`
 * --------------------------------------------------------------
 * `usage_get` is a thin pass-through that returns the raw `/api/v1/usage`
 * envelope. That's perfect when an MCP host wants to render its own usage
 * card, but it's noisy when an LLM-driven assistant is asked the simple
 * question "how much have I used?" — the model has to JSON-spelunk
 * `freeQuota.used` vs `freeQuota.limit` and decide what to say.
 *
 * `get_usage` is the human-facing wrapper. It hits the same `/api/v1/usage`
 * route but pre-computes the three states the assistant cares about:
 *
 *   1. BYOK active — runs bill the user's own Gemini key, free quota does
 *      not apply. Surfaces the key hint + added-on date when the BYOK
 *      detail endpoint is reachable.
 *   2. Quota exhausted (and no BYOK) — prompts the user to either add a
 *      Gemini key at /settings/keys or contact support. Loudly.
 *   3. Healthy — used / limit, recent run cost, top-3 evals, and the
 *      median per-run cost so the assistant can answer "do I have quota
 *      left for one more autouser run?".
 *
 * `betaUnlimited` users (no usage cap) are detected when the API returns
 * `freeQuota.limit === null` or omits the field entirely; we surface a
 * tailored message instead of dividing by zero.
 *
 * The tool always returns the structured JSON (totals, perRun.medianCost,
 * top-3 byEval) so a downstream LLM tool-call doesn't need to re-fetch
 * to reason about cost.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, AutousersApiError } from "../client.js";
import { fail, buildQuery, type ToolResult } from "../lib/helpers.js";
import { genericObjectShape } from "../lib/output-shapes.js";

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

const getUsageShape = {
  range: z
    .enum(["7d", "30d", "90d"])
    .optional()
    .describe(
      "Time window for the cost / runs summary. Defaults to '30d'. Use '7d' for 'this week', '90d' for quarterly summaries."
    ),
};

// ---------------------------------------------------------------------------
// API response types — mirror `app/api/v1/usage/route.ts` `UsageResponse`.
// We treat every field as optional so a future API change that drops or
// renames a field surfaces as a degraded response, not a hard crash.
// ---------------------------------------------------------------------------

interface UsageEnvelope {
  range?: string;
  /**
   * True only when BYOK is saved AND active (toggle on). Source of truth
   * for the "BYOK active" branch in the summary text.
   */
  byok?: boolean;
  /**
   * True when a key is saved, regardless of `byok`. Lets the tool surface
   * the new "saved but inactive" state — runs are still on free quota even
   * though a key is on file.
   */
  byokConfigured?: boolean;
  freeQuota?: {
    used?: number | null;
    // limit may be null when the user is on betaUnlimited (no cap).
    limit?: number | null;
  };
  totals?: {
    runs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    evaluations?: number;
    autousersUsed?: number;
  };
  byEval?: Array<{
    evaluationId?: string;
    evaluationName?: string;
    runs?: number;
    tokens?: number;
    costUsd?: number;
  }>;
  daily?: Array<{
    date?: string;
    runs?: number;
    tokens?: number;
    costUsd?: number;
  }>;
  perRun?: {
    medianCost?: number;
    meanCost?: number;
    medianTokens?: number;
  };
  // betaUnlimited may be surfaced by a future API change; treat as optional.
  betaUnlimited?: boolean;
}

interface ByokEnvelope {
  // Wave 2B's `/api/v1/settings/byok` GET. Tolerant of either shape:
  //   { byok: true, hint: '••••XXXX', addedAt: '2026-04-01T...' }
  //   { configured: true, geminiApiKeyHint: '...', createdAt: '...' }
  byok?: boolean;
  configured?: boolean;
  hint?: string | null;
  geminiApiKeyHint?: string | null;
  addedAt?: string | null;
  createdAt?: string | null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const KEYS_SETTINGS_URL = "https://app.autousers.ai/settings/keys";
const USAGE_SETTINGS_URL = "https://app.autousers.ai/settings/usage";

function formatUsd(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "$0.00";
  // Per-run costs are typically <$0.20 and the cents-only representation
  // ($0.09) loses ~10–20% precision vs the source $0.0912. Use 4 decimals
  // for sub-dollar amounts so the LLM doesn't mistake $0.09 for $0.10
  // when reasoning about cost-per-run; fall back to 2 decimals for the
  // larger cumulative totals where 4 decimals are just visual noise.
  const abs = Math.abs(n);
  const decimals = abs > 0 && abs < 1 ? 4 : 2;
  return `$${n.toFixed(decimals)}`;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // Trim to YYYY-MM-DD to match the spec exactly. Avoids locale issues.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1]! : null;
}

/**
 * Treat `freeQuota.limit === null` OR a missing limit OR an explicit
 * `betaUnlimited: true` as "no cap". This matches the MEMORY note that
 * the API may return `null` when `betaUnlimited` is set on the User row.
 */
function isUnlimited(usage: UsageEnvelope): boolean {
  if (usage.betaUnlimited === true) return true;
  const limit = usage.freeQuota?.limit;
  return limit === null || limit === undefined;
}

interface BuildOptions {
  byokDetail: ByokEnvelope | null;
}

/**
 * Build the human-readable summary text for one of the three states.
 * Pure function — no side effects, easy to snapshot in tests.
 */
function buildSummaryText(
  usage: UsageEnvelope,
  range: string,
  opts: BuildOptions
): string {
  const used = usage.freeQuota?.used ?? 0;
  const limit = usage.freeQuota?.limit ?? null;
  const totals = usage.totals ?? {};
  const perRun = usage.perRun ?? {};
  const top = (usage.byEval ?? []).slice(0, 3);

  const lines: string[] = [];

  // ---------------------------------------------------------------------
  // State 1: betaUnlimited — no cap, no upgrade prompt, no BYOK message.
  // ---------------------------------------------------------------------
  if (isUnlimited(usage)) {
    lines.push("You have unlimited beta quota.");
    lines.push("");
    lines.push(
      `Last ${range}: ${totals.runs ?? 0} run(s), ${formatUsd(
        totals.costUsd
      )} in Gemini token cost.`
    );
    if (typeof perRun.medianCost === "number" && (totals.runs ?? 0) > 0) {
      lines.push(`Median cost per run: ${formatUsd(perRun.medianCost)}.`);
    }
    appendTopEvals(lines, top);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------
  // State 2: BYOK active — runs use the user's Gemini key.
  // ---------------------------------------------------------------------
  if (usage.byok === true) {
    const hint =
      opts.byokDetail?.hint ?? opts.byokDetail?.geminiApiKeyHint ?? null;
    const added = formatDate(
      opts.byokDetail?.addedAt ?? opts.byokDetail?.createdAt
    );

    let header = "Bring-your-own-key is active — runs use your Gemini API key";
    const meta: string[] = [];
    if (hint) meta.push(`hint: ${hint}`);
    if (added) meta.push(`added ${added}`);
    if (meta.length > 0) header += ` (${meta.join(", ")})`;
    header += ". Free quota does not apply.";
    lines.push(header);
    lines.push("");
    lines.push(
      `Last ${range}: ${totals.runs ?? 0} run(s), ${formatUsd(
        totals.costUsd
      )} in Gemini token cost.`
    );
    if (typeof perRun.medianCost === "number" && (totals.runs ?? 0) > 0) {
      lines.push(`Median cost per run: ${formatUsd(perRun.medianCost)}.`);
    }
    appendTopEvals(lines, top);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------
  // State 3: Free quota — healthy or exhausted. Includes the new
  //          "saved but inactive" sub-state where the user has a key
  //          on file but hasn't flipped `byokActive` on.
  // ---------------------------------------------------------------------
  const numericLimit = typeof limit === "number" ? limit : 0;
  const exhausted = numericLimit > 0 && used >= numericLimit;
  // We've already returned above when `usage.byok === true`, so reaching here
  // implies BYOK is off (or undefined). Parked = a key is on file but the
  // toggle is off — runs still consume free quota.
  const byokParked = usage.byokConfigured === true;

  if (byokParked) {
    // Saved-but-off: explicit message so the user understands why their
    // saved key isn't billing the run. Includes the toggle URL.
    lines.push(
      "Bring-your-own-key is configured but inactive — runs are using your free quota. " +
        `Toggle it on at ${USAGE_SETTINGS_URL} to use your key.`
    );
    if (exhausted) {
      // Edge case worth surfacing: parked key + free quota dry. Activating
      // the key fixes both problems at once.
      lines.push(
        `You've used ${used} / ${numericLimit} free runs. Activating your saved key would let you keep running immediately.`
      );
    } else {
      const remaining = Math.max(0, numericLimit - used);
      lines.push(
        `You've used ${used} / ${numericLimit} free autouser runs (${remaining} remaining).`
      );
    }
  } else if (exhausted) {
    lines.push(
      `You've used ${used} / ${numericLimit} free runs. Add a Gemini API key at ${KEYS_SETTINGS_URL} to keep running, or contact support to request more quota.`
    );
  } else {
    const remaining = Math.max(0, numericLimit - used);
    lines.push(
      `You've used ${used} / ${numericLimit} free autouser runs (${remaining} remaining).`
    );
  }
  lines.push("");
  lines.push(
    `Last ${range}: ${totals.runs ?? 0} run(s), ${formatUsd(
      totals.costUsd
    )} in Gemini token cost.`
  );
  if (typeof perRun.medianCost === "number" && (totals.runs ?? 0) > 0) {
    lines.push(`Median cost per run: ${formatUsd(perRun.medianCost)}.`);
  }
  appendTopEvals(lines, top);
  return lines.join("\n");
}

function appendTopEvals(
  lines: string[],
  top: NonNullable<UsageEnvelope["byEval"]>
): void {
  if (top.length === 0) return;
  lines.push("");
  lines.push("Top evaluations by cost:");
  for (const ev of top) {
    const name = ev.evaluationName ?? ev.evaluationId ?? "(unknown)";
    lines.push(`  - ${name}: ${ev.runs ?? 0} run(s), ${formatUsd(ev.costUsd)}`);
  }
}

/**
 * Try to fetch BYOK details from `/api/v1/settings/byok`. The endpoint is
 * created by Wave 2B and may not exist in older builds — a 404 is treated
 * as "no detail available", not as an error. Anything else (auth failures,
 * 5xx) bubbles to the caller so the tool surfaces a coherent error.
 */
async function tryFetchByokDetail(): Promise<ByokEnvelope | null> {
  try {
    const { data } = await api<ByokEnvelope>(`/api/v1/settings/byok`);
    return data ?? null;
  } catch (err) {
    if (err instanceof AutousersApiError && err.status === 404) {
      return null;
    }
    // Wave 2B may not have shipped the endpoint yet. We don't want a missing
    // route to mask the (perfectly valid) /api/v1/usage response. So treat
    // any 4xx other than auth failures as "no detail" — the summary still
    // has `byok: true` from the usage envelope.
    if (
      err instanceof AutousersApiError &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 401 &&
      err.status !== 403
    ) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerUsage(server: McpServer): void {
  server.registerTool(
    "get_usage",
    {
      title: "Get current usage and quota",
      description:
        "Get the current user's autouser usage and quota: free runs used, limit, BYOK status, recent run cost, and a per-evaluation breakdown. Useful for answering 'how much have I used?' and 'do I have quota left to run more autousers?'. Returns formatted text PLUS structured JSON (totals, perRun.medianCost, top-3 byEval) so a calling LLM can reason about cost without re-calling. Four states: (1) free quota healthy or exhausted — surfaces /settings/keys upgrade prompt when used >= limit and no BYOK, (2) BYOK active — runs bill user's Gemini key with hint + added-on date, (3) BYOK saved but inactive — key on file but toggle off, runs still on free quota, surfaces /settings/usage to activate, (4) betaUnlimited — no cap.",
      inputSchema: getUsageShape,
      outputSchema: genericObjectShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const range = input.range ?? "30d";

        // Primary source of truth.
        const { data: usage, requestId } = await api<UsageEnvelope>(
          `/api/v1/usage${buildQuery({ range })}`
        );

        // Only enrich with BYOK detail when the usage envelope says BYOK
        // is on — saves a round-trip in the 90% free-tier case.
        const byokDetail =
          usage?.byok === true ? await tryFetchByokDetail() : null;

        const summary = buildSummaryText(usage ?? {}, range, { byokDetail });

        // Top-3 byEval is part of the public contract (per task spec) so
        // a downstream LLM can reason about cost without another call.
        const topByEval = (usage.byEval ?? []).slice(0, 3);

        const structured: Record<string, unknown> = {
          range: usage.range ?? range,
          byok: usage.byok ?? false,
          // Expose `byokConfigured` so downstream LLMs can reason about
          // the parked-key state without re-reading the summary text.
          byokConfigured: usage.byokConfigured ?? false,
          unlimited: isUnlimited(usage),
          freeQuota: usage.freeQuota ?? null,
          totals: usage.totals ?? null,
          perRun: usage.perRun ?? null,
          byEvalTop3: topByEval,
        };
        if (byokDetail) {
          structured.byokDetail = {
            hint: byokDetail.hint ?? byokDetail.geminiApiKeyHint ?? null,
            addedAt: byokDetail.addedAt ?? byokDetail.createdAt ?? null,
          };
        }

        const trailer = requestId ? `\n\n(request_id: ${requestId})` : "";

        return {
          content: [{ type: "text", text: summary + trailer }],
          structuredContent: structured,
        };
      } catch (err) {
        return fail(err);
      }
    }
  );
}
