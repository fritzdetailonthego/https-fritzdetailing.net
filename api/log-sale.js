// Logs a sale to durable runtime storage (persists across deploys).
// Also handles delete, clear-test, and GET ?action=mode for Stripe test/live detection.
const fs = require('fs');
const path = require('path');
const { appendSale, readSales, saleInputFromPaymentIntent, writeSales } = require('../lib/sales');
const {
  generateOrderId,
  generatePublicToken,
  normalizeOrder,
  updateOrders
} = require('../lib/orders');
const { getStripeModeStatus } = require('../lib/stripe-mode');

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

function cleanString(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeManualPaymentMethod(value) {
  const normalized = cleanString(value, 40).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'cashapp') return 'cashapp';
  if (normalized === 'paypal') return 'paypal';
  if (normalized === 'crypto') return 'crypto';
  if (normalized === 'card') return 'card';
  if (normalized === 'other') return 'other';
  return 'cash';
}

async function createManualOrderForSale(saleInput) {
  const amount = Number(saleInput.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw createHttpError(400, 'Invalid sale amount.');
  }

  const nowIso = new Date().toISOString();
  const customerName = cleanString(saleInput.customer || saleInput.name || 'Manual Sale', 160) || 'Manual Sale';
  const serviceName = cleanString(saleInput.service || 'Manual Sale', 160) || 'Manual Sale';
  const paymentMethod = normalizeManualPaymentMethod(saleInput.paymentMethod);
  const manualOrder = normalizeOrder({
    id: generateOrderId(),
    publicToken: generatePublicToken(),
    status: 'paid',
    paymentStatus: 'paid',
    paymentMethod,
    customer: {
      name: customerName,
      email: cleanString(saleInput.email, 160),
      phone: cleanString(saleInput.phone, 80)
    },
    vehicle: cleanString(saleInput.vehicle, 180),
    services: [
      {
        id: `manual:${paymentMethod}:${Date.now()}`,
        vehicleType: 'manual',
        vehicleLabel: 'Manual sale',
        category: 'manual',
        name: serviceName,
        price: Math.round(amount * 100) / 100,
        durationMinutes: Number.isInteger(saleInput.durationMinutes) ? saleInput.durationMinutes : 0
      }
    ],
    serviceSummary: serviceName,
    subtotal: Math.round(amount * 100) / 100,
    total: Math.round(amount * 100) / 100,
    managerFees: [],
    managerFeeTotal: 0,
    manualSale: true,
    manualSaleNotes: cleanString(saleInput.notes, 1000),
    paidAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso
  });

  await updateOrders((orders) => [manualOrder, ...orders], 'Could not create the manual order. Please try again.');
  return manualOrder;
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

function getWebhookSecretCandidates() {
  const candidates = [];
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    candidates.push({ secret: process.env.STRIPE_WEBHOOK_SECRET, isTest: false });
  }
  if (process.env.STRIPE_WEBHOOK_SECRET_TEST) {
    candidates.push({ secret: process.env.STRIPE_WEBHOOK_SECRET_TEST, isTest: true });
  }
  return candidates;
}

function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  if (req.body && typeof req.body === 'object') return Promise.resolve(Buffer.from(JSON.stringify(req.body)));

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function constructStripeEvent(rawBody, signature) {
  if (!signature) throw createHttpError(400, 'Missing Stripe signature.');

  const candidates = getWebhookSecretCandidates();
  if (candidates.length === 0) {
    throw createHttpError(500, 'Stripe webhook secret is not configured.');
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const apiKey = candidate.isTest
        ? (process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder')
        : (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || 'sk_live_placeholder');
      const stripe = require('stripe')(apiKey);
      const event = stripe.webhooks.constructEvent(rawBody, signature, candidate.secret);
      return {
        event,
        isTest: typeof event.livemode === 'boolean' ? !event.livemode : candidate.isTest
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw createHttpError(400, lastError?.message || 'Stripe webhook verification failed.');
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

async function handleStripeWebhook(req, res) {
  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];
  const { event, isTest } = constructStripeEvent(rawBody, signature);

  if (event.type !== 'payment_intent.succeeded') {
    return res.json({ received: true, ignored: true });
  }

  const paymentIntent = event.data && event.data.object;
  if (!paymentIntent || paymentIntent.object !== 'payment_intent') {
    return res.status(400).json({ error: 'Invalid payment intent event.' });
  }

  const saleInput = saleInputFromPaymentIntent(paymentIntent, isTest);
  const result = await appendSale(saleInput, { serverIsLive: !isTest });
  return res.json({ received: true, saleId: result.sale.id, duplicate: result.duplicate });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET ?action=mode returns Stripe mode and safe card readiness status.
  // Driven by site-config.stripeTestMode (admin toggle), not env var detection.
  if (req.method === 'GET' && req.query?.action === 'mode') {
    const cfg = readConfig();
    return res.json(await getStripeModeStatus(cfg));
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.headers['stripe-signature']) {
    try {
      return await handleStripeWebhook(req, res);
    } catch (error) {
      console.error('Stripe webhook error:', error.message);
      return res.status(error.statusCode || 500).json({ error: error.message || 'Webhook failed' });
    }
  }

  const { action, password, sale, saleId } = req.body;
  const isAdmin = password && password === process.env.ADMIN_PASSWORD;
  const cfg = readConfig();
  const serverIsLive = cfg.stripeTestMode !== true;

  try {
    if (action === 'delete') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      if (!saleId) return res.status(400).json({ error: 'saleId required' });
      const sales = await readSales();
      const saleToDelete = sales.find(s => s.id === saleId);
      const filtered = sales.filter(s => s.id !== saleId);
      if (filtered.length === sales.length) return res.status(404).json({ error: 'Sale not found' });
      await writeSales(filtered);
      if (saleToDelete && saleToDelete.orderId && saleToDelete.source === 'manual-order') {
        await updateOrders(
          (orders) => orders.filter((order) => !(order.id === saleToDelete.orderId && order.manualSale === true)),
          'Sale deleted, but the linked manual order could not be removed.'
        );
      }
      return res.json({ success: true, removed: sales.length - filtered.length });
    }

    if (action === 'clear-test') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const sales = await readSales();
      const kept = sales.filter(s => !s.isTest);
      const removedManualOrderIds = sales
        .filter(s => s.isTest && s.source === 'manual-order' && s.orderId)
        .map(s => s.orderId);
      const removed = sales.length - kept.length;
      await writeSales(kept);
      if (removedManualOrderIds.length) {
        const ids = new Set(removedManualOrderIds);
        await updateOrders(
          (orders) => orders.filter((order) => !(ids.has(order.id) && order.manualSale === true)),
          'Test sales were cleared, but linked manual orders could not be removed.'
        );
      }
      return res.json({ success: true, removed });
    }

    // Default: log a new sale
    const isStripeSale = typeof sale?.source === 'string' && sale.source.includes('stripe');
    if (!isAdmin && !isStripeSale) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!sale || !sale.amount) return res.status(400).json({ error: 'Invalid sale data' });

    const verifiedSale = isStripeSale ? await verifyStripeSale(sale, !serverIsLive) : null;
    const saleInput = verifiedSale || { ...sale };

    if (!verifiedSale && isAdmin && !saleInput.orderId) {
      const manualOrder = await createManualOrderForSale(saleInput);
      saleInput.orderId = manualOrder.id;
      saleInput.paymentMethod = manualOrder.paymentMethod;
      saleInput.customer = manualOrder.customer.name;
      saleInput.service = manualOrder.serviceSummary;
      saleInput.vehicle = manualOrder.vehicle || saleInput.vehicle || '';
      saleInput.amount = manualOrder.total;
      saleInput.source = 'manual-order';
      saleInput.status = 'completed';
      saleInput.notes = [saleInput.notes, `Manual order ${manualOrder.id}`].filter(Boolean).join(' | ');
    }

    // Stripe sales inherit test mode from the verified key. Manual sales trust the admin flag.
    saleInput.isTest = verifiedSale ? verifiedSale.isTest : !!sale.isTest;
    const result = await appendSale(saleInput, { serverIsLive });

    res.json({ success: true, sale: result.sale, duplicate: result.duplicate });
  } catch (error) {
    console.error('Log sale error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to log sale' });
  }
};
