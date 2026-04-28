const crypto = require('crypto');
const { BlobPreconditionFailedError, get, put } = require('@vercel/blob');

const ORDERS_PATH = 'orders-data.json';
const JSON_CONTENT_TYPE = 'application/json';
const JSON_BLOB_MAX_ATTEMPTS = 3;

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function isBlobNotFoundError(error) {
  if (!error || typeof error !== 'object') return false;

  return (
    error.name === 'BlobNotFoundError' ||
    error.code === 'BlobNotFoundError' ||
    error.status === 404 ||
    error.statusCode === 404 ||
    (typeof error.message === 'string' && error.message.includes('does not exist'))
  );
}

async function readJsonBlob(path, fallbackValue, token) {
  try {
    const blobResult = await get(path, {
      access: 'public',
      token,
      useCache: false
    });

    if (!blobResult) {
      return {
        data: cloneJson(fallbackValue),
        etag: null
      };
    }

    const text = await new Response(blobResult.stream).text();

    return {
      data: JSON.parse(text),
      etag: blobResult.blob && blobResult.blob.etag ? blobResult.blob.etag : null
    };
  } catch (error) {
    if (isBlobNotFoundError(error)) {
      return {
        data: cloneJson(fallbackValue),
        etag: null
      };
    }

    const readError = new Error('Checkout storage is temporarily unavailable. Please try again.');
    readError.statusCode = 503;
    readError.code = 'ORDER_STORAGE_READ_FAILED';
    readError.storagePath = path;
    readError.storageDetail = error && error.message ? error.message : 'blob read failed';
    throw readError;
  }
}

async function writeJsonBlob(path, data, etag, token) {
  const options = {
    access: 'public',
    contentType: JSON_CONTENT_TYPE,
    addRandomSuffix: false,
    allowOverwrite: true,
    token
  };

  if (etag) {
    options.ifMatch = etag;
  }

  await put(path, JSON.stringify(data), options);
}

async function updateSingletonJsonBlob({ read, write, mutate, errorMessage }) {
  for (let attempt = 0; attempt < JSON_BLOB_MAX_ATTEMPTS; attempt += 1) {
    const { data, etag } = await read();
    const nextData = await mutate(cloneJson(data));

    try {
      await write(nextData, etag);
      return nextData;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(errorMessage);
}

function normalizeOrder(order) {
  const nowIso = new Date().toISOString();
  const services = Array.isArray(order && order.services) ? order.services : [];
  const managerFees = Array.isArray(order && order.managerFees) ? order.managerFees : [];
  const subtotal = Number(order && order.subtotal);
  const managerFeeTotal = managerFees.reduce((sum, fee) => sum + (Number(fee.amount) || 0), 0);
  const total = Number(order && order.total);

  return {
    ...(order && typeof order === 'object' ? order : {}),
    id: typeof (order && order.id) === 'string' ? order.id : generateOrderId(),
    publicToken: typeof (order && order.publicToken) === 'string' ? order.publicToken : generatePublicToken(),
    status: typeof (order && order.status) === 'string' ? order.status : 'draft',
    paymentStatus:
      typeof (order && order.paymentStatus) === 'string'
        ? order.paymentStatus
        : 'unpaid',
    paymentMethod:
      typeof (order && order.paymentMethod) === 'string'
        ? order.paymentMethod
        : 'card',
    customer: order && order.customer && typeof order.customer === 'object' ? order.customer : {},
    services,
    managerFees,
    subtotal: Number.isFinite(subtotal) ? Math.round(subtotal * 100) / 100 : 0,
    managerFeeTotal: Math.round(managerFeeTotal * 100) / 100,
    total: Number.isFinite(total) ? Math.round(total * 100) / 100 : Math.round((subtotal + managerFeeTotal) * 100) / 100,
    durationMinutes:
      Number.isInteger(order && order.durationMinutes) && order.durationMinutes > 0
        ? order.durationMinutes
        : services.reduce((sum, service) => sum + (Number(service.durationMinutes) || 0), 0),
    createdAt: typeof (order && order.createdAt) === 'string' ? order.createdAt : nowIso,
    updatedAt: typeof (order && order.updatedAt) === 'string' ? order.updatedAt : nowIso
  };
}

async function readOrders() {
  const { data, etag } = await readJsonBlob(ORDERS_PATH, [], getBlobToken());
  const orders = Array.isArray(data) ? data.map(normalizeOrder) : [];
  return {
    data: sortOrders(orders),
    etag
  };
}

async function writeOrders(orders, etag) {
  await writeJsonBlob(ORDERS_PATH, sortOrders(orders.map(normalizeOrder)), etag, getBlobToken());
}

async function updateOrders(mutate, errorMessage = 'Could not update the order. Please try again.') {
  return updateSingletonJsonBlob({
    read: readOrders,
    write: writeOrders,
    errorMessage,
    mutate
  });
}

function generateOrderId() {
  return `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
}

function generatePublicToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function generateCashVerificationCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function findOrderByCredentials(orders, orderId, publicToken) {
  const normalizedOrderId = typeof orderId === 'string' ? orderId.trim() : '';
  const normalizedToken = typeof publicToken === 'string' ? publicToken.trim() : '';

  if (!normalizedOrderId || !normalizedToken) return null;

  return orders.find((order) => order.id === normalizedOrderId && order.publicToken === normalizedToken) || null;
}

function serializeOrderForPublic(order) {
  const normalizedOrder = normalizeOrder(order);
  return {
    id: normalizedOrder.id,
    status: normalizedOrder.status,
    paymentStatus: normalizedOrder.paymentStatus,
    paymentMethod: normalizedOrder.paymentMethod,
    customer: normalizedOrder.customer,
    vehicle: normalizedOrder.vehicle || '',
    services: normalizedOrder.services,
    serviceSummary: normalizedOrder.serviceSummary || normalizedOrder.services.map((service) => service.name).join(' + '),
    subtotal: normalizedOrder.subtotal,
    managerFees: normalizedOrder.managerFees,
    managerFeeTotal: normalizedOrder.managerFeeTotal,
    total: normalizedOrder.total,
    durationMinutes: normalizedOrder.durationMinutes,
    cashVerificationCode: normalizedOrder.cashVerificationCode || null,
    bookingId: normalizedOrder.bookingId || null,
    bookingDate: normalizedOrder.bookingDate || null,
    bookingTime: normalizedOrder.bookingTime || null,
    cancellation: normalizedOrder.cancellation || null,
    createdAt: normalizedOrder.createdAt,
    updatedAt: normalizedOrder.updatedAt
  };
}

function sortOrders(orders) {
  return [...orders].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

module.exports = {
  findOrderByCredentials,
  generateCashVerificationCode,
  generateOrderId,
  generatePublicToken,
  normalizeOrder,
  readOrders,
  serializeOrderForPublic,
  updateOrders,
  writeOrders
};
