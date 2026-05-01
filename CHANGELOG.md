# Changelog

All notable changes to `@autousers/mcp` will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.11] — 2026-05-01

### Changed — public mirror + provenance

- **Source mirrored to public repo `autousers-ai/mcp`.** The package
  source is now visible at https://github.com/autousers-ai/mcp as a
  read-only mirror. Issues are accepted there; PRs are accepted upstream
  in the private monorepo and propagate back via mirror sync. The
  `repository` field in `package.json` is restored (pointing at the
  public mirror) after being removed in 0.8.3 to avoid leaking the
  private monorepo URL on the npmjs.com package page.
- **npm provenance attestation re-enabled.** The publish workflow now
  runs `npm publish --access public --provenance`, producing a
  sigstore-signed provenance statement that links the published tarball
  to the exact GitHub Actions run that built it. Surfaces as a
  "Verified provenance" badge on the npm package page. Was disabled in
  the 0.8.x line because npm's sigstore verifier rejects `--provenance`
  when the source repo is private.
- **Publishing identity changed to `autousers-ai`.** Earlier versions
  were published by the personal account `darrenhead`. v0.8.11 onwards
  is published by the bot account `autousers-ai` (owner of the
  `@autousers` npm scope). No code or behaviour change — purely a
  metadata cleanup to consolidate brand surface under the
  `autousers-ai` org.

## [0.8.3] — 2026-04-29

### Changed — production-first install ergonomics

- **README rewritten** following the convention used by popular MCP servers
  (`@modelcontextprotocol/server-*`, `mcp-remote`, `@upstash/context7-mcp`).
  Production-first framing (drop the localhost-as-default narrative),
  per-client install matrix as the primary surface, full 39-tool table
  embedded for self-contained discoverability, OAuth path leads with the
  remote URL at `https://mcp.autousers.ai/mcp` and the npm stdio install
  is positioned for headless / CI use only. ~290 lines, down from 472.
- **Removed `repository` field** from `package.json`. The source repo is
  currently private; surfacing its URL on the npmjs.com package page
  exposed an unintended internal namespace. The `homepage` field still
  points at `https://autousers.ai/help/mcp` for users who want install
  docs, and `bugs` still resolves to `https://autousers.ai/contact`.
  This is a temporary measure; once the source is extracted to a
  public org-owned repo, `repository` will be re-added (and
  `--provenance` re-enabled in the publish workflow).
- **Doctor's `AUTOUSERS_BASE_URL` default** finalised at
  `https://app.autousers.ai` (carries the v0.8.2 fix that never
  shipped to npm — the v0.8.2 publish workflow was cancelled mid-run).

## [0.8.2] — 2026-04-28 (unreleased)

### Fixed

- **Doctor `AUTOUSERS_BASE_URL` default actually changed.** v0.8.1 claimed
  to flip the default to `https://app.autousers.ai` but the source edit
  silently didn't persist before commit; the published v0.8.1 doctor
  still defaulted to `http://localhost:3000`. v0.8.2 ships the corrected
  default. The stdio bin (`src/client.ts`) was correct in v0.8.1 — only
  the doctor was affected.

## [0.8.1] — 2026-04-28

### Fixed — install ergonomics for end users (no breaking API changes)

- **`bin: { mcp }` alias** so the bare `npx -y @autousers/mcp` form works
  out of the box. Previously the package shipped two bins
  (`autousers-mcp` and `autousers-mcp-doctor`), neither matching the
  package's last path segment, so npx errored with "could not determine
  executable to run." End users had to type
  `npx -y -p @autousers/mcp autousers-mcp`. Now they don't.
  The legacy bin names are kept as aliases for back-compat.
- **`AUTOUSERS_BASE_URL` default flipped** from `http://localhost:3000`
  to `https://app.autousers.ai` in both the stdio bin (`src/client.ts`)
  and the doctor (`src/commands/doctor.ts`). The 99% case for
  `npx -y @autousers/mcp` is end users targeting production from a
  local terminal — they shouldn't have to set an env var. Local dev
  still works by setting `AUTOUSERS_BASE_URL=http://localhost:3000`
  explicitly in `.env.local`. The fallback chain
  `AUTOUSERS_BASE_URL → NEXT_PUBLIC_APP_URL → fallback` is unchanged
  for the in-process /mcp HTTP route, which still picks up the right
  origin from Vercel via `NEXT_PUBLIC_APP_URL`.

## [0.8.0] — 2026-04-28

### Added — Wave 1 of MCP hardening (transport-agnostic refactor + cost preview)

**Cost-estimate preview on `autousers_run` and `evaluations_create`.**
Both run-triggering tools now compute a conservative spend forecast
(per-rating USD × autouser count × comparison count, with SxS multiplier
and per-stimulus token approximations) using the live numbers from
`docs/PRICING.md` §3 — anchored on `gemini-3-flash-preview` for navigation
and `gemini-3.1-pro-preview` for judging. Pass `dryRun: true` to preview
spend without queueing any work; the response carries the estimate, the
would-have-run plan, and the post-optimisation §3 target so callers can
confirm before re-issuing without `dryRun`. Implementation in
`mcp/src/lib/cost-estimate.ts`.

**Transport-agnostic refactor — splits the bootstrap into reusable parts.**
The McpServer construction + tool/resource/prompt registration moved out
of `index.ts` into `mcp/src/server-factory.ts` (pure builder, no transport
assumptions). `index.ts` is now a thin dispatcher routing to subcommands:

- `autousers-mcp` (no args) → stdio transport (current behaviour, no change for users)
- `autousers-mcp stdio` → stdio transport (explicit form)
- `autousers-mcp http` → placeholder; throws "Wave 2 not implemented"
- `autousers-mcp doctor` → preflight diagnostic (also `bin: autousers-mcp-doctor`)

**Per-request bearer context (`AsyncLocalStorage`).** New
`mcp/src/lib/request-context.ts` carries the upstream bearer through
`await` chains. Stdio mode continues to read `process.env.AUTOUSERS_API_KEY`
— the new lookup in `client.ts` is `requestContext.getStore()?.bearer ??
process.env.AUTOUSERS_API_KEY`, so v0.7.x setups behave identically. The
context store is the seam Wave 2 (HTTP) and Wave 3 (OAuth) will populate
per-request.

**`autousers-mcp-doctor` preflight CLI.** Standalone diagnostic that runs
the same auth + base-URL probes the MCP server uses on first call, and
exits with a clear PASS/FAIL summary. Catches the most common host
failure mode ("MCP server failed to start" with no details — usually a
missing or wrong `AUTOUSERS_API_KEY` or an unreachable
`AUTOUSERS_BASE_URL`). Also reachable via `autousers-mcp doctor`.

### Changed

- `package.json` adds the `repository` field (GitHub source, `mcp/`
  subdirectory) and a `prepublishOnly` gate that runs `build && pack
--dry-run` so a missing-file regression can't ship by accident.
- `index.ts` now sources the version from `package.json` instead of
  hardcoding it in the McpServer construction — one source of truth.

### Internal — Wave 1 setup for Wave 2/3

- `mcp/src/http-entry.ts` exists as a placeholder so the file layout is
  settled before Wave 2 starts shipping HTTP code.
- `mcp/src/commands/` directory introduced for one-shot CLI subcommands
  (doctor today; future cleanup/migration helpers may join).

## [0.7.1] — 2026-04-27

### UX polish — round-trip elimination + wider input grammar on prompt resolvers

**No more wasted round-trip on the picker.** v0.7.0 emitted instructions
telling Claude to call `evaluations_list` and ask the user — that cost a tool
call + 2 conversation turns before a picker showed up. v0.7.1 pre-fetches the
list **server-side at prompt-resolution time** and bakes the rendered markdown
table directly into the first user message, so Claude responds with the picker
immediately on turn 1. Affects `analyze-results`, `calibrate-autouser`, and
`triage-low-agreement`.

**Wider input grammar.** All three prompts now accept:

- a verbatim cuid (id);
- a fuzzy substring name (case-insensitive);
- magic shortcuts: `latest`, `recent`, `newest`, `last`;
- list-position numerics: `1` through `99` (1-indexed against the most-recent
  20-row default);
- picker triggers: `list`, `pick`, `show`, `which`, `choose`, `select`, `menu`;
- evaluation status filters: `running`, `ended`, `draft`, `archived` (single
  match → resolve, multiple → mini-picker scoped to the status).

**Auto-detect cuid-vs-name on misrouted positional args.** Claude Code passes
the user's free text into the first schema slot (`evaluationId`) regardless
of whether it's actually a cuid. v0.7.1 sniffs the cuid pattern (`/^c[a-z0-9]{20,}$/`);
if the string doesn't match, it falls through to name lookup transparently —
no failed `evaluations_get` round-trip. Built-in autouser ids (`power-user`,
`screen-reader`, etc.) deliberately don't match the cuid pattern and resolve
via the same name path, which finds them by the substring match against
`name` (or by id-as-name if needed).

**Schema `.describe()` strings now document the magic values** so Claude
Code's prompt-arg dialog tells users the syntax up-front instead of forcing
trial-and-error.

**Single resolver, no throws.** `resolveEvaluation` and `resolveAutouser`
collapsed into a single `resolveEntity(kind, id, name)` helper. API failures
return a graceful `⚠️ Couldn't fetch the list (...)` preamble with
`resolvedId: null` rather than throwing — a flaky API can't break the host's
prompt rendering for the rest of the session.

`evaluate-url` and `compare-designs` are unchanged — they take URLs, not ids.

## [0.7.0] — 2026-04-27

### UX polish — surfaced from v0.6.0 smoke testing in Claude Code

**Prompts: name-based fuzzy match, no more cuid copy/paste.** `analyze-results`,
`calibrate-autouser`, and `triage-low-agreement` now accept either an `*Id`
(verbatim cuid) or a `*Name` (case-insensitive substring match against the
list endpoint). If neither is supplied, the prompt instructs Claude to render
a numbered eval/autouser table and ask the user to pick. Power users can still
paste an id when they have one; everyone else gets a real picker.

- `analyze-results` — `evaluationId` + `evaluationName` (both optional)
- `calibrate-autouser` — `autouserId` + `autouserName` + `evaluationId` +
  `evaluationName` (all optional, both sides resolvable independently)
- `triage-low-agreement` — `evaluationId` + `evaluationName` (both optional)

`evaluate-url` and `compare-designs` are unchanged — they take URLs, not ids.

**Resources: list callbacks enumerate concrete instances.** The 3 bare
templated URIs (`autousers://evaluation/{id}`, `autousers://autouser/{id}`,
`autousers://template/{id}`) now ship a `list` callback that returns up to 100
concrete resources. Hosts that support `resources/list` (Claude Code, etc.)
render a real picker with the entity's name + a one-line description (type,
status, source) instead of forcing the user to type the full templated URI.
Sub-resources (`/results`, `/ratings`, `/agreement`) keep `list: undefined` —
they have no discrete catalogue. List callbacks return `{ resources: [] }` on
API failure rather than throwing, so a flaky API doesn't break the host's
picker for the rest of the session.

**List tools render built-in vs custom.** `autousers_list` and `templates_list`
now produce a markdown table with an explicit `Source` column (`built-in` /
`custom`) before the JSON dump, so Power User and a calibrated team persona
no longer look identical at a glance. New helpers `okAutouserList` and
`okTemplateList` in `mcp/src/lib/helpers.ts` mirror the existing
`okEvalList` pattern. `structuredContent` is still populated, so outputSchema
validation is unchanged.

## [0.6.0] — 2026-04-27

### Added — Phase 3 polish (Resources + Prompts + outputSchema)

**Resources (6 templated URIs):** Hosts can now attach autousers data into a
Claude conversation as first-class context, separate from tool calls.

- `autousers://evaluation/{id}` — eval config + metadata
- `autousers://evaluation/{id}/results` — aggregated results
- `autousers://evaluation/{id}/ratings` — ratings list
- `autousers://evaluation/{id}/agreement` — Cohen's Kappa breakdown
- `autousers://autouser/{id}` — single persona with calibrated rubric
- `autousers://template/{id}` — single rubric template

**Prompts (5 user-invokable workflows):** Compresses the surface from the
host's perspective — instead of scanning 39 tool descriptions, users pick a
named workflow.

- `evaluate-url` — URL → SSE eval → run autouser → fetch results
- `compare-designs` — A vs B → SxS eval → results
- `analyze-results` — eval ID → results + agreement + AI insights
- `calibrate-autouser` — autouser ID + eval ID → calibrate → freeze/optimize
- `triage-low-agreement` — surface low-kappa dimensions + suggest rubric tweaks

**outputSchema on every tool (39/39):** All tool responses now declare
structured-content schemas. Hosts can render results as tables/cards
without LLM round-tripping. New `mcp/src/lib/output-shapes.ts` factors
out shared shapes (`evalRowShape`, `templateRowShape`, `autouserRowShape`,
`paginatedListShape`, etc., all `.passthrough()` so backend additions
don't break clients).

`mcp/src/lib/helpers.ts`: `ok()`, `okEval()`, `okEvalList()` now populate
`structuredContent` alongside the human-facing text content block, so
the SDK's outputSchema validation has something to check.

### Capabilities block now advertises all three primitives

`{ tools: {}, resources: {...}, prompts: {...} }` so hosts call
`resources/list` and `prompts/list` at handshake time and surface the
new entry points in their UIs.

## [0.5.0] — 2026-04-27

### Removed

- All 6 `dimensions_*` tools. They duplicated `templates_*` (the `/api/v1/templates`
  route is a byte-identical re-export of `/api/v1/dimensions`, which itself
  ships a `Sunset: 2027-04-04` header). Surface duplication confused agents
  and inflated host context. Use `templates_*` for any question-set CRUD —
  same database table, same schema.

### Added

- `npm run smoke` — boots the built MCP server as a subprocess and calls
  every read-only tool against your local dev API, emitting a markdown
  pass/fail table. Catches the class of bug where a generated tool's
  `inputSchema` doesn't match the route's actual zod schema. Pass
  `--include-writes` to additionally exercise reversible writes
  (`templates_duplicate`, `autousers_duplicate`).
- `mcp/scripts/smoke.ts` — the harness itself; uses `@modelcontextprotocol/sdk`
  Client + StdioClientTransport, no direct `src/` imports.

### Changed

- Tool count: 45 → 39 (after dimensions cull). Saves ~1.5–2K tokens of
  host-side tool definitions per turn.

## [0.4.0] — 2026-04-27

### Added — full Phase 2 tool surface (38 new tools, 45 total)

Closes the vibe-coding loop end-to-end (create eval → run autousers →
fetch results → iterate) and rounds out CRUD across every domain.

**Evaluations (+10):** `evaluations_update`, `evaluations_delete`,
`evaluations_save_draft`, `evaluations_export_get`, `evaluations_results_get`,
`evaluations_agreement_get`, `evaluations_ai_insights_get`,
`evaluations_share_create`, `evaluations_shares_list`, `evaluations_transfer`.

**Autousers (+14):** `autousers_get`, `autousers_create`, `autousers_update`,
`autousers_delete`, `autousers_duplicate`, `autousers_run`,
`autousers_run_stop`, `autouser_status_get`, `autouser_run_get`,
`autouser_run_turns_list`, `autousers_calibration_start`,
`autousers_calibration_status_get`, `autousers_calibration_freeze`,
`autousers_calibration_optimize`.

**Templates (+4):** `templates_create`, `templates_update`,
`templates_delete`, `templates_duplicate`.

**Dimensions (+6, new domain):** `dimensions_list`, `dimensions_get`,
`dimensions_create`, `dimensions_update`, `dimensions_delete`,
`dimensions_duplicate`. (Underlying API is deprecated in favour of
`/api/v1/templates` — exposed for parity until the successor surface
ships.)

**Settings (+4, new domain, read-only):** `teams_list`, `teams_get`,
`team_members_list`, `usage_get`.

### Changed

- Refactored `mcp/src/tools.ts` (553 lines) into per-domain modules under
  `mcp/src/tools/{evaluations,autousers,templates,dimensions,settings}.ts`,
  with shared helpers in `mcp/src/lib/{helpers,shapes}.ts`. Public registry
  surface unchanged.
- Updated server `instructions` to mention Dimensions and the calibrate-
  autouser workflow.
- All run/stop tools annotate `openWorldHint: true` so MCP hosts confirm
  before kicking off Gemini-backed work.
- All `*_delete` tools annotate `destructiveHint: true`.

## [0.3.0] — 2026-04-27

### Added

- Published as `@autousers/mcp` on npm (was unpublished `autousers-mcp`).
- MIT license.
- Provenance attestation via npm publish + GitHub Actions OIDC.

### Changed

- Package now public (`publishConfig.access: public`, removed `private: true`).
- Versioning: jumped from 0.2.0 → 0.3.0 to mark distribution. Phases 2/3 of
  the roadmap (additional tools, resources/prompts) will fill 0.4/0.5/0.6.

## [0.2.0] — 2026-04-27

### Breaking

- Tool names dropped the redundant `autousers_` prefix. The MCP server
  namespace already disambiguates. New names: `templates_list`,
  `evaluations_create`, etc. Update your MCP host config; tool selectors
  in scripts must be renamed.

### Added

- Server-level `instructions` field so the host LLM has routing context
  for when to reach for Autousers vs other connected MCPs.
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`, `title`) on every tool, so MCP hosts can auto-approve
  read-only calls and require confirmation only on destructive ones.
- Migrated to `McpServer.registerTool` (high-level SDK API).

## [0.1.0] — 2026-04-26

Initial release. 7 tools, stdio transport, AUTOUSERS_API_KEY env auth.
