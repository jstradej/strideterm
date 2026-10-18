# Contributing to strIDEterm

Thanks for your interest in contributing to strIDEterm. See the [Development Guide](docs/development.md) for setup and build basics.

## Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/jstradej/strideterm.git
cd strideterm
npm install
npm run dev
```

## Code quality

Pre-commit hooks (husky + lint-staged) run automatically on every commit:

- **ESLint** — catches bugs and enforces code style
- **Prettier** — formats code consistently

Manual checks:

```bash
npm run lint        # ESLint + Prettier check
npm run lint:fix    # auto-fix
npm run typecheck   # TypeScript type-check (frontend + backend + tests + scripts)
```

## Commit guidelines

- Write clear commit messages describing the **why**
- Keep commits focused — one logical change per commit
- Pre-commit hooks enforce lint and formatting automatically

## Pull requests

- Branch from `master`
- `npm run lint` and `npm run typecheck` must pass with 0 errors
- `npm test` and `npm run test:e2e` must pass
- Describe what changed and why in the PR body
- If you change packaging, remote access, plugins, or runtime behavior, update the relevant docs
