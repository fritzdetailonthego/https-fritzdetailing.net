const crypto = require('crypto');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 8;
const attempts = new Map();

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function getAttemptKey(req, scope) {
  return `${scope}:${getClientIp(req)}`;
}

function getFreshAttempts(key, now = Date.now()) {
  const fresh = (attempts.get(key) || []).filter((timestamp) => now - timestamp < WINDOW_MS);
  if (fresh.length) attempts.set(key, fresh);
  else attempts.delete(key);
  return fresh;
}

function getAuthRetryAfterSeconds(req, scope) {
  const now = Date.now();
  const fresh = getFreshAttempts(getAttemptKey(req, scope), now);
  if (fresh.length < MAX_FAILED_ATTEMPTS) return 0;
  return Math.max(1, Math.ceil((WINDOW_MS - (now - fresh[0])) / 1000));
}

function recordAuthFailure(req, scope) {
  const key = getAttemptKey(req, scope);
  const now = Date.now();
  const fresh = getFreshAttempts(key, now);
  fresh.push(now);
  attempts.set(key, fresh);
}

function clearAuthFailures(req, scope) {
  attempts.delete(getAttemptKey(req, scope));
}

function isSecretEqual(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string' || !expected) return false;
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);
  if (inputBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function rejectIfRateLimited(req, res, scope) {
  const retryAfterSeconds = getAuthRetryAfterSeconds(req, scope);
  if (!retryAfterSeconds) return false;
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({
    error: 'Too many failed attempts. Try again later.',
    retryAfterSeconds
  });
  return true;
}

function verifyAdminPassword(req, res, password, scope, failureMessage = 'Unauthorized') {
  if (rejectIfRateLimited(req, res, scope)) return false;
  if (isSecretEqual(password, process.env.ADMIN_PASSWORD)) {
    clearAuthFailures(req, scope);
    return true;
  }
  recordAuthFailure(req, scope);
  res.status(401).json({ error: failureMessage });
  return false;
}

module.exports = {
  clearAuthFailures,
  getAuthRetryAfterSeconds,
  isSecretEqual,
  recordAuthFailure,
  rejectIfRateLimited,
  verifyAdminPassword
};
