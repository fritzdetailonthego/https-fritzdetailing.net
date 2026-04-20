// Logs a sale to Vercel Blob Storage (persists across deploys).
// Also handles delete, clear-test, and GET ?action=mode for Stripe test/live detection.
const { put, list } = require('@vercel/blob');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET ?action=mode returns Stripe test/live state. No auth needed.
  if (req.method === 'GET' && req.query?.action === 'mode') {
    const key = process.env.STRIPE_SECRET_KEY || '';
    return res.json({ testMode: !key.startsWith('sk_live_') });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const { action, password, sale, saleId } = req.body;
  const isAdmin = password && password === process.env.ADMIN_PASSWORD;
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  const serverIsLive = stripeKey.startsWith('sk_live_');

  async function readSales() {
    try {
      const { blobs } = await list({ prefix: 'sales-data', token });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return await r.json();
      }
    } catch(e) {}
    return [];
  }

  async function writeSales(sales) {
    await put('sales-data.json', JSON.stringify(sales), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });
  }

  try {
    if (action === 'delete') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      if (!saleId) return res.status(400).json({ error: 'saleId required' });
      const sales = await readSales();
      const filtered = sales.filter(s => s.id !== saleId);
      if (filtered.length === sales.length) return res.status(404).json({ error: 'Sale not found' });
      await writeSales(filtered);
      return res.json({ success: true, removed: sales.length - filtered.length });
    }

    if (action === 'clear-test') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const sales = await readSales();
      const kept = sales.filter(s => !s.isTest);
      const removed = sales.length - kept.length;
      await writeSales(kept);
      return res.json({ success: true, removed });
    }

    // Default: log a new sale
    if (!isAdmin && !sale?.source?.includes('stripe')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!sale || !sale.amount) return res.status(400).json({ error: 'Invalid sale data' });

    const commissionRate = parseFloat(process.env.COMMISSION_RATE || '0.10');
    const commission = Math.round(sale.amount * commissionRate * 100) / 100;

    // Stripe sales inherit test mode from the server key. Manual sales trust the client flag.
    const isTest = sale.source?.includes('stripe') ? !serverIsLive : !!sale.isTest;

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
      status: sale.status || 'completed',
      isTest: isTest
    };

    let sales = await readSales();

    // If this is a live Stripe sale and test sales exist, sweep them first.
    // This is the auto-archive on switch back to live mode.
    if (sale.source?.includes('stripe') && serverIsLive && sales.some(s => s.isTest)) {
      sales = sales.filter(s => !s.isTest);
    }

    sales.push(saleRecord);
    await writeSales(sales);

    res.json({ success: true, sale: saleRecord });
  } catch (error) {
    console.error('Log sale error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to log sale' });
  }
};
