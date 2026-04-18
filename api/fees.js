// Manage custom fees (distance, pet hair, etc). Stored in Vercel Blob.
const { put, list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  async function readFees() {
    try {
      const { blobs } = await list({ prefix: 'fees-data', token });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return await r.json();
      }
    } catch(e) {}
    return [
      { id: 'distance', name: 'Distance Fee (30+ min)', amount: 25, type: 'flat', description: 'Added for locations beyond standard service radius' },
      { id: 'pet-hair', name: 'Heavy Pet Hair', amount: 40, type: 'flat', description: 'For vehicles with excessive pet hair requiring extra cleaning time' },
      { id: 'heavy-soil', name: 'Heavy Soil / Mud', amount: 50, type: 'flat', description: 'For heavily soiled vehicles requiring extra prep' },
      { id: 'biohazard', name: 'Biohazard Cleanup', amount: 75, type: 'flat', description: 'Vomit, blood, or similar cleanup' }
    ];
  }

  async function writeFees(fees) {
    await put('fees-data.json', JSON.stringify(fees), {
      access: 'public',
      contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token
    });
  }

  try {
    // PUBLIC GET: list fees. No auth needed, they're shown to customers.
    if (req.method === 'GET') {
      const fees = await readFees();
      return res.json({ fees });
    }

    const { password, action } = req.body || {};
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (action === 'list') {
      return res.json({ fees: await readFees() });
    }

    if (action === 'save') {
      const { fees } = req.body;
      if (!Array.isArray(fees)) return res.status(400).json({ error: 'fees must be an array' });
      await writeFees(fees);
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('Fees error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
