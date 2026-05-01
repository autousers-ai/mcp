/**
 * Evaluation MCP resources — exposes Autousers evaluations as first-class
 * MCP `Resource`s under the `autousers://` URI namespace.
 *
 * Resources are how an MCP host (Claude Desktop, Cursor, etc.) attaches
 * server-side context into a conversation without paying tool-call
 * orchestration cost. A user "@-mentions" a resource and the host calls
 * `resources/read` to inline the JSON. That JSON ends up in the model's
 * context just like any user-pasted snippet.
 *
 * URI templates registered here:
 *   - autousers://evaluation/{id}            — eval config + metadata
 *   - autousers://evaluation/{id}/results    — aggregated results
 *   - autousers://evaluation/{id}/ratings    — per-rater rating list
 *   - autousers://evaluation/{id}/agreement  — Cohen's Kappa agreement
 *
 * Read handlers wrap thrown errors into a content block (rather than
 * re-throwing) — a broken resource read shouldn't kill the host's
 * resource picker for the rest of the session.
 */

import {
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { api } from "../client.js";

/**
 * The MCP `ReadResourceTemplateCallback` returns each template variable as
 * `string | string[]`. RFC 6570 allows comma-expansion (`{id*}`), but our
 * templates are scalar — so we coerce defensively rather than crashing if
 * the host ever sends an array.
 */
function asScalar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Shared shape for read-callback return value. Centralized so every handler
 * emits the same `{ uri, mimeType, text }` content block — the MCP spec
 * permits multiple content blocks per resource read, but JSON resources
 * always emit exactly one.
 */
function jsonContent(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorContent(uri: URL, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "text/plain",
        text: `Error reading resource: ${message}`,
      },
    ],
  };
}

/**
 * Enumerate up to 100 concrete evaluations so MCP hosts that support
 * `resources/list` can render a real picker (eval names) instead of
 * forcing the user to type the full templated URI. The MCP spec doesn't
 * require exhaustive enumeration — hosts can show "+N more" if needed.
 *
 * On API failure we return `{ resources: [] }` rather than throwing —
 * a broken picker is better than a broken host.
 */
async function listEvaluations() {
  try {
    const { data } = await api<{
      data?: Array<{
        id: string;
        name?: string;
        type?: string;
        status?: string;
        createdAt?: string;
      }>;
    }>(`/api/v1/evaluations?limit=100`);
    const rows = data?.data ?? [];
    return {
      resources: rows.map((ev) => {
        const created = ev.createdAt
          ? new Date(ev.createdAt).toLocaleDateString()
          : "—";
        return {
          uri: `autousers://evaluation/${ev.id}`,
          name: ev.name ?? ev.id,
          description: `${ev.type ?? "—"} · ${ev.status ?? "—"} · created ${created}`,
          mimeType: "application/json",
        };
      }),
    };
  } catch {
    return { resources: [] };
  }
}

export function registerEvaluationResources(server: McpServer): void {
  // -------------------------------------------------------------------
  // autousers://evaluation/{id} — eval config + metadata
  // -------------------------------------------------------------------
  server.registerResource(
    "evaluation",
    new ResourceTemplate("autousers://evaluation/{id}", {
      list: listEvaluations,
    }),
    {
      title: "Evaluation",
      description:
        "A single Autousers evaluation: config, type (SSE|SxS), status, design URLs, and selected dimensions/autousers. Use this to attach an eval into a conversation as context.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const id = asScalar(variables.id);
        const { data } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}`
        );
        return jsonContent(uri, data);
      } catch (err) {
        return errorContent(uri, err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers://evaluation/{id}/results — aggregated results
  // -------------------------------------------------------------------
  server.registerResource(
    "evaluation-results",
    new ResourceTemplate("autousers://evaluation/{id}/results", {
      list: undefined,
    }),
    {
      title: "Evaluation results",
      description:
        "Aggregated results for an evaluation: per-dimension averages, per-rater summaries, and pairwise agreement when available.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const id = asScalar(variables.id);
        const { data } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}/results`
        );
        return jsonContent(uri, data);
      } catch (err) {
        return errorContent(uri, err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers://evaluation/{id}/ratings — full ratings list
  // -------------------------------------------------------------------
  server.registerResource(
    "evaluation-ratings",
    new ResourceTemplate("autousers://evaluation/{id}/ratings", {
      list: undefined,
    }),
    {
      title: "Evaluation ratings",
      description:
        "List of ratings (human + autouser) for a single evaluation, including per-dimension scores and any open-text responses.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const id = asScalar(variables.id);
        const { data } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}/ratings`
        );
        return jsonContent(uri, data);
      } catch (err) {
        return errorContent(uri, err);
      }
    }
  );

  // -------------------------------------------------------------------
  // autousers://evaluation/{id}/agreement — Cohen's Kappa
  // -------------------------------------------------------------------
  server.registerResource(
    "evaluation-agreement",
    new ResourceTemplate("autousers://evaluation/{id}/agreement", {
      list: undefined,
    }),
    {
      title: "Evaluation inter-rater agreement",
      description:
        "Cohen's Kappa agreement statistics across raters for an evaluation. Returns `insufficient` when fewer than 2 raters overlap.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const id = asScalar(variables.id);
        const { data } = await api(
          `/api/v1/evaluations/${encodeURIComponent(id)}/agreement`
        );
        return jsonContent(uri, data);
      } catch (err) {
        return errorContent(uri, err);
      }
    }
  );
}
