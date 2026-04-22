const fs = require('fs');
const path = require('path');

const DEFAULT_PRICES_DOLLARS = [
  25, 40, 50, 60, 75, 90, 100, 125, 140, 150,
  175, 180, 200, 275, 325, 350, 1000, 1250, 1500
];

function loadPricing() {
  const filePath = path.join(__dirname, '..', 'public', 'pricing.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectPrices(data) {
  const prices = new Set();

  for (const tier of Object.values(data || {})) {
    for (const section of ['exterior', 'interior', 'packages']) {
      const entries = tier && typeof tier === 'object' ? tier[section] : null;
      if (!entries || typeof entries !== 'object') continue;

      for (const price of Object.values(entries)) {
        if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
          prices.add(price);
        }
      }
    }
  }

  return prices;
}

function getCanonicalPrices() {
  try {
    const prices = collectPrices(loadPricing());
    if (prices.size > 0) return prices;
  } catch (error) {}

  return new Set(DEFAULT_PRICES_DOLLARS);
}

function getValidPricesInDollars() {
  return getCanonicalPrices();
}

function getValidPricesInCents() {
  return new Set(Array.from(getCanonicalPrices(), (price) => Math.round(price * 100)));
}

module.exports = {
  getValidPricesInCents,
  getValidPricesInDollars
};
