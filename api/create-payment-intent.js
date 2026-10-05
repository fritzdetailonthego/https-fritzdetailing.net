const path = require('path');
const fs = require('fs');
const { findOrderByCredentials, readOrders } = require('../lib/orders');
const {
  createPaymentIntentIdempotencyKey,
  getExpectedAmountCents
} = require('../lib/payment-integrity');
const { getStripePaymentConfig, isStripeAuthenticationError } = require('../lib/stripe-mode');

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
  res.setHeader('Cache-Control', 'no-store');
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

    if (order.status !== 'requires_payment' || order.paymentStatus !== 'requires_payment') {
      return res.status(409).json({ error: 'This order is not waiting for card payment.' });
    }

    if (!isValidEmail(order.customer && order.customer.email)) {
      return res.status(400).json({ error: 'A valid email is required before payment.' });
    }

    const amount = getExpectedAmountCents(order);

    const cfg = readConfig();
    if (!isCardPaymentEnabled(cfg)) {
      return res.status(409).json({ error: 'Card payment is not available right now.' });
    }

    const stripeConfig = getStripePaymentConfig(cfg);

    if (!stripeConfig.secretKey || !stripeConfig.secretLooksValid || !stripeConfig.publishableLooksValid) {
      return res.status(503).json({
        error: 'Card payment is not configured correctly. Choose another payment method or call Fritz.'
      });
    }

    const stripe = require('stripe')(stripeConfig.secretKey);
    const serviceSummary = order.serviceSummary || (order.services || []).map((service) => service.name).join(' + ');

    const paymentIntent = await stripe.paymentIntents.create(
      {
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
      },
      {
        idempotencyKey: createPaymentIntentIdempotencyKey(order, stripeConfig.testMode)
      }
    );

    if (!paymentIntent || typeof paymentIntent.id !== 'string' || typeof paymentIntent.client_secret !== 'string') {
      throw new Error('Stripe did not return a usable payment session.');
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      orderId: order.id,
      testMode: stripeConfig.testMode
    });

  } catch (error) {
    console.error('Stripe error:', error.storageDetail || error.message);
    const isStorageError =
      error && (
        error.code === 'ORDER_STORAGE_READ_FAILED' ||
        /orders-data|Blob|storage|Failed to read/i.test(error.message || '')
      );
    const isStripeConfigError =
      isStripeAuthenticationError(error);
    res.status(error.statusCode && error.statusCode >= 400 ? error.statusCode : 500).json({
      error: isStorageError
        ? 'Checkout storage is temporarily unavailable. Please try again.'
        : isStripeConfigError
          ? 'Card payment is not configured correctly. Choose another payment method or call Fritz.'
          : 'Payment could not be started. Please try again.'
    });
  }
};
