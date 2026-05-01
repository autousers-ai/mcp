# @autousers/mcp

Evaluate UX with AI personas and human raters — directly from Claude, Cursor, ChatGPT, and any MCP-aware client.

[![npm version](https://img.shields.io/npm/v/@autousers/mcp)](https://www.npmjs.com/package/@autousers/mcp)
[![MIT licensed](https://img.shields.io/npm/l/@autousers/mcp)](./LICENSE)

> **Mirror notice.** This repository is a read-only mirror — direct PRs
> filed here will be force-overwritten on the next sync. Please file
> **issues** here; the team applies fixes upstream and they propagate
> back to this mirror automatically.

---

## Install

The fastest way to connect is via the **remote server** — no package to install, OAuth handles auth automatically.

### Direct URL (recommended)

Paste `https://mcp.autousers.ai/mcp` into your client's MCP connector UI or config. OAuth 2.1 launches in the browser on first use.

| Client                | How to connect                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude.ai**         | Settings → Connectors → Add custom connector → paste URL                                                                                                                                            |
| **Claude Desktop**    | Settings → Connectors → Add custom connector → paste URL                                                                                                                                            |
| **Cursor**            | See config below or use the [one-click deeplink](cursor://anysphere.cursor-deeplink/mcp/install?name=autousers&config=eyJuYW1lIjoiYXV0b3VzZXJzIiwidXJsIjoiaHR0cHM6Ly9tY3AuYXV0b3VzZXJzLmFpL21jcCJ9) |
| **VS Code + Copilot** | See config below                                                                                                                                                                                    |
| **ChatGPT**           | Settings → Connectors → Developer Mode → Add connector → paste URL                                                                                                                                  |
| **Codex CLI**         | See config below                                                                                                                                                                                    |

**Cursor** — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "autousers": {
      "url": "https://mcp.autousers.ai/mcp"
    }
  }
}
```

**VS Code + GitHub Copilot** — `.vscode/mcp.json` (workspace) or `~/.config/Code/User/mcp.json` (global):

```json
{
  "servers": {
    "autousers": {
      "type": "http",
      "url": "https://mcp.autousers.ai/mcp"
    }
  }
}
```

**Claude Code CLI**:

```bash
claude mcp add --transport http autousers https://mcp.autousers.ai/mcp
```

**Codex CLI**:

```bash
codex mcp add autousers --url https://mcp.autousers.ai/mcp
```

### Bridge fallback (stdio-only clients)

Clients that only support stdio — Cline, Zed, Continue, Goose — use [mcp-remote](https://github.com/geelen/mcp-remote) as a shim:

```json
{
  "mcpServers": {
    "autousers": {
      "command": "npx",
      "args": ["-y", "mcp-remote@>=0.1.16", "https://mcp.autousers.ai/mcp"]
    }
  }
}
```

**Zed** — `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "autousers": {
      "command": {
        "path": "npx",
        "args": ["-y", "mcp-remote@>=0.1.16", "https://mcp.autousers.ai/mcp"]
      }
    }
  }
}
```

**Continue** — `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: autousers
    command: npx
    args:
      - -y
      - "mcp-remote@>=0.1.16"
      - https://mcp.autousers.ai/mcp
```

### Stdio / headless / CI

For environments without a browser (CI pipelines, scripted workflows), use the npm package with an API key:

```bash
# Claude Code with Bearer token
claude mcp add --transport http autousers https://mcp.autousers.ai/mcp \
  --header "Authorization: Bearer $AUTOUSERS_API_KEY"
```

Or run as a local stdio process:

```bash
npx -y @autousers/mcp
```

With environment variables:

```json
{
  "mcpServers": {
    "autousers": {
      "command": "npx",
      "args": ["-y", "@autousers/mcp"],
      "env": {
        "AUTOUSERS_API_KEY": "ak_live_..."
      }
    }
  }
}
```

---

## Tools

39 tools across four categories. Read-only tools carry `readOnlyHint=true` and are safe to call without side effects.

### Templates (6)

| Tool                  | Description                                    |
| --------------------- | ---------------------------------------------- |
| `templates_list`      | List question templates available to your team |
| `templates_get`       | Fetch a single template by ID                  |
| `templates_create`    | Create a new team-scoped template              |
| `templates_update`    | Patch a template (only supplied fields change) |
| `templates_delete`    | Hard-delete a template                         |
| `templates_duplicate` | Deep-clone a template into a destination team  |

### Evaluations (14)

| Tool                          | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `evaluations_list`            | List evaluations the caller can see                             |
| `evaluations_get`             | Fetch one evaluation including config and comparisons           |
| `evaluations_create`          | Create an SSE or SxS evaluation; optionally queue autouser runs |
| `evaluations_update`          | Patch fields on an evaluation                                   |
| `evaluations_delete`          | Delete an evaluation and its dependent rows                     |
| `evaluations_save_draft`      | Merge wizard fields into a draft evaluation                     |
| `evaluations_ratings_list`    | List human + autouser ratings                                   |
| `evaluations_results_get`     | Aggregate stats and per-rater summaries                         |
| `evaluations_agreement_get`   | Pairwise Cohen's Kappa inter-rater agreement                    |
| `evaluations_ai_insights_get` | AI-authored summary, key findings, and recommendations          |
| `evaluations_export_get`      | Download results as JSON or CSV                                 |
| `evaluations_share_create`    | Grant a per-user VIEWER / EDITOR / OWNER share                  |
| `evaluations_shares_list`     | List explicit per-user shares                                   |
| `evaluations_transfer`        | Transfer evaluation ownership to another user                   |

### Autousers (15)

| Tool                               | Description                                       |
| ---------------------------------- | ------------------------------------------------- |
| `autousers_list`                   | List autousers (built-in + custom)                |
| `autousers_get`                    | Fetch a single autouser by ID                     |
| `autousers_create`                 | Create a team-scoped custom autouser              |
| `autousers_update`                 | Patch a custom autouser                           |
| `autousers_delete`                 | Soft-delete a custom autouser                     |
| `autousers_duplicate`              | Deep-clone an autouser into a team                |
| `autousers_run`                    | Queue autouser runs against an evaluation         |
| `autousers_run_stop`               | Cancel pending or running autouser runs           |
| `autouser_status_get`              | Run statuses and summary counts for an evaluation |
| `autouser_run_get`                 | Fetch one autouser run with full context          |
| `autouser_run_turns_list`          | Per-turn token and cost telemetry for a run       |
| `autousers_calibration_start`      | Compute Cohen's Kappa vs human ratings            |
| `autousers_calibration_status_get` | Get calibration status                            |
| `autousers_calibration_freeze`     | Freeze a rubric version and set it as active      |
| `autousers_calibration_optimize`   | Send disagreements to AI for rubric suggestions   |

### Settings (4)

| Tool                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `teams_list`        | List every team the caller belongs to                 |
| `teams_get`         | Fetch one team's detail                               |
| `team_members_list` | List team members with roles and profiles             |
| `usage_get`         | Usage rollup: free-run pool remaining and token spend |

---

## Resources & Prompts

### Resources

Three readable resource URIs:

| URI                           | Description                              |
| ----------------------------- | ---------------------------------------- |
| `autousers://evaluation/{id}` | Full evaluation object including results |
| `autousers://template/{id}`   | Template definition with all dimensions  |
| `autousers://autouser/{id}`   | Autouser persona with rubric             |

### Prompts

Five canned workflows registered as MCP prompts:

| Prompt                 | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `evaluate-url`         | Create an SSE evaluation against a URL and surface results |
| `compare-designs`      | Create an SxS evaluation between two URLs                  |
| `analyze-results`      | Summarise evaluation results with key findings             |
| `calibrate-autouser`   | Run calibration and freeze the rubric when stable          |
| `triage-low-agreement` | Surface autouser/human disagreements and suggest fixes     |

---

## Authentication

### OAuth 2.1 (recommended)

When you add the server URL to any supported client, an OAuth 2.1 PKCE + DCR flow launches in the browser. After approving, the client receives a short-lived access token (~15 min) that rotates automatically via a refresh token. No static credentials are stored on the client.

**Best for:** Claude.ai, Claude Desktop, Cursor, VS Code, ChatGPT — any interactive session.

### API keys

API keys are long-lived bearer tokens for headless environments. Pass them as `Authorization: Bearer ak_live_...` — either as an HTTP header in the direct-URL clients or as the `AUTOUSERS_API_KEY` env var for stdio.

**Best for:** CI pipelines, Claude Code with `--header`, Codex CLI `--bearer-token`, scripts.

Mint keys at [app.autousers.ai/settings/api-keys](https://app.autousers.ai/settings/api-keys). Keys are shown **once** at creation — store them in a secrets manager immediately.

### Scopes

| Scope               | Grants                                           |
| ------------------- | ------------------------------------------------ |
| `templates:read`    | List and fetch templates                         |
| `templates:write`   | Create, update, delete, duplicate templates      |
| `evaluations:read`  | List, fetch, export, view results                |
| `evaluations:write` | Create, update, delete, share evaluations        |
| `autousers:read`    | List autousers, fetch runs and telemetry         |
| `autousers:write`   | Create, update, delete, run, calibrate autousers |
| `ratings:read`      | List ratings for an evaluation                   |

---

## Configuration

| Variable             | Default                    | Description                                               |
| -------------------- | -------------------------- | --------------------------------------------------------- |
| `AUTOUSERS_API_KEY`  | —                          | Bearer token for headless / stdio auth (`ak_live_...`)    |
| `AUTOUSERS_BASE_URL` | `https://app.autousers.ai` | Override the API host (e.g. for self-hosted or local dev) |

The default base URL points to production. You only need `AUTOUSERS_BASE_URL` if you are targeting a different environment.

---

## Diagnostics

Run the bundled doctor command to verify your configuration:

```bash
npx -y -p @autousers/mcp autousers-mcp-doctor
```

It checks that `AUTOUSERS_API_KEY` is set (for stdio auth), that the API host is reachable, and that at least one tool call succeeds. Exits non-zero on any misconfiguration so it integrates cleanly into CI pre-flight checks.

---

## Links

- [autousers.ai](https://autousers.ai) — product homepage
- [Install hub](https://autousers.ai/help/mcp) — client-specific setup guides
- [npm package](https://www.npmjs.com/package/@autousers/mcp) — `@autousers/mcp`
- [MCP specification](https://modelcontextprotocol.io) — Model Context Protocol
- [License](./LICENSE) — MIT
