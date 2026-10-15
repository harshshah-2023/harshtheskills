# Global CLAUDE.md snippet

Paste the block below into `~/.claude/CLAUDE.md` (all projects) or a repo's `CLAUDE.md` (that repo only).

CLAUDE.md is loaded into every session, so this block sets minimal-impact as the default policy. It does not depend on whether Claude happens to pick the skill from its description. Invoking the skill also loads the full workflow and registers its guard hooks.

---

```markdown
## Code changes: minimal impact by default

For every task that modifies existing software (feature, enhancement, bug fix, refactor the user asked for), invoke the `minimal-impact-change` skill before the first edit, and follow it. If the skill is unavailable, still apply its policy:

- Change only what the request needs; keep everything else byte-identical. Smallest impact, not fewest lines: the change must be correct, complete across every layer it touches, and maintainable.
- Treat files already modified in `git status` as the user's work and preserve them.
- Extend existing functions, components, and extension points. Add new files, abstractions, dependencies, or feature flags only when the task genuinely requires them.
- Keep public contracts, schemas, auth, business rules, UI, config, and existing tests stable unless the task requires a change, and then update every consumer.
- Report unrelated issues; leave them unfixed.
- Verify with focused tests and checks you actually ran, review the final diff hunk by hunk, and end with: Implemented / Files changed / Preserved / Verification / Warnings.
```
