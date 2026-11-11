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
- Replay fixtures use world snapshot v2 (`fixtures/replay-v2/world`, generation
  `world-12c4186a13a664ec`): cassettes keep per-request bytes plus leaf/recipe
  references instead of duplicating the shared system/tool prefixes.
  `world:sync` / `world-check` require an explicit `PERI_SOURCE_ROOT`.
- The catalog now has 66 scenarios: the original 30 plus B01–B12, H01–H12 and
  M01–M12 migrated from `legacy/replay-v3` (`19dd2d33166b4fe9abaf6556972879f58bed9d78`).
  61 have world-v2 cassettes and pass real replay; B02, H05, H12, M10 and M11 are
  blocked by pinned Peri behavior and kept as `*.blocked.ts` cases outside the
  default replay (listed in `config/replay-blocked.json`).
  `.github/peri-rev` pins the product commit used by this repo's CI to
  `4ba78d7e15f6040e5fa3192492987b17c0d0e2e6`.
- Migration restored typed `timestamp` bindings, explicit-rule precedence over
  automatic binding rules, isolated TMP/XDG directories for every test process,
  and the slow-scenario proxy timeout. The 62 world-v2 fixtures were explicitly
  re-recorded against the pinned binary because the archived cassettes used
  format v1 and the harness configuration/isolation changed. D/J/L remain for
  the next batch.

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

The #375 fixture tree was deliberately **not** copied wholesale. The current
`fixtures/replay-v2` was migrated to world snapshot v2 in `2ad625c`, with the
renderer-fingerprint fix in `75a6278` and merge `7827cd5`; the #374
sensitive-tool re-anchor is included in `2709a5a`.

## Peri PR mapping

| Peri PR | Disposition in this repository |
| --- | --- |
| #372 | Its v1 fixture refresh is superseded by world v2; the compact v1 snapshot is archived on branch `legacy/compact-372` (`13a8ab3`, `365984c`). |
| #373 | Code is present through the rebased #375 snapshot. |
| #375 | Non-fixture code imported (see above); the fixture tree is now world snapshot v2. |
| #374 | Re-anchored into `sys.block1.main.prefix` and `sys.block1.replay-worker.prefix` in `2709a5a`; 30 cassettes were re-sealed, 17 affected request stubs re-rendered, and the 99 response blobs stayed unchanged. |
| #365 | Replay v3 exported to branch `legacy/replay-v3` at `19dd2d33166b4fe9abaf6556972879f58bed9d78` (based on `7827cd5`); not merged into `main`. |

## tui-tester

Vendored from `KonghaYao/tui-tester` at
`1d73f75510232aea4ec589e7dc563f9fcb23ee04` (MIT, Copyright (c) 2025 LuxQuant).
See `THIRD_PARTY_NOTICES.md`.

## Fixture recording provenance

`fixtures/replay-v2` contains synthetic recordings captured while driving the
real Peri agent against a local fixture model. Scenario manifests declare
`provenance.source = "local-fixture-model"` and `realLlm: false`; no production
API credentials are embedded. The world snapshot records the generation, leaves
and seal in `fixtures/replay-v2/world/`; it does not embed a Peri commit SHA.
The product version used for verification comes from `.github/peri-rev`. The
world v2 migration re-anchored shared prompt/tool bytes without re-recording
model responses; the 99 response blobs are unchanged since the imported
snapshot.
