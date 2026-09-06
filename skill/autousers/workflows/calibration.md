# Calibrating an autouser

Calibration is how a custom autouser gets trustworthy. Without it, an AI persona is just a system prompt — useful, but you can't tell whether its ratings agree with humans on your domain.

The goal is to raise **Cohen's kappa** (agreement between the autouser and human raters) across each dimension until it crosses a usability threshold. The MCP exposes this as a four-tool loop; the `/calibrate-autouser` prompt orchestrates it for you.

## When to calibrate

- The user just created a custom autouser and wants to validate it before relying on its ratings.
- An existing autouser's results stopped feeling right ("the persona used to agree with us, now it doesn't").
- The user wants to measurably tighten a rubric (rather than tweak it by feel).

## Kappa thresholds

These are the practical thresholds Autousers uses for guidance. Surface them when reporting status — don't quote them as absolute truth.

| κ range   | Interpretation | Action                                                                     |
| --------- | -------------- | -------------------------------------------------------------------------- |
| < 0.20    | Slight / poor  | Rubric needs major work — call `optimize`                                  |
| 0.20–0.40 | Fair           | Likely a single ambiguous dimension dragging the average — `optimize` it   |
| 0.40–0.60 | Moderate       | Acceptable for low-stakes evals; `optimize` if the user wants higher trust |
| 0.60–0.80 | Substantial    | Ready to `freeze` — the persona reliably mirrors human raters              |
| > 0.80    | Almost perfect | Definitely `freeze`; consider whether the rubric is too rigid (overfit)    |

Kappa is per-dimension. Don't average them into one number — the user needs to see the per-dimension breakdown to know which dimension needs work.

## The four-tool loop

### 1. Start

```
autousers_calibration_start({
  autouserId: "au_abc",
  evaluationId: "ev_with_human_ratings",
  sampleSize: <optional>,
})
```

Returns a calibration session id and an initial kappa snapshot. Calibration needs an evaluation that already has **human ratings** to compare against — the autouser will rate the same comparisons and the system computes κ per dimension.

If the user doesn't have a calibration-ready eval, point them at `autousers_calibration_status_get({ id, includeEvals: true })` — that returns a list of pickable evals.

### 2. Poll status

```
autousers_calibration_status_get({ id: "au_abc" })
```

Returns:

- Current per-dimension kappa
- Whether each dimension has converged (sample size sufficient)
- Disagreements (rating pairs where autouser and human diverged)

Poll cadence: 30–60 seconds. Stop when the status reports convergence OR when the user has seen enough.

### 3. Branch: optimize OR freeze

This is the decision point. Look at the per-dimension κ values:

**If κ is below the user's target on any dimension:**

```
autousers_calibration_optimize({
  id: "au_abc",
  disagreements: [
    { ratingId: "r_1", humanReasoning: "..." },
    ...
  ],
  manualRubricEdit: <optional, when the user wants to dictate the change>,
})
```

`optimize` ships the disagreements to Gemini and returns an updated rubric draft. The user reviews and either accepts (which produces a new rubric version) or rejects (no change). After accepting, you're back to step 2: re-poll until kappa stabilises.

**If κ is at or above target across the board:**

```
autousers_calibration_freeze({
  id: "au_abc",
  rubricId: <current version>,
  commitMessage: "v3 final — usability + content stable",
})
```

Freezing locks the rubric version as the active one. From this point, the autouser's ratings are reproducible and shareable across teams.

## Disagreements: how to handle them

When `optimize` returns disagreements, do not invent the `humanReasoning` field. The user (or the human raters' notes) provide it. If the user says "just optimize from what's there", omit `disagreements` and let the optimizer infer from the eval data alone — the API supports this.

When the user wants to manually rewrite a rubric criterion, pass `manualRubricEdit` instead of `disagreements`. This skips the Gemini step and applies the edit directly.

## Output

When you finish a calibration round, report it using the [calibration-report.md](../templates/calibration-report.md) output template. Always include:

- Per-dimension kappa before and after
- Which dimensions you optimized vs left alone
- Whether the rubric was frozen and the new version's `commitMessage`
- A link to the autouser's settings: `https://app.autousers.ai/autousers/{id}`

## Anti-patterns

- **Reporting a single average kappa.** Always per-dimension.
- **Calling `freeze` before convergence.** The kappa snapshot must say converged.
- **Re-running `start` repeatedly.** It costs compute. Use `status_get` to poll an in-flight session.
- **Optimizing every dimension at once.** It's faster and clearer to optimize one dimension, re-measure, then move to the next.
