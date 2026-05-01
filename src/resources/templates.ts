/**
 * Template MCP resources — exposes individual rubric templates under the
 * `autousers://template/{id}` URI namespace.
 *
 * A template is a reusable bundle of dimensions (the rubric humans +
 * autousers score against). Attaching one as a resource lets the model
 * reason about the rubric structure when, for example, helping the user
 * design a new dimension or interpret cross-template results.
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
 * Enumerate up to 100 concrete templates so MCP hosts that support
 * `resources/list` can render a real picker (template names with a
 * built-in/custom suffix) instead of forcing the user to type the full
 * templated URI. `teamId === null` ⇒ system/built-in row; non-null ⇒
 * custom team-owned row (matches the autousers app's conventions).
 *
 * On API failure we return `{ resources: [] }` rather than throwing —
 * a broken picker is better than a broken host.
 */
async function listTemplates() {
  try {
    const { data } = await api<{
      data?: Array<{
        id: string;
        name?: string;
        description?: string | null;
        teamId?: string | null;
        isSystem?: boolean;
        type?: string;
        scaleType?: string;
      }>;
    }>(`/api/v1/templates?limit=100`);
    const rows = data?.data ?? [];
    return {
      resources: rows.map((tpl) => {
        // Either explicit `isSystem` or null `teamId` marks a built-in.
        const isBuiltIn = tpl.isSystem === true || tpl.teamId == null;
        const source = isBuiltIn ? "built-in" : "custom";
        const baseName = tpl.name ?? tpl.id;
        const descParts = [source, tpl.type ?? null, tpl.scaleType ?? null]
          .filter(Boolean)
          .join(" · ");
        return {
          uri: `autousers://template/${tpl.id}`,
          name: `${baseName} (${source})`,
          description: tpl.description
            ? `${descParts} — ${tpl.description}`
            : descParts,
          mimeType: "application/json",
        };
      }),
    };
  } catch {
    return { resources: [] };
  }
}

export function registerTemplateResources(server: McpServer): void {
  // -------------------------------------------------------------------
  // autousers://template/{id} — single template (with dimensions)
  // -------------------------------------------------------------------
  server.registerResource(
    "template",
    new ResourceTemplate("autousers://template/{id}", {
      list: listTemplates,
    }),
    {
      title: "Rubric template",
      description:
        "A single rubric template: type (TEXT_SXS|TEXT_SSE|MEDIA_SXS|MEDIA_SSE), scale, scoring mode, context, and the list of dimensions (factors + anchors) that humans and autousers score against.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      try {
        const id = asScalar(variables.id);
        const { data } = await api(
          `/api/v1/templates/${encodeURIComponent(id)}`
        );
        return jsonContent(uri, data);
      } catch (err) {
        return errorContent(uri, err);
      }
    }
  );
}
