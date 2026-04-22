const crypto = require('crypto');

const MANAGER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getManagerSessionSecret() {
  return process.env.MANAGER_SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
}

function createManagerToken() {
  const issuedAtMs = Date.now();
  const payload = {
    role: 'manager',
    iat: Math.floor(issuedAtMs / 1000),
    exp: Math.floor((issuedAtMs + MANAGER_TOKEN_TTL_MS) / 1000)
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(
    crypto
      .createHmac('sha256', getManagerSessionSecret())
      .update(encodedPayload)
      .digest()
  );

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt: new Date(issuedAtMs + MANAGER_TOKEN_TTL_MS).toISOString()
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { password } = req.body;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not set in Vercel environment variables.' });
  }

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const session = createManagerToken();
  res.json({
    success: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: { role: 'manager' }
  });
};
