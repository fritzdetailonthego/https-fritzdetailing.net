const path = require('path');
const fs = require('fs');
const { getValidPaymentAmountsInCents } = require('./_pricing');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'site-config.json'), 'utf8'));
  } catch(e) { return {}; }
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
    const { amount, currency, description, receipt_email, metadata } = req.body;

    if (!amount || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Only accept menu prices, optionally plus configured add-on fees.
    const validPrices = await getValidPaymentAmountsInCents();
    if (!validPrices.has(amount)) {
      return res.status(400).json({ error: 'Invalid price. Please select a service and configured add-ons from the menu.' });
    }

    // Pick secret key based on admin toggle
    const cfg = readConfig();
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

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency || 'usd',
      description: description || "Fritz's Detail on the Go",
      metadata: {
        business: "Fritz's Detail on the Go",
        customer_name: metadata?.customer_name || '',
        service: metadata?.service || '',
      },
      ...(receipt_email && { receipt_email }),
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      testMode
    });

  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: error.message || 'Payment failed' });
  }
};
