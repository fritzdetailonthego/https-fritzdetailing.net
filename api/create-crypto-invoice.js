// NOWPayments crypto invoice endpoint
// Set NOWPAYMENTS_API_KEY in Vercel environment variables

const { getValidPricesInDollars } = require('./_pricing');

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

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Crypto payments not configured yet. Contact Fritz at (276) 247-0921.' });
  }

  try {
    const { amount, currency, description } = req.body;

    const validPrices = getValidPricesInDollars();
    if (typeof amount !== 'number' || !validPrices.has(amount)) {
      return res.status(400).json({ error: 'Invalid price. Please select a service from the menu.' });
    }

    const payCurrency = currency === 'xmr' ? 'xmr' : 'btc';

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        pay_currency: payCurrency,
        order_id: 'FRITZ-' + Date.now(),
        order_description: "Fritz's Detail on the Go: " + (description || 'Detailing Service'),
        success_url: 'https://fritzdetailing.net?payment=success',
        cancel_url: 'https://fritzdetailing.net?payment=cancelled'
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.message || 'NOWPayments error');
    }

    const data = await response.json();
    res.json({ invoice_url: data.invoice_url, id: data.id });

  } catch (error) {
    console.error('Crypto error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to create crypto invoice' });
  }
};
