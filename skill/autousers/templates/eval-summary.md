# Output template — evaluation summary

Use this structure when reporting evaluation results back to the user. Adapt section content to the eval's specifics, but keep the order and the reliability gate.

## Template

```markdown
## {Eval name} · {SSE | SxS} · {Ended | Running}

**Headline:** {one-line takeaway — winner for SxS, score band for SSE}

**Reliability:** Overall κ = {value} ({band}).
{If any dimension < 0.40, list it here with a 1-line caveat.}

### Per-dimension breakdown

| Dimension | Score      | Agreement (κ) | Notes               |
| --------- | ---------- | ------------- | ------------------- |
| {dim 1}   | {mean} / 5 | {κ} ({band})  | {1-line if notable} |
| ...       | ...        | ...           | ...                 |

### Key findings

1. {Finding from `ai_insights_get`, rephrased.}
2. {Finding 2.}
3. {Finding 3 — keep to 3–5 max.}

### Recommendations

- {Top action from `ai_insights_get`, rephrased.}
- {Second action if there is one.}

[View full results in Autousers →](https://app.autousers.ai/evals/{id}/results)
```

## Rules

- **Headline first.** The user wants the answer before the methodology.
- **Reliability gate next.** A score with low κ is misleading; flag it before the breakdown.
- **Cite the source for findings.** Use phrasing like "the AI insights pass surfaced..." rather than presenting them as your own analysis.
- **Always include the deeplink.** The Autousers app has session replay, per-rating rationale, and rater-level filtering that you can't render in chat.
- **Don't show every rating.** That's what the export is for. Summarise.
- **Currency: USD.** When mentioning cost, use the format `$0.12` (no fractional cents below $0.01).

## SSE vs SxS specifics

**SSE headline patterns:**

- "Strong overall — {dimension} scored {value}/5 with substantial agreement."
- "Mixed result — {dim A} is solid ({value}/5) but {dim B} is weak ({value}/5)."
- "Reliability gap — overall score is {value}/5, but κ on {dim} is {value}, so this number isn't trustworthy yet."

**SxS headline patterns:**

- "{Variant} wins on {N of M} comparisons."
- "{Variant A} wins overall, but {Variant B} is stronger on {dimension}."
- "Inconclusive — winners split evenly and per-dimension agreement is low."

## When the eval has only one rater

If the eval has only one rater (one human OR one autouser), there's no inter-rater agreement to report. Skip the κ row and replace the reliability gate with:

> **Reliability:** Single-rater eval — agreement statistics not applicable. Treat scores as one point of view.

## When the eval has failed runs

If `autouser_status_get` shows `failed > 0`, surface this BEFORE the breakdown:

> ⚠️ {N} autouser run(s) failed and are not included in these scores. {Optional: link to `autouser_run_get` for the failure detail.}

Don't hide failures — the user needs to know if their headline is computed from a partial sample.
