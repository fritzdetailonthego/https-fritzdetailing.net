module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const key = process.env.STRIPE_SECRET_KEY || '';
    res.json({ testMode: !key.startsWith('sk_live_') });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to read Stripe mode' });
  }
};
