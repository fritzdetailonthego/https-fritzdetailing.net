// Stores and retrieves pricing revision history in Vercel Blob
const { put, list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { password, action, pricing } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (action === 'save') {
      // Save current pricing as a revision before overwriting
      const ts = new Date().toISOString();
      const filename = `pricing-revisions/${ts}.json`;
      await put(filename, JSON.stringify(pricing, null, 2), {
        access: 'public', contentType: 'application/json', addRandomSuffix: false
      });
      return res.json({ success: true, revision: ts });
    }

    if (action === 'list') {
      // List all revisions
      const revisions = [];
      let cursor;
      do {
        const result = await list({ prefix: 'pricing-revisions/', cursor, limit: 100 });
        for (const blob of result.blobs) {
          const ts = blob.pathname.replace('pricing-revisions/', '').replace('.json', '');
          revisions.push({ timestamp: ts, url: blob.url, size: blob.size });
        }
        cursor = result.cursor;
      } while (cursor);
      revisions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return res.json({ revisions });
    }

    if (action === 'restore') {
      // Fetch a specific revision
      const { revisionUrl } = req.body;
      if (!revisionUrl) return res.status(400).json({ error: 'Missing revisionUrl' });
      const r = await fetch(revisionUrl);
      if (!r.ok) throw new Error('Could not fetch revision');
      const data = await r.json();
      return res.json({ success: true, pricing: data });
    }

    res.status(400).json({ error: 'Invalid action. Use save, list, or restore.' });
  } catch (e) {
    console.error('Pricing revision error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
