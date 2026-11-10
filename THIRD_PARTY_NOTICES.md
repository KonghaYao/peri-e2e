# Third-Party Notices

## tui-tester

- Upstream: https://github.com/KonghaYao/tui-tester
- Original project: https://github.com/luxquant/tui-tester
- Revision: `1d73f75510232aea4ec589e7dc563f9fcb23ee04`
- License: MIT
- Copyright: Copyright (c) 2025 LuxQuant
- Vendored path: `tui-tester/`

The full MIT license text is kept at `tui-tester/LICENSE`. No upstream source
files were modified.

Vendoring changes:

1. The nested `tui-tester/package-lock.json` was removed. npm workspaces use
   the root `package-lock.json` as the single lockfile; keeping a nested lock
   would make installs non-reproducible.
2. The nested `tui-tester/yarn.lock` is retained unmodified for provenance.
3. `tui-tester/dist/` is not committed. It is produced by the root
   `postinstall` script (`build:tui-tester`).
4. The root TypeScript devDependency is pinned to `^5.9.2`. The hoisted tsup
   dts build resolves `typescript` from the root `node_modules`; the native
   TypeScript 7 package does not expose the JS compiler API that
   `rollup-plugin-dts` expects, so the build fails with
   `Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')`.
   tui-tester itself pins TypeScript 5.9.2, so this keeps one compiler version.

## npm dependencies

Runtime and development dependencies are declared in `package.json` and pinned
by `package-lock.json`. Each package remains under its own license; see the
`LICENSE` file shipped inside the corresponding `node_modules` package.
