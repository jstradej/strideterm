# Recover an interrupted task

If strIDEterm closes while a Worker or Judge is running, the task stops with the app. When you start strIDEterm again, a recovery dialog can show tasks that were interrupted.

- **Resume** starts new agent sessions and asks them to continue from the task's saved files and prior work.
- **Restart** clears the task's round history but keeps its files, so you can start it again from the beginning.
- **Skip** leaves the task paused for you to inspect or resume later from its Dashboard.

You can resume or skip all tasks in the dialog. Review the task files and any changes in its workspace before continuing; the agents may not know whether an external action, such as creating a pull request, completed before the app closed.
