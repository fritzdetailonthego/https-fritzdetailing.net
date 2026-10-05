// Manage custom fees (distance, pet hair, etc). Stored in Vercel Blob.
const { put, get } = require('@vercel/blob');
const {
  hasGitHubJsonStore,
  readGitHubJson,
  writeGitHubJson
} = require('../lib/github-json-store');
const { verifyAdminPassword } = require('../lib/admin-auth');

const FEES_PATH = 'fees-data.json';

function isBlobNotFoundError(error) {
  return !!error && (
    error.name === 'BlobNotFoundError' ||
    error.code === 'BlobNotFoundError' ||
    error.status === 404 ||
    error.statusCode === 404 ||
    (typeof error.message === 'string' && error.message.includes('does not exist'))
  );
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  async function readFeesState() {
    const defaultFees = [
      { id: 'distance', name: 'Distance Fee (30+ min)', amount: 25, type: 'flat', description: 'Added for locations beyond standard service radius' },
      { id: 'pet-hair', name: 'Heavy Pet Hair', amount: 40, type: 'flat', description: 'For vehicles with excessive pet hair requiring extra cleaning time' },
      { id: 'heavy-soil', name: 'Heavy Soil / Mud', amount: 50, type: 'flat', description: 'For heavily soiled vehicles requiring extra prep' },
      { id: 'biohazard', name: 'Biohazard Cleanup', amount: 75, type: 'flat', description: 'Vomit, blood, or similar cleanup' }
    ];

    if (hasGitHubJsonStore()) {
      const state = await readGitHubJson(FEES_PATH, defaultFees);
      return {
        ...state,
        data: Array.isArray(state.data) ? state.data : defaultFees
      };
    }

    let blobError = null;
    const accessModes = process.env.ALLOW_LEGACY_PUBLIC_BLOB_READS === 'true'
      ? ['private', 'public']
      : ['private'];
    for (const access of accessModes) {
      try {
        const result = await get(FEES_PATH, { access, token, useCache: false });
        if (result) {
          const text = await new Response(result.stream).text();
          const data = JSON.parse(text);
          return { data: Array.isArray(data) ? data : defaultFees, storage: 'blob' };
        }
      } catch (error) {
        if (isBlobNotFoundError(error)) continue;
        blobError = error;
      }
    }

    if (blobError) throw blobError;
    return { data: defaultFees, storage: 'blob' };
  }

  async function readFees() {
    const state = await readFeesState();
    return state.data;
  }

  async function writeFees(fees) {
    if (hasGitHubJsonStore()) {
      const state = await readGitHubJson(FEES_PATH, []);
      await writeGitHubJson(FEES_PATH, fees, state.sha || null, `Update ${FEES_PATH}`);
      return;
    }

    await put('fees-data.json', JSON.stringify(fees), {
      access: 'private',
      contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token
    });
  }

  try {
    if (req.method === 'GET') {
      return res.status(405).json({ error: 'Fees are managed by Fritz after booking.' });
    }

    const { password, action } = req.body || {};
    if (!verifyAdminPassword(req, res, password, 'fees')) return;

    if (action === 'list') {
      return res.json({ fees: await readFees() });
    }

    if (action === 'save') {
      const { fees } = req.body;
      if (!Array.isArray(fees)) return res.status(400).json({ error: 'fees must be an array' });
      if (fees.length > 100) return res.status(400).json({ error: 'Too many fees.' });
      const cleanFees = fees.map((fee) => {
        const amount = Number(fee && fee.amount);
        const name = typeof (fee && fee.name) === 'string' ? fee.name.trim() : '';
        if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 100000) return null;
        return {
          id: typeof fee.id === 'string' && fee.id.trim()
            ? fee.id.trim().slice(0, 80)
            : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80),
          name: name.slice(0, 120),
          amount: Math.round(amount * 100) / 100,
          type: 'flat',
          description: typeof fee.description === 'string' ? fee.description.trim().slice(0, 240) : ''
        };
      }).filter(Boolean);
      if (cleanFees.length !== fees.length) {
        return res.status(400).json({ error: 'Every fee needs a valid name and amount.' });
      }
      await writeFees(cleanFees);
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('Fees error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
