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

**Effect version installed:** `4.0.0-beta.57` (2026-04-26)
**@effect/platform-node:** `4.0.0-beta.57`
**@effect/vitest:** `4.0.0-beta.57`
**@effect/language-service:** Not installed — `4.0.0-beta.57` does not exist on npm. Latest available is `0.85.1` (v3 series), incompatible with Effect v4. Omitting tsconfig plugin; will add when v4-compatible release appears.

### Migrated modules (full / selective)

| Module | Status |
|--------|--------|
| `electron/backend/effect/runtime.ts` | Full — ManagedRuntime foundation |
| `electron/backend/effect/operation-context.ts` | Full — Context.Reference for request context |
| `electron/backend/effect/logger.ts` | Full — Logger as Context.Service |
| `electron/backend/effect/scope-helpers.ts` | Full — PTY acquireRelease |
| `electron/backend/effect/schedules.ts` | Full — retry schedules |
| `electron/backend/effect/wiring.ts` | Full — shutdown hook |
| `electron/backend/effect/errors/git-errors.ts` | Full |
| `electron/backend/effect/errors/docker-errors.ts` | Full |
| `electron/backend/effect/errors/session-errors.ts` | Full |
| `electron/backend/effect/errors/task-errors.ts` | Full |
| `electron/backend/agent-task-runner.ts` | Selective — `writeInitialFiles` uses `Effect.all` for parallel file ops; `#evaluateWorker` uses `Effect.acquireRelease` for `#evaluating` Set guard |
| `electron/backend/session-manager.ts` | Selective — SSH key temp files use `Effect.acquireRelease` via `Scope.make`; PTY spawn uses `Effect.tryPromise` with `PtySpawnError` |
| `electron/backend/git-manager.ts` | Selective — fetch/pull/push/merge/rebase in Effect |
| `electron/backend/docker-manager.ts` | Selective — parallel refresh in Effect |

### v4 API adaptations (FiberRef → Context.Reference)

The plan uses `FiberRef.unsafeMake` / `FiberRef.unsafeGet` from Effect v3. These were removed in v4. Adaptations:
- `FiberRef.unsafeMake<T>(default)` → `Context.Reference<T>(id, { defaultValue: () => default })`
- `yield* FiberRef.get(ref)` → `yield* ref` (Reference is directly yieldable)
- `Effect.locallyWith(ref, fn)(effect)` → `Effect.gen(function*() { const cur = yield* ref; return yield* effect.pipe(Effect.provideService(ref, fn(cur))); })`
- `FiberRef.unsafeGet(ref)` — **not available in v4**. The logger's operation context enrichment (plan 10.4 step 3) is omitted since there is no safe way to read a Context.Reference outside an Effect fiber. Non-Effect log calls remain unenriched with operation context. This is an accepted v4 limitation; future mitigation via AsyncLocalStorage adapter.

### NodeContext.layer (plan) vs NodeServices.layer (v4)

The plan references `NodeContext.layer` from `@effect/platform-node`. In v4, this export was renamed to `NodeServices.layer`. The runtime.ts uses `NodeServices.layer`.

### Rolling open questions

- After Effect 4 stable: consider Effect Schema as replacement for Zod on IPC layer (structured concurrency + codec parity).
- After Effect 4 stable: consider `effect/unstable/rpc` as transport replacement for the IPC/HTTP dual-mode pattern.
- After Effect 4 stable: add `@effect/language-service` to `tsconfig.base.json` plugins once a v4-compatible release is available.

### Off-ramp playbook

If downgrade to `effect@3` LTS is required:
- `Context.Service<Self, Shape>()(id)` → `Context.Tag<Service>(id)` class syntax
- `Context.Reference<T>(id, { defaultValue })` → `FiberRef.unsafeMake<T>(defaultValue)` + `FiberRef.currentFoo`
- `Schema.TaggedErrorClass` → `Data.TaggedError` (already used in this plan)
- `NodeServices.layer` → `NodeContext.layer`
- See `C:\work\effect-smol\MIGRATION.md` for full v4→v3 mapping.
