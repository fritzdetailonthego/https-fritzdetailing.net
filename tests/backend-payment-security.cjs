const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const projectRoot = path.resolve(__dirname, '..');
const {
  createPaymentIntentIdempotencyKey,
  createRefundIdempotencyKey,
  validatePaymentIntentForOrder,
  validateStripeSalePayment
} = require('../lib/payment-integrity');

const order = {
  id: 'ORD-123',
  publicToken: 'public-token-value',
  total: 125,
  subtotal: 125
};

function completedIntent(overrides = {}) {
  return {
    id: 'pi_123456789',
    status: 'succeeded',
    amount: 12500,
    amount_received: 12500,
    currency: 'usd',
    livemode: false,
    metadata: { order_id: order.id },
    ...overrides
  };
}

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

async function withModuleMocks(mocks, load, run) {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const loaded = load();
    return await run(loaded);
  } finally {
    Module._load = originalLoad;
  }
}

test('PaymentIntent and refund idempotency keys are deterministic and scoped', () => {
  const first = createPaymentIntentIdempotencyKey(order, true);
  assert.equal(first, createPaymentIntentIdempotencyKey({ ...order }, true));
  assert.notEqual(first, createPaymentIntentIdempotencyKey({ ...order, total: 126 }, true));
  assert.notEqual(first, createPaymentIntentIdempotencyKey(order, false));
  assert.notEqual(
    createRefundIdempotencyKey(order, 'pi_123456789'),
    createRefundIdempotencyKey(order, 'pi_987654321')
  );
  assert.ok(first.length < 255);
  assert.equal(first.includes(order.publicToken), false);
});

test('order payment validation rejects wrong status, currency, amount, order, and mode', () => {
  assert.deepEqual(validatePaymentIntentForOrder(completedIntent(), order, { isTest: true }), {
    amount: 12500,
    currency: 'usd'
  });

  for (const [intent, message] of [
    [completedIntent({ status: 'processing' }), /not been confirmed/],
    [completedIntent({ currency: 'eur' }), /currency/],
    [completedIntent({ amount_received: 12499 }), /amount/],
    [completedIntent({ amount_received: undefined }), /amount/],
    [completedIntent({ metadata: {} }), /does not match/],
    [completedIntent({ livemode: undefined }), /mode/],
    [completedIntent({ livemode: true }), /mode/]
  ]) {
    assert.throws(() => validatePaymentIntentForOrder(intent, order, { isTest: true }), message);
  }
});

test('legacy Stripe sale validation requires a completed USD payment with the exact amount', () => {
  assert.equal(validateStripeSalePayment(completedIntent(), 125), 12500);
  assert.throws(() => validateStripeSalePayment(completedIntent({ currency: 'cad' }), 125), /USD/);
  assert.throws(() => validateStripeSalePayment(completedIntent({ amount_received: 10000 }), 125), /amount/);
});

test('invalid commission configuration falls back to the bounded default', () => {
  const original = process.env.COMMISSION_RATE;
  const { getCommissionRate } = require('../lib/sales');
  try {
    process.env.COMMISSION_RATE = 'not-a-number';
    assert.equal(getCommissionRate(), 0.10);
    process.env.COMMISSION_RATE = '1.5';
    assert.equal(getCommissionRate(), 0.10);
    process.env.COMMISSION_RATE = '0.125';
    assert.equal(getCommissionRate(), 0.125);
  } finally {
    if (original === undefined) delete process.env.COMMISSION_RATE;
    else process.env.COMMISSION_RATE = original;
  }
});

test('create-payment-intent sends a stable Stripe idempotency key without charging', async () => {
  const calls = [];
  const stripeMock = () => ({
    paymentIntents: {
      create: async (payload, options) => {
        calls.push({ payload, options });
        return { id: 'pi_123456789', client_secret: 'pi_secret_mock' };
      }
    }
  });
  const ordersMock = {
    findOrderByCredentials: (orders, orderId, token) =>
      orders.find((entry) => entry.id === orderId && entry.publicToken === token) || null,
    readOrders: async () => ({
      data: [{
        ...order,
        paymentMethod: 'card',
        paymentStatus: 'requires_payment',
        status: 'requires_payment',
        customer: { name: 'Test Customer', email: 'test@example.com' },
        services: [{ name: 'Detail' }]
      }]
    })
  };
  const stripeModeMock = {
    getStripePaymentConfig: () => ({
      secretKey: 'sk_test_mock',
      secretLooksValid: true,
      publishableLooksValid: true,
      testMode: true
    }),
    isStripeAuthenticationError: () => false
  };
  const handlerPath = require.resolve('../api/create-payment-intent');
  delete require.cache[handlerPath];

  await withModuleMocks(
    { stripe: stripeMock, '../lib/orders': ordersMock, '../lib/stripe-mode': stripeModeMock },
    () => require(handlerPath),
    async (handler) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = makeResponse();
        await handler({
          method: 'POST',
          body: { orderId: order.id, token: order.publicToken }
        }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.paymentIntentId, 'pi_123456789');
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
  assert.equal(calls[0].payload.amount, 12500);
  assert.equal(calls[0].payload.currency, 'usd');
  assert.equal(calls[0].payload.metadata.order_id, order.id);
});

test('sensitive runtime stores are private and admin timeline escapes stored ids', () => {
  for (const relativePath of [
    'lib/orders.js',
    'lib/sales.js',
    'api/bookings.js',
    'api/fees.js',
    'api/pricing-revisions.js'
  ]) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.match(source, /access:\s*'private'/, relativePath);
    const putBlocks = source.match(/put\([\s\S]{0,500}?\}\);/g) || [];
    for (const block of putBlocks) assert.doesNotMatch(block, /access:\s*'public'/, relativePath);
  }

  const timeline = fs.readFileSync(path.join(projectRoot, 'public/admin-timeline.js'), 'utf8');
  assert.match(timeline, /data-entry-id="\$\{escapeAttribute\(entry\.id\)\}"/);
});

test('GitHub customer-data store rejects public repositories and caches verified private metadata', async () => {
  const originalFetch = global.fetch;
  const originalRepo = process.env.GITHUB_DATA_REPO;
  const originalToken = process.env.GITHUB_DATA_TOKEN;
  const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const modulePath = require.resolve('../lib/github-json-store');
  try {
    process.env.GITHUB_DATA_REPO = 'owner/customer-data';
    process.env.GITHUB_DATA_TOKEN = 'github-data-token-for-test';

    process.env.BLOB_READ_WRITE_TOKEN = 'second-backend-must-fail';
    global.fetch = async () => { throw new Error('privacy API must not run for invalid dual-store config'); };
    delete require.cache[modulePath];
    let store = require('../lib/github-json-store');
    await assert.rejects(
      () => store.readGitHubJson('orders-data.json', []),
      (error) => error.code === 'GITHUB_JSON_INVALID_REPOSITORY' && error.statusCode === 503
    );
    delete process.env.BLOB_READ_WRITE_TOKEN;

    let calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ private: false }) };
    };
    delete require.cache[modulePath];
    store = require('../lib/github-json-store');
    await assert.rejects(
      () => store.readGitHubJson('orders-data.json', []),
      (error) => error.code === 'GITHUB_JSON_REPOSITORY_NOT_PRIVATE' && error.statusCode === 503
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/repos\/owner\/customer-data$/);

    calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return { ok: true, status: 200, json: async () => ({ private: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    };
    delete require.cache[modulePath];
    store = require('../lib/github-json-store');
    const first = await store.readGitHubJson('orders-data.json', []);
    const second = await store.readGitHubJson('sales-data.json', []);
    assert.equal(first.storage, 'github');
    assert.equal(second.storage, 'github');
    assert.equal(calls.filter((url) => /\/repos\/owner\/customer-data$/.test(url)).length, 1);
    assert.equal(calls.length, 3, 'one privacy check and two content reads expected');
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
    if (originalRepo === undefined) delete process.env.GITHUB_DATA_REPO;
    else process.env.GITHUB_DATA_REPO = originalRepo;
    if (originalToken === undefined) delete process.env.GITHUB_DATA_TOKEN;
    else process.env.GITHUB_DATA_TOKEN = originalToken;
    if (originalBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
  }
});
