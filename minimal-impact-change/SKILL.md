---
name: minimal-impact-change
description: Surgical, backward-compatible code changes with a pre-change scope plan, targeted edits, focused verification, and a final impact audit, backed by guard hooks. Use for any task that modifies existing software - implementing a feature, fixing a bug, enhancing behavior, adding an endpoint, field, filter, option, or integration - in any language or repo, even when the user does not mention scope or minimalism.
hooks:
  PreToolUse:
    - matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash"
      hooks:
        - type: command
          command: node "$HOME/.claude/skills/minimal-impact-change/hooks/mic-hook.js" pre
          timeout: 10
  PostToolUse:
    - matcher: "Edit|Write|MultiEdit|NotebookEdit"
      hooks:
        - type: command
          command: node "$HOME/.claude/skills/minimal-impact-change/hooks/mic-hook.js" post
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: node "$HOME/.claude/skills/minimal-impact-change/hooks/mic-hook.js" stop
          timeout: 20
---

# Minimal-impact change

Change only what the request needs; preserve everything else. The goal is the smallest *impact*, not the fewest lines: the change must still be correct, complete across every layer it touches, and maintainable. A **surgical** change is one a reviewer can read in a single pass and see that nothing unrelated moved.

Guard hooks are now active for the rest of this session (see "What the hooks do" below). They catch objective problems; the judgement calls below are yours.

## 1. Scope assessment

1. Pin down the requested behavior and its acceptance criteria.
2. Run `git status`. Every file already modified or untracked is the user's work in progress: keep it intact and build on top of it.
3. Locate the code that owns the behavior. Trace the execution flow only as far as needed to understand impact; for a localized task, stay local.
4. Look for what already exists: the function, service, utility, component, interface, or registration point that this change should extend. Reuse beats new code; an existing extension point beats a new abstraction.
5. Identify consumers of anything you will touch (callers, API clients, shared types, serialized data) and the regression risks they carry.

For nontrivial work, state a short change plan before editing: files to change and why each is necessary, what stays unchanged, and how you will verify. Then declare it so the hooks can check it:

```
node "$HOME/.claude/skills/minimal-impact-change/hooks/mic-hook.js" scope set <file-or-glob> ...
```

Proceed without waiting for approval when the change is clearly authorized. Stop and ask only for material scope expansion, destructive operations, or a breaking change the request did not authorize.

Done when: you can name every file that must change and the reason for each, and you know which existing component you are extending.

## 2. Surgical implementation

- Edit in place with targeted `Edit`s. A whole-file `Write` is for new files or genuine rewrites only.
- Match the surrounding code: naming, formatting, error handling, logging style, comment density. Leave untouched lines byte-identical, including whitespace and line endings.
- Put new logic in the existing function or module that owns the behavior. Create a new file only when no existing one is a reasonable home.
- Keep these stable unless the task requires changing them: business rules and calculations, public APIs and request/response contracts, schemas and migrations, auth and permissions, routes and state management, UI design and styling, jobs and integrations, error handling, validation, logging, configuration, and existing tests.
- When the task does require changing one of them, change it deliberately, update every consumer, and preserve backward compatibility where possible: new fields optional, old paths still working.
- **Complete beats small.** If the feature spans frontend, backend, database, mobile, or shared types, update every layer it needs so contracts match end to end. A half-wired feature is not minimal; it is broken.
- Add a dependency only when the task cannot be met reasonably without it.
- Write comments only for non-obvious decisions or constraints.

When you notice an unrelated bug, smell, outdated package, or formatting issue, write it down for the report and leave the code as it is. Refactors, renames, reorganizations, upgrades, repo-wide formatting, new patterns or layers, and feature flags are all scope expansion. Do them only when requested, or when the task genuinely cannot be done without them (a feature flag is warranted for rollout, compatibility, or reversibility needs).

If a hook advisory names a file as out of scope and the file is genuinely required, add it with `scope add` and say why in the report. Otherwise undo your own edit to it.

## 3. Verification

1. Add or update a focused test for the new behavior or the fixed bug, next to the existing tests and in their style. A bug fix gets a regression test that fails without the fix.
2. Run the focused tests, then type-check, lint, or build where the project has them. Find the commands in the project's config (`package.json` scripts, Makefile, CI config) rather than guessing.
3. Run broader regression tests when the change touches shared code and the suite is feasible to run.
4. Existing assertions stay as they are unless the authorized behavior legitimately changed. Fix code until checks pass on their merits: never weaken a test, skip it, loosen a type, or suppress an error to get green.
5. Record exactly what ran and its result. A check counts as passed only if you saw it pass.

Done when: every check you can run has run, and each one you could not run has a stated reason.

## 4. Final impact audit

Read `git diff` (and `git status` for new files) and check every hunk against these questions:

- Is each changed file necessary? Is every hunk required by the task?
- Could an equally maintainable change have been smaller?
- Is there redundant code, a needless abstraction, or a stray debug line?
- Did any unrelated behavior, formatting, or whitespace change?
- Did a public contract change that did not have to?
- Are all required cross-layer changes present?
- Is the user's pre-existing work fully intact?

Revert only your own unnecessary hunks, and only with targeted edits. Never use `git checkout`, `git restore`, `git stash`, or `git reset`, because they would also discard the user's changes in those files.

Done when: every hunk in the diff traces back to the request.

## 5. Final report

Keep it concise and use exactly these headings:

**Implemented:** what changed, in behavior terms.
**Files changed:** each file and why it was necessary.
**Preserved:** important adjacent behavior deliberately left unchanged.
**Verification:** each command run and its actual result.
**Warnings:** remaining risks, unverified paths, checks that could not run, and unrelated issues noticed but left alone.

Passing checks show that those checks pass; they do not prove there are no regressions. Word the report accordingly.

## Patterns

| Request | Surgical shape |
|---|---|
| Log failed logins | One call in the existing auth failure branch, using the existing logger |
| Add a payment method | One new provider implementing the existing provider interface and registered where the others are, plus its tests. Other processors untouched |
| Add a dashboard filter | The component, the existing query or API parameter (optional and backward-compatible), and the state wiring. Calculations, permissions, styling unchanged |
| Fix a validation bug | Fix the responsible rule, add a regression test. The controller and service stay as they are |
| Feature spanning UI and API | Both sides plus the shared type or contract, changed together so they match |

## What the hooks do

Registered by this skill's frontmatter when the skill is invoked; they then stay active until the session ends. `deny` blocks the action, and the reason is shown to you. `ask` makes the user confirm. Advisories arrive as context and block nothing.

- **PreToolUse**: denies hand edits to `.git/`, `node_modules/`, and lockfiles. Denies or asks for globs the repo lists in `.claude/minimal-impact.json` (`{"protected": [...], "protectedMode": "deny"|"ask"}`). Asks before a whole-file `Write` over a file the user had already modified, an edit to a committed migration, a destructive git command on a dirty tree, a repo-wide formatter or `--fix`, a dependency upgrade, or a bulk `sed -i`. Advises on new files, whole-file rewrites, out-of-scope paths, `.env`, CI, infra, build output, and dependency manifests.
- **PostToolUse**: advises on whitespace errors, conflict markers, and diffs that look like whole-file rewrites or line-ending flips.
- **Stop**: compares the working tree with its state when the session's first hook ran, so the user's earlier changes are not counted against you. Blocks once, never in a loop, on conflict markers or changes outside the declared scope. Otherwise it shows the user a summary of changed files, deletions, any lost user changes, and missing verification.
