const path = require('path');
const fs = require('fs');
const { findOrderByCredentials, readOrders } = require('../lib/orders');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'site-config.json'), 'utf8'));
  } catch(e) { return {}; }
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isCardPaymentEnabled(config) {
  const payments = config && typeof config.payments === 'object' ? config.payments : {};
  return payments.card !== false;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { orderId, token: publicToken } = req.body || {};
    const { data: orders } = await readOrders();
    const order = findOrderByCredentials(orders, orderId, publicToken);

    if (!order) {
      return res.status(404).json({ error: 'Order not found. Start checkout again.' });
    }

    if (order.paymentMethod !== 'card') {
      return res.status(400).json({ error: 'This order is not configured for card payment.' });
    }

    if (order.status !== 'requires_payment' && order.paymentStatus !== 'requires_payment') {
      return res.status(409).json({ error: 'This order is not waiting for card payment.' });
    }

    if (!isValidEmail(order.customer && order.customer.email)) {
      return res.status(400).json({ error: 'A valid email is required before payment.' });
    }

    const amount = Math.round(Number(order.total) * 100);
    if (!Number.isInteger(amount) || amount < 100) {
      return res.status(400).json({ error: 'Invalid order total.' });
    }

    const cfg = readConfig();
    if (!isCardPaymentEnabled(cfg)) {
      return res.status(409).json({ error: 'Card payment is not available right now.' });
    }

    const testMode = cfg.stripeTestMode === true;
    const secretKey = testMode ? process.env.STRIPE_SECRET_KEY_TEST : process.env.STRIPE_SECRET_KEY;

    if (!secretKey) {
      return res.status(500).json({
        error: testMode
          ? 'Stripe test mode is ON but STRIPE_SECRET_KEY_TEST env var is not set in Vercel.'
          : 'STRIPE_SECRET_KEY env var is not set in Vercel.'
      });
    }

    const stripe = require('stripe')(secretKey);
    const serviceSummary = order.serviceSummary || (order.services || []).map((service) => service.name).join(' + ');

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      description: serviceSummary || "Fritz's Detail on the Go",
      metadata: {
        business: "Fritz's Detail on the Go",
        order_id: order.id,
        customer_name: order.customer?.name || '',
        service: serviceSummary || ''
      },
      receipt_email: order.customer.email
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      orderId: order.id,
      testMode
    });

  } catch (error) {
    console.error('Stripe error:', error.storageDetail || error.message);
    const isStorageError =
      error && (
        error.code === 'ORDER_STORAGE_READ_FAILED' ||
        /orders-data|Blob|storage|Failed to read/i.test(error.message || '')
      );
    const isStripeConfigError =
      error && /invalid api key|no api key|api key provided|authentication/i.test(error.message || '');
    res.status(error.statusCode && error.statusCode >= 400 ? error.statusCode : 500).json({
      error: isStorageError
        ? 'Checkout storage is temporarily unavailable. Please try again.'
        : isStripeConfigError
          ? 'Card payment is not configured correctly. Choose another payment method or call Fritz.'
        : error.message || 'Payment failed'
    });
  }
};
