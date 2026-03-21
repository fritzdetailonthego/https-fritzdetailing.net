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

  // Auth check
  const password = req.method === 'POST' ? req.body?.password : req.query?.password;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sales = [];
    let cursor = undefined;
    
    // List all blobs in the sales/ prefix
    do {
      const result = await list({
        prefix: 'sales/',
        cursor,
        limit: 1000
      });

      // Fetch each sale's JSON data
      for (const blob of result.blobs) {
        try {
          const response = await fetch(blob.url);
          if (response.ok) {
            const sale = await response.json();
            sales.push(sale);
          }
        } catch(e) {
          // Skip corrupted entries
        }
      }

      cursor = result.cursor;
    } while (cursor);

    // Sort by timestamp descending (newest first)
    sales.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Calculate totals
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
