// Logs a sale to Vercel Blob Storage (persists across deploys).
// Also handles delete, clear-test, and GET ?action=mode for Stripe test/live detection.
const fs = require('fs');
const path = require('path');
const { appendSale, readSales, saleInputFromPaymentIntent, writeSales } = require('./_sales');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'site-config.json'), 'utf8'));
  } catch(e) { return {}; }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getStripeSecretCandidates(preferTestMode) {
  const candidates = [];
  const testKey = process.env.STRIPE_SECRET_KEY_TEST;
  const liveKey = process.env.STRIPE_SECRET_KEY;

  if (preferTestMode && testKey) candidates.push({ key: testKey, isTest: true });
  if (liveKey) candidates.push({ key: liveKey, isTest: false });
  if (!preferTestMode && testKey) candidates.push({ key: testKey, isTest: true });

  return candidates;
}

async function retrieveStripePaymentIntent(paymentIntentId, preferTestMode) {
  if (typeof paymentIntentId !== 'string' || !paymentIntentId.startsWith('pi_')) {
    throw createHttpError(400, 'A valid Stripe payment id is required.');
  }

  const candidates = getStripeSecretCandidates(preferTestMode);
  if (candidates.length === 0) {
    throw createHttpError(500, 'Stripe secret key is not configured.');
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const stripe = require('stripe')(candidate.key);
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return { paymentIntent, isTest: candidate.isTest };
    } catch (error) {
      lastError = error;
    }
  }

  throw createHttpError(400, lastError?.message || 'Could not verify Stripe payment.');
}

async function verifyStripeSale(sale, preferTestMode) {
  const { paymentIntent, isTest } = await retrieveStripePaymentIntent(sale && sale.stripePaymentId, preferTestMode);

  if (paymentIntent.status !== 'succeeded') {
    throw createHttpError(409, 'Stripe payment has not succeeded.');
  }

  const expectedAmount = Math.round(Number(sale.amount) * 100);
  const paidAmount = paymentIntent.amount_received || paymentIntent.amount;
  if (!Number.isInteger(expectedAmount) || expectedAmount !== paidAmount) {
    throw createHttpError(400, 'Sale amount does not match the Stripe payment.');
  }

  return {
    ...saleInputFromPaymentIntent(paymentIntent, isTest, {
      vehicle: sale.vehicle,
      notes: sale.notes
    }),
    customer: paymentIntent.metadata?.customer_name || sale.customer || paymentIntent.receipt_email || 'Unknown',
    service: paymentIntent.metadata?.service || sale.service || paymentIntent.description || 'Detailing Service'
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET ?action=mode returns Stripe test/live state and the test pk if configured.
  // Driven by site-config.stripeTestMode (admin toggle), not env var detection.
  if (req.method === 'GET' && req.query?.action === 'mode') {
    const cfg = readConfig();
    const testMode = cfg.stripeTestMode === true;
    const hasTestKeys = !!(process.env.STRIPE_SECRET_KEY_TEST && process.env.STRIPE_PUBLISHABLE_KEY_TEST);
    return res.json({
      testMode,
      publishableKey: testMode && hasTestKeys ? process.env.STRIPE_PUBLISHABLE_KEY_TEST : null,
      hasTestKeys
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, password, sale, saleId } = req.body;
  const isAdmin = password && password === process.env.ADMIN_PASSWORD;
  const cfg = readConfig();
  const serverIsLive = cfg.stripeTestMode !== true;

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
    const isStripeSale = typeof sale?.source === 'string' && sale.source.includes('stripe');
    if (!isAdmin && !isStripeSale) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!sale || !sale.amount) return res.status(400).json({ error: 'Invalid sale data' });

    const verifiedSale = isStripeSale ? await verifyStripeSale(sale, !serverIsLive) : null;
    const saleInput = verifiedSale || sale;

    // Stripe sales inherit test mode from the verified key. Manual sales trust the admin flag.
    saleInput.isTest = verifiedSale ? verifiedSale.isTest : !!sale.isTest;
    const result = await appendSale(saleInput, { serverIsLive });

    res.json({ success: true, sale: result.sale, duplicate: result.duplicate });
  } catch (error) {
    console.error('Log sale error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to log sale' });
  }
};
