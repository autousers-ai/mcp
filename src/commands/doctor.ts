#!/usr/bin/env node
/**
 * `autousers-mcp-doctor` — preflight diagnostic.
 *
 * The single most-reported MCP host failure is "the server crashed on
 * startup with no useful error" — almost always a missing or wrong
 * `AUTOUSERS_API_KEY`, or a base URL the user can't reach (corp proxy,
 * VPN-only environment, app deploy down). Hosts hide stderr unless you
 * dig, so the user only sees "MCP server failed to start".
 *
 * `doctor` is the get-out-of-jail card: a tiny standalone CLI that
 * exercises the same auth + base-URL path the MCP tools use, prints a
 * clear PASS/FAIL summary, and exits with a non-zero code on failure so
 * scripts can gate on it. Users invoke it via:
 *
 *     npx -y @autousers/mcp autousers-mcp-doctor
 *
 * (or `autousers-mcp-doctor` directly after a global install).
 *
 * Checks
 * ------
 *   1. AUTOUSERS_API_KEY is set.
 *   2. AUTOUSERS_BASE_URL resolves and accepts a request.
 *   3. /api/v1/usage returns 200 (ie. the bearer is recognised by the
 *      same auth path the tools rely on).
 *
 * Notes
 * -----
 * - This file is published as a separate `bin` entry so it has a stable
 *   name; the dispatcher can also route to it via `argv[2] === "doctor"`,
 *   but external launchers should prefer the bin name.
 * - We deliberately do NOT import the MCP SDK here — startup latency
 *   matters when this is in front of a 30-second host timeout.
 */

import pkg from "../../package.json" with { type: "json" };

const BASE_URL = process.env.AUTOUSERS_BASE_URL ?? "https://app.autousers.ai";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function check(
  name: string,
  fn: () => Promise<string>
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkApiKeyPresent(): Promise<string> {
  const key = process.env.AUTOUSERS_API_KEY;
  if (!key) {
    throw new Error(
      `AUTOUSERS_API_KEY not set. Mint one at ${BASE_URL}/settings/api-keys ` +
        `and add it to your MCP host's env block.`
    );
  }
  // Don't print the whole key; show prefix + last 4 so users can spot
  // copy-paste truncation.
  const masked = `${key.slice(0, 8)}…${key.slice(-4)}`;
  return `present (${masked})`;
}

async function checkBaseUrlReachable(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/usage`, {
    method: "OPTIONS",
  }).catch((err: unknown) => {
    throw new Error(
      `Could not reach ${BASE_URL}: ${
        err instanceof Error ? err.message : String(err)
      }. ` +
        `Set AUTOUSERS_BASE_URL=https://app.autousers.ai for prod, or ` +
        `http://localhost:3000 for local dev.`
    );
  });
  return `${BASE_URL} (HTTP ${res.status})`;
}

async function checkUsageEndpoint(): Promise<string> {
  const key = process.env.AUTOUSERS_API_KEY;
  if (!key) {
    throw new Error("Skipped (no AUTOUSERS_API_KEY).");
  }
  const res = await fetch(`${BASE_URL}/api/v1/usage`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": `autousers-mcp-doctor/${pkg.version}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Bearer rejected (HTTP ${res.status}). Mint a fresh key at ` +
        `${BASE_URL}/settings/api-keys.`
    );
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return `HTTP ${res.status} OK`;
}

async function main(): Promise<void> {
  console.error(`autousers-mcp-doctor v${pkg.version}`);
  console.error(`base url: ${BASE_URL}`);
  console.error("");

  const checks: CheckResult[] = [];
  checks.push(await check("AUTOUSERS_API_KEY", checkApiKeyPresent));
  checks.push(await check("base URL reachable", checkBaseUrlReachable));
  checks.push(await check("/api/v1/usage 200", checkUsageEndpoint));

  let failures = 0;
  for (const c of checks) {
    const tag = c.ok ? "PASS" : "FAIL";
    console.error(`[${tag}] ${c.name} — ${c.detail}`);
    if (!c.ok) failures++;
  }

  console.error("");
  if (failures === 0) {
    console.error("All checks passed. The MCP server should start cleanly.");
    process.exit(0);
  } else {
    console.error(
      `${failures} check(s) failed. Fix above and re-run \`autousers-mcp-doctor\`.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("doctor crashed:", err);
  process.exit(2);
});
