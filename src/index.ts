#!/usr/bin/env node
/**
 * Autousers MCP server — entrypoint dispatcher.
 *
 * Wave 1 of `docs/MCP_HARDENING_PLAN.md` splits the bootstrap path so the
 * package can host more than one launcher behind a single `bin` entry. The
 * default (no argv) keeps v0.7.x behaviour: spawn a stdio MCP server. The
 * subcommands give us:
 *
 *   - `autousers-mcp`              → stdio MCP server (default)
 *   - `autousers-mcp stdio`        → stdio MCP server (explicit)
 *   - `autousers-mcp http`         → HTTP MCP server (Wave 2, throws today)
 *   - `autousers-mcp doctor`       → preflight diagnostic (also published
 *                                    separately as `autousers-mcp-doctor`)
 *   - `autousers-mcp install-skill`→ install the Autousers Agent Skill
 *                                    into ~/.claude/skills/ (Claude Code)
 *
 * Why a dispatcher instead of multiple `bin` files only
 * -----------------------------------------------------
 * MCP hosts (Claude Code, Cursor, …) overwhelmingly use the package's
 * default `bin` and pass args via their config. Keeping `autousers-mcp` as
 * the single discoverable entry preserves the install instructions in the
 * README; the `autousers-mcp-doctor` shortcut is additive (`bin` map adds
 * a second symlink, no breaking change).
 *
 * Adding a subcommand: switch on `argv[2]` here, route to a function in
 * `./<name>-entry.ts` or `./commands/<name>.ts`. The factory in
 * `server-factory.ts` is the shared core — every MCP-shaped subcommand
 * goes through it.
 */

import { runStdio } from "./stdio-entry.js";

async function dispatch(): Promise<void> {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case undefined:
    case "stdio": {
      await runStdio();
      return;
    }
    case "http": {
      const { runHttp } = await import("./http-entry.js");
      await runHttp();
      return;
    }
    case "doctor": {
      // doctor.ts runs `main()` on import and calls process.exit; the
      // dynamic import is only needed because we don't want to load it
      // (and its fetch path) on every stdio start.
      await import("./commands/doctor.js");
      return;
    }
    case "install-skill": {
      // install-skill.ts runs `main()` on import; same dynamic-import
      // rationale as doctor — keeps the stdio fast path lean.
      await import("./commands/install-skill.js");
      return;
    }
    default: {
      console.error(`Unknown subcommand: ${subcommand}`);
      console.error(
        "Valid subcommands: stdio (default), http, doctor, install-skill"
      );
      process.exit(64);
    }
  }
}

dispatch().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
