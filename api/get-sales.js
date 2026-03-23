// Retrieves all sales from Vercel Blob Storage
const { list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const password = req.method === 'POST' ? req.body?.password : req.query?.password;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    let sales = [];

    const { blobs } = await list({ prefix: 'sales-data', token });
    if (blobs.length > 0) {
      const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) sales = await r.json();
    }

    sales.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const totalRevenue = sales.reduce((sum, s) => sum + (s.amount || 0), 0);
    const totalCommission = sales.reduce((sum, s) => sum + (s.commission || 0), 0);
    const commissionRate = parseFloat(process.env.COMMISSION_RATE || '0.10');

    res.json({
      sales,
      summary: {
        totalSales: sales.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        commissionRate,
        avgSale: sales.length > 0 ? Math.round((totalRevenue / sales.length) * 100) / 100 : 0
      }
    });
  } catch (error) {
    console.error('Get sales error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch sales' });
  }
};
