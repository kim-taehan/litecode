---
name: sonarqube-fix
description: "Fix SonarQube issues with the smallest possible change and no side effects (YAGNI). Use when asked to fix SonarQube issues (a file:line, a rule key like typescript:S2871, and the issue message), e.g. from the SonarQube panel's fix request."
---

Fix exactly the SonarQube issues you were given — nothing more. The goal is that the reported issue disappears on the next analysis while the program behaves exactly as before.

## Rules (YAGNI, no side effects)
1. Touch only the lines the issue points at, plus the fewest neighbouring lines the fix truly needs. Do not reformat, rename, reorder, or "clean up" anything else in the file.
2. Keep behaviour identical: same inputs give the same outputs, same public names and signatures, same config keys and defaults. If the only correct fix would change behaviour (e.g. lowering a size limit, changing a timeout, dropping a feature), STOP and explain the trade-off instead of changing it.
3. Do not add abstractions, helpers, options, dependencies, or new files for a one-line problem. Do not fix other issues you happen to notice — list them at the end instead.
4. Configuration and infrastructure files (YAML, Kubernetes manifests, properties): change only the reported key. If the value is a deliberate choice (e.g. a large upload limit), do not change it — explain why it may be intended and suggest marking the issue as reviewed in SonarQube instead.
5. Test code: if the issue is in a test (e.g. a hard-coded IP in a test fixture), prefer leaving it and say so, unless the fix is trivial and clearly harmless.
6. Read the surrounding code first so the fix matches the file's existing style.

## Steps
1. Open each reported file at the reported line and read enough context to understand it.
2. Decide per issue: fix minimally, or do not fix (with a one-line reason).
3. Make the edits.
4. If the project has a quick check for the touched code (type check, the related unit tests), run it. Do not run long or full test suites unless asked.
5. Re-check with SonarQube: call the `litecode_sonarqube_check` tool with the files you changed (project-relative paths). It re-analyzes just those files and returns the issues that remain.
   - If an issue you were asked to fix is still there, fix it once more (at most 2 re-checks in total), still following the rules above.
   - New issues in lines you did not touch are not yours to fix — list them.
   - If the tool is missing or says the server is not running, do not retry — tell the user to press 분석 in the SonarQube panel (same scope) to confirm.

## Reply
- One line per issue: `path:line` — fixed / not fixed — what changed (or why not).
- The diff stays small; if it grew beyond the reported lines, say why.
- Other problems you noticed but did not touch, as a short list.
- The re-check result: resolved / still remaining (with the reason), or that the re-check could not run.
