const { appendSale, saleInputFromPaymentIntent } = require('./_sales');

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
  if (!signature) {
    const error = new Error('Missing Stripe signature.');
    error.statusCode = 400;
    throw error;
  }

  const candidates = getWebhookSecretCandidates();
  if (candidates.length === 0) {
    const error = new Error('Stripe webhook secret is not configured.');
    error.statusCode = 500;
    throw error;
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

  const error = new Error(lastError?.message || 'Stripe webhook verification failed.');
  error.statusCode = 400;
  throw error;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Stripe-Signature, Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
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
  } catch (error) {
    console.error('Stripe webhook error:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Webhook failed' });
  }
};
