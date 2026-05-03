---
name: autousers
description: Runs UX evaluations with Autousers — creates side-by-side (SxS) and single-sided (SSE) evals, dispatches AI personas (autousers), calibrates rubrics with Cohen's kappa, and synthesizes results. Use when the user mentions Autousers, UX evals, side-by-side comparison, design rating, autouser personas, calibration, kappa, SxS, SSE, rubric, or any URL on app.autousers.ai. Pairs with the @autousers/mcp MCP server: this Skill provides the workflows; the MCP exposes the tools.
---

# Autousers

Autousers is a UX evaluation platform: humans and calibrated AI personas (autousers) rate designs against a rubric of dimensions. This Skill teaches you the canonical workflows for driving Autousers through its MCP server.

The MCP server exposes ~40 tools. This Skill is the operating manual for chaining them correctly.

## Prerequisite: the MCP must be connected

Every tool referenced in this Skill (`evaluations_*`, `autousers_*`, `templates_*`, `teams_*`, `usage_get`, `get_usage`) is exposed by the `@autousers/mcp` MCP server. If those tools are not available in your tool list, the user has not connected the MCP yet — point them at the install guide before continuing:

- Server URL: `https://mcp.autousers.ai/mcp`
- Install docs: `https://autousers.ai/help/mcp`
- Auth: Bearer `ak_live_*` API key minted at `https://app.autousers.ai/settings/api-keys`

If `evaluations_list` returns `MissingApiKeyError` or 401, the user's API key is missing or revoked — direct them to mint a new one at the URL above.

> Open standard: this Skill follows the [agentskills.io](https://agentskills.io) SKILL.md format, originally introduced by Anthropic in 2025 and now an open spec. The same files work in Claude Code, Claude.ai, the Claude API, and any other agentskills.io-compliant runtime.

## Prefer MCP prompts over manual chains

The MCP ships 5 user-invokable prompts (slash commands) that resolve IDs server-side and bake the right tool sequence into a single user turn. **Use these first** — they save round trips and avoid common mistakes:

| Prompt                  | When                          | What it does                                               |
| ----------------------- | ----------------------------- | ---------------------------------------------------------- |
| `/evaluate-url`         | "Rate this URL"               | Single-sided eval (SSE) on one design                      |
| `/compare-designs`      | "Compare A vs B"              | Side-by-side eval (SxS) on a pair                          |
| `/analyze-results`      | "Summarise eval X"            | Chains `results_get` → `agreement_get` → `ai_insights_get` |
| `/calibrate-autouser`   | "Tune persona Y on eval X"    | Kappa loop with optimize/freeze branches                   |
| `/triage-low-agreement` | "Why are raters disagreeing?" | Per-dimension kappa breakdown + rubric clarification       |

Three of these (`analyze-results`, `calibrate-autouser`, `triage-low-agreement`) accept a smart resolver in place of an ID — see [reference/smart-resolvers.md](reference/smart-resolvers.md). If the user's request fits a prompt, use the prompt; only fall through to manual tool chains for off-pattern asks.

## Top workflows

Each workflow has its own file. Read the one that matches the user's request:

- **[workflows/creating-evals.md](workflows/creating-evals.md)** — How to create an eval (SxS vs SSE, draft → publish, dimensions, autouser selection). Read this before any `evaluations_create` call.
- **[workflows/running-autousers.md](workflows/running-autousers.md)** — How to dispatch autousers, preview cost with `dryRun`, poll status, and inspect a single run.
- **[workflows/analyzing-results.md](workflows/analyzing-results.md)** — How to synthesize eval results: aggregate stats, inter-rater agreement (Cohen's κ), AI-authored insights. Includes the canonical output template.
- **[workflows/calibration.md](workflows/calibration.md)** — The kappa loop: start → poll → optimize/freeze. Thresholds and decision rules.
- **[workflows/managing-templates.md](workflows/managing-templates.md)** — Templates (rubric question sets) and dimensions: when to reuse a built-in vs create custom.

## Reference

- **[reference/tool-cheatsheet.md](reference/tool-cheatsheet.md)** — Every MCP tool in one table with a one-line summary.
- **[reference/domain-glossary.md](reference/domain-glossary.md)** — SxS, SSE, kappa, dimension, rubric, factor, anchor, autouser, calibration, BYOK.
- **[reference/smart-resolvers.md](reference/smart-resolvers.md)** — How to use `latest`, `recent`, `running`, `pick`, `1`–`99`, fuzzy name match in prompt args.
- **[reference/auth-and-setup.md](reference/auth-and-setup.md)** — `ak_live_*` keys, base URL resolution, BYOK vs metered cost model.

## Output templates

When summarising results back to the user, use these:

- **[templates/eval-summary.md](templates/eval-summary.md)** — Output shape for results synthesis.
- **[templates/calibration-report.md](templates/calibration-report.md)** — Output shape for a calibration run.

## Five rules that override everything else

These rules win over any heuristic the model might apply on its own. Internalise them.

1. **Preview spend before incurring it.** `evaluations_create` and `autousers_run` both accept `dryRun: true` and MUST be called that way first when running personas. The dryRun response carries `dryRun: true, queued: false, costEstimate, wouldRun` and **persists nothing**. Never describe a dryRun result as "created", "started", "queued", or "running" — by definition nothing happened. Re-issue the same call **without** `dryRun` only after the user confirms cost and config.

2. **Never pick autousers for the user.** Personas are contextual to the audience and design under test. Always call `autousers_list` first, present the candidates (built-ins AND the user's custom personas — both have a `source` field), and let the user choose. The exception: a manual-only eval (`evaluationMethod: 'manual'`) needs no personas, and that's fully valid — not a misconfiguration.

3. **Drafts are the default.** Set `status: 'Draft'` on `evaluations_create` unless the user explicitly says "launch" or "go live". Drafts are iteratively editable via `evaluations_update` / `evaluations_save_draft`. Flipping to `status: 'Running'` is what triggers autouser dispatch + cost; do it only when the user has confirmed the full config.

4. **Resolve IDs, don't guess them.** When the user names an evaluation or persona instead of pasting a cuid, use a smart-resolver shortcut (`latest`, `running`, `pick`, position number, fuzzy name) inside an MCP prompt — don't fabricate IDs and don't loop on `evaluations_list` until you find a match. See [reference/smart-resolvers.md](reference/smart-resolvers.md).

5. **`teamId` is required for create operations.** `templates_create` and `autousers_create` both fail without it. If you don't already have one, call `teams_list` first and pick the user's team — there's usually only one for solo accounts.

## When this Skill should NOT fire

This Skill is for _driving_ Autousers. It is not for:

- Generating UX rubrics from scratch without using Autousers (that's a general writing task).
- Debugging the Autousers app itself (that's an engineering task; route to `/help/troubleshooting`).
- Managing billing, subscriptions, or BYOK configuration UI (that lives at `/settings`, not in the MCP).

If the user's request is not about running an evaluation, dispatching personas, calibrating rubrics, or analysing results, do not invoke this Skill's workflows.
