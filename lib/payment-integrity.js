const crypto = require('crypto');

const DEFAULT_CURRENCY = 'usd';

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getExpectedAmountCents(order) {
  const amount = Math.round(Number(order && order.total) * 100);
  if (!Number.isInteger(amount) || amount < 100) {
    throw createHttpError(400, 'Invalid order total.');
  }
  return amount;
}

function getPaidAmountCents(paymentIntent) {
  const amountReceived = Number(paymentIntent && paymentIntent.amount_received);
  if (Number.isInteger(amountReceived) && amountReceived > 0) return amountReceived;
  return null;
}

function createPaymentIntentIdempotencyKey(order, testMode) {
  const orderId = typeof (order && order.id) === 'string' ? order.id : '';
  const publicToken = typeof (order && order.publicToken) === 'string' ? order.publicToken : '';
  const amount = getExpectedAmountCents(order);
  if (!orderId || !publicToken) {
    throw createHttpError(400, 'Invalid order credentials.');
  }

  const digest = crypto
    .createHash('sha256')
    .update(`${orderId}\u0000${publicToken}\u0000${amount}\u0000${DEFAULT_CURRENCY}\u0000${testMode ? 'test' : 'live'}`)
    .digest('hex');
  return `fritz-order-${digest}`;
}

function createRefundIdempotencyKey(order, paymentIntentId) {
  const orderId = typeof (order && order.id) === 'string' ? order.id : '';
  const publicToken = typeof (order && order.publicToken) === 'string' ? order.publicToken : '';
  if (!orderId || !publicToken || typeof paymentIntentId !== 'string' || !paymentIntentId) {
    throw createHttpError(400, 'Invalid refund credentials.');
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${orderId}\u0000${publicToken}\u0000${paymentIntentId}`)
    .digest('hex');
  return `fritz-refund-${digest}`;
}

function validatePaymentIntentForOrder(paymentIntent, order, options = {}) {
  if (!paymentIntent || typeof paymentIntent !== 'object' || typeof paymentIntent.id !== 'string') {
    throw createHttpError(400, 'Stripe returned an invalid payment.');
  }
  if (paymentIntent.status !== 'succeeded') {
    throw createHttpError(409, 'Card payment has not been confirmed.');
  }

  const currency = String(paymentIntent.currency || '').toLowerCase();
  const expectedCurrency = String(options.currency || DEFAULT_CURRENCY).toLowerCase();
  if (currency !== expectedCurrency) {
    throw createHttpError(400, 'Payment currency does not match this order.');
  }

  const suppliedExpectedAmount = Number(options.expectedAmountCents);
  const expectedAmount = Number.isInteger(suppliedExpectedAmount) && suppliedExpectedAmount > 0
    ? suppliedExpectedAmount
    : getExpectedAmountCents(order);
  if (getPaidAmountCents(paymentIntent) !== expectedAmount) {
    throw createHttpError(400, 'Payment amount does not match the order total.');
  }

  const orderId = typeof (order && order.id) === 'string' ? order.id : '';
  if (!orderId || paymentIntent.metadata?.order_id !== orderId) {
    throw createHttpError(400, 'Payment does not match this order.');
  }

  if (typeof options.isTest === 'boolean') {
    if (
      typeof paymentIntent.livemode !== 'boolean' ||
      paymentIntent.livemode !== !options.isTest
    ) {
      throw createHttpError(400, 'Payment mode does not match this order.');
    }
  }

  return {
    amount: expectedAmount,
    currency: expectedCurrency
  };
}

function validateStripeSalePayment(paymentIntent, expectedAmountDollars) {
  if (!paymentIntent || typeof paymentIntent !== 'object' || typeof paymentIntent.id !== 'string') {
    throw createHttpError(400, 'Stripe returned an invalid payment.');
  }
  if (paymentIntent.status !== 'succeeded') {
    throw createHttpError(409, 'Stripe payment has not succeeded.');
  }
  if (String(paymentIntent.currency || '').toLowerCase() !== DEFAULT_CURRENCY) {
    throw createHttpError(400, 'Stripe payment currency must be USD.');
  }

  const expectedAmount = Math.round(Number(expectedAmountDollars) * 100);
  if (!Number.isInteger(expectedAmount) || expectedAmount < 1 || getPaidAmountCents(paymentIntent) !== expectedAmount) {
    throw createHttpError(400, 'Sale amount does not match the Stripe payment.');
  }
  return expectedAmount;
}

module.exports = {
  createPaymentIntentIdempotencyKey,
  createRefundIdempotencyKey,
  getExpectedAmountCents,
  getPaidAmountCents,
  validatePaymentIntentForOrder,
  validateStripeSalePayment
};
