# Auth and setup

The Skill calls Autousers exclusively through the MCP server. The MCP handles auth; you don't make raw HTTP calls.

## API keys

Autousers issues `ak_live_*` API keys. They are minted by the user at:

```
https://app.autousers.ai/settings/api-keys
```

The key is shown **once** at creation. After that, only its hash is stored. If the user lost it, they need to mint a new one and revoke the old.

The MCP receives the key as `Authorization: Bearer ak_live_…`. How that header gets there depends on the host:

| Host                           | How the key reaches the MCP                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Claude Code**                | OAuth flow OR `--header "Authorization: Bearer $AUTOUSERS_API_KEY"` on the install command                              |
| **Claude.ai / Claude Desktop** | OAuth via the Connectors UI                                                                                             |
| **Cursor**                     | JSON config: `{"transport": "http", "url": "https://mcp.autousers.ai/mcp", "headers": {"Authorization": "Bearer ..."}}` |
| **VS Code + Copilot**          | Workspace or user `mcp.json` with `Authorization` header                                                                |
| **stdio bridge fallback**      | `AUTOUSERS_API_KEY` env var on the bridge process                                                                       |

The user never types the key into chat. If they ask "should I paste my key here?" the answer is **no** — point them at their host's MCP settings.

## Server URL

Production:

```
https://mcp.autousers.ai/mcp
```

Also reachable at `https://app.autousers.ai/mcp` (same handler, alias). Don't tell the user to use the alias unless they're behind DNS that blocks the `mcp.` subdomain.

## What happens on auth failure

If the MCP can't find a key, every tool call returns `MissingApiKeyError` with a hint. Surface the recovery path:

> "Your Autousers API key is missing. Mint one at https://app.autousers.ai/settings/api-keys and add it to your MCP config. See https://autousers.ai/help/mcp for host-specific instructions."

If the key is present but invalid (revoked, expired, wrong workspace), the tool returns 401. Same recovery path.

## BYOK vs metered

The user can be in one of three cost modes. `usage_get` (or `get_usage`) tells you which:

| Mode                             | Indicator                              | Implication                                                              |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| **Metered, free pool healthy**   | `freeRunsRemaining > 0`, `byok: false` | Each rating consumes a free-pool slot; no $ spent                        |
| **Metered, free pool exhausted** | `freeRunsRemaining: 0`, `byok: false`  | Each rating bills at ~$0.091–$0.137                                      |
| **BYOK**                         | `byok: true`                           | User's Gemini key bills for inference; Autousers takes no per-rating fee |
| **`betaUnlimited`**              | `betaUnlimited: true`                  | No quota cap                                                             |

When summarising costs to the user, **always state both `freeRunsRemaining` and `costUsd`** — they are different concepts. A `costUsd: 0` response does not mean the user has unlimited free runs forever; it might mean the runs that happened consumed the prepaid pool.

## Base URL resolution (rare)

The MCP itself talks to the Autousers REST API. The base URL it uses, in priority order:

1. `AUTOUSERS_BASE_URL` env var (override for staging/dev)
2. `NEXT_PUBLIC_APP_URL`
3. `https://app.autousers.ai` (production fallback)

This matters only when the user is running their own MCP build against a non-prod environment. For 99% of cases, prod is correct and you don't need to think about it.

## Privacy

Autousers data retention follows the standard policy described at `https://autousers.ai/privacy`. The MCP server itself is stateless — it doesn't store conversation history; tool calls are forwarded to the REST API and the response returned.

If the user is running this Skill on the **Claude API** with the `code-execution-2025-08-25` and `skills-2025-10-02` betas, note that Skills **are not eligible for Zero Data Retention (ZDR)** per Anthropic's documentation. Tell the user this if they ask.
