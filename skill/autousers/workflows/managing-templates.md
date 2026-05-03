# Managing templates and dimensions

Templates in Autousers are reusable rubric question sets — a saved bundle of dimensions, factors, criteria, and anchors that you can apply across evaluations.

## When to use a template vs ad-hoc dimensions

Use a **built-in dimension ID** (no template needed) when:

- The user wants a quick eval and doesn't care about a custom rubric
- The dimension is generic: `'overall'`, `'usability'`, `'visual-design'`, `'accessibility'`, `'content'`, `'helpfulness'`, `'accuracy'`, `'safety'`, `'design-system'`

Use a **template** (saved rubric) when:

- The team has a recurring eval shape (e.g., "our quarterly homepage review")
- The rubric has custom dimensions, factors, or anchors that are tedious to re-enter
- Multiple team members need to run the same eval consistently

Use **`customDimensions[]` inline on `evaluations_create`** when:

- The eval is one-off but needs a non-standard dimension
- The user is experimenting with a rubric they may later promote to a template

## The template lifecycle

### List

```
templates_list({ limit: 50 })
```

Returns built-in templates AND the team's custom templates. Each row has `source: 'built-in' | 'custom'`. Built-ins are not duplicates of custom ones — show both.

### Get

```
templates_get({ id: "tpl_abc" })
```

Returns the full template: `factors`, `criteria`, `anchors`, `scoreLabels`. Read this before creating an eval that uses the template — the user may want to override one of these inline.

### Create

```
templates_create({
  teamId: "team_xyz",       // REQUIRED
  name: "UX heuristics v2",
  type: "TEXT_SSE",         // or "TEXT_SXS"
  factors: [...],
  // OR sseCriteria / sxsCriteria depending on type
})
```

**Validation rule:** The template is persisted only if the response has NO `isError` field AND contains a non-empty `id`. If either is missing, the template was NOT created — surface the error verbatim. Do not claim success on a malformed response.

If you don't know the user's `teamId`, call `teams_list` first.

### Update

```
templates_update({ id: "tpl_abc", name: "Renamed" })
```

PATCH semantics — only included fields change.

### Duplicate

```
templates_duplicate({ id: "tpl_abc", teamId: "team_xyz" })
```

Use this when the user wants to fork a built-in template or copy a colleague's template into their team. Cleaner than re-creating from scratch.

### Delete

```
templates_delete({ id: "tpl_abc" })
```

Fails if the template is currently attached to an evaluation. If the user insists, they need to detach it from the eval first (or delete the eval) — surface the error and ask.

## Anchors and scoreLabels

Anchors are the example responses that map to each score on the scale. The MCP doesn't rewrite anchors for you — that's a manual edit by the user (or a calibration optimization, see [calibration.md](calibration.md)).

When the user says "make my anchors clearer", do not generate replacement text yourself. Instead:

1. Show them the current anchors (`templates_get`)
2. Ask what's unclear about each one
3. Apply their edits via `templates_update`

The exception: if the user explicitly invokes `/calibrate-autouser` and the optimization step suggests anchor changes, those are vetted by the optimizer and OK to apply on user confirmation.

## Composing with evaluations

When `evaluations_create` is called with a template ID, the eval inherits the template's dimensions, factors, and anchors. The user can still:

- Override the dimension list inline with `selectedDimensionIds`
- Add one-off dimensions with `customDimensions[]` (each must also appear in `selectedDimensionIds`)
- Edit the eval's copy of the rubric without affecting the template

Templates are a **starting point**, not a binding contract.

## What NOT to do

- **Don't call `templates_create` without `teamId`.** It will fail. Always list teams first if you don't have one.
- **Don't claim a template was created if the response has `isError: true` or no `id`.** Read both before reporting success.
- **Don't generate anchor text for the user.** It's their rubric — you're the operator, not the author.
- **Don't delete a template attached to an eval without explicit confirmation.** The error is the safety net; respect it.
