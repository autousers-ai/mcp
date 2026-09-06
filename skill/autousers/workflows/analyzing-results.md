# Analyzing results

This is what you do once an evaluation has finished collecting ratings. The MCP exposes three tools that compose into a complete picture; the `/analyze-results` prompt chains them for you.

## The three-tool synthesis chain

```
evaluations_results_get   →   evaluations_agreement_get   →   evaluations_ai_insights_get
       (what)                          (how reliable)                     (why)
```

Always run all three for any non-trivial summary. Each answers a different question and they don't substitute for each other.

### 1. `evaluations_results_get` — the WHAT

```
evaluations_results_get({ id: "ev_abc" })
```

Returns:

- Aggregate scores per dimension (mean, median, stddev)
- Per-rater summaries (each human + each autouser, with their dimension scores)
- For SxS: a winner per comparison + overall winner
- Sample counts (how many ratings, how many comparisons)

This is the headline number. But a headline number without an agreement context is misleading — never report it alone if there are multiple raters.

### 2. `evaluations_agreement_get` — the HOW RELIABLE

```
evaluations_agreement_get({ id: "ev_abc" })
```

Returns:

- Overall Cohen's κ across rater pairs
- Per-pair κ (autouser vs human, autouser vs autouser, human vs human)
- Per-dimension agreement percentages
- An `interpretation` field with the κ band (slight/fair/moderate/substantial/almost-perfect)

Use this to qualify the headline. If κ is < 0.40 on a dimension, the score on that dimension is unreliable — say so explicitly.

### 3. `evaluations_ai_insights_get` — the WHY

```
evaluations_ai_insights_get({ id: "ev_abc" })
```

Returns a Gemini-authored narrative:

- Summary
- Key findings (3–5 bullets)
- Recommendations

Use these as a starting point for your own synthesis — quote them, but rephrase for the user's specific question. Don't paste the raw insights without context; the user asked you, not Gemini.

## Output shape

Use [templates/eval-summary.md](../templates/eval-summary.md) as the canonical structure. The short version:

1. **One-line headline** — winner (SxS) or overall score band (SSE)
2. **Reliability gate** — overall κ + interpretation; flag any dimension under 0.40
3. **Per-dimension breakdown** — score + agreement, side-by-side
4. **Top 2–3 findings** from `ai_insights` (rephrased)
5. **Top 1–2 recommendations** from `ai_insights` (rephrased)
6. **Deeplink** to the results page: `https://app.autousers.ai/evals/{id}/results`

## Triaging low agreement

If overall κ is below 0.40, the user's evaluation has a reliability problem. Don't try to fix it inline — recommend the `/triage-low-agreement` prompt instead. That prompt:

1. Identifies which dimension(s) are dragging the average
2. Surfaces the specific disagreements driving low κ
3. Suggests rubric clarifications
4. Offers to start a calibration round for the offending autouser (see [calibration.md](calibration.md))

## Exporting

When the user wants the data outside Autousers:

```
evaluations_export_get({ id: "ev_abc", format: "csv" })  // one row per (rating × dimension)
evaluations_export_get({ id: "ev_abc", format: "json" }) // full structured payload
```

CSV is friendlier for spreadsheet analysis; JSON preserves nested structure (rationale text, anchors). Default to CSV unless the user asks for JSON.

## Sharing the result

If the user wants to share a specific eval with a colleague:

```
evaluations_share_create({
  id: "ev_abc",
  userId: "user_xyz",      // from teams_get / team_members_list
  permission: "VIEWER",    // or "EDITOR" / "OWNER"
})
```

For a permanent ownership change (e.g., the user is leaving the team):

```
evaluations_transfer({ id: "ev_abc", userId: "user_new_owner" })
// caller is demoted to EDITOR; target becomes OWNER
```

To audit who has access:

```
evaluations_shares_list({ id: "ev_abc" })
```

## What NOT to do

- **Don't summarise from `results_get` alone.** A score without κ is misleading.
- **Don't paraphrase `ai_insights` as your own analysis.** Cite that they came from the AI insights pass.
- **Don't compute κ yourself from raw ratings.** Use `agreement_get` — the math is already done and tested.
- **Don't ignore failed runs.** If `results_get` shows fewer ratings than expected, check `autouser_status_get` for failures and surface them.
