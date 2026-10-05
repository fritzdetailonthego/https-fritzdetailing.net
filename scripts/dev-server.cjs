#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');
const MAX_BODY_BYTES = 1024 * 1024;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp'
};

// Scrub deployment credentials before any API module (or dependency) can load them.
const CREDENTIAL_NAME = /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|PUBLISHABLE_KEY|WEBHOOK_SECRET|GITHUB_REPO|STRIPE_|NOWPAYMENTS_|EXPO_)/i;
for (const key of Object.keys(process.env)) {
  if (CREDENTIAL_NAME.test(key) && key !== 'FRITZ_LOCAL_TEST_MODE' && key !== 'FRITZ_ALLOW_LOCAL_MUTATIONS') delete process.env[key];
}
process.env.FRITZ_LOCAL_SERVER = '1';

function blockExternalRequest(options) {
  const value = typeof options === 'string' ? options : (options && (options.href || options.hostname || options.host));
  const host = String(value || '').replace(/^https?:\/\//i, '').split(/[/:]/)[0].toLowerCase();
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Outbound network access is disabled by the local server.');
}
const originalFetch = global.fetch;
global.fetch = async (url, options) => { blockExternalRequest(String(url)); return originalFetch(url, options); };
const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;
http.request = function localHttpRequest(options, callback) { blockExternalRequest(options); return originalHttpRequest.call(this, options, callback); };
http.get = function localHttpGet(options, callback) { blockExternalRequest(options); return originalHttpGet.call(this, options, callback); };
https.request = function localHttpsRequest(options, callback) { blockExternalRequest(options); return originalHttpsRequest.call(this, options, callback); };
https.get = function localHttpsGet(options, callback) { blockExternalRequest(options); return originalHttpsGet.call(this, options, callback); };

function safePublicPath(requestPath) {
  let name = decodeURIComponent(requestPath || '/').split('?')[0].split('#')[0];
  if (name === '/') name = '/index.html';
  if (!path.extname(name)) name += '.html';
  const resolved = path.resolve(PUBLIC, `.${name}`);
  return resolved.startsWith(`${PUBLIC}${path.sep}`) ? resolved : null;
}

function localApiPath(requestPath) {
  const match = String(requestPath).match(/^\/api\/([a-z0-9][a-z0-9-]*)$/i);
  if (!match) return null;
  const file = path.join(API, `${match[1]}.js`);
  return fs.existsSync(file) && path.resolve(file).startsWith(`${path.resolve(API)}${path.sep}`) ? file : null;
}

function localMutationAllowed() {
  return process.env.FRITZ_ALLOW_LOCAL_MUTATIONS === '1' && process.env.FRITZ_LOCAL_TEST_MODE === '1';
}

function assertTestEnvironment() {
  if (!localMutationAllowed()) return 'Local API mutations are disabled. Set FRITZ_ALLOW_LOCAL_MUTATIONS=1 and FRITZ_LOCAL_TEST_MODE=1 with dummy test values.';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; let tooLarge = false; const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk); else tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
      if (!size) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch (_) { reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function responseAdapter(res) {
  return {
    status(code) { res.statusCode = code; return this; },
    setHeader(name, value) { res.setHeader(name, value); },
    json(value) { if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); },
    end(value) { res.end(value); }
  };
}

async function runApi(req, res, apiFile, parsedUrl) {
  if (!READ_METHODS.has(req.method)) {
    const problem = assertTestEnvironment();
    if (problem) return responseAdapter(res).status(403).json({ error: problem });
  }
  if (!READ_METHODS.has(req.method)) req.body = await readBody(req);
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());
  const handler = require(apiFile);
  if (localMutationAllowed()) {
    process.env.ADMIN_PASSWORD = 'local-test-password';
    process.env.MANAGER_SESSION_SECRET = 'local-test-secret';
    process.env.STRIPE_SECRET_KEY_TEST = 'sk_test_local_dummy';
  }
  try { await handler(req, responseAdapter(res)); }
  catch (error) { if (!res.headersSent) responseAdapter(res).status(error.statusCode || 500).json({ error: error.message || 'Local API error' }); }
}

async function requestHandler(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const apiFile = localApiPath(parsed.pathname);
  if (apiFile) return runApi(req, res, apiFile, parsed);
  if (parsed.pathname.startsWith('/api/')) return responseAdapter(res).status(404).json({ error: 'Unknown local API endpoint.' });
  const file = safePublicPath(parsed.pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return responseAdapter(res).status(404).json({ error: 'Not found.' });
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  if (req.method === 'HEAD') return res.end();
  if (req.method !== 'GET') return responseAdapter(res).status(405).json({ error: 'Method not allowed.' });
  return fs.createReadStream(file).pipe(res);
}

if (require.main === module) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 4173);
  const server = http.createServer((req, res) => requestHandler(req, res).catch((error) => responseAdapter(res).status(error.statusCode || 500).json({ error: error.message || 'Server error.' })));
  server.listen(port, '127.0.0.1', () => console.log(`Fritz local server listening at http://127.0.0.1:${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

module.exports = { requestHandler, safePublicPath, localApiPath, MAX_BODY_BYTES };
