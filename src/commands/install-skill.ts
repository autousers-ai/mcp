#!/usr/bin/env node
/**
 * `autousers-mcp install-skill` — install the Autousers Agent Skill into
 * a Claude Code skills directory.
 *
 * Skills are SKILL.md packages (open standard, https://agentskills.io)
 * that Anthropic introduced in 2025. They give Claude domain-specific
 * workflows + reference material the model wouldn't have on its own.
 *
 * The Autousers MCP exposes ~40 tools; this Skill teaches Claude when and
 * how to chain them (dryRun-first, kappa thresholds, output templates,
 * smart-resolver vocabulary, …). Without it, Claude has the tools but
 * not the operating manual.
 *
 * Source location
 * ---------------
 * The skill lives at `mcp/skill/autousers/` in the source tree. At
 * publish time, `package.json#files` includes `skill`, so the npm tarball
 * carries a copy at `node_modules/@autousers/mcp/skill/autousers/`.
 *
 * What this command does
 * ----------------------
 *   1. Detects (or accepts via flag) the target Claude Code skills
 *      directory: `~/.claude/skills/` (personal) or `.claude/skills/`
 *      (project-scoped).
 *   2. Copies the bundled `skill/autousers/` directory to
 *      `<target>/autousers/`, overwriting on rerun.
 *   3. Prints a one-liner confirming the install and the next step
 *      (restart Claude Code so the new skill is picked up).
 *
 * Flags
 * -----
 *   --project    install into `./.claude/skills/` (project scope) instead
 *                of `~/.claude/skills/` (personal scope).
 *   --target=DIR install into a specific directory; useful for hosts
 *                other than Claude Code.
 *   --force      overwrite without confirmation if the destination
 *                already exists.
 *
 * Why a CLI subcommand
 * --------------------
 * The MCP install is a one-line `npx -y @autousers/mcp …`; the Skill
 * install should be the same DX. Asking users to download a zip + hand-
 * unpack into `~/.claude/skills/` is friction we don't need.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import pkg from "../../package.json" with { type: "json" };

const SKILL_NAME = "autousers";
const HELP_URL = "https://autousers.ai/help/mcp";

interface ParsedArgs {
  project: boolean;
  target?: string;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { project: false, force: false, help: false };
  for (const arg of argv) {
    if (arg === "--project") out.project = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--target=")) out.target = arg.slice(9);
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    [
      `autousers-mcp install-skill — install the Autousers Agent Skill`,
      ``,
      `Usage:`,
      `  npx -y @autousers/mcp install-skill            # personal: ~/.claude/skills/`,
      `  npx -y @autousers/mcp install-skill --project  # project:  ./.claude/skills/`,
      `  npx -y @autousers/mcp install-skill --target=<dir>`,
      ``,
      `Flags:`,
      `  --project       install into ./.claude/skills/`,
      `  --target=<dir>  install into <dir>/${SKILL_NAME}/`,
      `  --force         overwrite an existing skill without confirmation`,
      `  -h, --help      show this message`,
      ``,
      `After install, restart your Claude Code session so the skill is loaded.`,
      `Docs: ${HELP_URL}`,
      ``,
    ].join("\n")
  );
}

/**
 * Resolve the absolute path of the bundled skill directory.
 *
 * In dev (running via tsx from `mcp/src/commands/install-skill.ts`), the
 * skill lives at `<repo>/mcp/skill/autousers/`. After build + publish,
 * the file is at `<pkg>/dist/commands/install-skill.js` and the skill is
 * bundled at `<pkg>/skill/autousers/`. Both resolve relative to the
 * compiled file.
 */
function bundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Walk up until we find the package root (contains package.json).
  // `here` is either `<pkg>/dist/commands` (built) or `<repo>/mcp/src/commands` (dev).
  const pkgRoot = path.resolve(here, "..", "..");
  return path.join(pkgRoot, "skill", SKILL_NAME);
}

function resolveTarget(args: ParsedArgs): string {
  if (args.target) {
    return path.resolve(args.target, SKILL_NAME);
  }
  if (args.project) {
    return path.resolve(process.cwd(), ".claude", "skills", SKILL_NAME);
  }
  return path.join(os.homedir(), ".claude", "skills", SKILL_NAME);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function main(): Promise<void> {
  // argv[2] is the subcommand name when dispatched from index.ts;
  // when invoked directly (bin), argv[2] is the first user flag.
  const argv = process.argv.slice(2);
  const startIdx = argv[0] === "install-skill" ? 1 : 0;
  const args = parseArgs(argv.slice(startIdx));

  if (args.help) {
    printHelp();
    return;
  }

  const src = bundledSkillDir();
  if (!(await pathExists(src))) {
    process.stderr.write(
      `error: bundled skill not found at ${src}\n` +
        `       this is a packaging bug; please report at ${pkg.bugs.url}\n`
    );
    process.exit(1);
  }

  const dest = resolveTarget(args);

  if (await pathExists(dest)) {
    if (!args.force) {
      process.stderr.write(
        `error: ${dest} already exists. Use --force to overwrite.\n`
      );
      process.exit(2);
    }
    await fs.rm(dest, { recursive: true, force: true });
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await copyDir(src, dest);

  process.stdout.write(
    [
      `✓ Installed Autousers Skill v${pkg.version} → ${dest}`,
      ``,
      `Next steps:`,
      `  1. Restart your Claude Code session (the skill loads at startup).`,
      `  2. Make sure the @autousers/mcp MCP server is connected:`,
      `       claude mcp add --transport http autousers https://mcp.autousers.ai/mcp \\`,
      `         --header "Authorization: Bearer $AUTOUSERS_API_KEY"`,
      `  3. Try a prompt: "create a side-by-side eval comparing https://a.com and https://b.com"`,
      ``,
      `Docs: ${HELP_URL}`,
      ``,
    ].join("\n")
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
