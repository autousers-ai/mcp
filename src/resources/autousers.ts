/**
 * Autouser MCP resources — exposes individual autouser personas under the
 * `autousers://autouser/{id}` URI namespace.
 *
 * Lets a host attach a calibrated persona (capabilities, behavior profile,
 * environment, calibration state) into a conversation so the model can
 * reason about how that persona would judge a design.
 */

import {
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { api } from "../client.js";

function asScalar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

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
 * Enumerate up to 100 concrete autousers so MCP hosts that support
 * `resources/list` can render a real picker (persona names with a
 * built-in/custom suffix) instead of forcing the user to type the full
 * templated URI.
 *
 * On API failure we return `{ resources: [] }` rather than throwing —
 * a broken picker is better than a broken host.
 */
async function listAutousers() {
  try {
    const { data } = await api<{
      data?: Array<{
        id: string;
        name?: string;
        description?: string;
        isSystem?: boolean;
        source?: string;
        visibility?: string;
        status?: string;
      }>;
    }>(`/api/v1/autousers?limit=100`);
    const rows = data?.data ?? [];
    return {
      resources: rows.map((au) => {
        const source = au.isSystem ? "built-in" : "custom";
        const baseName = au.name ?? au.id;
        const descParts = [
          source,
          au.status ?? null,
          au.visibility ?? null,
        ].filter(Boolean);
        return {
          uri: `autousers://autouser/${au.id}`,
          name: `${baseName} (${source})`,
          description: au.description
            ? `${descParts.join(" · ")} — ${au.description}`
            : descParts.join(" · "),
          mimeType: "application/json",
        };
      }),
    };
  } catch {
    return { resources: [] };
  }
}

export function registerAutouserResources(server: McpServer): void {
  // -------------------------------------------------------------------
  // autousers://autouser/{id} — single autouser persona
  // -------------------------------------------------------------------
  server.registerResource(
    "autouser",
    new ResourceTemplate("autousers://autouser/{id}", {
      list: listAutousers,
    }),
    {
      title: "Autouser persona",
      description:
        "A single autouser persona: capabilities (focus areas, behavior profile, environment), calibrated rubric weights, and current calibration state.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const id = asScalar(variables.id);
        const { data } = await api(
          `/api/v1/autousers/${encodeURIComponent(id)}`
        );
        return jsonContent(uri, data);
      } catch (err) {
        return errorContent(uri, err);
      }
    }
  );
}
