# CLAUDE.md

Guidance for Claude Code in this repo. Project-specific notes first, then behavioral guidelines.

## Project

strIDEterm — multi-workspace terminal app with Electron shell, headless runtime, and remote web client. Details (stack, modules, build scripts) live in the codebase — discover them by reading; don't rely on a description here that will rot.

## Project-Specific Things to Remember

### Dev runtime uses a separate home directory

Dev is started with `.\dev.ps1` (interactive PowerShell, not from the Bash tool). It sets `STRIDETERM_DATA_DIR` to `~/.strideterm-dev` and remaps Electron `userData` there. Production uses `~/.strideterm` (also not Electron's default userData path — see `electron/main.ts`).

- **Dev logs, state, credentials, and Electron cache live under `~/.strideterm-dev/`, separate from prod's `~/.strideterm/`.** When debugging a dev-mode issue, read logs from the dev directory.
- Dev and prod don't share state — a workspace/profile/credential present in one is not present in the other.
- The single-instance lock is also isolated, so dev and prod can run side-by-side.

`--data-dir <path>` overrides both. Check `dev.ps1` and `electron/main.ts` if unsure where something landed.

### Never run plain `npm run build` while the user's dev loop is active

The user develops with `.\dev.ps1`, which runs `vite build --watch` with `VITE_BUILD_WATCH=1`. That env var:

- skips `emptyOutDir` so the watcher keeps writing into a live `dist/` that the remote-server serves to open mobile/web sessions
- emits chunks **without content hashes** (`assets/[name].js`) so a rebuild overwrites in place instead of leaving orphan hashed files behind

Running plain `npm run build` from a Claude tool call (no env var, default config) breaks both: it wipes `dist/`, then produces hashed chunks like `DockerPane-XXXX.js`. Any browser page already loaded on the remote client references the previous chunk names and 404s — and because the 404 response carries `text/plain`, Chrome's strict-MIME check fires the noisy "Refused to apply style from … because its MIME type ('text/plain') is not a supported stylesheet" error that buries the real cause.

Rules:

- **For verification, use `npm run typecheck`** — it doesn't touch `dist/`.
- **If a real build is genuinely needed, set the env var explicitly:** `VITE_BUILD_WATCH=1 npx vite build`. This matches what `dev.ps1` does and stays compatible with a live watch.
- **Never run plain `npm run build`** while `dev.ps1` may be open. If unsure whether it's running, ask first or pick the typecheck-only path.

### Cross-platform & multi-agent

Users run on **Windows, macOS, and Linux**, and may drive the app from multiple **AI agents** (Claude Code, Codex, Gemini, etc.). Most functionality is intentionally generic:

- Don't hardcode platform paths, shells, or executables — go through the existing config / platform-detection helpers.
- Don't bake in assumptions about a specific terminal, PTY, or path separator.
- Don't tie behavior to a single agent's conventions; agent integrations should share the generic plumbing.
- When adding a feature, ask: "does this work on all three OSes and for any agent?" If you need platform- or agent-specific code, isolate it behind the existing abstractions.

### Profiles — what is and isn't isolated

Profiles group workspaces inside one installation. They are a UI/organizational construct, **not a security or storage boundary**.

- **Scoped to a profile:** which workspaces are visible/active, profile metadata (name, color), and the workspace→profile assignment via `profileId`.
- **Shared across all profiles in one install:** the persisted state file, credentials store (`credentials.json` under the data dir), and the runtime managers (git/docker/azure/github). Anything else: check the code before assuming — profile is primarily a workspace-grouping concept, not a sandbox.

Switching profiles filters the visible workspace list — it does not swap stores or credentials. For true isolation (different creds, different data), use a separate data dir (dev vs prod, or `--data-dir`) or a different OS user.

### Terminal font size — per-transport settings keys

Two flat settings keys control terminal font size, separated by transport so desktop and remote/mobile clients are independent:

- `terminalFontSizeLocal: number` — font size for Electron desktop windows. Range 8–32 px, default 13. Adjusted via Ctrl/Cmd + scroll wheel, Ctrl/Cmd + 0 (reset to 13), or the Settings dialog.
- `terminalFontSizeRemote: number` — font size for remote/mobile web clients. Range 8–32 px, default 13. Adjusted via pinch gesture or the Settings dialog on the remote client.

**Invariant:** `terminalFontSizeLocal` may only be written by desktop IPC (`settings:update`). Remote HTTP clients (`/api/settings/update`) are blocked from writing it — `sanitizeSettingsFromRemote()` in `remote-server.ts` drops the key. Remote clients may freely write `terminalFontSizeRemote`. This keeps desktop and remote/mobile font preferences isolated even when both are connected simultaneously.

Migration: both keys are backfilled to 13 by `normalizeState()` in `default-state.ts` for any persisted state that predates this feature.

---

# Behavioral Guidelines

Reduce common LLM coding mistakes. Bias toward caution over speed; for trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that _your_ changes orphaned. Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
