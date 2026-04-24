const { put, list } = require('@vercel/blob');

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function getCommissionRate() {
  return parseFloat(process.env.COMMISSION_RATE || '0.10');
}

async function readSales() {
  const token = getBlobToken();
  try {
    const { blobs } = await list({ prefix: 'sales-data', token });
    if (blobs.length > 0) {
      const response = await fetch(blobs[0].url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        return Array.isArray(data) ? data : [];
      }
    }
  } catch (error) {}
  return [];
}

async function writeSales(sales) {
  await put('sales-data.json', JSON.stringify(sales), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    token: getBlobToken()
  });
}

function buildSaleRecord(saleInput) {
  const amount = Number(saleInput.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('Invalid sale data');
    error.statusCode = 400;
    throw error;
  }

  const commissionRate = getCommissionRate();
  const commission = Math.round(amount * commissionRate * 100) / 100;

  return {
    id: 'SALE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
    timestamp: new Date().toISOString(),
    customer: saleInput.customer || 'Unknown',
    service: saleInput.service || 'Detailing Service',
    vehicle: saleInput.vehicle || '',
    amount,
    commission,
    commissionRate,
    paymentMethod: saleInput.paymentMethod || 'Unknown',
    source: saleInput.source || 'manual',
    stripePaymentId: saleInput.stripePaymentId || '',
    notes: saleInput.notes || '',
    status: saleInput.status || 'completed',
    isTest: !!saleInput.isTest
  };
}

async function appendSale(saleInput, options = {}) {
  const saleRecord = buildSaleRecord(saleInput);
  let sales = await readSales();

  if (saleRecord.stripePaymentId) {
    const existingSale = sales.find((sale) => sale.stripePaymentId === saleRecord.stripePaymentId);
    if (existingSale) {
      return { sale: existingSale, duplicate: true };
    }
  }

  if (saleRecord.source === 'stripe' && !saleRecord.isTest && options.serverIsLive !== false && sales.some((sale) => sale.isTest)) {
    sales = sales.filter((sale) => !sale.isTest);
  }

  sales.push(saleRecord);
  await writeSales(sales);
  return { sale: saleRecord, duplicate: false };
}

function saleInputFromPaymentIntent(paymentIntent, isTest, overrides = {}) {
  const paidAmount = paymentIntent.amount_received || paymentIntent.amount;
  return {
    customer: paymentIntent.metadata?.customer_name || paymentIntent.receipt_email || 'Unknown',
    service: paymentIntent.metadata?.service || paymentIntent.description || 'Detailing Service',
    vehicle: overrides.vehicle || '',
    amount: paidAmount / 100,
    paymentMethod: 'card',
    source: 'stripe',
    stripePaymentId: paymentIntent.id,
    notes: overrides.notes || '',
    status: 'completed',
    isTest
  };
}

module.exports = {
  appendSale,
  getCommissionRate,
  readSales,
  saleInputFromPaymentIntent,
  writeSales
};
