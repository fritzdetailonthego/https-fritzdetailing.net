const fs = require('fs');
const path = require('path');

function readVersion() {
  try {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch (error) {
    return '0.0.0';
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const commitSha = typeof process.env.VERCEL_GIT_COMMIT_SHA === 'string'
    ? process.env.VERCEL_GIT_COMMIT_SHA
    : '';

  return res.json({
    version: readVersion(),
    commit: commitSha ? commitSha.slice(0, 7) : null
  });
};
