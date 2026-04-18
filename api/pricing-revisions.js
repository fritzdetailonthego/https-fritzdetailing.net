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

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  async function readRevisions() {
    try {
      const { blobs } = await list({ prefix: 'pricing-revisions-data', token });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return await r.json();
      }
    } catch(e) {}
    return [];
  }

  async function writeRevisions(revisions) {
    await put('pricing-revisions-data.json', JSON.stringify(revisions), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });
  }

  try {
    if (action === 'save') {
      const revisions = await readRevisions();
      revisions.push({ timestamp: new Date().toISOString(), pricing });
      // Keep last 50 revisions
      if (revisions.length > 50) revisions.splice(0, revisions.length - 50);
      await writeRevisions(revisions);
      return res.json({ success: true, revision: revisions.length });
    }

    if (action === 'list') {
      const revisions = await readRevisions();
      const list = revisions.map((r, i) => ({
        index: i,
        timestamp: r.timestamp
      })).reverse();
      return res.json({ revisions: list });
    }

    if (action === 'restore') {
      const { revisionIndex } = req.body;
      const revisions = await readRevisions();
      const idx = revisionIndex !== undefined ? revisionIndex : (req.body.revisionUrl ? -1 : -1);
      if (idx >= 0 && idx < revisions.length) {
        return res.json({ success: true, pricing: revisions[idx].pricing });
      }
      // Fallback: try last revision
      if (revisions.length > 0) {
        return res.json({ success: true, pricing: revisions[revisions.length - 1].pricing });
      }
      return res.status(404).json({ error: 'No revisions found' });
    }

    res.status(400).json({ error: 'Invalid action. Use save, list, or restore.' });
  } catch (e) {
    console.error('Pricing revision error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
