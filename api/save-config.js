// Saves site-config.json to GitHub repo
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { password, config } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Invalid config data' });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return res.status(500).json({ error: 'GitHub not configured.' });
  }

  try {
    const filePath = 'public/site-config.json';
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

    const getRes = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    let sha = null;
    if (getRes.ok) { const data = await getRes.json(); sha = data.sha; }

    const content = Buffer.from(JSON.stringify(config, null, 2)).toString('base64');
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Update site config via admin panel', content, ...(sha && { sha }) })
    });

    if (!putRes.ok) { const err = await putRes.json(); throw new Error(err.message); }
    res.json({ success: true, message: 'Settings saved! Site will update in ~30 seconds.' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to save config' });
  }
};
