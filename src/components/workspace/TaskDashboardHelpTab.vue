<template>
  <div class="td__section">
    <h3>How the Agent Task Runner works</h3>
    <ol class="td__help-list">
      <li>
        You provide a <strong>task description</strong> (or instruct the Worker directly). The system auto-generates
        control files and detects verification commands from your project.
      </li>
      <li><strong>Worker</strong> (Claude Code) executes the task in its terminal panel.</li>
      <li>
        When the Worker goes idle, the <strong>Task Runner</strong> kicks in automatically and runs
        <strong>built-in checks</strong>: WORK_LOCK must be absent, TODO "In Progress" and "Blocked" sections must be
        empty.
      </li>
      <li>
        Then it runs <strong>verification commands</strong> from FINISH_CRITERIA.md (tests, lint, etc.) in a separate
        process.
      </li>
      <li>
        If any check fails, the Worker is <strong>re-prompted</strong> with failure details and continues working.
      </li>
      <li>
        If all checks pass, the <strong>Judge</strong> (another Claude Code) independently evaluates whether the task is
        genuinely complete.
      </li>
      <li>
        The Judge writes a verdict. If "continue", the Worker gets actionable feedback. If "complete", you get notified.
      </li>
      <li>The loop repeats until the Judge approves or max rounds are reached.</li>
    </ol>
    <h4>Control files</h4>
    <p class="td__help-intro">
      All task state lives in <code>.strideterm/tasks/{{ taskId || "&lt;taskId&gt;" }}/</code> inside your project. You
      can edit these files in the <strong>Files</strong> tab.
    </p>
    <ul class="td__help-list">
      <li>
        <strong>TASK.md</strong> &mdash; The full task description, finish criteria, and rules. Both the Worker and
        Judge read this file to understand what needs to be done.
      </li>
      <li>
        <strong>TODO.md</strong> &mdash; Kanban-style board with To Do / In Progress / Done sections. The Worker updates
        this as it makes progress. You can pre-fill items here before starting.
      </li>
      <li>
        <strong>FINISH_CRITERIA.md</strong> &mdash; Simple list of verification commands (<code
          >- Tests: `npm test`</code
        >), required/forbidden file paths. Auto-detected from your project. Task Runner reads this before each round.
      </li>
      <li>
        <strong>WORK_LOCK</strong> &mdash; Simple signal file: "work remains". The Worker must delete it when genuinely
        done. Task Runner checks its absence for completion.
      </li>
      <li>
        <strong>JUDGE_PROMPT.md</strong> &mdash; Customizable instructions for the Judge. Edit this to change how the
        Judge evaluates: stricter code review, domain-specific criteria, or entirely custom evaluation logic.
      </li>
      <li><strong>JUDGE_TODO.md</strong> &mdash; Tiny scratchpad for the Judge's evaluation notes (read-only).</li>
    </ul>

    <h4>Example: TASK.md <button class="td__copy-btn" @click="copyExample('task')">copy</button></h4>
    <pre ref="exampleTask" class="td__example">
# Task

Add pagination to the `/api/users` endpoint. Return 25 items
per page with `?page=N` query parameter. Include `totalPages`
and `currentPage` in the response. Add integration tests.

## Rules
- Commit your work regularly with clear messages (the judge reviews git diffs)
- Do not push to any remote
- Update TODO.md as you work (move items between sections)
- Finish criteria and verification commands are in FINISH_CRITERIA.md
- Remove WORK_LOCK only when genuinely done
- The judge will independently verify your work</pre
    >

    <h4>Example: TODO.md <button class="td__copy-btn" @click="copyExample('todo')">copy</button></h4>
    <pre ref="exampleTodo" class="td__example">
# TODO

## To Do
- [ ] Add pagination logic to users controller
- [ ] Update API response schema with totalPages/currentPage
- [ ] Write integration tests for pagination edge cases
- [ ] Ensure all existing tests still pass

## In Progress

## Done</pre
    >

    <h4>
      Example: FINISH_CRITERIA.md
      <button class="td__copy-btn" @click="copyExample('criteria')">copy</button>
    </h4>
    <pre ref="exampleCriteria" class="td__example">
# Finish Criteria

## Verify Commands
- Tests: `npm test`
- Lint: `npm run lint` (timeout: 30s)

## Required Files
- src/controllers/users.js
- tests/users-pagination.test.js

## Forbidden Files
```</pre
    >

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
        Switch to <strong>Files</strong> and edit what you need &mdash; change <strong>TASK.md</strong> for a different
        assignment, adjust <strong>FINISH_CRITERIA.md</strong>, or rewrite <strong>TODO.md</strong>.
      </li>
      <li>Press <strong>Start</strong> to run the task again with your updated files.</li>
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
        Edit <strong>TASK.md</strong> in the Files tab before pressing Start to refine the task description, or leave it
        empty and instruct the Worker directly in the terminal.
      </li>
      <li>
        Use <strong>worktree mode</strong> when you want to run tasks in parallel or keep your main checkout clean.
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref } from "vue";

defineProps({
  taskId: { type: String, default: "" },
});

const exampleTask = ref(null);
const exampleTodo = ref(null);
const exampleCriteria = ref(null);

function copyExample(which) {
  const el = which === "task" ? exampleTask.value : which === "todo" ? exampleTodo.value : exampleCriteria.value;
  if (!el) return;
  const text = el.textContent || "";
  navigator.clipboard.writeText(text.trim()).catch(() => {});
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
