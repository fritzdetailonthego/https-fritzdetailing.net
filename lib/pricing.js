const fs = require('fs');
const path = require('path');
const { list } = require('@vercel/blob');

const DEFAULT_PRICES_DOLLARS = [
  25, 40, 50, 60, 75, 90, 100, 125, 140, 150,
  175, 180, 200, 275, 325, 350, 1000, 1250, 1500
];
const DEFAULT_FEES_DOLLARS = [25, 40, 50, 75];

function loadPricing() {
  const filePath = path.join(__dirname, '..', 'public', 'pricing.json');

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function getCanonicalPrices() {
  const pricing = loadPricing();
  if (!pricing || typeof pricing !== 'object') return new Set(DEFAULT_PRICES_DOLLARS);

  const prices = new Set();
  for (const tier of Object.values(pricing)) {
    if (!tier || typeof tier !== 'object') continue;
    for (const section of ['exterior', 'interior', 'packages']) {
      const items = tier[section];
      if (!items || typeof items !== 'object') continue;

      for (const value of Object.values(items)) {
        const price = Number(value);
        if (Number.isFinite(price) && price > 0) prices.add(price);
      }
    }
  }

  return prices.size > 0 ? prices : new Set(DEFAULT_PRICES_DOLLARS);
}

function getValidPricesInDollars() {
  return getCanonicalPrices();
}

function getValidPricesInCents() {
  return new Set(Array.from(getCanonicalPrices(), (price) => Math.round(price * 100)));
}

async function loadFees() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return DEFAULT_FEES_DOLLARS;

  try {
    const { blobs } = await list({ prefix: 'fees-data', token });
    if (blobs.length === 0) return DEFAULT_FEES_DOLLARS;

    const response = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return DEFAULT_FEES_DOLLARS;

    const fees = await response.json();
    if (!Array.isArray(fees)) return DEFAULT_FEES_DOLLARS;

    const amounts = fees
      .map((fee) => fee && fee.amount)
      .filter((amount) => typeof amount === 'number' && Number.isFinite(amount) && amount > 0);

    return amounts.length > 0 ? amounts : DEFAULT_FEES_DOLLARS;
  } catch (error) {
    return DEFAULT_FEES_DOLLARS;
  }
}

function collectServiceAndFeeTotals(servicePrices, feeAmounts) {
  const totals = new Set(servicePrices);

  for (const feeAmount of feeAmounts) {
    const existingTotals = Array.from(totals);
    for (const total of existingTotals) {
      totals.add(total + feeAmount);
    }
  }

  return totals;
}

async function getValidPaymentAmountsInDollars() {
  const servicePrices = getCanonicalPrices();
  const feeAmounts = await loadFees();
  return collectServiceAndFeeTotals(servicePrices, feeAmounts);
}

async function getValidPaymentAmountsInCents() {
  const totals = await getValidPaymentAmountsInDollars();
  return new Set(Array.from(totals, (price) => Math.round(price * 100)));
}

module.exports = {
  getValidPricesInCents,
  getValidPricesInDollars,
  getValidPaymentAmountsInCents,
  getValidPaymentAmountsInDollars
};
