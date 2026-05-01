const LIVE_PUBLISHABLE_KEY = 'pk_live_51TCOBz1xKrhk2iIWpqK6J28lU8BxVrlEpC0mIbR4ZkLA3kaJDGcJHdH5UY1Aeqrnk8K5XtSVTtZZAaKPjp2Gxq6700yZHMpxcl';
const HEALTH_CACHE_MS = 5 * 60 * 1000;

let stripeHealthCache = null;

function cleanEnv(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function looksLikeStripeKey(value, prefix) {
  return (
    typeof value === 'string' &&
    value.startsWith(prefix) &&
    value.length > prefix.length + 20 &&
    !/[\s*]/.test(value)
  );
}

function isStripeAuthenticationError(error) {
  return (
    error &&
    (error.code === 'STRIPE_AUTHENTICATION_FAILED' ||
      /invalid api key|no api key|api key provided|authentication/i.test(error.message ? error.message : ''))
  );
}

function getStripePaymentConfig(siteConfig = {}) {
  const payments = siteConfig && typeof siteConfig.payments === 'object' ? siteConfig.payments : {};
  const testMode = siteConfig.stripeTestMode === true;
  const secretKey = cleanEnv(testMode ? process.env.STRIPE_SECRET_KEY_TEST : process.env.STRIPE_SECRET_KEY);
  const publishableKey = cleanEnv(
    testMode
      ? process.env.STRIPE_PUBLISHABLE_KEY_TEST
      : (process.env.STRIPE_PUBLISHABLE_KEY || LIVE_PUBLISHABLE_KEY)
  );
  const expectedSecretPrefix = testMode ? 'sk_test_' : 'sk_live_';
  const expectedPublishablePrefix = testMode ? 'pk_test_' : 'pk_live_';

  return {
    testMode,
    cardEnabled: payments.card !== false,
    secretKey,
    publishableKey,
    secretLooksValid: looksLikeStripeKey(secretKey, expectedSecretPrefix),
    publishableLooksValid: looksLikeStripeKey(publishableKey, expectedPublishablePrefix),
    hasTestKeys: !!(cleanEnv(process.env.STRIPE_SECRET_KEY_TEST) && cleanEnv(process.env.STRIPE_PUBLISHABLE_KEY_TEST))
  };
}

async function getStripeModeStatus(siteConfig = {}) {
  const cfg = getStripePaymentConfig(siteConfig);

  if (!cfg.cardEnabled) {
    return {
      testMode: cfg.testMode,
      publishableKey: null,
      hasTestKeys: cfg.hasTestKeys,
      cardReady: false,
      cardStatus: 'disabled',
      cardMessage: 'Card payment is turned off.'
    };
  }

  if (!cfg.secretKey || !cfg.publishableKey) {
    return {
      testMode: cfg.testMode,
      publishableKey: null,
      hasTestKeys: cfg.hasTestKeys,
      cardReady: false,
      cardStatus: 'missing_keys',
      cardMessage: 'Card payment is not configured. Choose another payment method or call Fritz.'
    };
  }

  if (!cfg.secretLooksValid || !cfg.publishableLooksValid) {
    return {
      testMode: cfg.testMode,
      publishableKey: null,
      hasTestKeys: cfg.hasTestKeys,
      cardReady: false,
      cardStatus: 'invalid_key_shape',
      cardMessage: 'Card payment is not configured correctly. Choose another payment method or call Fritz.'
    };
  }

  const cacheKey = `${cfg.testMode}:${cfg.secretKey}:${cfg.publishableKey}`;
  if (
    stripeHealthCache &&
    stripeHealthCache.cacheKey === cacheKey &&
    Date.now() - stripeHealthCache.checkedAt < HEALTH_CACHE_MS
  ) {
    return stripeHealthCache.result;
  }

  let result;
  try {
    const response = await fetch('https://api.stripe.com/v1/balance', {
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`
      },
      cache: 'no-store'
    });
    if (response.status === 401 || response.status === 403) {
      const authError = new Error('Stripe authentication failed.');
      authError.code = 'STRIPE_AUTHENTICATION_FAILED';
      throw authError;
    }
    if (!response.ok) {
      throw new Error(`Stripe health check failed (${response.status}).`);
    }
    result = {
      testMode: cfg.testMode,
      publishableKey: cfg.publishableKey,
      hasTestKeys: cfg.hasTestKeys,
      cardReady: true,
      cardStatus: 'ready',
      cardMessage: ''
    };
  } catch (error) {
    if (isStripeAuthenticationError(error)) {
      result = {
        testMode: cfg.testMode,
        publishableKey: null,
        hasTestKeys: cfg.hasTestKeys,
        cardReady: false,
        cardStatus: 'authentication_failed',
        cardMessage: 'Card payment is not configured correctly. Choose another payment method or call Fritz.'
      };
    } else {
      result = {
        testMode: cfg.testMode,
        publishableKey: cfg.publishableKey,
        hasTestKeys: cfg.hasTestKeys,
        cardReady: true,
        cardStatus: 'unverified',
        cardMessage: ''
      };
    }
  }

  stripeHealthCache = {
    cacheKey,
    checkedAt: Date.now(),
    result
  };

  return result;
}

module.exports = {
  getStripePaymentConfig,
  getStripeModeStatus,
  isStripeAuthenticationError
};
