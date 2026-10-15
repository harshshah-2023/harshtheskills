# harshtheskills

Claude Code skills by Harsh Shah, packaged as a plugin marketplace so you can install them in one step.

| Skill | What it does |
|---|---|
| [`minimal-impact-change`](skills/minimal-impact-change/) | Makes Claude's code changes surgical: the smallest correct, complete, backward-compatible change, with guard hooks that block or flag risky edits, focused verification, and a final impact audit. |

**Requirements:** [Claude Code](https://code.claude.com) 2.1 or later, plus `node` (v16+) and `git` on your PATH. Works on Windows, macOS, and Linux.

## Install

### Option 1: as a plugin (recommended)

Inside Claude Code, type:

```
/plugin marketplace add harshshah-2023/harshtheskills
/plugin install minimal-impact-change@harshtheskills
```

Or in one step (Claude Code 2.1.275 or later):

```
/plugin install minimal-impact-change --marketplace harshshah-2023/harshtheskills
```

From a terminal instead:

```bash
claude plugin marketplace add harshshah-2023/harshtheskills
claude plugin install minimal-impact-change@harshtheskills
```

To install it for everyone working in one repository (writes to that repo's `.claude/settings.json`):

```bash
claude plugin install minimal-impact-change@harshtheskills --scope project
```

Start a new session, or run `/reload-plugins`, and the skill is available.

**Update later:**

```bash
claude plugin marketplace update harshtheskills
claude plugin update minimal-impact-change@harshtheskills
```

**Try it without installing:** clone the repo and run `claude --plugin-dir path/to/harshtheskills`. The plugin is loaded for that session only.

### Option 2: copy the skill folder

If you prefer not to use plugins:

```bash
git clone https://github.com/harshshah-2023/harshtheskills.git
cd harshtheskills
node install.js            # installs to ~/.claude/skills (all your projects)
node install.js --project  # or into ./.claude/skills of the current project
```

The installer copies the skill and fixes the hook paths for the new location. To uninstall, delete the installed folder.

## Use

**Manual:** type `/minimal-impact-change` followed by the task.

```
/minimal-impact-change add an optional `includeEmail` flag to getUserSummary
/minimal-impact-change the date filter on the orders page ignores the timezone, fix it
```

**Automatic:** Claude can pick the skill on its own for any task that modifies existing code. That is a judgement call Claude makes, not a guarantee, and short requests sometimes skip it.

**Always on (recommended):** paste the block from [`skills/minimal-impact-change/references/global-CLAUDE.md-snippet.md`](skills/minimal-impact-change/references/global-CLAUDE.md-snippet.md) into `~/.claude/CLAUDE.md`. It tells Claude to use the skill for every feature, enhancement, and bug fix, in every project.

When the skill runs, Claude plans the change, declares which files it expects to touch, edits only those, runs focused tests, audits its own diff, and ends with a short report: Implemented / Files changed / Preserved / Verification / Warnings.

### What the hooks do

The skill registers three hooks when it is invoked; they stay active for the rest of that session and are not installed globally.

- **Block:** hand edits to `.git/`, `node_modules/`, and lockfiles, plus any paths you list as protected in `<repo>/.claude/minimal-impact.json`.
- **Ask you first:** overwriting a file that already had your uncommitted changes, editing a committed migration, `git reset --hard` / `git clean` / `git checkout -- .` on a dirty tree, force-push, broad `rm -rf`, repo-wide formatters or `--fix`, dependency upgrades, bulk `sed -i`.
- **Warn Claude:** new files, whole-file rewrites, edits outside the declared scope, `.env` / CI / infra files, whitespace errors, conflict markers.
- **At the end:** a summary of what the session changed (your own earlier changes are not counted), and a one-time block if conflict markers or out-of-scope changes remain.

The hooks only run read-only git commands. They never stage, commit, reset, delete, or rewrite files, and never make network calls. Full details, configuration, and the enforced-vs-instructed breakdown are in the [skill README](skills/minimal-impact-change/README.md).

## Repository layout

```
.claude-plugin/
  marketplace.json      lets Claude Code install from this repo
  plugin.json           plugin manifest
skills/
  minimal-impact-change/
    SKILL.md            the skill (workflow + hook registration)
    README.md           details for humans
    hooks/mic-hook.js   the hook script (Node, no dependencies)
    references/         CLAUDE.md snippet, optional always-on hooks
    tests/run-tests.js  self-test: node skills/minimal-impact-change/tests/run-tests.js
install.js              manual installer (Option 2)
```

## License

MIT
