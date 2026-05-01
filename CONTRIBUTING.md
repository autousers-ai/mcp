# Contributing to `@autousers/mcp`

This repository is a **read-only mirror** of the canonical source, which lives in a private monorepo. Direct PRs filed against this repo will be force-overwritten on the next mirror sync.

## How to contribute

- **Bug reports & feature requests** — please [open an issue](https://github.com/autousers-ai/mcp/issues/new). The team monitors issues here directly, triages them, and applies fixes upstream. Resolved fixes propagate back to this mirror automatically on the next release.
- **Questions & feedback** — same place: [issues](https://github.com/autousers-ai/mcp/issues). Use the `question` label or just the regular form.
- **Code contributions** — open an issue first describing the proposed change. If the team agrees, we'll either implement it upstream and credit you, or invite you to contribute on the upstream repo. We can't merge PRs filed against this mirror because they'd be force-overwritten on the next sync.
- **Security disclosures** — please don't file these as public issues. Email [security@autousers.ai](mailto:security@autousers.ai) or report via [autousers.ai/contact](https://autousers.ai/contact).

## How releases work

Every release force-pushes a single fresh commit to this repo's `main` branch — that commit represents the exact source tree of the latest published npm package. Tags (`mcp-v*`) trigger automated publication to npm with [verifiable provenance](https://docs.npmjs.com/generating-provenance-statements), attesting that the published tarball was built from the commit you can browse here. The provenance signature is verifiable via `npm audit signatures` or directly on the [npm package page](https://www.npmjs.com/package/@autousers/mcp).

## Why is this repo a mirror

Real development happens upstream against the broader Autousers monorepo (web app, server, schema, MCP, CLI, etc. — they share types and migrations). Splitting the MCP package out as a public, single-commit mirror gives users a verifiable source-to-tarball chain without requiring the team to maintain a separate development repo.
