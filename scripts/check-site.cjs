#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const htmlFiles = fs.readdirSync(publicDir).filter((name) => name.toLowerCase().endsWith('.html')).sort();
const errors = [];
const localPath = (value) => {
  const clean = decodeURIComponent(value.split('#')[0].split('?')[0]);
  if (!clean || clean.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  const pathname = clean.startsWith('/') ? clean.slice(1) : clean;
  const candidate = path.resolve(publicDir, pathname || 'index.html');
  const htmlCandidate = path.extname(candidate) ? candidate : `${candidate}.html`;
  if (!htmlCandidate.startsWith(`${publicDir}${path.sep}`)) return null;
  return { candidate, htmlCandidate };
};

for (const name of htmlFiles) {
  const filename = path.join(publicDir, name);
  const source = fs.readFileSync(filename, 'utf8');
  const seenMeta = new Map();
  for (const match of source.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const keyMatch = attrs.match(/\b(name|property|http-equiv)\s*=\s*["']([^"']+)["']/i);
    if (keyMatch) {
      const key = `${keyMatch[1].toLowerCase()}:${keyMatch[2].toLowerCase()}`;
      if (seenMeta.has(key)) errors.push(`${name}: duplicate meta ${key}`); else seenMeta.set(key, true);
    }
  }
  const canonicals = [...source.matchAll(/<link\b[^>]*\brel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*>/gi)];
  if (canonicals.length > 1) errors.push(`${name}: duplicate canonical links (${canonicals.length})`);
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1]; const body = match[2];
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) { const target = localPath(src); if (target && !fs.existsSync(target.candidate)) errors.push(`${name}: missing script ${src}`); }
    else if (body.trim() && !/\btype\s*=\s*["']application\/ld\+json["']/i.test(attrs)) {
      try { new vm.Script(body, { filename: `${name}:inline-script` }); } catch (error) { errors.push(`${name}: inline script syntax: ${error.message}`); }
    }
  }
  for (const match of source.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1]; if (value.startsWith('#') || /^\s*(?:data:|mailto:|tel:|javascript:|https?:|\/\/)/i.test(value)) continue;
    if (value.includes('${') || value.includes('{{')) continue;
    const target = localPath(value); if (target && !fs.existsSync(target.candidate) && !fs.existsSync(target.htmlCandidate)) errors.push(`${name}: missing local asset ${value}`);
  }
}

if (errors.length) { console.error(errors.map((entry) => `- ${entry}`).join('\n')); process.exitCode = 1; }
else console.log(`Static site checks passed (${htmlFiles.length} HTML files).`);
