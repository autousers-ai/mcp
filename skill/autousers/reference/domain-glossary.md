# Domain glossary

Terms used across Autousers. Use these definitions consistently when talking to the user.

## Core nouns

**Autouser** — A synthetic AI persona that rates designs against a rubric. Two flavors: **built-in** (canonical personas like "Power User", "Casual User", available to every account) and **custom** (team-scoped, calibrated to the team's domain). A persona is just a system prompt + capabilities + config; what makes it trustworthy is calibration.

**Evaluation (eval)** — A single rating session. Has a type (SSE or SxS), a stimulus (URL, image, or other), a dimension list, raters (human and/or autouser), and a status. An eval moves through states: `Draft → Running → Ended → (Archived)`.

**Stimulus** — What's being rated. Most common: a URL. Also: image, file, prototype.

**Dimension** — An axis the design is rated on. Examples: `usability`, `visual-design`, `accessibility`, `content`. Each dimension carries a score scale (typically 1–5).

**Rubric** — The full scoring guide for a dimension: factors, criteria, and anchors that explain what each score means.

**Factor** — A sub-component of a dimension. Example: under `usability`, factors might be `clarity`, `efficiency`, `error-prevention`.

**Criterion** — A specific testable statement. Example: "Primary CTA is visible without scrolling."

**Anchor** — Example text describing what each numeric score _looks like_ for a given criterion. Anchors are the most calibration-sensitive part of a rubric.

**Template** — A saved bundle of dimensions + factors + criteria + anchors that can be reused across evals. Team-scoped.

**Team** — The unit of access control. Members have roles (`OWNER`, `EDITOR`, `VIEWER`). Solo accounts get a personal team automatically.

**Rating** — One persona's score on one comparison on one dimension. The atomic unit of cost: one rating ≈ $0.091–$0.137.

**Run** — A single autouser dispatch on an evaluation. Encompasses all the ratings that persona will produce for that eval. Has a state: `pending → running → done | failed | cancelled`.

## Eval types

**SSE (single-sided evaluation)** — One stimulus at a time gets rated. "Score this design." Output is a score per dimension + rationale.

**SxS (side-by-side comparison)** — Two stimuli are compared per turn. "A or B?" Output is a winner per comparison + rationale + per-dimension scores. Costs more per rating because two stimuli are processed.

**Comparison** — In SxS, one A-vs-B pair. An eval can have many comparisons (one per pair the user wants tested).

## Quality and reliability

**Cohen's kappa (κ)** — Statistical measure of inter-rater agreement, corrected for chance. Ranges from -1 (perfect disagreement) to +1 (perfect agreement); 0 means agreement at chance level. Bands: <0.20 slight, 0.20–0.40 fair, 0.40–0.60 moderate, 0.60–0.80 substantial, >0.80 almost perfect.

**Calibration** — The process of measuring an autouser's κ against humans, then iteratively tightening the rubric until κ crosses a usability threshold. Output: a frozen rubric version that's reproducible and shareable.

**Disagreement** — A rating pair where the autouser's score and the human's score diverge by more than the configured threshold (typically ≥1 point on a 5-point scale). Disagreements feed the calibration optimizer.

**Convergence** — Calibration's stopping condition: kappa has stabilised across enough samples that further sampling won't meaningfully change the value.

**Freeze** — Lock a rubric version as the active one for an autouser. Frozen rubrics are reproducible across runs and shareable across teams.

**Optimize** — Send disagreements to Gemini and receive a refined rubric draft. The user reviews before the new version is committed.

## Cost and quota

**Free run pool** — A fixed prepaid pool of autouser runs (`freeRunsTotal` / `freeRunsRemaining`). Each rating consumes one slot from this pool until exhausted. Once exhausted, ratings bill at the per-rating rate.

**Per-rating cost** — ~$0.091 (URL stimulus, SSE) to ~$0.137 (URL stimulus, SxS). One rating = one autouser × one comparison × one dimension. Different stimulus types (image, file) have different rates.

**BYOK (Bring Your Own Key)** — Mode where the user supplies their own Gemini API key. Their key is billed for inference; Autousers does not charge per-rating. Configured at `/settings/api-keys`.

**Metered** — The default mode: Autousers' Gemini key is used and the user is billed at the per-rating rate after the free pool is exhausted.

**`betaUnlimited`** — A team flag that disables the free-pool cap entirely. If `usage_get` shows this, the user has no quota constraint.

## Auth and identity

**`ak_live_*`** — The format of an Autousers API key. Minted at `https://app.autousers.ai/settings/api-keys`. Used as `Authorization: Bearer ak_live_...` against the MCP server and the public REST API.

**Personal access token** — Synonym for `ak_live_*` in the UI.

**Session cookie** — How the web app authenticates browser users. Not relevant for Skill or MCP usage.

**OAuth** — How some MCP hosts (Claude.ai, Claude Desktop) authenticate users interactively. Alternative to Bearer; both end up at the same `userId`.

## Status / state

| Eval status | Meaning                                       |
| ----------- | --------------------------------------------- |
| `Draft`     | Editable; not collecting ratings              |
| `Running`   | Active; collecting ratings (human + autouser) |
| `Ended`     | Closed to new ratings; results frozen         |
| `Archived`  | Hidden from default lists; data preserved     |

| Run status  | Meaning                                           |
| ----------- | ------------------------------------------------- |
| `pending`   | Queued, not started                               |
| `running`   | Inference in flight                               |
| `done`      | Completed successfully                            |
| `failed`    | Errored; check `autouser_run_get` for the message |
| `cancelled` | User-cancelled via `autousers_run_stop`           |
