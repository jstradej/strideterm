# Contributing to strIDEterm

## Setup

```bash
git clone https://github.com/jstradej/strideterm.git
cd strideterm
npm install
npm run dev
```

## Code Quality

Pre-commit hooks (husky + lint-staged) run automatically on every commit:

- **ESLint** — catches bugs and enforces code style
- **Prettier** — formats code consistently

Manual check: `npm run lint`
Auto-fix: `npm run lint:fix`
Type-check: `npm run typecheck`

## Testing

```bash
npm run typecheck   # TypeScript type-check (frontend + backend)
npm test            # Unit tests (UI + backend)
npm run test:e2e    # E2E tests (Playwright + mock server)
npm run smoke       # Startup smoke test
```

E2E tests use fixture JSON files in `test/fixtures/` and a mock server that serves them on the same API as the real backend. No Electron needed.

## Project Structure

- `src/` — Vue 3 frontend (TypeScript components, stores, composables)
- `electron/backend/` — TypeScript backend (runtime, managers, IPC)
- `electron/main.ts` — Electron shell
- `config/` — shared app configuration
- `test/` — E2E test infrastructure (mock server, fixtures, specs)

## Commit Guidelines

- Write clear commit messages describing the "why"
- Keep commits focused — one logical change per commit
- Pre-commit hooks enforce lint and formatting automatically

## Pull Requests

- Branch from `master`
- Ensure `npm run lint` and `npm run typecheck` pass with 0 errors
- Ensure `npm run test:e2e` passes
- Describe what changed and why in the PR description
