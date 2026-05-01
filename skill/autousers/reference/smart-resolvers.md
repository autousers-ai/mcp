# Smart resolvers

Three of the MCP's canned prompts (`/analyze-results`, `/calibrate-autouser`, `/triage-low-agreement`) accept an evaluation or autouser identifier. Instead of forcing the user to paste a cuid, the prompt server resolves these shortcuts at prompt-render time.

Use them when the user names something instead of pasting an ID.

## Shortcut vocabulary

The resolver matches the input against these patterns, in order:

### 1. Verbatim cuid

If the input matches the cuid pattern (e.g., `cmoi…`), it's used directly with no preamble and no list call.

### 2. Picker words

Inputs `pick`, `list`, `which`, `choose` render the full list as a markdown picker, no auto-selection. Use this when the user explicitly asks "show me my evals" or hasn't decided yet.

### 3. Latest / recent / newest

Inputs `latest`, `recent`, `newest` resolve to the first row of the default-ordered list (most recently updated). Use this when the user says "the eval I just created" or "the most recent one".

### 4. Numeric position

Inputs `1` through `99` resolve to the 1-indexed position in the list. Use this after the user has seen a picker and replied with "the second one" or "3".

### 5. Status filter (evaluations only)

Inputs `running`, `ended`, `draft`, `archived` filter the list by that status:

- If exactly one eval matches, it's auto-selected.
- If multiple match, a filtered picker is rendered.
- If none match, the full picker is rendered with a warning.

Use this when the user says "the running one" or "my draft".

### 6. Fuzzy name match

Anything else is treated as a substring, case-insensitive name search:

- One match → auto-selected with a confirmation preamble
- Zero matches → full picker rendered with a warning
- Multiple matches → filtered picker rendered

## When to use a shortcut vs the verbatim cuid

| User said                   | Shortcut            | Why                                    |
| --------------------------- | ------------------- | -------------------------------------- |
| "Analyze ev_abc123"         | (cuid)              | Already an ID — pass through           |
| "Analyze the latest eval"   | `latest`            | Resolver does the lookup               |
| "Show me my running evals"  | `running`           | Filter by status                       |
| "Pick eval 2"               | `2`                 | Position from the picker they just saw |
| "The homepage redesign one" | `homepage redesign` | Fuzzy name match                       |
| "I'm not sure"              | `pick`              | Render full picker                     |

## Where the resolver runs

The resolver is **server-side, inside the prompt handler** — it pre-fetches the list and bakes the picker (or the resolved id) into the user-facing message. That means:

- One round-trip instead of three (no separate `evaluations_list` → confirm → re-prompt cycle)
- The picker shows up on turn 1
- The user's free-text input (whether typed into a slash menu arg or said in chat) is parsed the same way

## When to fall back to manual chains

If the user's intent doesn't match a canned prompt at all (e.g., "create a new eval", "delete this template"), don't try to force a smart resolver. Use the corresponding tool directly with the cuid you already have, or ask the user to disambiguate.

The smart resolvers are a UX optimization for **read-side** prompt arguments. They are not a general ID-disambiguation strategy for write tools.

## Edge cases

- **Numeric input outside list range** (e.g., `7` when only 3 rows exist) — picker re-renders with a "position out of range" warning. Pass the user's choice from the picker.
- **Empty list** — the resolver returns "No evaluations found" with no auto-selection. Suggest the user create one (workflows/creating-evals.md).
- **Stale list** — the resolver fetches fresh data per prompt invocation. If the user expects an eval to be there but it isn't, the eval may be in a different team — check `teams_list`.
