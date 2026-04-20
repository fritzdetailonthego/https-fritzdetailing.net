module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = process.env.STRIPE_SECRET_KEY || '';
  res.json({ testMode: !key.startsWith('sk_live_') });
};
