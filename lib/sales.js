const { put, get } = require('@vercel/blob');
const {
  hasGitHubJsonStore,
  readGitHubJson,
  writeGitHubJson
} = require('./github-json-store');

const SALES_PATH = 'sales-data.json';

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function getCommissionRate() {
  return parseFloat(process.env.COMMISSION_RATE || '0.10');
}

async function readSales() {
  const state = await readSalesState();
  return state.data;
}

async function readSalesState() {
  let blobError = null;
  try {
    return await readBlobSalesState();
  } catch (error) {
    blobError = error;
  }

  if (hasGitHubJsonStore()) {
    try {
      const state = await readGitHubJson(SALES_PATH, []);
      return {
        ...state,
        data: Array.isArray(state.data) ? state.data : []
      };
    } catch (_githubError) {
      if (blobError) throw blobError;
    }
  }

  return { data: [], storage: 'blob', missing: true };
}

async function readBlobSalesState() {
  const token = getBlobToken();
  const result = await get(SALES_PATH, {
    access: 'public',
    token,
    useCache: false
  });

  if (!result) return { data: [], storage: 'blob', missing: true };

  const text = await new Response(result.stream).text();
  const data = JSON.parse(text);
  return {
    data: Array.isArray(data) ? data : [],
    storage: 'blob',
    etag: result.blob && result.blob.etag ? result.blob.etag : null
  };
}

async function writeSales(sales, state = null) {
  if ((state && state.storage === 'github') || (!state && hasGitHubJsonStore())) {
    const currentState = state || await readGitHubJson(SALES_PATH, []);
    await writeGitHubJson(SALES_PATH, sales, currentState.sha || null, `Update ${SALES_PATH}`);
    return;
  }

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
    orderId: saleInput.orderId || '',
    notes: saleInput.notes || '',
    status: saleInput.status || 'completed',
    refundedAt: saleInput.refundedAt || '',
    refundId: saleInput.refundId || '',
    refundAmount: Number(saleInput.refundAmount) || 0,
    isTest: !!saleInput.isTest
  };
}

async function appendSale(saleInput, options = {}) {
  const saleRecord = buildSaleRecord(saleInput);
  const state = await readSalesState();
  let sales = state.data;

  if (saleRecord.stripePaymentId) {
    const existingSale = sales.find((sale) => sale.stripePaymentId === saleRecord.stripePaymentId);
    if (existingSale) {
      return { sale: existingSale, duplicate: true };
    }
  }

  if (saleRecord.orderId) {
    const existingSale = sales.find((sale) => sale.orderId === saleRecord.orderId);
    if (existingSale) {
      return { sale: existingSale, duplicate: true };
    }
  }

  if (saleRecord.source === 'stripe' && !saleRecord.isTest && options.serverIsLive !== false && sales.some((sale) => sale.isTest)) {
    sales = sales.filter((sale) => !sale.isTest);
  }

  sales.push(saleRecord);
  await writeSales(sales, state);
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
    orderId: paymentIntent.metadata?.order_id || overrides.orderId || '',
    notes: overrides.notes || '',
    status: 'completed',
    isTest
  };
}

async function markSaleRefunded({ stripePaymentId, orderId, refundId, refundAmount }) {
  const state = await readSalesState();
  const sales = state.data;
  const saleIndex = sales.findIndex((sale) =>
    (stripePaymentId && sale.stripePaymentId === stripePaymentId) ||
    (orderId && sale.orderId === orderId)
  );

  if (saleIndex < 0) {
    return { updated: false };
  }

  const sale = sales[saleIndex];
  const amount = Number(sale.amount) || 0;
  sales[saleIndex] = {
    ...sale,
    status: 'refunded',
    refundedAt: new Date().toISOString(),
    refundId: refundId || sale.refundId || '',
    refundAmount: Math.round((Number(refundAmount) || amount) * 100) / 100,
    commission: 0
  };

  await writeSales(sales, state);
  return { updated: true, sale: sales[saleIndex] };
}

module.exports = {
  appendSale,
  getCommissionRate,
  markSaleRefunded,
  readSales,
  saleInputFromPaymentIntent,
  writeSales
};
