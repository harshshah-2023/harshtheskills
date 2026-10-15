#!/usr/bin/env node
// Manual installer for people who prefer not to use the plugin system.
//
//   node install.js            -> ~/.claude/skills/minimal-impact-change  (all projects)
//   node install.js --project  -> ./.claude/skills/minimal-impact-change  (this project only)
//
// Copies skills/minimal-impact-change and rewrites the hook paths in SKILL.md,
// which otherwise rely on ${CLAUDE_PLUGIN_ROOT} (only set for plugin installs).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'minimal-impact-change';
const src = path.join(__dirname, 'skills', NAME);
const base = process.argv.includes('--project')
  ? path.join(process.cwd(), '.claude', 'skills')
  : path.join(os.homedir(), '.claude', 'skills');
const dest = path.join(base, NAME);

if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
  console.error(`Cannot find ${src}. Run this from the cloned repository.`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

const skillMd = path.join(dest, 'SKILL.md');
const posixDest = dest.split(path.sep).join('/');
const text = fs.readFileSync(skillMd, 'utf8').split('${CLAUDE_PLUGIN_ROOT}/skills/' + NAME).join(posixDest);
fs.writeFileSync(skillMd, text);

console.log(`Installed ${NAME} to ${dest}`);
console.log('Hook paths in SKILL.md now point at that folder. Start a new Claude Code session, then type /minimal-impact-change.');
console.log('To uninstall, delete that folder.');
