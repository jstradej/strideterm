/**
 * Project technology detection for agent task runner.
 * Auto-detects verification commands and technology-stack review hints
 * by scanning project configuration files.
 *
 * Extracted from agent-task-runner.js to reduce file size.
 */
import path from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import { getLogger } from "./logger.js";

const log = getLogger("task-runner");

/**
 * Auto-detect verification commands from project configuration files.
 * Scans for all known stacks (not mutually exclusive — a project can have
 * both package.json and a Makefile). The order within each stack is:
 * formatting -> lint -> compile/build -> tests (fast-to-slow).
 */
export async function detectProjectVerifyCommands(cwd) {
  const commands = [];
  const has = (f) =>
    access(path.join(cwd, f)).then(
      () => true,
      () => false,
    );
  const tryRead = (f) => readFile(path.join(cwd, f), "utf8").catch(() => null);

  // --- Node.js: package.json ---
  try {
    const raw = await tryRead("package.json");
    if (raw) {
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts || {};
      const devDeps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (scripts.typecheck || scripts["type-check"]) {
        const cmd = scripts.typecheck ? "npm run typecheck" : "npm run type-check";
        commands.push({ label: "Type-check", command: cmd, timeoutMs: 120_000 });
      } else if (devDeps.typescript && (await has("tsconfig.json"))) {
        commands.push({ label: "Type-check", command: "npx tsc --noEmit", timeoutMs: 120_000 });
      }
      if (scripts.lint) {
        commands.push({ label: "Lint", command: "npm run lint", timeoutMs: 60_000 });
      }
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        commands.push({ label: "Tests", command: "npm test", timeoutMs: 300_000 });
      }
      if (scripts.build) {
        commands.push({ label: "Build", command: "npm run build", timeoutMs: 120_000 });
      }
      if ((await has("package-lock.json")) || (await has("yarn.lock"))) {
        commands.push({ label: "Audit", command: "npm audit --audit-level=high", timeoutMs: 30_000 });
      }
    }
  } catch {
    // package.json parse error
  }

  // --- Java: Maven (pom.xml) ---
  if (await has("pom.xml")) {
    const pom = (await tryRead("pom.xml")) || "";
    commands.push({ label: "Maven verify", command: "mvn verify -B -q", timeoutMs: 600_000 });
    if (pom.includes("maven-checkstyle-plugin") || (await has("checkstyle.xml"))) {
      commands.push({ label: "Checkstyle", command: "mvn checkstyle:check -B -q", timeoutMs: 60_000 });
    }
    if (pom.includes("spotbugs-maven-plugin")) {
      commands.push({ label: "SpotBugs", command: "mvn spotbugs:check -B -q", timeoutMs: 120_000 });
    }
    if (pom.includes("maven-pmd-plugin")) {
      commands.push({ label: "PMD", command: "mvn pmd:check -B -q", timeoutMs: 60_000 });
    }
  }

  // --- Java: Gradle (build.gradle / build.gradle.kts) ---
  if (!commands.some((c) => c.command.startsWith("mvn"))) {
    const hasGradle = (await has("build.gradle")) || (await has("build.gradle.kts"));
    if (hasGradle) {
      const gradleCmd = (await has("gradlew")) || (await has("gradlew.bat")) ? "./gradlew" : "gradle";
      commands.push({ label: "Gradle check", command: `${gradleCmd} check --no-daemon -q`, timeoutMs: 300_000 });
      commands.push({ label: "Gradle build", command: `${gradleCmd} build --no-daemon -q`, timeoutMs: 300_000 });
    }
  }

  // --- Python ---
  if (!commands.some((c) => c.label.startsWith("Maven") || c.label.startsWith("Gradle"))) {
    const pyproject = await tryRead("pyproject.toml");
    const hasPytest =
      pyproject?.includes("[tool.pytest") ||
      (await has("pytest.ini")) ||
      (await has("conftest.py")) ||
      (await has("setup.cfg"));
    if (pyproject?.includes("[tool.ruff")) {
      commands.push({ label: "Ruff format", command: "ruff format --check .", timeoutMs: 30_000 });
      commands.push({ label: "Ruff lint", command: "ruff check .", timeoutMs: 30_000 });
    } else {
      if (pyproject?.includes("[tool.black") || (await has(".black.toml"))) {
        commands.push({ label: "Black format", command: "black --check .", timeoutMs: 30_000 });
      }
      if (await has(".flake8")) {
        commands.push({ label: "Flake8", command: "flake8", timeoutMs: 60_000 });
      }
    }
    if (pyproject?.includes("[tool.mypy") || (await has("mypy.ini")) || (await has(".mypy.ini"))) {
      commands.push({ label: "Mypy", command: "mypy .", timeoutMs: 120_000 });
    } else if (await has("pyrightconfig.json")) {
      commands.push({ label: "Pyright", command: "pyright", timeoutMs: 120_000 });
    }
    if (hasPytest) {
      commands.push({ label: "Tests", command: "pytest", timeoutMs: 300_000 });
    }
    if (pyproject?.includes("[tool.tox") || (await has("tox.ini"))) {
      if (!hasPytest) {
        commands.push({ label: "Tox", command: "tox", timeoutMs: 600_000 });
      }
    }
  }

  // --- Rust: Cargo.toml ---
  if (await has("Cargo.toml")) {
    commands.push({ label: "Cargo fmt", command: "cargo fmt --check", timeoutMs: 15_000 });
    commands.push({ label: "Cargo clippy", command: "cargo clippy -- -D warnings", timeoutMs: 120_000 });
    commands.push({ label: "Cargo test", command: "cargo test", timeoutMs: 300_000 });
    if (await has("deny.toml")) {
      commands.push({ label: "Cargo deny", command: "cargo deny check", timeoutMs: 30_000 });
    }
  }

  // --- Go: go.mod ---
  if (await has("go.mod")) {
    commands.push({ label: "Go vet", command: "go vet ./...", timeoutMs: 60_000 });
    if ((await has(".golangci.yml")) || (await has(".golangci.yaml")) || (await has(".golangci.toml"))) {
      commands.push({ label: "GolangCI-Lint", command: "golangci-lint run", timeoutMs: 120_000 });
    }
    commands.push({ label: "Go test", command: "go test ./...", timeoutMs: 300_000 });
    commands.push({ label: "Go mod verify", command: "go mod verify", timeoutMs: 30_000 });
  }

  // --- .NET: *.sln or *.csproj ---
  {
    let hasDotnet = false;
    try {
      const entries = await readdir(cwd);
      hasDotnet = entries.some((e) => e.endsWith(".sln") || e.endsWith(".csproj"));
    } catch {
      // readdir failed
    }
    if (hasDotnet) {
      commands.push({ label: "Dotnet build", command: "dotnet build --no-restore", timeoutMs: 120_000 });
      commands.push({ label: "Dotnet test", command: "dotnet test --no-build", timeoutMs: 300_000 });
      if (await has(".editorconfig")) {
        commands.push({ label: "Dotnet format", command: "dotnet format --verify-no-changes", timeoutMs: 30_000 });
      }
    }
  }

  // --- Ruby: Gemfile ---
  if (await has("Gemfile")) {
    const gemfile = (await tryRead("Gemfile")) || "";
    if (gemfile.includes("rubocop") || (await has(".rubocop.yml"))) {
      commands.push({ label: "RuboCop", command: "bundle exec rubocop", timeoutMs: 60_000 });
    }
    if (gemfile.includes("rspec") || (await has(".rspec"))) {
      commands.push({ label: "RSpec", command: "bundle exec rspec", timeoutMs: 300_000 });
    } else if (await has("Rakefile")) {
      commands.push({ label: "Rake test", command: "bundle exec rake test", timeoutMs: 300_000 });
    }
    if (gemfile.includes("brakeman")) {
      commands.push({ label: "Brakeman", command: "bundle exec brakeman --no-pager -q", timeoutMs: 60_000 });
    }
  }

  // --- Makefile (fallback for any stack) ---
  if (!commands.length) {
    try {
      const makefile = await readFile(path.join(cwd, "Makefile"), "utf8");
      if (/^check\s*:/m.test(makefile)) {
        commands.push({ label: "Make check", command: "make check", timeoutMs: 120_000 });
      }
      if (/^test\s*:/m.test(makefile)) {
        commands.push({ label: "Make test", command: "make test", timeoutMs: 120_000 });
      }
      if (/^lint\s*:/m.test(makefile)) {
        commands.push({ label: "Make lint", command: "make lint", timeoutMs: 60_000 });
      }
    } catch {
      // No Makefile
    }
  }

  return commands;
}

/**
 * Detect project technology stack and return review hints for the Judge.
 * These are included in JUDGE_PROMPT.md so the Judge knows what to look for
 * based on the specific technologies used.
 */
export async function detectStackReviewHints(cwd) {
  const hints = [];
  const has = (f) =>
    access(path.join(cwd, f)).then(
      () => true,
      () => false,
    );
  const tryRead = (f) => readFile(path.join(cwd, f), "utf8").catch(() => null);

  // --- Node.js / JavaScript / TypeScript ---
  const pkgRaw = await tryRead("package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (allDeps.typescript || (await has("tsconfig.json"))) {
        hints.push(
          "**TypeScript**: Check for proper typing — no untyped `any` escape hatches, correct use of generics, interfaces over type assertions where possible",
        );
      }
      if (allDeps.react || allDeps["react-dom"]) {
        hints.push(
          "**React**: Verify hooks rules (no conditional hooks), proper dependency arrays in useEffect/useMemo, no unnecessary re-renders, keys on list items",
        );
      }
      if (allDeps.vue) {
        hints.push(
          "**Vue**: Check reactivity patterns (ref/reactive usage), proper prop validation, no direct prop mutation, correct use of computed vs methods",
        );
      }
      if (allDeps.next) {
        hints.push(
          "**Next.js**: Verify correct use of server/client components, proper data fetching patterns, no sensitive data leaked to client bundles",
        );
      }
      if (allDeps.express || allDeps.fastify || allDeps.koa) {
        hints.push(
          "**Node.js API**: Check for proper async error handling (no unhandled promise rejections), input validation on endpoints, no secrets in responses",
        );
      }
      if (allDeps.prisma || allDeps.sequelize || allDeps.typeorm || allDeps.knex) {
        hints.push(
          "**Database/ORM**: Verify parameterized queries (no SQL injection via string concatenation), proper transaction usage, N+1 query patterns",
        );
      }
      if (allDeps.zod || allDeps.joi || allDeps.yup) {
        hints.push(
          "**Validation**: Ensure new endpoints/inputs use the existing validation library, schemas match expected data shapes",
        );
      }
    } catch {
      // package.json parse error
    }
  }

  // --- Python ---
  const pyproject = await tryRead("pyproject.toml");
  if (pyproject || (await has("requirements.txt")) || (await has("setup.py"))) {
    hints.push(
      "**Python**: Check for proper type hints on new functions, correct use of context managers for resources, no bare `except:` clauses",
    );
    if (pyproject?.includes("django") || (await has("manage.py"))) {
      hints.push(
        "**Django**: Verify ORM queries are efficient (select_related/prefetch_related), no raw SQL without parameterization, proper permission checks on views",
      );
    }
    if (pyproject?.includes("fastapi")) {
      hints.push(
        "**FastAPI**: Check Pydantic models match API contracts, proper dependency injection, async endpoints where appropriate",
      );
    }
    if (pyproject?.includes("asyncio") || pyproject?.includes("aiohttp") || pyproject?.includes("httpx")) {
      hints.push(
        "**Async Python**: Verify proper await usage, no blocking calls in async functions, correct task/gather patterns",
      );
    }
  }

  // --- Rust ---
  if (await has("Cargo.toml")) {
    hints.push(
      "**Rust**: Check for proper error handling (no unwrap() in production paths), correct ownership/borrowing, appropriate use of Clone vs references",
    );
  }

  // --- Go ---
  if (await has("go.mod")) {
    hints.push(
      "**Go**: Verify proper error handling (no ignored errors), correct goroutine lifecycle (no leaks), defer usage for cleanup, context propagation",
    );
  }

  // --- Java ---
  if ((await has("pom.xml")) || (await has("build.gradle")) || (await has("build.gradle.kts"))) {
    hints.push(
      "**Java**: Check for proper null handling, resource management (try-with-resources), correct exception hierarchy, thread safety where applicable",
    );
  }

  // --- .NET ---
  {
    try {
      const entries = await readdir(cwd);
      if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"))) {
        hints.push(
          "**C#/.NET**: Verify proper async/await patterns (no sync-over-async), IDisposable implementation, null checks or nullable reference types",
        );
      }
    } catch {
      // readdir failed
    }
  }

  // --- Ruby ---
  if (await has("Gemfile")) {
    hints.push(
      "**Ruby**: Check for proper exception handling, no mass assignment vulnerabilities, correct use of ActiveRecord scopes and validations",
    );
  }

  log.debug("stack review hints detected", { cwd, hintCount: hints.length });
  return hints;
}
