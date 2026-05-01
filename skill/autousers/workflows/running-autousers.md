# Running autousers

This file covers dispatching AI personas at an evaluation, polling their status, and inspecting individual runs.

## Two paths to dispatch

Autousers can be queued in two ways:

1. **Inline at eval creation** — when `evaluations_create` runs with `status: 'Running'` and a non-empty `selectedAutousers`, it auto-fans `autousers_run` for you. This is the common path for the create-and-launch flow.
2. **Standalone** — call `autousers_run` directly against an existing eval. Use this when the user is iterating on personas without re-creating the eval, or when a previous run failed and they want to retry a subset.

## Always preview first

`autousers_run` SPENDS Gemini tokens (real money) once queued. The cost band is **~$0.091 per rating** (URL stimulus, SSE) to **~$0.137 per rating** (URL stimulus, SxS). One rating = one autouser × one comparison.

Always call `autousers_run` with `dryRun: true` first:

```
autousers_run({
  evaluationId: "ev_abc",
  autouserIds: ["au_1", "au_2"],
  dryRun: true,
})
```

The dryRun response shape:

```
{
  dryRun: true,
  queued: false,
  costEstimate: { totalCostUsd, perRunCostUsd, ... },
  wouldRun: { autouserCount, comparisonCount, totalRuns },
}
```

**Never describe a dryRun response as "kicked off", "queued", or "running"** — `queued: false` means nothing happened. Re-issue the same call without `dryRun` only after the user confirms.

## Polling status

After dispatch, poll with `autouser_status_get`:

```
autouser_status_get({ evaluationId: "ev_abc" })
```

Returns an array of run statuses + summary counts (`running`, `completed`, `failed`). Poll cadence:

- **Every 10–15 seconds** for short evals (1–3 personas, 1–3 comparisons).
- **Every 30–60 seconds** for longer evals.
- **Stop polling** when `summary.running === 0`. Move to results synthesis (see [analyzing-results.md](analyzing-results.md)).

Do not poll faster than 10s — it's wasted tokens and the backend rate-limits. If the user wants real-time, point them at the in-app session replay (see deeplinks below).

## Inspecting a single run

When the user asks "why did persona X rate this 2?", fetch the run:

```
autouser_run_get({ evaluationId: "ev_abc", runId: "run_xyz" })
```

The response includes a **`viewUrl`** deeplink that opens the run with full session replay in the Autousers app:

```
https://app.autousers.ai/evals/ev_abc/results/autousers?inspectRun=run_xyz
```

Always surface this URL when a user asks for run details — it's a richer inspection surface than anything you can render in the chat.

For per-turn token + cost breakdown:

```
autouser_run_turns_list({ evaluationId: "ev_abc", runId: "run_xyz" })
```

Returns an array of turns with `inputTokens`, `outputTokens`, `cost` per turn. Useful for diagnosing expensive runs.

## Stopping in-flight runs

If the user wants to cancel:

```
autousers_run_stop({ evaluationId: "ev_abc" })          // cancel ALL pending/running
autousers_run_stop({ evaluationId: "ev_abc", runIds })   // cancel a subset
```

Cancellation is best-effort — runs already in their final inference call may still complete. Cost incurred up to the cancellation moment is not refunded.

## State machine

```
[ created ] --(start)--> [ running ] --(complete)--> [ done ]
                              |
                              +--(stop)--> [ cancelled ]
                              |
                              +--(error)--> [ failed ]
```

`autouser_status_get` returns counts across all states. If `failed > 0`, fetch the individual run with `autouser_run_get` and surface its error message.

## Cost-aware UX

Before you dispatch, the user should see:

- **How many ratings** will run (= autousers × comparisons)
- **Estimated total cost** (from the dryRun response's `costEstimate.totalCostUsd`)
- **Their remaining quota** (call `usage_get` once if helpful — but don't poll it)

After dispatch, when summarising completion:

- **Actual cost** (from the post-run response or `evaluations_results_get`)
- **Runs completed vs failed** (from `autouser_status_get`)
- **Deeplink to the results page** (`https://app.autousers.ai/evals/{id}/results`)

## Common failure modes

- **401 / `MissingApiKeyError`** → user's `ak_live_*` key is missing or revoked. Send them to `https://app.autousers.ai/settings/api-keys`.
- **422 on dispatch** → eval is in `Draft` status. Move it to `Running` with `evaluations_update` first, OR set the status inline on `evaluations_create`.
- **`autouserIds` rejected** → either the autouser is soft-deleted, or it belongs to a different team. Re-fetch with `autousers_list`.
- **Free quota exhausted** → `usage_get` will show `freeRunsRemaining: 0`. The user can continue (each rating bills at the per-rating rate), or add BYOK at `/settings/api-keys`. Surface both options; do not assume.
