const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}

function futureBusinessDate() {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 3);
  while (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

test('bookings endpoint preserves totals and supports idempotent payment, booking, and pending-refund retries', async () => {
  const originalLoad = Module._load;
  const originalEnv = {
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    GITHUB_DATA_REPO: process.env.GITHUB_DATA_REPO,
    GITHUB_DATA_TOKEN: process.env.GITHUB_DATA_TOKEN,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_SECRET_KEY_TEST: process.env.STRIPE_SECRET_KEY_TEST
  };

  class MockBlobPreconditionFailedError extends Error {}
  const blobs = new Map();
  const blobWrites = [];
  let etagSequence = 0;
  const blobMock = {
    BlobPreconditionFailedError: MockBlobPreconditionFailedError,
    get: async (pathname) => {
      const entry = blobs.get(pathname);
      if (!entry) return null;
      return {
        stream: new Blob([entry.text]).stream(),
        blob: { etag: entry.etag }
      };
    },
    put: async (pathname, body, options) => {
      const current = blobs.get(pathname);
      if (options.ifMatch && (!current || current.etag !== options.ifMatch)) {
        throw new MockBlobPreconditionFailedError('etag mismatch');
      }
      const entry = { text: String(body), etag: `etag-${++etagSequence}` };
      blobs.set(pathname, entry);
      blobWrites.push({ pathname, options });
      return { pathname };
    }
  };

  const stripeState = {
    intent: null,
    refundStatus: 'pending',
    refundCreateCalls: 0,
    refundRetrieveCalls: 0,
    refundIdempotencyKeys: []
  };
  const stripeMock = () => ({
    paymentIntents: {
      retrieve: async (paymentIntentId) => {
        assert.equal(paymentIntentId, stripeState.intent.id);
        return { ...stripeState.intent, metadata: { ...stripeState.intent.metadata } };
      }
    },
    refunds: {
      create: async ({ payment_intent: paymentIntentId }, options) => {
        stripeState.refundCreateCalls += 1;
        stripeState.refundIdempotencyKeys.push(options.idempotencyKey);
        return {
          id: 're_123456789',
          payment_intent: paymentIntentId,
          amount: stripeState.intent.amount_received,
          status: stripeState.refundStatus
        };
      },
      retrieve: async (refundId) => {
        stripeState.refundRetrieveCalls += 1;
        assert.equal(refundId, 're_123456789');
        return {
          id: refundId,
          payment_intent: stripeState.intent.id,
          amount: stripeState.intent.amount_received,
          status: stripeState.refundStatus
        };
      }
    }
  });

  try {
    process.env.BLOB_READ_WRITE_TOKEN = 'mock-blob-token';
    delete process.env.GITHUB_DATA_REPO;
    delete process.env.GITHUB_DATA_TOKEN;
    process.env.STRIPE_SECRET_KEY = 'sk_live_mock';
    delete process.env.STRIPE_SECRET_KEY_TEST;

    Module._load = function mockedLoad(request, parent, isMain) {
      if (request === '@vercel/blob') return blobMock;
      if (request === 'stripe') return stripeMock;
      return originalLoad.call(this, request, parent, isMain);
    };

    for (const modulePath of [
      '../api/bookings',
      '../lib/orders',
      '../lib/sales',
      '../lib/github-json-store'
    ]) {
      delete require.cache[require.resolve(modulePath)];
    }
    const handler = require('../api/bookings');
    const { getServiceCatalog } = require('../lib/pricing');
    const service = getServiceCatalog()[0];
    assert.ok(service, 'pricing fixture should expose at least one service');

    async function call(body, headers = {}) {
      const res = makeResponse();
      await handler({ method: 'POST', body, headers }, res);
      return res;
    }

    const unauthenticatedManagerRead = await call({ action: 'list-bookings' });
    assert.equal(unauthenticatedManagerRead.statusCode, 401);

    const cashCreate = await call({
      action: 'create-order',
      paymentMethod: 'cash',
      serviceIds: [service.id],
      amount: 1,
      paymentTermsAccepted: true,
      customer: {
        name: 'Cash Customer',
        email: 'cash@example.com',
        phone: '555-0100',
        vehicle: 'Cash Car'
      }
    });
    assert.equal(cashCreate.statusCode, 200);
    assert.equal(cashCreate.body.order.total, service.price, 'server pricing must override client totals');
    assert.equal(cashCreate.body.order.paymentStatus, 'cash_due_on_site');

    const cashRead = await call({
      action: 'get-order',
      orderId: cashCreate.body.order.id,
      token: cashCreate.body.order.publicToken
    });
    assert.equal(cashRead.statusCode, 404, 'public serialization must not reveal the order token');

    const storedCashOrder = JSON.parse(blobs.get('orders-data.json').text)
      .find((entry) => entry.id === cashCreate.body.order.id);
    const cashReadWithToken = await call({
      action: 'get-order',
      orderId: storedCashOrder.id,
      token: storedCashOrder.publicToken
    });
    assert.equal(cashReadWithToken.statusCode, 200);
    assert.equal(cashReadWithToken.body.order.customer.email, 'cash@example.com');

    const cardCreate = await call({
      action: 'create-order',
      paymentMethod: 'card',
      serviceIds: [service.id],
      amount: 1,
      paymentTermsAccepted: true,
      customer: {
        name: 'Card Customer',
        email: 'card@example.com',
        phone: '555-0101',
        vehicle: 'Card Car'
      }
    });
    assert.equal(cardCreate.statusCode, 200);
    assert.equal(cardCreate.body.order.total, service.price);
    const storedCardOrder = JSON.parse(blobs.get('orders-data.json').text)
      .find((entry) => entry.id === cardCreate.body.order.id);

    stripeState.intent = {
      id: 'pi_123456789',
      object: 'payment_intent',
      status: 'succeeded',
      amount: Math.round(service.price * 100),
      amount_received: Math.round(service.price * 100),
      currency: 'usd',
      livemode: true,
      metadata: { order_id: 'ORD-wrong-order' },
      receipt_email: 'card@example.com'
    };
    const originalConsoleError = console.error;
    let wrongOrderConfirmation;
    try {
      console.error = () => {};
      wrongOrderConfirmation = await call({
        action: 'confirm-card-order',
        orderId: storedCardOrder.id,
        token: storedCardOrder.publicToken,
        paymentIntentId: stripeState.intent.id
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(wrongOrderConfirmation.statusCode, 400);

    stripeState.intent.metadata.order_id = storedCardOrder.id;
    const confirmations = await Promise.all([0, 1].map(() => call({
      action: 'confirm-card-order',
      orderId: storedCardOrder.id,
      token: storedCardOrder.publicToken,
      paymentIntentId: stripeState.intent.id
    })));
    assert.ok(confirmations.every((response) => response.statusCode === 200));
    assert.deepEqual(
      confirmations.map((response) => response.body.alreadyConfirmed).sort(),
      [false, true],
      'concurrent confirmation should transition once and treat the other call as a retry'
    );
    const confirmation = confirmations[0];
    assert.equal(confirmation.body.order.paymentStatus, 'paid');

    const bookingDate = futureBusinessDate();
    const slots = await call({
      action: 'get-slots',
      date: bookingDate,
      bookingType: 'customer',
      durationMinutes: confirmation.body.order.durationMinutes
    });
    assert.equal(slots.statusCode, 200);
    assert.ok(slots.body.slots.length > 0);

    const scheduled = await call({
      action: 'schedule-paid-order',
      orderId: storedCardOrder.id,
      token: storedCardOrder.publicToken,
      date: bookingDate,
      time: slots.body.slots[0].time,
      phone: '555-0101',
      vehicle: 'Card Car'
    });
    assert.equal(scheduled.statusCode, 200);
    assert.equal(scheduled.body.order.status, 'booked');

    const pendingCancellation = await call({
      action: 'cancel-public-booking',
      orderId: storedCardOrder.id,
      token: storedCardOrder.publicToken
    });
    assert.equal(pendingCancellation.statusCode, 200);
    assert.equal(pendingCancellation.body.refundPending, true);
    assert.equal(pendingCancellation.body.order.paymentStatus, 'refund_pending');
    assert.equal(stripeState.refundCreateCalls, 1);

    stripeState.refundStatus = 'succeeded';
    const completedCancellation = await call({
      action: 'cancel-public-booking',
      orderId: storedCardOrder.id,
      token: storedCardOrder.publicToken
    });
    assert.equal(completedCancellation.statusCode, 200);
    assert.equal(completedCancellation.body.alreadyCancelled, true);
    assert.equal(completedCancellation.body.refundPending, false);
    assert.equal(completedCancellation.body.order.paymentStatus, 'refunded');
    assert.equal(stripeState.refundCreateCalls, 1);
    assert.equal(stripeState.refundRetrieveCalls, 1);

    const finalRetry = await call({
      action: 'cancel-public-booking',
      orderId: storedCardOrder.id,
      token: storedCardOrder.publicToken
    });
    assert.equal(finalRetry.statusCode, 200);
    assert.equal(finalRetry.body.alreadyCancelled, true);
    assert.equal(stripeState.refundCreateCalls, 1);
    assert.equal(stripeState.refundRetrieveCalls, 1);

    assert.ok(blobWrites.length > 0);
    assert.ok(blobWrites.every((entry) => entry.options.access === 'private'));
  } finally {
    Module._load = originalLoad;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
