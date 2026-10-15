#!/usr/bin/env node
// minimal-impact-change hook runner. Zero dependencies; Node >= 16.
//
//   node mic-hook.js pre    PreToolUse   (stdin: hook JSON)
//   node mic-hook.js post   PostToolUse  (stdin: hook JSON)
//   node mic-hook.js stop   Stop         (stdin: hook JSON)
//   node mic-hook.js scope set|add|show|clear [files...]   (CLI, run by Claude)
//
// Safety contract: this script only runs read-only git commands (status, diff,
// ls-files, rev-parse). It never stages, commits, resets, cleans, deletes, or
// rewrites repository files, and it makes no network calls. Its only writes are
// small JSON state files under <os tmpdir>/minimal-impact-change/.
// Any internal error fails open (exit 0, no output) so a hook bug can never
// block the user's work.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SKILL = 'minimal-impact-change';
const STATE_DIR = process.env.MIC_STATE_DIR || path.join(os.tmpdir(), SKILL);
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const LARGE_CHANGE_LINES = 300;
const MAX_LISTED = 15;

// ---------------------------------------------------------------- utilities

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}

function git(args, cwd) {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error || r.status === null) return null;
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
  } catch {
    return null;
  }
}

function repoRoot(cwd) {
  if (!cwd || !safeIsDir(cwd)) return null;
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  if (!r || r.code !== 0) return null;
  const root = r.out.trim();
  return root ? path.resolve(root) : null;
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function hashFile(abs) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return 'missing';
  }
}

// Forward-slash path relative to root; null when outside root.
function relTo(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

// Minimal glob: ** = any depth, * = within a segment, ? = one char.
// A pattern without "/" matches the basename at any depth.
function globToRegExp(glob) {
  let g = toPosix(glob).trim();
  if (!g.includes('/')) g = '**/' + g;
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

function matchesAny(rel, globs) {
  return (globs || []).some((g) => {
    try {
      return globToRegExp(g).test(rel);
    } catch {
      return false;
    }
  });
}

function stateKey(root) {
  return crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch {
    /* state is best-effort */
  }
}

function sanitize(id) {
  return String(id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'nosession';
}

const SCOPE_TTL_MS = 12 * 60 * 60 * 1000;

// A declared scope is valid for 12 hours, so a stale scope from an earlier
// task cannot block today's work. "scope set" replaces it.
function readScope(root) {
  const s = readJson(scopePath(root));
  if (!s || !Array.isArray(s.files) || !s.files.length) return null;
  const age = Date.now() - Date.parse(s.setAt || 0);
  return Number.isFinite(age) && age < SCOPE_TTL_MS ? s : null;
}

const scopePath = (root) => path.join(STATE_DIR, `${stateKey(root)}-scope.json`);
const baselinePath = (root, sid) =>
  path.join(STATE_DIR, `${stateKey(root)}-${sanitize(sid)}-baseline.json`);

// Optional per-repo config: <repo>/.claude/minimal-impact.json
//   { "protected": ["glob", ...], "protectedMode": "deny" | "ask" }
function loadConfig(root) {
  const c = root ? readJson(path.join(root, '.claude', 'minimal-impact.json')) : null;
  return {
    protected: Array.isArray(c && c.protected) ? c.protected.filter((s) => typeof s === 'string') : [],
    protectedMode: c && c.protectedMode === 'ask' ? 'ask' : 'deny',
  };
}

// ------------------------------------------------------------ git snapshots

// Map of repo-relative path -> porcelain XY status for every changed/untracked file.
function gitStatus(root) {
  const r = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  if (!r || r.code !== 0) return null;
  const map = {};
  const parts = r.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    map[entry.slice(3)] = xy;
    if (xy[0] === 'R' || xy[0] === 'C') i++; // skip rename source
  }
  return map;
}

// Baseline = working-tree state the first time a hook fires in this session.
// Files already dirty then are the user's pre-existing work.
function ensureBaseline(root, sid) {
  const p = baselinePath(root, sid);
  const existing = readJson(p);
  if (existing && existing.files) return existing;
  const status = gitStatus(root);
  if (!status) return null;
  const files = {};
  for (const rel of Object.keys(status)) {
    files[rel] = { xy: status[rel], hash: hashFile(path.join(root, rel)) };
  }
  const base = { createdAt: new Date().toISOString(), files };
  writeJson(p, base);
  return base;
}

// Files whose state differs from the session baseline: changed by this session
// (or by anything else running concurrently, which the report notes).
function sessionChanges(root, base) {
  const status = gitStatus(root);
  if (!status) return null;
  const changed = [];
  for (const rel of Object.keys(status)) {
    const b = base.files[rel];
    const h = hashFile(path.join(root, rel));
    if (!b) changed.push({ rel, xy: status[rel], preexisting: false });
    else if (b.hash !== h) changed.push({ rel, xy: status[rel], preexisting: true });
  }
  // Files dirty at baseline that are now clean again (reverted to HEAD).
  for (const rel of Object.keys(base.files)) {
    if (!(rel in status)) changed.push({ rel, xy: 'reverted', preexisting: true });
  }
  return changed;
}

function isTracked(root, rel) {
  const r = git(['ls-files', '--error-unmatch', '--', rel], root);
  return !!r && r.code === 0;
}

// ------------------------------------------------------------- path policy

const DENY_PATH_RULES = [
  {
    test: (rel) => /(^|\/)\.git\//.test(rel),
    why: 'is inside the .git directory; repository internals are never hand-edited',
  },
  {
    test: (rel) => /(^|\/)node_modules\//.test(rel),
    why: 'is an installed dependency under node_modules; changes are lost on reinstall',
  },
  {
    test: (rel) =>
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|packages\.lock\.json|pubspec\.lock|Podfile\.lock)$/.test(
        rel
      ),
    why: 'is a generated lockfile; change it through the package manager, not by hand',
  },
];

const ADVISORY_PATH_RULES = [
  {
    test: (rel) => /(^|\/)\.env(\..+)?$/.test(rel) && !/\.example$|\.sample$|\.template$/.test(rel),
    note: 'environment file (may hold secrets and per-machine config)',
  },
  {
    test: (rel) => /^(\.github\/workflows|\.gitlab-ci\.yml|\.circleci\/|azure-pipelines\.yml|Jenkinsfile|\.buildkite\/)/.test(rel),
    note: 'CI/CD pipeline configuration',
  },
  {
    test: (rel) => /(^|\/)(dist|build|out|target|\.next|coverage|__pycache__)\//.test(rel),
    note: 'likely generated build output; edit the source instead',
  },
  {
    test: (rel) => /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$|(^|\/)(k8s|helm|terraform|infra)\//.test(rel),
    note: 'deployment / infrastructure configuration',
  },
  {
    test: (rel) => /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|[^/]+\.csproj)$/.test(rel),
    note: 'dependency manifest; add or upgrade dependencies only when the task truly needs it',
  },
];

const MIGRATION_RE = /(^|\/)(migrations?|db\/migrate|alembic\/versions|prisma\/migrations|flyway)\//i;

// ---------------------------------------------------------- bash heuristics

// Each rule: [regex, message]. These yield "ask" (user confirms), never deny:
// the user may genuinely want them, but they are never part of a minimal change
// unless explicitly requested.
const BASH_ASK_RULES = [
  [/\bgit\s+reset\s+(?:[^|;&]*\s)?--hard\b/, 'git reset --hard discards uncommitted work'],
  [/\bgit\s+clean\s+(?:[^|;&]*\s)?-[a-zA-Z]*f/, 'git clean -f deletes untracked files'],
  [/\bgit\s+checkout\s+(?:[^|;&]*\s)?--\s+(\.|\*|:\/)(\s|$)/, 'git checkout -- . discards all working-tree changes'],
  [/\bgit\s+checkout\s+(\.|\*)(\s|$)/, 'git checkout . discards all working-tree changes'],
  [/\bgit\s+restore\s+(?![^|;&]*--staged\b)(?:[^|;&]*\s)?(\.|\*|:\/)(\s|$)/, 'git restore . discards all working-tree changes'],
  [/\bgit\s+stash\s+(drop|clear)\b/, 'git stash drop/clear permanently deletes stashed work'],
  [/\bgit\s+push\s+(?:[^|;&]*\s)?(--force\b|-f\b|--force-with-lease\b)/, 'force-push rewrites remote history'],
  [/\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*(\/|~|\.|\*|\.\/\*|\$HOME)(\s|$)/, 'recursive delete of a broad path'],
  [/\b(Remove-Item|rd|rmdir)\b[^|;&]*\s(-Recurse|\/s)\b/i, 'recursive delete'],
  [/\bprettier\b[^|;&]*(--write|-w)\b[^|;&]*\s(\.|\*\*?|src)(\/?)(\s|$)/, 'repo-wide prettier --write reformats unrelated code'],
  [/\b(eslint|biome|ruff|rubocop|stylelint)\b[^|;&]*--fix\b[^|;&]*\s(\.|src)(\/?)(\s|$)/, 'repo-wide lint --fix rewrites unrelated code'],
  [/\b(black|isort)\s+(\.|src)(\/?)(\s|$)/, 'repo-wide formatter reformats unrelated code'],
  [/\bgofmt\s+-w\s+(\.|\.\/\.\.\.)(\s|$)/, 'repo-wide gofmt -w reformats unrelated code'],
  [/\b(cargo\s+fmt|dotnet\s+format)\s*($|[|;&])/, 'repo-wide formatter reformats unrelated code'],
  [/\b(npm|pnpm|yarn)\s+(update|upgrade|up)\b/, 'upgrades dependencies beyond the task'],
  [/\bnpm\s+audit\s+fix\b/, 'npm audit fix upgrades dependencies'],
  [/\bnpx\s+npm-check-updates\b|\bncu\s+-u\b/, 'bulk dependency upgrade'],
  [/\b(cargo\s+update|poetry\s+update|bundle\s+update|composer\s+update|go\s+get\s+-u)\b/, 'upgrades dependencies beyond the task'],
  [/\bpip\s+install\s+(?:[^|;&]*\s)?(-U|--upgrade)\b/, 'upgrades Python packages'],
  [/\bfind\b[^|;&]*-exec\s+sed\s+-i\b|\bsed\s+-i[^|;&]*\s(\*\*?\/|\.\s|\*\.)|\bxargs\b[^|;&]*\bsed\s+-i\b/, 'bulk in-place edit across many files'],
  [/\bperl\s+-p?i\b[^|;&]*\*/, 'bulk in-place edit across many files'],
];

// ------------------------------------------------------------------- events

function handlePre(input) {
  const tool = input.tool_name;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = repoRoot(cwd);
  if (root) ensureBaseline(root, input.session_id);

  if (tool === 'Bash') return preBash(String(ti.command || ''), root);
  if (!FILE_TOOLS.has(tool)) return null;

  const rawPath = ti.file_path || ti.notebook_path;
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const abs = path.resolve(cwd, rawPath);
  const rel = root ? relTo(root, abs) : null;
  const relForRules = rel || toPosix(abs);
  const cfg = loadConfig(root);

  for (const rule of DENY_PATH_RULES) {
    if (rule.test(relForRules)) return decide('deny', `${relForRules} ${rule.why}.`);
  }

  if (rel && matchesAny(rel, cfg.protected)) {
    return decide(
      cfg.protectedMode,
      `${rel} matches a protected pattern in .claude/minimal-impact.json. Change it only if the task explicitly requires it.`
    );
  }

  const notes = [];

  if (root && rel) {
    const base = readJson(baselinePath(root, input.session_id));
    const exists = fileExists(abs);
    const userDirty = !!(base && base.files && base.files[rel]);

    if (tool === 'Write' && exists && userDirty) {
      return decide(
        'ask',
        `${rel} already had uncommitted changes before this session started. A whole-file Write would overwrite them; prefer a targeted Edit that preserves the user's work.`
      );
    }
    if (tool === 'Write' && exists) {
      notes.push(`${rel}: whole-file Write over an existing file. Prefer targeted Edits unless the task is a genuine rewrite.`);
    }
    if (MIGRATION_RE.test(rel) && exists && isTracked(root, rel)) {
      const st = gitStatus(root) || {};
      if (!(rel in st)) {
        return decide(
          'ask',
          `${rel} is an already-committed migration. Editing applied migrations diverges databases; add a new migration instead unless the user asked for this.`
        );
      }
    }
    if (!exists) {
      notes.push(`${rel}: creating a new file. Confirm an existing module cannot host this change.`);
    }

    const scope = readScope(root);
    if (scope && Array.isArray(scope.files) && scope.files.length && !matchesAny(rel, scope.files)) {
      notes.push(
        `${rel} is outside the declared change scope (${scope.files.slice(0, 8).join(', ')}). If it is genuinely required, add it with: node "${toPosix(__filename)}" scope add "${rel}"`
      );
    }
  }

  for (const rule of ADVISORY_PATH_RULES) {
    if (rule.test(relForRules)) notes.push(`${relForRules}: ${rule.note}.`);
  }

  return notes.length ? advise('PreToolUse', notes) : null;
}

// Matches only this script's own read-only scope subcommand, so the skill can
// declare its plan without a permission prompt. Anything chained after it
// (|, ;, &&) falls through to normal permission handling.
const SCOPE_CMD_RE = /^\s*node\s+"?[^"|;&]*mic-hook\.js"?\s+scope\s+(set|add|show|clear)(\s+[^|;&]*)?$/;

function preBash(command, root) {
  if (!command) return null;
  if (SCOPE_CMD_RE.test(command)) return decide('allow', 'declaring the change scope');
  for (const [re, why] of BASH_ASK_RULES) {
    if (re.test(command)) {
      if (/git (reset|clean|checkout|restore)/.test(why) && root) {
        const st = gitStatus(root);
        if (st && Object.keys(st).length === 0) return null; // nothing to lose
      }
      return decide(
        'ask',
        `${why}. A minimal-impact change does not need this unless the user explicitly requested it.`
      );
    }
  }
  return null;
}

function handlePost(input) {
  const tool = input.tool_name;
  if (!FILE_TOOLS.has(tool)) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const rawPath = ti.file_path || ti.notebook_path;
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = repoRoot(cwd);
  if (!root) return null;
  const abs = path.resolve(cwd, rawPath);
  const rel = relTo(root, abs);
  if (!rel || !fileExists(abs)) return null;

  const notes = [];
  if (!isTracked(root, rel)) {
    return null; // new files are noted at PreToolUse and in the Stop summary
  }

  const num = git(['diff', '--numstat', '--', rel], root);
  if (num && num.code === 0 && num.out.trim()) {
    const [a, d] = num.out.trim().split(/\s+/);
    const added = Number(a);
    const deleted = Number(d);
    if (Number.isFinite(added) && Number.isFinite(deleted)) {
      const total = countLines(abs);
      const churn = added + deleted;
      if (total >= 40 && deleted >= total * 0.6) {
        notes.push(
          `${rel}: ${deleted} of ~${total} lines differ from HEAD. This looks like a whole-file rewrite or a line-ending/indentation flip; restore the original structure and keep only the required edits.`
        );
      } else if (churn >= LARGE_CHANGE_LINES) {
        notes.push(`${rel}: ${churn} changed lines vs HEAD. Confirm all of it is required by the task.`);
      }
    }
  }

  const chk = git(['diff', '--check', '--', rel], root);
  if (chk && chk.code !== 0 && chk.out.trim()) {
    const lines = chk.out.trim().split('\n').filter((l) => !l.startsWith('+')).slice(0, 5);
    notes.push(`${rel}: whitespace problems in changed lines:\n  ${lines.join('\n  ')}`);
  }

  if (/^(<{7}|>{7}|={7})( |$)/m.test(safeRead(abs))) {
    notes.push(`${rel}: contains merge-conflict markers.`);
  }

  return notes.length ? advise('PostToolUse', notes) : null;
}

function handleStop(input) {
  if (input.stop_hook_active === true) return null; // never loop
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = repoRoot(cwd);
  if (!root) return null;
  const base = readJson(baselinePath(root, input.session_id));
  if (!base || !base.files) return null; // no edits observed this session
  const changes = sessionChanges(root, base);
  if (!changes || !changes.length) return null;

  const problems = [];
  const warnings = [];

  for (const c of changes) {
    const abs = path.join(root, c.rel);
    if (c.xy !== 'reverted' && fileExists(abs)) {
      if (/^(<{7}|>{7})( |$)/m.test(safeRead(abs))) problems.push(`${c.rel}: unresolved merge-conflict markers.`);
    }
    if (!c.preexisting && c.xy.trim() !== '??' && c.xy !== 'reverted') {
      const chk = git(['diff', '--check', 'HEAD', '--', c.rel], root);
      if (chk && chk.code !== 0 && chk.out.trim()) {
        const first = chk.out.trim().split('\n')[0];
        warnings.push(`${c.rel}: whitespace errors (${first.trim()}).`);
      }
    }
    if (c.xy.includes('D')) warnings.push(`${c.rel}: tracked file deleted.`);
    if (c.xy === 'reverted') warnings.push(`${c.rel}: the user's pre-existing changes to this file are gone.`);
  }

  const scope = readScope(root);
  if (scope && Array.isArray(scope.files) && scope.files.length) {
    const outside = changes.filter((c) => !matchesAny(c.rel, scope.files)).map((c) => c.rel);
    if (outside.length) {
      problems.push(
        `Changed outside the declared scope: ${outside.slice(0, MAX_LISTED).join(', ')}. For each: revert your own change to it, or if it is genuinely required, add it with \`node "${toPosix(__filename)}" scope add <file>\` and mention why in the final report.`
      );
    }
  }

  const summary = summarize(changes);
  const codeChanged = changes.some((c) => c.xy !== 'reverted' && !/\.(md|mdx|txt|rst)$/i.test(c.rel));
  if (codeChanged && !verificationSeen(input.transcript_path)) {
    warnings.push('no test, type-check, lint, or build command was seen in this session; run focused verification or say why it could not run.');
  }

  if (problems.length) {
    return {
      decision: 'block',
      reason:
        `[${SKILL}] Final impact audit found issues to fix before finishing (never discard the user's pre-existing changes):\n- ` +
        problems.join('\n- ') +
        (warnings.length ? `\nAlso check:\n- ${warnings.join('\n- ')}` : '') +
        `\n${summary}`,
    };
  }

  return {
    systemMessage: `[${SKILL}] ${summary}${warnings.length ? ' | Check: ' + warnings.join(' ') : ''}`,
  };
}

function summarize(changes) {
  const mod = changes.filter((c) => c.xy.trim() !== '??' && c.xy !== 'reverted' && !c.xy.includes('D'));
  const add = changes.filter((c) => c.xy.trim() === '??' || c.xy.includes('A'));
  const del = changes.filter((c) => c.xy.includes('D'));
  const names = changes.slice(0, MAX_LISTED).map((c) => c.rel).join(', ');
  const more = changes.length > MAX_LISTED ? ` (+${changes.length - MAX_LISTED} more)` : '';
  return `Session changed ${changes.length} file(s): ${mod.length} modified, ${add.length} new, ${del.length} deleted: ${names}${more}`;
}

// Cheap scan of the transcript tail for a shell command that looks like
// verification. Unknown or unreadable transcript counts as "seen" (no nagging).
const VERIFY_RE = /\b(test|tests|pytest|jest|vitest|mocha|rspec|phpunit|tsc|typecheck|type-check|mypy|pyright|lint|eslint|ruff|flake8|clippy|build|compile|cargo (check|test)|go (test|vet|build)|mvn|gradle|dotnet (test|build)|make)\b/i;

function verificationSeen(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return true;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const cmdRe = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = cmdRe.exec(text))) {
      if (VERIFY_RE.test(m[1])) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function countLines(abs) {
  const s = safeRead(abs);
  return s ? s.split('\n').length : 0;
}

function safeRead(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.size > 5 * 1024 * 1024) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

// ----------------------------------------------------------- output shapes

function decide(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: `[${SKILL}] ${reason}`,
    },
  };
}

function advise(event, notes) {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `[${SKILL}] Advisory (not blocking):\n- ${notes.join('\n- ')}`,
    },
  };
}

// --------------------------------------------------------------- scope CLI

function scopeCli(args) {
  const [action, ...files] = args;
  const root = repoRoot(process.cwd());
  if (!root) {
    console.log('Not inside a git repository; scope tracking is unavailable.');
    return 0;
  }
  const p = scopePath(root);
  const current = readJson(p) || { files: [] };
  const norm = (f) => {
    const abs = path.resolve(process.cwd(), f);
    return relTo(root, abs) || toPosix(f);
  };
  if (action === 'set') {
    writeJson(p, { files: files.map(norm), setAt: new Date().toISOString() });
  } else if (action === 'add') {
    const set = new Set(current.files.concat(files.map(norm)));
    writeJson(p, { files: [...set], setAt: new Date().toISOString() });
  } else if (action === 'clear') {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already clear */
    }
    console.log('Scope cleared.');
    return 0;
  } else if (action !== 'show') {
    console.log('Usage: mic-hook.js scope set|add|show|clear [files or globs...]');
    return 1;
  }
  const now = readJson(p);
  console.log(now && now.files.length ? `Scope for ${root}:\n  ${now.files.join('\n  ')}` : 'No scope declared.');
  return 0;
}

// --------------------------------------------------------------------- main

function main() {
  const mode = process.argv[2];
  if (mode === 'scope') {
    process.exitCode = scopeCli(process.argv.slice(3));
    return;
  }
  const input = parseInput(readStdin());
  if (!input) return; // malformed or empty input: do nothing
  let out = null;
  if (mode === 'pre') out = handlePre(input);
  else if (mode === 'post') out = handlePost(input);
  else if (mode === 'stop') out = handleStop(input);
  emit(out);
}

try {
  main();
} catch {
  process.exitCode = 0; // fail open
}
