// Saves gallery.json to GitHub repo
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { password, gallery } = req.body;

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  if (!gallery || typeof gallery !== 'object') {
    return res.status(400).json({ error: 'Invalid gallery data' });
  }

  const images = Array.isArray(gallery.images) ? gallery.images : [];
  for (const image of images) {
    if (!image || typeof image !== 'object' || typeof image.url !== 'string') {
      return res.status(400).json({ error: 'Each gallery image needs a URL.' });
    }

    try {
      const parsedUrl = new URL(image.url);
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return res.status(400).json({ error: 'Gallery URLs must start with http or https.' });
      }
    } catch (error) {
      return res.status(400).json({ error: 'Invalid gallery URL.' });
    }
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!token || !repo) {
    return res.status(500).json({ error: 'GitHub not configured. Add GITHUB_TOKEN and GITHUB_REPO env vars.' });
  }

  try {
    const filePath = 'public/gallery.json';
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

    const content = Buffer.from(JSON.stringify(gallery, null, 2)).toString('base64');
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Update gallery via admin panel',
        content: content,
        ...(sha && { sha })
      })
    });

    if (!putRes.ok) {
      const err = await putRes.json();
      throw new Error(err.message || 'GitHub API error');
    }

    res.json({ success: true, message: 'Gallery saved! Site will redeploy in ~30 seconds.' });

  } catch (error) {
    console.error('Save gallery error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to save gallery' });
  }
};
