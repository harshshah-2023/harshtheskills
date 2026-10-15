# minimal-impact-change

A Claude Code skill that makes code changes surgical: the smallest correct, complete, backward-compatible change, with guard hooks that enforce the objective parts. This README is for humans. Claude reads `SKILL.md`.

Install instructions are in the [repository README](../../README.md): as a plugin (`/plugin install minimal-impact-change@harshtheskills` after `/plugin marketplace add harshshah-2023/harshtheskills`), or by copying with `node install.js`.

```
minimal-impact-change/
├── SKILL.md                              workflow + frontmatter hooks (Claude reads this)
├── README.md                             this file
├── hooks/mic-hook.js                     single zero-dependency Node hook runner (pre | post | stop | scope)
├── references/
│   ├── global-CLAUDE.md-snippet.md       default-policy block for ~/.claude/CLAUDE.md
│   └── global-hooks.settings.json        optional: hooks for every session
└── tests/run-tests.js                    synthetic-input self-test
```

Requirements: `node` (v16 or later) and `git` on PATH. Works on Windows (Git Bash or PowerShell), macOS, and Linux.

## Activation

| Mode | How | Instructions | Hooks |
|---|---|---|---|
| Manual | Type `/minimal-impact-change` (optionally followed by the task) | Loaded | Registered at invocation; active until the session ends |
| Automatic (model choice) | Claude matches the task against the skill's description | Loaded if Claude picks it | Same as manual |
| Default policy (recommended) | Paste `references/global-CLAUDE.md-snippet.md` into `~/.claude/CLAUDE.md` | Policy always in context; it tells Claude to invoke the skill for every change task | Registered when Claude invokes the skill |
| Always-on hooks (optional) | Merge `references/global-hooks.settings.json` into `~/.claude/settings.json` | Not affected | Active in **every** session, whether or not the skill is used |

**Limits of automatic selection.** Claude picks skills by matching the task against their descriptions. That works most of the time, but it is a judgement Claude makes, not a guarantee, and very short requests ("fix typo in X") often skip skills. The CLAUDE.md snippet is what makes minimal-impact the default: its policy sits in context every session even when the skill is not invoked.

**Hook scope.** The hooks in `SKILL.md` frontmatter are *skill-scoped*: Claude Code registers them only when the skill is invoked, and they stay active for the rest of that session. Nothing is installed globally by default. If you opt into `global-hooks.settings.json`, the same script runs in every session. In that case skill-scoped copies would run a second time, so remove the `hooks:` block from `SKILL.md` to avoid duplicate advisories.

**Hook paths.** In `SKILL.md` the hook commands reference `${CLAUDE_PLUGIN_ROOT}/skills/minimal-impact-change/hooks/mic-hook.js`. Claude Code fills in `${CLAUDE_PLUGIN_ROOT}` for plugin installs (verified on 2.1.300); `${CLAUDE_SKILL_DIR}` is *not* expanded in hook commands, which is why the manual installer (`install.js`) rewrites the paths to the absolute install folder instead. If you move a manually installed copy, update those paths in `SKILL.md` **before** the next session: when the script cannot be found, or `node` is not on PATH, Claude Code reports a hook error and blocks every Edit/Write until it is fixed. The script itself fails open on any internal error; only a missing script or missing `node` can block you.

## What is enforced vs. instructed

| Enforced by hooks (objective) | Instruction-only (needs judgement) |
|---|---|
| **Deny:** hand edits to `.git/`, `node_modules/`, lockfiles; repo-configured protected globs | Whether a file or hunk is *necessary* for the task |
| **Ask user:** whole-file Write over a file with pre-existing user changes; edit to a committed migration; `git reset --hard` / `clean -f` / `checkout -- .` / `restore .` on a dirty tree; force-push; broad `rm -rf`; repo-wide formatter or `--fix`; dependency upgrades; bulk `sed -i` | Reusing existing components instead of new abstractions |
| **Advise Claude:** new files, whole-file rewrites, out-of-scope paths, `.env` / CI / infra / build output / manifests; whitespace errors, conflict markers, rewrite-sized or line-ending-flip diffs after each edit | Backward compatibility of contracts, schemas, and business rules |
| **Stop, blocks once:** conflict markers; changes outside a declared scope | Cross-layer completeness |
| **Stop, tells the user:** files changed this session (pre-existing user work excluded), deletions, lost user changes, no verification command seen | Test quality, and not weakening tests |
| | The final report format |

The hooks never stage, commit, reset, clean, delete, or rewrite files, and never make network calls. They run only read-only git commands and write small state files to `<tmp>/minimal-impact-change/`. On malformed input, outside a git repo, or on any internal error they exit 0 silently (fail open). The Stop hook honors `stop_hook_active`, so it cannot loop.

## Per-repo configuration (optional)

`<repo>/.claude/minimal-impact.json`:

```json
{ "protected": ["src/billing/**", "legacy/", "schema.prisma"], "protectedMode": "deny" }
```

Patterns without `/` match a file name at any depth. `protectedMode` is `deny` (default) or `ask`.

## Declared scope

Claude declares the planned files for nontrivial work:

```
node "<skill-dir>/hooks/mic-hook.js" scope set src/auth/login.ts "src/auth/login.test.ts"
node "<skill-dir>/hooks/mic-hook.js" scope add <file>     # extend when genuinely needed
node "<skill-dir>/hooks/mic-hook.js" scope show | clear
```

(`SKILL.md` gives Claude the real path. The hook auto-approves this command, so it causes no permission prompt.)

The scope is kept per repository for 12 hours. Edits outside it get an advisory; finishing with out-of-scope changes is blocked once.

## Testing

```
node tests/run-tests.js
```

The test builds throwaway git repos in the temp dir and runs the hooks on synthetic inputs. It covers malformed input, non-git dirs, paths with spaces, every deny/ask/advise rule, scope expiry, the Stop baseline, and loop guard, and checks that no hook mutates the repo.
