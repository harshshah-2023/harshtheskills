#!/usr/bin/env node
// Self-test for hooks/mic-hook.js using synthetic hook inputs in throwaway
// git repos under the OS temp dir. Run: node tests/run-tests.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'mic-hook.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mic test '));
const STATE = path.join(TMP, 'state');
let passed = 0;
let failed = 0;

function run(mode, input, opts = {}) {
  const r = spawnSync(process.execPath, [HOOK, mode, ...(opts.args || [])], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: opts.cwd || TMP,
    env: { ...process.env, MIC_STATE_DIR: STATE },
  });
  let json = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    json = { unparsable: r.stdout };
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? '\n       ' + JSON.stringify(detail) : ''}`);
  }
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'core.autocrlf', 'false');
  const body = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), body);
  fs.writeFileSync(path.join(dir, 'src', 'user work.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'db', 'migrations', '001_init.sql'), 'create table t (id int);\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function treeHash(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;
const context = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const pre = (cwd, sid, tool, tool_input) =>
  run('pre', { session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input });
const post = (cwd, sid, tool, tool_input) =>
  run('post', { session_id: sid, cwd, hook_event_name: 'PostToolUse', tool_name: tool, tool_input, tool_response: {} });
const stop = (cwd, sid, extra = {}) =>
  run('stop', { session_id: sid, cwd, hook_event_name: 'Stop', stop_hook_active: false, ...extra });

// ----------------------------------------------------------------------------
console.log('Malformed and missing input');
for (const mode of ['pre', 'post', 'stop']) {
  const a = run(mode, '');
  check(`${mode}: empty stdin -> exit 0, no output`, a.code === 0 && !a.stdout, a);
  const b = run(mode, '{not json');
  check(`${mode}: invalid JSON -> exit 0, no output`, b.code === 0 && !b.stdout, b);
  const c = run(mode, { tool_name: 42, tool_input: 'x', cwd: 7 });
  check(`${mode}: wrong field types -> exit 0`, c.code === 0, c);
}
check('unknown mode -> exit 0', run('bogus', { a: 1 }).code === 0);

// ----------------------------------------------------------------------------
console.log('Non-git directory');
const plain = path.join(TMP, 'plain dir');
fs.mkdirSync(plain);
fs.writeFileSync(path.join(plain, 'x.js'), 'x\n');
{
  const r = pre(plain, 's0', 'Edit', { file_path: path.join(plain, 'x.js') });
  check('pre Edit in non-git dir -> allowed silently', r.code === 0 && !decision(r), r);
  const l = pre(plain, 's0', 'Write', { file_path: path.join(plain, 'node_modules', 'a', 'i.js') });
  check('pre Write into node_modules in non-git dir -> deny', decision(l) === 'deny', l);
  const p = post(plain, 's0', 'Edit', { file_path: path.join(plain, 'x.js') });
  check('post in non-git dir -> silent', p.code === 0 && !p.stdout, p);
  const s = stop(plain, 's0');
  check('stop in non-git dir -> silent', s.code === 0 && !s.stdout, s);
}

// ----------------------------------------------------------------------------
console.log('PreToolUse path policy');
const repo = makeRepo('repo one');
// Pre-existing user work (dirty before the session's first hook).
fs.writeFileSync(path.join(repo, 'src', 'user work.js'), 'const a = 2; // user edit\n');
const before = treeHash(repo);
{
  const sid = 'sess-a';
  const ok = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'src', 'app.js'), old_string: 'a', new_string: 'b' });
  check('ordinary Edit of tracked file -> allowed, no output', ok.code === 0 && !ok.stdout, ok);

  const lock = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'package-lock.json') });
  check('Edit lockfile -> deny', decision(lock) === 'deny', lock);

  const gitInt = pre(repo, sid, 'Write', { file_path: path.join(repo, '.git', 'config') });
  check('Write inside .git -> deny', decision(gitInt) === 'deny', gitInt);

  const rel = pre(repo, sid, 'Edit', { file_path: 'src/app.js' });
  check('relative path resolved against cwd -> allowed', !decision(rel), rel);

  const clobber = pre(repo, sid, 'Write', { file_path: path.join(repo, 'src', 'user work.js'), content: 'x' });
  check('Write over file with pre-existing user changes (path with space) -> ask', decision(clobber) === 'ask', clobber);

  const rewrite = pre(repo, sid, 'Write', { file_path: path.join(repo, 'src', 'app.js'), content: 'x' });
  check('Write over clean existing file -> advisory only', !decision(rewrite) && /whole-file Write/.test(context(rewrite)), rewrite);

  const mig = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'db', 'migrations', '001_init.sql') });
  check('Edit committed migration -> ask', decision(mig) === 'ask', mig);

  const newMig = pre(repo, sid, 'Write', { file_path: path.join(repo, 'db', 'migrations', '002_add.sql') });
  check('new migration file -> allowed with advisory', !decision(newMig) && /new file/.test(context(newMig)), newMig);

  const env = pre(repo, sid, 'Edit', { file_path: path.join(repo, '.env') });
  check('.env -> advisory', !decision(env) && /environment file/.test(context(env)), env);

  const nb = pre(repo, sid, 'NotebookEdit', { notebook_path: path.join(repo, 'node_modules', 'x.ipynb') });
  check('NotebookEdit notebook_path honoured -> deny', decision(nb) === 'deny', nb);

  const read = pre(repo, sid, 'Read', { file_path: path.join(repo, 'package-lock.json') });
  check('non-editing tool ignored', !read.stdout, read);
}
check('pre hooks did not modify the repo', treeHash(repo) === before);

// ----------------------------------------------------------------------------
console.log('Protected config and scope');
{
  const sid = 'sess-b';
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'minimal-impact.json'), JSON.stringify({ protected: ['src/legacy/**', 'billing.ts'] }));
  const p1 = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'src', 'legacy', 'old.js') });
  check('protected glob -> deny', decision(p1) === 'deny', p1);
  const p2 = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'src', 'deep', 'billing.ts') });
  check('protected basename at any depth -> deny', decision(p2) === 'deny', p2);
  fs.writeFileSync(path.join(repo, '.claude', 'minimal-impact.json'), JSON.stringify({ protected: ['billing.ts'], protectedMode: 'ask' }));
  const p3 = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'billing.ts') });
  check('protectedMode ask -> ask', decision(p3) === 'ask', p3);
  fs.rmSync(path.join(repo, '.claude'), { recursive: true });

  const s = run('scope', '', { cwd: repo, args: ['set', 'src/app.js', 'test/**'] });
  check('scope set succeeds', s.code === 0 && /src\/app\.js/.test(s.stdout), s);
  const inScope = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'src', 'app.js') });
  check('in-scope edit -> silent', !inScope.stdout, inScope);
  const outScope = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'src', 'other.js') });
  check('out-of-scope edit -> advisory, not blocked', !decision(outScope) && /outside the declared change scope/.test(context(outScope)), outScope);
  run('scope', '', { cwd: repo, args: ['clear'] });

  // A scope older than the 12h TTL is ignored.
  run('scope', '', { cwd: repo, args: ['set', 'src/app.js'] });
  const scopeFile = fs.readdirSync(STATE).find((f) => f.endsWith('-scope.json'));
  const sp = path.join(STATE, scopeFile);
  const stale = JSON.parse(fs.readFileSync(sp, 'utf8'));
  stale.setAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  fs.writeFileSync(sp, JSON.stringify(stale));
  const old = pre(repo, sid, 'Edit', { file_path: path.join(repo, 'src', 'other.js') });
  check('stale scope (>12h) ignored', !/outside the declared change scope/.test(context(old)), old.json);
  run('scope', '', { cwd: repo, args: ['clear'] });
}

// ----------------------------------------------------------------------------
console.log('PreToolUse Bash heuristics');
{
  const sid = 'sess-c';
  const cases = [
    ['git reset --hard HEAD', 'ask'],
    ['git clean -fdx', 'ask'],
    ['git checkout -- .', 'ask'],
    ['git restore .', 'ask'],
    ['git push --force origin main', 'ask'],
    ['rm -rf ./*', 'ask'],
    ['npx prettier --write .', 'ask'],
    ['npx eslint --fix .', 'ask'],
    ['npm update', 'ask'],
    ['npm audit fix', 'ask'],
    ["find . -name '*.js' -exec sed -i 's/a/b/' {} +", 'ask'],
    ['git status', undefined],
    ['git diff --stat', undefined],
    ['git restore --staged .', undefined],
    ['npm test -- src/app.test.js', undefined],
    ['npx prettier --write src/app.js', undefined],
    ['npx eslint src/app.js', undefined],
    ['rm -rf dist/tmp-artifact', undefined],
    ['npm install lodash', undefined],
  ];
  for (const [cmd, want] of cases) {
    const r = pre(repo, sid, 'Bash', { command: cmd });
    check(`${JSON.stringify(cmd)} -> ${want || 'allow'}`, (decision(r) || undefined) === want, r.json);
  }
  const own = pre(repo, sid, 'Bash', { command: 'node "C:/Users/User/.claude/skills/minimal-impact-change/hooks/mic-hook.js" scope set src/app.js "src/a b.js"' });
  check('own scope command -> allow (no prompt)', decision(own) === 'allow', own.json);
  const chained = pre(repo, sid, 'Bash', { command: 'node mic-hook.js scope show && rm -rf ./*' });
  check('scope command chained with destructive command -> not auto-allowed', decision(chained) !== 'allow', chained.json);
  const clean = makeRepo('clean repo');
  const r = pre(clean, 'sess-c2', 'Bash', { command: 'git reset --hard' });
  check('git reset --hard on a clean tree -> allowed (nothing to lose)', !decision(r), r.json);
}

// ----------------------------------------------------------------------------
console.log('PostToolUse inspection');
{
  const sid = 'sess-d';
  const r2 = makeRepo('repo two');
  pre(r2, sid, 'Edit', { file_path: path.join(r2, 'src', 'app.js') }); // baseline
  const appPath = path.join(r2, 'src', 'app.js');
  const orig = fs.readFileSync(appPath, 'utf8');

  fs.writeFileSync(appPath, orig.replace('export const v3 = 3;', 'export const v3 = 30;'));
  const small = post(r2, sid, 'Edit', { file_path: appPath });
  check('small targeted edit -> silent', !small.stdout, small);

  fs.writeFileSync(appPath, orig.replace('export const v3 = 3;', 'export const v3 = 30;   '));
  const ws = post(r2, sid, 'Edit', { file_path: appPath });
  check('trailing whitespace -> advisory', /whitespace/.test(context(ws)), ws.json);

  fs.writeFileSync(appPath, orig.replace(/\n/g, '\r\n'));
  const crlf = post(r2, sid, 'Write', { file_path: appPath });
  check('line-ending flip -> whole-file rewrite advisory', /whole-file rewrite/.test(context(crlf)), crlf.json);
  check('post never blocks', !(crlf.json && crlf.json.decision), crlf.json);

  const h = treeHash(r2);
  post(r2, sid, 'Edit', { file_path: appPath });
  check('post hook did not modify the repo', treeHash(r2) === h);
  fs.writeFileSync(appPath, orig);
}

// ----------------------------------------------------------------------------
console.log('Stop final review');
{
  const sid = 'sess-e';
  const r3 = makeRepo('repo three');
  fs.writeFileSync(path.join(r3, 'src', 'user work.js'), 'const a = 3; // pre-existing\n');
  const transcript = path.join(TMP, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] } }) + '\n');

  const none = stop(r3, sid, { transcript_path: transcript });
  check('no baseline (no edits this session) -> silent', !none.stdout, none);

  pre(r3, sid, 'Edit', { file_path: path.join(r3, 'src', 'app.js') }); // baseline
  const quiet = stop(r3, sid, { transcript_path: transcript });
  check('baseline but nothing changed -> silent (user work not reported)', !quiet.stdout, quiet);

  const appPath = path.join(r3, 'src', 'app.js');
  fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8').replace('v3 = 3', 'v3 = 33'));
  fs.writeFileSync(path.join(r3, 'src', 'new file.js'), 'export {};\n');
  const h = treeHash(r3);
  const s1 = stop(r3, sid, { transcript_path: transcript });
  check('changes -> non-blocking summary', s1.json && !s1.json.decision && /2 file\(s\)/.test(s1.json.systemMessage), s1.json);
  check('summary flags missing verification', /no test, type-check/.test((s1.json || {}).systemMessage || ''), s1.json);
  check('summary excludes untouched pre-existing user work', !/user work/.test((s1.json || {}).systemMessage || ''), s1.json);
  check('stop hook did not modify the repo', treeHash(r3) === h);

  fs.appendFileSync(transcript, JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- app' } }] } }) + '\n');
  const s2 = stop(r3, sid, { transcript_path: transcript });
  check('verification command seen -> no verification warning', !/no test, type-check/.test((s2.json || {}).systemMessage || ''), s2.json);

  fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8') + '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n');
  const s3 = stop(r3, sid, { transcript_path: transcript });
  check('conflict markers -> block', s3.json && s3.json.decision === 'block' && /conflict/.test(s3.json.reason), s3.json);
  const s4 = run('stop', { session_id: sid, cwd: r3, stop_hook_active: true });
  check('stop_hook_active -> silent (no loop)', !s4.stdout, s4);
  git(r3, 'checkout', '--', 'src/app.js');
  fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8').replace('v3 = 3', 'v3 = 33'));

  run('scope', '', { cwd: r3, args: ['set', 'src/app.js'] });
  const s5 = stop(r3, sid, { transcript_path: transcript });
  check('change outside declared scope -> block', s5.json && s5.json.decision === 'block' && /new file\.js/.test(s5.json.reason), s5.json);
  run('scope', '', { cwd: r3, args: ['add', 'src/new file.js'] });
  const s6 = stop(r3, sid, { transcript_path: transcript });
  check('after scope add -> no block', s6.json && !s6.json.decision, s6.json);
  run('scope', '', { cwd: r3, args: ['clear'] });

  fs.writeFileSync(path.join(r3, 'src', 'user work.js'), 'const a = 1;\n'); // user work lost
  const s7 = stop(r3, sid, { transcript_path: transcript });
  check('pre-existing user change reverted -> warned', /pre-existing changes to this file are gone/.test((s7.json || {}).systemMessage || ''), s7.json);
}

// ----------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
