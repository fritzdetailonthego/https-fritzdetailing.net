#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[.:]/g, '-');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const output = path.resolve(arg('--output') || path.join(root, '..', `fritz-site-backup-${stamp}.zip`));
const sourceExtensions = new Set(['.cjs', '.css', '.html', '.ico', '.js', '.json', '.md', '.mjs', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.txt', '.xml', '.yml', '.yaml']);
const sourceNames = new Set(['.gitignore', '.vercelignore']);
const excluded = /(^|[\\/])(?:\.git|\.vercel|\.sites-runtime|backups|node_modules|data)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\.|$)|.*(?:secret|token|credential|password).*|.*\.zip$)/i;
const outputRelative = path.relative(root, output);
const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
if (listed.status !== 0) { console.error(listed.stderr || 'Unable to list source files with git.'); process.exit(listed.status || 1); }
const files = listed.stdout.split(/\r?\n/).filter(Boolean).filter((relative) => {
  if (relative === outputRelative || excluded.test(relative)) return false;
  let stat; try { stat = fs.lstatSync(path.join(root, relative)); } catch (_) { return false; }
  return stat.isFile() && (sourceNames.has(relative) || sourceExtensions.has(path.extname(relative).toLowerCase()));
});
if (process.argv.includes('--dry-run')) { console.log(files.join('\n')); process.exit(0); }
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync('tar', ['-a', '-c', '-f', output, ...files], { cwd: root, encoding: 'utf8' });
if (result.status !== 0) { console.error(result.stderr || 'tar failed'); process.exit(result.status || 1); }
console.log(`Created ${output} with ${files.length} source files.`);
