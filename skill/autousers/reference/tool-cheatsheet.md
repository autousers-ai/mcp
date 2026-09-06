# MCP tool cheatsheet

Every tool exposed by `@autousers/mcp`, one line each. Use this as a lookup table when planning a chain.

## Contents

- [Evaluations (14)](#evaluations-14)
- [Autousers (15)](#autousers-15)
- [Templates (6)](#templates-6)
- [Teams + Settings (4)](#teams--settings-4)
- [Usage (1–2)](#usage-12)

## Evaluations (14)

| Tool                          | Purpose                                     | Key inputs                                                                    |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `evaluations_list`            | List evaluations the caller can see         | `limit`, `teamId`                                                             |
| `evaluations_get`             | Fetch one eval + full config                | `id`                                                                          |
| `evaluations_create`          | Create an SSE or SxS eval                   | `name`, `type`, `designUrls`/`comparisonPairs`, `selectedAutousers`, `dryRun` |
| `evaluations_update`          | PATCH any eval field                        | `id`, fields to change                                                        |
| `evaluations_delete`          | Hard-delete an eval (cascade)               | `id`                                                                          |
| `evaluations_save_draft`      | Merge wizard fields into a Draft/Ended eval | `id`, wizard fields                                                           |
| `evaluations_ratings_list`    | All ratings (human + autouser) for an eval  | `evaluationId`                                                                |
| `evaluations_results_get`     | Aggregate stats + per-rater summaries       | `id`                                                                          |
| `evaluations_agreement_get`   | Cohen's κ, overall + per-rater-pair         | `id`                                                                          |
| `evaluations_ai_insights_get` | Gemini-authored summary + findings          | `id`                                                                          |
| `evaluations_export_get`      | Download CSV or JSON                        | `id`, `format`                                                                |
| `evaluations_share_create`    | Grant per-user access                       | `id`, `userId`, `permission`                                                  |
| `evaluations_shares_list`     | List explicit shares                        | `id`                                                                          |
| `evaluations_transfer`        | Move ownership to another user              | `id`, `userId`                                                                |

## Autousers (15)

| Tool                               | Purpose                          | Key inputs                                 |
| ---------------------------------- | -------------------------------- | ------------------------------------------ |
| `autousers_list`                   | List built-in + custom personas  | `teamId`, `includeSystem`, `limit`         |
| `autousers_get`                    | Fetch one persona                | `id`                                       |
| `autousers_create`                 | Create a custom persona          | `teamId`, `name`, `systemPrompt`           |
| `autousers_update`                 | PATCH persona fields             | `id`, fields                               |
| `autousers_delete`                 | Soft-delete a persona            | `id`                                       |
| `autousers_duplicate`              | Clone a persona to a team        | `id`, `teamId`                             |
| `autousers_run`                    | Queue runs against an eval ($)   | `evaluationId`, `autouserIds`, `dryRun`    |
| `autousers_run_stop`               | Cancel pending/running runs      | `evaluationId`, `runIds?`                  |
| `autouser_status_get`              | Status snapshot + summary counts | `evaluationId`                             |
| `autouser_run_get`                 | One run + viewUrl deeplink       | `evaluationId`, `runId`                    |
| `autouser_run_turns_list`          | Per-turn token + cost breakdown  | `evaluationId`, `runId`                    |
| `autousers_calibration_start`      | Begin κ measurement              | `autouserId`, `evaluationId`, `sampleSize` |
| `autousers_calibration_status_get` | Poll κ convergence               | `id`, `includeEvals`                       |
| `autousers_calibration_freeze`     | Lock rubric version              | `id`, `rubricId`, `commitMessage`          |
| `autousers_calibration_optimize`   | Gemini-driven rubric refinement  | `id`, `disagreements`, `manualRubricEdit`  |

## Templates (6)

| Tool                  | Purpose                                   | Key inputs                                 |
| --------------------- | ----------------------------------------- | ------------------------------------------ |
| `templates_list`      | List built-in + custom templates          | `limit`                                    |
| `templates_get`       | Fetch template + factors/criteria/anchors | `id`                                       |
| `templates_create`    | Create a team-scoped template             | `teamId`, `name`, `type`, factors/criteria |
| `templates_update`    | PATCH a template                          | `id`, fields                               |
| `templates_delete`    | Delete (fails if attached to an eval)     | `id`                                       |
| `templates_duplicate` | Clone a template to a team                | `id`, `teamId`                             |

## Teams + Settings (4)

| Tool                | Purpose                              | Key inputs |
| ------------------- | ------------------------------------ | ---------- |
| `teams_list`        | Caller's teams + roles               | —          |
| `teams_get`         | One team + full members array        | `id`       |
| `team_members_list` | Members of a team                    | `teamId`   |
| `usage_get`         | Raw `/api/v1/usage` envelope (newer) | `range`    |

## Usage (1–2)

| Tool        | Purpose                                         | Key inputs                 |
| ----------- | ----------------------------------------------- | -------------------------- |
| `get_usage` | Formatted text + JSON; BYOK detail; top-3 evals | `range` ('7d'/'30d'/'90d') |

> **Note on the duplication:** `usage_get` (in `settings.ts`, raw envelope) and `get_usage` (in `usage.ts`, formatted) currently both register. Prefer `get_usage` for user-facing summaries — it includes the BYOK detail and per-eval breakdown. The duplication will be cleaned up in a future server release.

## Annotations meaning

Each tool ships with annotations the host can read:

- `readOnlyHint: true` — pure read, safe to call freely
- `destructiveHint: true` — deletes or overwrites; ask before calling
- `idempotentHint: true` — calling twice has no extra effect
- `openWorldHint: true` — can have external side effects (queues runs, calls Gemini)

`autousers_run` is the one to watch: `readOnly: false`, `idempotent: false`, `openWorld: true`. Always preview with `dryRun` first.

## Resources (3 URI schemes)

The MCP also exposes 3 resource URI schemes that the host can subscribe to or include as context:

- `autousers://evaluation/{id}` — eval card with view/edit/results URLs
- `autousers://template/{id}` — rubric snapshot
- `autousers://autouser/{id}` — persona card

Use these when the host supports MCP resources (Claude.ai, Claude Code do; some others don't yet).
