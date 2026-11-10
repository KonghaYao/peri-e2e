# Provenance

## Imported snapshot

| Item | Value |
| --- | --- |
| Source repository | https://github.com/KonghaYao/peri |
| Source commit | `ef529909437deae4182cb7068ee29735dc7aaa5e` |
| Source path | `e2e/` |
| Import mode | Working-tree snapshot; Peri git history is not imported |
| Import date | 2026-11-09 |

The import excludes `.env`, `results/`, `recordings/`, `node_modules/`, and the
`e2e/tui-tester` submodule gitlink. The suite now occupies the repository root.

## Local modifications

- Path resolution is repository-relative: `E2E_ROOT` for this repo, optional
  `PERI_SOURCE_ROOT` / `PERI_BINARY` for the Peri checkout and binary.
- `tui-tester` is vendored and wired as an npm workspace; the root TypeScript
  version is pinned to `^5.9.2` for the hoisted tsup dts build (see
  `THIRD_PARTY_NOTICES.md`).

## Non-fixture code from Peri PR #375

| Item | Value |
| --- | --- |
| PR | https://github.com/KonghaYao/peri/pull/375 |
| Head commit | `d790877d580320cea822631376f7499c87c79342` |

Imported files:

- `llm-replay/`: `cassette.mjs`, `template-text.mjs`, `world-store.mjs`,
  `world-mapping.mjs`, `request-bindings.mjs`, `cli.mjs`, `proxy.mjs`,
  `cassette-v2.test.mjs`, `world-store.test.mjs`, `world-check.test.mjs`,
  `world-sync.test.mjs`, `README.md`
- `scripts/`: `migrate-replay-v2.mjs`, `verify-replay-fixtures.mjs`,
  `refresh-cassettes.mjs`, `replay-world-recorded.mjs`,
  `replay-world-sources.mjs`, `world-sync-swap.mjs`
- `package.json` replay scripts

The #375 fixture tree was deliberately **not** copied. `fixtures/replay-v2`
still reflects the `ef5299094` baseline (cassette format version 1) until the
world-snapshot v2 migration lands. The #374 sensitive-tool re-anchor is part of
that later migration.

## Peri PR mapping

| Peri PR | Disposition in this repository |
| --- | --- |
| #372 | Its fixture refresh is superseded by the world v2 migration; the v1 `refresh-cassettes.mjs` is replaced by `world:sync`. |
| #373 | Code is present through the rebased #375 snapshot. |
| #375 | Non-fixture code imported (see above); fixture tree pending migration. |
| #374 | Merged in Peri. Its 13th sensitive-tool line must be re-anchored into the shared `block1.main.prefix` leaf. |
| #365 | Not imported (Replay v3, separate decision). |

## tui-tester

Vendored from `KonghaYao/tui-tester` at
`1d73f75510232aea4ec589e7dc563f9fcb23ee04` (MIT, Copyright (c) 2025 LuxQuant).
See `THIRD_PARTY_NOTICES.md`.

## Fixture recording provenance

`fixtures/replay-v2` contains synthetic recordings captured while driving the
real Peri agent against a local fixture model. Scenario manifests declare
`provenance.source = "local-fixture-model"` and `realLlm: false`; no production
API credentials are embedded. The world snapshot (when migrated) will record
the Peri source commit and generation seal in `fixtures/replay-v2/world/`.
