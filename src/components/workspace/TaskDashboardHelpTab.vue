<template>
  <div class="td__section">
    <h3>How the Agent Task Runner works</h3>
    <ol class="td__help-list">
      <li>
        You provide a <strong>task description</strong> (or instruct the Worker directly). The system auto-generates
        control files and detects verification commands from your project.
      </li>
      <li>
        <strong>Worker</strong> (Claude Code, Codex, Gemini CLI, or GitHub Copilot) executes the task in its terminal
        panel.
      </li>
      <li>
        When the Worker goes idle, the <strong>Task Runner</strong> kicks in automatically and runs
        <strong>built-in checks</strong>: WORK_LOCK must be absent, TODO "In Progress" and "Blocked" sections must be
        empty.
      </li>
      <li>
        If built-in checks fail, the Worker is <strong>re-prompted</strong> with failure details and continues working.
      </li>
      <li>
        If all checks pass, the <strong>Judge</strong> (any of the supported agents — same options as the Worker)
        independently evaluates whether the task is genuinely complete.
      </li>
      <li>
        The Judge writes a verdict. If "continue", the Worker gets actionable feedback. If "complete", you get notified.
      </li>
      <li>The loop repeats until the Judge approves or max rounds are reached.</li>
    </ol>
    <h4>Your inputs</h4>
    <p class="td__help-intro">
      The <strong>Assignment</strong> tab is where you tell the agents what to do. Two files, both optional &mdash;
      changes save to disk and take effect on the next Start/Continue.
    </p>
    <ul class="td__help-list">
      <li>
        <strong>Task</strong> &mdash; the full task description, verification checklist, and rules. Both the Worker and
        Judge read this. Verification commands (tests, lint, etc.) are auto-detected and pre-filled &mdash; edit freely.
      </li>
      <li>
        <strong>Judge</strong> &mdash; customizable instructions for the Judge. Edit this to make the Judge stricter,
        add domain-specific criteria, or replace the evaluation logic entirely. Leave empty to use the default.
      </li>
    </ul>
    <p class="td__help-intro">
      Other files (worker progress, judge audit, event log, work-lock signal) live on disk in
      <code>.strideterm/tasks/{{ taskId || "&lt;taskId&gt;" }}/</code> and are managed by the agents. The Status and Log
      tabs surface what you usually want to see; if you need to inspect or hand-edit those files, open them through your
      file system.
    </p>

    <h4>
      Example: TASK.md
      <button class="td__copy-btn" @click="copyExample('task')">{{
        copyFeedback?.which === "task" ? copyFeedback.text : "copy"
      }}</button>
    </h4>
    <pre ref="exampleTask" class="td__example">
# Task

Add pagination to the `/api/users` endpoint. Return 25 items
per page with `?page=N` query parameter. Include `totalPages`
and `currentPage` in the response. Add integration tests.

## Verification before completion
- [ ] Run `npm test` — must pass
- [ ] Run `npm run lint` — no errors

## Rules
- Commit your work regularly with clear messages (the judge reviews git diffs)
- Do not push to any remote
- Update TODO.md as you work (move items between sections)
- Before finishing, complete the verification checklist above
- Remove WORK_LOCK only when genuinely done
- The judge will independently verify your work</pre>

    <h4>
      Example: TODO.md
      <button class="td__copy-btn" @click="copyExample('todo')">{{
        copyFeedback?.which === "todo" ? copyFeedback.text : "copy"
      }}</button>
    </h4>
    <pre ref="exampleTodo" class="td__example">
# TODO

## To Do
- [ ] Add pagination logic to users controller
- [ ] Update API response schema with totalPages/currentPage
- [ ] Write integration tests for pagination edge cases
- [ ] Ensure all existing tests still pass

## In Progress

## Done</pre>

    <h4>
      Example: verification checklist
      <button class="td__copy-btn" @click="copyExample('criteria')">{{
        copyFeedback?.which === "criteria" ? copyFeedback.text : "copy"
      }}</button>
    </h4>
    <pre ref="exampleCriteria" class="td__example">
## Verification before completion
- [ ] Run `npm test` — must pass
- [ ] Run `npm run lint` — no errors
- [ ] Run `npx tsc --noEmit` — no type errors
- [ ] Ensure src/controllers/users.js exists
- [ ] Ensure tests/users-pagination.test.js exists</pre>

    <h4>Reset &amp; Retry</h4>
    <p class="td__help-intro">
      After stopping, completing, or failing a task you'll see <strong>Continue</strong> and <strong>Reset</strong>.
      Continue picks up where you left off. Reset clears all round history and returns to idle &mdash; but preserves
      every control file on disk:
    </p>
    <ol class="td__help-list">
      <li>Press <strong>Pause</strong> to pause the task (or wait for it to complete/fail).</li>
      <li>Press <strong>Reset</strong> &mdash; clears rounds, returns to idle.</li>
      <li>
        Open the <strong>Assignment</strong> tab and refine the <strong>Task</strong> brief (including the verification
        checklist) or tweak the <strong>Judge</strong> instructions.
      </li>
      <li>Press <strong>Start</strong> to run the task again with your updated inputs.</li>
    </ol>
    <p class="td__help-intro">
      The workspace is fully reusable: create once, then reset and re-run as many times as you need.
    </p>

    <h4>Git Worktree Mode</h4>
    <p class="td__help-intro">
      When creating a task workspace, check <strong>Create in git worktree</strong> to run the agent on an isolated
      branch. The base repository directory is used to create a new git worktree, and the agent works entirely within
      that worktree.
    </p>
    <ul class="td__help-list">
      <li>
        <strong>Parallel tasks</strong> &mdash; run multiple task agents on the same repo simultaneously, each in its
        own worktree with its own branch. No file conflicts between agents.
      </li>
      <li>
        <strong>Isolation</strong> &mdash; all commits, control files, and changes stay in the worktree. Your main
        working directory is untouched.
      </li>
      <li>
        <strong>Branch name</strong> &mdash; auto-generated from the task description (e.g.
        <code>task/add-pagination</code>), or type your own. A new branch is created from the current HEAD.
      </li>
      <li>
        <strong>Cleanup</strong> &mdash; when you delete a worktree task workspace, you'll be asked whether to also
        remove the worktree files from disk.
      </li>
    </ul>

    <h4>Tips</h4>
    <ul class="td__help-list">
      <li>
        The Worker should <strong>commit its work</strong> with clear messages &mdash; the Judge reviews git diffs to
        verify what actually changed in the code.
      </li>
      <li>
        You can type into Worker or Judge terminals at any time &mdash; the task runner auto-pauses during evaluation.
      </li>
      <li>Use the <strong>Pause/Resume</strong> buttons to take manual control.</li>
      <li>Verification commands run in the project directory, not inside the agent's terminal.</li>
      <li>
        Edit the <strong>Task</strong> brief in the Assignment tab before pressing Start to refine the description, or
        leave it empty and instruct the Worker directly in the terminal.
      </li>
      <li>
        Use <strong>worktree mode</strong> when you want to run tasks in parallel or keep your main checkout clean.
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

withDefaults(
  defineProps<{
    taskId?: string;
  }>(),
  { taskId: "" },
);

const exampleTask = ref<HTMLElement | null>(null);
const exampleTodo = ref<HTMLElement | null>(null);
const exampleCriteria = ref<HTMLElement | null>(null);
const copyFeedback = ref<{ which: string; text: string } | null>(null);

async function copyExample(which: string): Promise<void> {
  const el = which === "task" ? exampleTask.value : which === "todo" ? exampleTodo.value : exampleCriteria.value;
  if (!el) return;
  const text = el.textContent || "";
  try {
    await navigator.clipboard.writeText(text.trim());
    copyFeedback.value = { which, text: "Copied!" };
  } catch {
    copyFeedback.value = { which, text: "Failed" };
  }
  setTimeout(() => {
    if (copyFeedback.value?.which === which) copyFeedback.value = null;
  }, 2000);
}
</script>

<style scoped>
.td__section h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 10px;
}
.td__section h4 {
  font-size: 13px;
  font-weight: 600;
  margin: 16px 0 6px;
}
.td__help-list {
  margin: 0 0 8px;
  padding-left: 20px;
  line-height: 1.7;
}
.td__help-list li {
  margin-bottom: 2px;
}
.td__help-list code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
.td__help-intro {
  margin: 0 0 8px;
  line-height: 1.6;
}
.td__example {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 4px 0 12px;
  max-height: 200px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.td__copy-btn {
  background: none;
  border: 1px solid var(--border, #444);
  color: var(--muted, #888);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  cursor: pointer;
  margin-left: 6px;
  vertical-align: middle;
}
.td__copy-btn:hover {
  color: var(--fg, #ccc);
  border-color: var(--fg, #ccc);
}
</style>
