# Migration Notes — strIDEterm JS → TypeScript

This file is updated throughout the TypeScript migration (Phases 1–10). It tracks decisions outside the plan, MIGRATION-EXEMPT `any` usages, discovered bugs, and pre-existing issues.

## MIGRATION-EXEMPT `any` usages

None so far.

## Decisions outside plan

### Phase 1: Placeholder TS files for empty tsconfig domains

**Context:** `tsc` fails with TS18003 when a tsconfig's `include` paths match no files.
**Choice:** Created placeholder `.ts`/`.mts` files for the three tsconfig domains that have no TS files in Phase 1:
- `electron/shared/types/index.ts` (satisfies `tsconfig.backend.json`)
- `test/types/index.ts` (satisfies `tsconfig.tests.json`)
- `scripts/placeholder.mts` (satisfies `tsconfig.scripts.json`)
**Reason:** Plan requires `npm run typecheck` to pass in Phase 1. These placeholders will be superseded by real content in Phases 2, 6, and 8 respectively.

### Phase 1: ESLint TS-eslint scoped to TS files only

**Context:** The plan says to add `...tseslint.configs.recommended` globally. But applying it globally caused TS-specific rules (`@typescript-eslint/no-empty-function`, etc.) to fire on existing JS files with empty functions (a valid pattern in the codebase).
**Choice:** Scoped `@typescript-eslint/*` rules to only `.ts`, `.d.ts`, `.mts` files (not JS files). This is semantically correct — TS rules should only run on TS files.
**Reason:** Existing JS codebase uses empty arrow functions as intentional noop callbacks; applying TS strictness to them pre-migration would block lint.

## Discovered bugs

None so far.

## Required path adjustments

- `review-bridge-agent-launch.ts` `DEFAULT_APP_ENTRY` depth increased by one level (`../../` → `../../../`) to account for the `dist-electron/` prefix in compiled output layout. Without this, the resolved app root would be one level too deep inside `dist-electron/`.
- `electron/main.ts` preload path updated: `path.join(app.getAppPath(), "electron", "preload.js")` → `path.join(app.getAppPath(), "dist-electron", "electron", "preload.js")` to match the compiled output location.
- `electron/main.ts` version loading replaced: `require("../package.json")` → `app.getVersion()` to avoid path resolution issues after compilation to `dist-electron/`.

## Discovered pre-existing issues

- `scripts/perf-test.mjs` missing — `npm run perf` is broken pre-migration.

## Test failures during migration

None so far.

## Phase 8: typecheck status

Phase 8 introduces 0 new typecheck errors. The 1094 errors reported by `npm run typecheck` are all pre-existing from prior migration phases (primarily in `*.test.ts` files and `runtime.ts`). The plan requires 0 errors for Phase 8 files specifically; `electron/main.ts`, all migrated scripts, `vite.config.ts`, and `vitest.backend.config.ts` are error-free.

## Effect adoption

(To be filled in during Phase 10.)
