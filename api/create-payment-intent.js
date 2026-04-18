const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const fs = require('fs');

function getValidPrices() {
  try {
    const filePath = path.join(__dirname, '..', 'public', 'pricing.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const prices = new Set();
    for (const tier of Object.values(data)) {
      for (const section of ['exterior', 'interior', 'packages']) {
        if (tier[section]) {
          for (const price of Object.values(tier[section])) {
            prices.add(price * 100); // cents
          }
        }
      }
    }
    return prices;
  } catch (e) {
    return new Set([
      2500,4000,5000,6000,7500,9000,10000,12500,14000,15000,
      17500,18000,20000,27500,32500,35000,100000,125000,150000
    ]);
  }
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

    // Only accept prices from the menu. No custom amounts.
    const validPrices = getValidPrices();
    if (!validPrices.has(amount)) {
      return res.status(400).json({ error: 'Invalid price. Please select a service from the menu.' });
    }

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
    });

  } catch (error) {
    console.error('Stripe error:', error.message);
    res.status(500).json({ error: error.message || 'Payment failed' });
  }
};
