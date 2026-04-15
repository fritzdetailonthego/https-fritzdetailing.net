// Logs a sale to Vercel Blob Storage (persists across deploys)
const { put } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password, sale } = req.body;
  const isAdmin = password && password === process.env.ADMIN_PASSWORD;
  if (!isAdmin && !sale?.source?.includes('stripe')) {
    if (!sale) return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sale || !sale.amount) return res.status(400).json({ error: 'Invalid sale data' });

  try {
    const commissionRate = parseFloat(process.env.COMMISSION_RATE || '0.10');
    const commission = Math.round(sale.amount * commissionRate * 100) / 100;

    const saleRecord = {
      id: 'SALE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      timestamp: new Date().toISOString(),
      customer: sale.customer || 'Unknown',
      service: sale.service || 'Detailing Service',
      vehicle: sale.vehicle || '',
      amount: sale.amount,
      commission: commission,
      commissionRate: commissionRate,
      paymentMethod: sale.paymentMethod || 'Unknown',
      source: sale.source || 'manual',
      stripePaymentId: sale.stripePaymentId || '',
      notes: sale.notes || '',
      status: sale.status || 'completed'
    };

    // Read existing sales, append, write back
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    let sales = [];
    try {
      const { blobs } = await require('@vercel/blob').list({ prefix: 'sales-data', token });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) sales = await r.json();
      }
    } catch(e) {}

    sales.push(saleRecord);

    await put('sales-data.json', JSON.stringify(sales), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });

    res.json({ success: true, sale: saleRecord });
  } catch (error) {
    console.error('Log sale error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to log sale' });
  }
};
