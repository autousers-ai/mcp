# Output template — calibration report

Use this structure when reporting the result of a calibration round. Adapt to the run's specifics, but keep the per-dimension table and the action taken.

## Template

```markdown
## Calibration: {autouser name} · {Optimized | Frozen | In progress}

**Eval used:** {eval name} ({rating count} ratings)
**Status:** {converged | needs more samples}

### Kappa, before vs after

| Dimension | κ before         | κ after          | Action                         |
| --------- | ---------------- | ---------------- | ------------------------------ |
| {dim 1}   | {value} ({band}) | {value} ({band}) | Optimized / Unchanged / Frozen |
| {dim 2}   | ...              | ...              | ...                            |

### What changed

- {Bullet describing rubric edits the optimizer suggested for dim X.}
- {Anchor change for dim Y, if any.}
- {Manual edit by the user, if any.}

### Outcome

{One paragraph: did the persona converge? Was the rubric frozen? What's the new version's `commitMessage`? Where can the user inspect the rubric?}

[Open this autouser in Autousers →](https://app.autousers.ai/autousers/{id})
```

## Rules

- **Per-dimension always.** Never average kappa across dimensions in the headline.
- **Show before vs after.** The user wants to see the delta the round produced.
- **Name the action per dimension.** "Optimized" / "Unchanged" / "Frozen" / "Needs more samples". Don't leave the user guessing what happened to which dimension.
- **Quote the `commitMessage` on freeze.** It's the version label the user (or you) authored — show it in the outcome paragraph.
- **Link to the persona page.** The app shows full rubric history; you can't render that in chat.

## When optimization didn't converge

If the loop ran but kappa didn't cross the user's target, end the outcome paragraph with the next-step recommendation:

> κ on {dimension} is still {value} ({band}) after this round. Consider: (a) gathering more human ratings on a fresh eval and re-running calibration, or (b) editing the {dimension} criterion text manually before the next round.

## When the user manually edited a rubric

If the round used `manualRubricEdit` (no Gemini step), say so:

> The user edited the {dimension} criterion directly. No optimizer suggestions were applied this round.

## When freeze is recommended but not yet executed

After a round where every dimension is at or above target, the outcome paragraph should ask:

> All dimensions are at or above target κ. Ready to freeze this rubric version?

Then wait for the user's confirmation before calling `autousers_calibration_freeze`. Freezing changes the active rubric for the persona — it's a write action that should not happen without explicit consent.
