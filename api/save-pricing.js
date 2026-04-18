// Saves pricing.json to GitHub repo, triggering auto-redeploy on Vercel
// Requires env vars: ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { password, pricing } = req.body;

  // Auth check
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  if (!pricing || typeof pricing !== 'object') {
    return res.status(400).json({ error: 'Invalid pricing data' });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // format: "owner/repo"

  if (!token || !repo) {
    return res.status(500).json({ error: 'GitHub not configured. Add GITHUB_TOKEN and GITHUB_REPO to Vercel env vars.' });
  }

  try {
    const filePath = 'public/pricing.json';
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

    // GitHub PUT requires current SHA
    const getRes = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });

    let sha = null;
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }

    const content = Buffer.from(JSON.stringify(pricing, null, 2)).toString('base64');
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Update pricing via admin panel',
        content: content,
        ...(sha && { sha })
      })
    });

    if (!putRes.ok) {
      const err = await putRes.json();
      throw new Error(err.message || 'GitHub API error');
    }

    const validPrices = new Set();
    for (const tier of Object.values(pricing)) {
      for (const section of ['exterior', 'interior', 'packages']) {
        if (tier[section]) {
          for (const price of Object.values(tier[section])) {
            validPrices.add(price * 100); // cents for Stripe
          }
        }
      }
    }

    res.json({ success: true, message: 'Pricing updated! Site will redeploy in ~30 seconds.' });

  } catch (error) {
    console.error('Save error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to save pricing' });
  }
};
