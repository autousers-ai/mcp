# Creating evaluations

This file covers how to create an evaluation correctly. Read it before calling `evaluations_create`.

## SxS vs SSE — pick the right shape first

Autousers has two evaluation types. They are not interchangeable.

| Type                   | Use when                                                     | Stimulus shape                                      |
| ---------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| **SSE** (single-sided) | "Rate this design" / "Score this URL" / one-at-a-time review | `designUrls: [{ url, stimulusType }]`               |
| **SxS** (side-by-side) | "Compare A vs B" / variant testing / before-after            | `comparisonPairs: [{ id, currentUrl, variantUrl }]` |

If the user's intent is comparative ("which is better", "did the redesign improve X"), choose SxS. Otherwise choose SSE. When in doubt, ask once — switching mid-eval is not supported.

## The default policy: preview, then confirm

`evaluations_create` enforces this in its tool description, but you must follow it consciously:

1. **First call** with `dryRun: true` to surface the proposed config + cost estimate + the personas you'd suggest.
2. **Wait for user confirmation.** Do not describe a dryRun response as "created", "live", or "started". By definition nothing was persisted.
3. **Re-issue without `dryRun`**, almost always with `status: 'Draft'`. Drafts are editable via `evaluations_update` / `evaluations_save_draft`.
4. **Only set `status: 'Running'`** when the user explicitly says to launch AND the eval is fully configured (including `selectedAutousers` if `evaluationMethod` is `'ai'` or `'both'`).

When `status === 'Running'` AND `selectedAutousers` is non-empty AND `evaluationMethod` is `'ai'` or `'both'`, `evaluations_create` ALSO queues autouser runs and returns a cost estimate. That is the point of no return for spend.

## Selecting autousers

**Never pick personas yourself.** They're contextual to the audience and design.

The right sequence:

1. Call `autousers_list` (returns both built-ins and the user's custom personas, each row has `source: 'built-in' | 'custom'` and `isSystem: boolean`).
2. Present the user with the candidates relevant to their stated audience. Lead with their **custom** personas — those are calibrated to their domain. Built-ins are good fallbacks when no custom persona fits.
3. Let the user pick. Multiple is fine; one is fine.
4. Pass them as `selectedAutousers: [{ autouserId, agentCount }]` on `evaluations_create`.

If the user wants only human raters, set `evaluationMethod: 'manual'` and omit `selectedAutousers`. That is a fully valid eval, not a misconfiguration.

## Selecting dimensions

`selectedDimensionIds` defaults to `['overall']` when omitted. Prefer:

- Built-in dimension IDs: `'overall'`, `'usability'`, `'visual-design'`, `'accessibility'`, `'content'`, `'helpfulness'`, `'accuracy'`, `'safety'`, `'design-system'`.
- Or IDs from `templates_list` if the user has a saved rubric.

**Custom dimensions rule:** any ID present in `customDimensions[]` MUST also appear in `selectedDimensionIds`, and each `customDimension` MUST have an `id` and a `name` (or `label`). Validation will reject otherwise.

## End-to-end example

```
User: "Run a quick AI review on https://acme.com/pricing — focus on usability and content."

You:
  1. autousers_list (see what custom personas they have)
     → present 2–3 candidates, ask user to pick
  2. evaluations_create (dryRun: true) with
     {
       name: "Pricing page review",
       type: "SSE",
       designUrls: [{ url: "https://acme.com/pricing", stimulusType: "url" }],
       selectedDimensionIds: ["usability", "content"],
       evaluationMethod: "ai",
       selectedAutousers: [{ autouserId: <picked>, agentCount: 1 }]
     }
     → present cost estimate + config
  3. On confirmation: re-issue WITHOUT dryRun, status: "Draft"
  4. On launch: evaluations_update { id, status: "Running" }
     (which auto-fans the autouser runs)
  5. workflows/running-autousers.md takes over from here
```

## What goes wrong

- **Setting `status: 'Running'` immediately on `evaluations_create`.** This skips the user's chance to review the config and burns money on a misconfigured eval. Use `'Draft'` first.
- **Calling without `dryRun: true`.** You miss the cost estimate, and you can't recover the user's confirmation step.
- **Picking autousers from their `name`** ("the Skeptic sounds right"). Always show the list and let the user choose.
- **Forgetting `teamId` on team-scoped templates.** `templates_create` will return `isError: true` with no `id` — if you don't see both a clean response AND an `id`, the template was NOT created. Surface the error verbatim.

## Drafts: the iteration loop

Once you have a draft, use:

- `evaluations_update` — patch any field. Standard PATCH semantics.
- `evaluations_save_draft` — merge wizard fields (`designUrls`, `selectedAutousers`, etc.) into a Draft or Ended eval. Useful for "save my progress" UX.
- `evaluations_get` — re-fetch to confirm state before publishing.

When the user says "ship it" / "launch" / "go live": `evaluations_update { id, status: 'Running' }`. From this point, [workflows/running-autousers.md](running-autousers.md) takes over.
