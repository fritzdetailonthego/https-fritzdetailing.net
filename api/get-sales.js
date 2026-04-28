const { getCommissionRate, readSales } = require('../lib/sales');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const password = req.body?.password;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    let sales = await readSales();

    sales.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const totalRevenue = sales.reduce((sum, s) => {
      const amount = Number(s.amount) || 0;
      const refundAmount = s.status === 'refunded' ? (Number(s.refundAmount) || amount) : 0;
      return sum + Math.max(0, amount - refundAmount);
    }, 0);
    const totalCommission = sales.reduce((sum, s) => {
      if (s.status === 'refunded') return sum;
      return sum + (Number(s.commission) || 0);
    }, 0);
    const commissionRate = getCommissionRate();
    const activeSales = sales.filter((sale) => sale.status !== 'refunded');

    res.json({
      sales,
      summary: {
        totalSales: activeSales.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        commissionRate,
        avgSale: activeSales.length > 0 ? Math.round((totalRevenue / activeSales.length) * 100) / 100 : 0
      }
    });
  } catch (error) {
    console.error('Get sales error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch sales' });
  }
};
