import { describe, expect, test } from "vitest";
import { classifyCommand, allowT3ForCommandClass, allowExitAlertForCommandClass } from "./command-classifier.js";

describe("classifyCommand — agents", () => {
  test.each([
    ["claude", "agent"],
    ["claude --dangerously-skip-permissions", "agent"],
    ["codex", "agent"],
    ["aider ./src", "agent"],
    ["opencode", "agent"],
    ["gemini chat", "agent"],
    ["copilot", "agent"],
    ["copilot --allow-all-tools --model gpt-5.4", "agent"],
    ["env ANTHROPIC_API_KEY=x claude", "agent"],
  ])('"%s" → %s', (input, expected) => {
    expect(classifyCommand(input)).toBe(expected);
  });
});

describe("classifyCommand — streaming / watchers / dev servers", () => {
  test.each([
    ["npm run dev", "streaming"],
    ["npm run watch", "streaming"],
    ["npm start", "streaming"],
    ["pnpm dev", "streaming"],
    ["yarn dev", "streaming"],
    ["next dev", "streaming"],
    ["vite", "streaming"],
    ["vite --host", "streaming"],
    ["cargo watch", "streaming"],
    ["jest --watch", "streaming"],
    ["vitest --watch", "streaming"],
    ["tail -f app.log", "streaming"],
    ["docker logs -f api", "streaming"],
    ["docker compose up", "streaming"],
    ["kubectl logs -f pod", "streaming"],
    ["ng serve", "streaming"],
    ["python -m http.server 8000", "streaming"],
  ])('"%s" → %s', (input, expected) => {
    expect(classifyCommand(input)).toBe(expected);
  });

  test("docker compose up -d is NOT streaming (detached)", () => {
    expect(classifyCommand("docker compose up -d")).toBe("shell");
  });
});

describe("classifyCommand — interactive TUIs", () => {
  test.each([
    ["vim src/foo.ts", "tui"],
    ["nvim", "tui"],
    ["less README.md", "tui"],
    ["top", "tui"],
    ["htop", "tui"],
    ["lazygit", "tui"],
    ["k9s", "tui"],
    ["ranger", "tui"],
    ["nano file.txt", "tui"],
  ])('"%s" → %s', (input, expected) => {
    expect(classifyCommand(input)).toBe(expected);
  });
});

describe("classifyCommand — jobs", () => {
  test.each([
    ["npm install", "job"],
    ["npm ci", "job"],
    ["npm test", "job"],
    ["npm run build", "job"],
    ["npm run typecheck", "job"],
    ["yarn install", "job"],
    ["pnpm install", "job"],
    ["cargo build", "job"],
    ["cargo test", "job"],
    ["go build ./...", "job"],
    ["go test ./...", "job"],
    ["make", "job"],
    ["pytest", "job"],
    ["tsc", "job"],
    ["eslint src", "job"],
  ])('"%s" → %s', (input, expected) => {
    expect(classifyCommand(input)).toBe(expected);
  });
});

describe("classifyCommand — shell fallback", () => {
  test.each([
    ["ls", "shell"],
    ["cd /tmp", "shell"],
    ["echo hello", "shell"],
    ["git status", "shell"],
    ["cat file", "shell"],
    ["", "shell"],
    ["   ", "shell"],
    ["some-binary --flag", "shell"],
  ])('"%s" → %s', (input, expected) => {
    expect(classifyCommand(input)).toBe(expected);
  });
});

describe("allowT3ForCommandClass — policy matrix", () => {
  test("agent and shell allow T3", () => {
    expect(allowT3ForCommandClass("agent")).toBe(true);
    expect(allowT3ForCommandClass("shell")).toBe(true);
  });
  test("streaming, tui, job do NOT allow T3", () => {
    expect(allowT3ForCommandClass("streaming")).toBe(false);
    expect(allowT3ForCommandClass("tui")).toBe(false);
    expect(allowT3ForCommandClass("job")).toBe(false);
  });
  test("unknown class defaults to allowing (safe default)", () => {
    expect(allowT3ForCommandClass("")).toBe(true);
    expect(allowT3ForCommandClass("foobar")).toBe(true);
  });
});

describe("allowExitAlertForCommandClass", () => {
  test("shell suppresses exit alerts (user exited on purpose)", () => {
    expect(allowExitAlertForCommandClass("shell")).toBe(false);
  });
  test("other classes allow exit alerts", () => {
    for (const c of ["agent", "streaming", "tui", "job"]) {
      expect(allowExitAlertForCommandClass(c)).toBe(true);
    }
  });
});
