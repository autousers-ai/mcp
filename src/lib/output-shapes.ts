/**
 * Shared Zod output schemas used across multiple tool modules.
 *
 * MCP tools may declare an `outputSchema` (either a zod raw shape or a full
 * `ZodObject`). When set, MCP hosts validate the tool's `structuredContent`
 * against the schema and can render structured responses (tables, cards)
 * directly without LLM round-tripping. See:
 *   https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content
 *
 * IMPORTANT: the SDK serialises every output schema to JSON-Schema and
 * ships it on the wire. The MCP *client* then validates received
 * `structuredContent` against that JSON-Schema. The vendored zod→JSON
 * Schema converter emits `additionalProperties: false` for any plain
 * `z.object({...})`. To keep the API forward-compatible (the API may add
 * fields any time), every shape below is wrapped with `.passthrough()`,
 * which sets `additionalProperties: true` in the emitted JSON Schema.
 *
 * Each export is therefore a full `ZodObject` (not a raw shape). Pass them
 * verbatim to `registerTool({ outputSchema })`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Generic envelopes
// ---------------------------------------------------------------------------

/**
 * Catch-all schema accepting any object response. Use when the route returns
 * an unstructured / heterogeneous payload we don't want to schema-lock.
 */
export const genericObjectShape = z.object({}).passthrough();

/**
 * Factory for the standard Stripe-style paginated list envelope:
 *   { data: T[], has_more: boolean, next_cursor: string | null }
 *
 * Pass an item shape (raw shape — i.e. the kind you'd hand to
 * `z.object(...)`) and the factory returns a `ZodObject` with `passthrough`
 * (so the host accepts unknown top-level fields like `total_count`).
 */
export function paginatedListShape<T extends z.ZodRawShape>(itemShape: T) {
  return z
    .object({
      data: z.array(z.object(itemShape).passthrough()),
      has_more: z.boolean().optional(),
      next_cursor: z.string().nullable().optional(),
    })
    .passthrough();
}

// ---------------------------------------------------------------------------
// Eval shapes
// ---------------------------------------------------------------------------

/** Sub-shape — the per-evaluation `links` block (preview/review/edit/results/share). */
export const evalLinksShape = z
  .object({
    preview: z.string().url().optional(),
    review: z.string().url().optional(),
    edit: z.string().url().optional(),
    results: z.string().url().optional(),
    share: z.string().url().optional(),
  })
  .passthrough();

/** Single Evaluation row as returned from `/api/v1/evaluations[/:id]`. */
export const evalRowShape = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    teamId: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    ratingsCount: z.number().int().optional(),
    comparisonsCount: z.number().int().optional(),
    autouserRunSummary: z.unknown().optional(),
    isSharedWithMe: z.boolean().optional(),
    myPermission: z.string().nullable().optional(),
    links: evalLinksShape.optional(),
  })
  .passthrough();

// Raw shape variants — needed when composing into other schemas via
// `paginatedListShape({ ...evalRowRawShape })` etc.
export const evalRowRawShape = {
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  teamId: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  ratingsCount: z.number().int().optional(),
  comparisonsCount: z.number().int().optional(),
  autouserRunSummary: z.unknown().optional(),
  isSharedWithMe: z.boolean().optional(),
  myPermission: z.string().nullable().optional(),
  links: evalLinksShape.optional(),
};

// ---------------------------------------------------------------------------
// Templates / Autousers
// ---------------------------------------------------------------------------

/** Single Template (Dimension) row. */
export const templateRowShape = z
  .object({
    id: z.string(),
    teamId: z.string().nullable().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    type: z.string().optional(),
    scaleType: z.string().optional(),
    isSystem: z.boolean().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const templateRowRawShape = {
  id: z.string(),
  teamId: z.string().nullable().optional(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  type: z.string().optional(),
  scaleType: z.string().optional(),
  isSystem: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
};

/** Single Autouser row. */
export const autouserRowShape = z
  .object({
    id: z.string(),
    teamId: z.string().nullable().optional(),
    name: z.string().optional(),
    role: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    status: z.string().optional(),
    visibility: z.string().optional(),
    isSystem: z.boolean().optional(),
    source: z.string().nullable().optional(),
    capabilities: z.object({}).passthrough().nullable().optional(),
    config: z.object({}).passthrough().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const autouserRowRawShape = {
  id: z.string(),
  teamId: z.string().nullable().optional(),
  name: z.string().optional(),
  role: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
  visibility: z.string().optional(),
  isSystem: z.boolean().optional(),
  source: z.string().nullable().optional(),
  capabilities: z.object({}).passthrough().nullable().optional(),
  config: z.object({}).passthrough().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
};

/**
 * Helper to build a tiny `{ deleted, id }` schema for DELETE endpoints.
 * Wrapped in `.passthrough()` so the API can add fields like `cascade_count`
 * later without breaking the host.
 */
export const deleteResultShape = z
  .object({
    deleted: z.boolean(),
    id: z.string(),
  })
  .passthrough();
