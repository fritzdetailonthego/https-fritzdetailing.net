const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { put, get, BlobPreconditionFailedError } = require('@vercel/blob');
const packageJson = require('../package.json');
const {
  appendSale,
  markSaleRefunded,
  saleInputFromPaymentIntent
} = require('../lib/sales');
const {
  findOrderByCredentials,
  generateCashVerificationCode,
  generateOrderId,
  generatePublicToken,
  normalizeOrder,
  readOrders,
  serializeOrderForPublic,
  updateOrders,
  writeOrders
} = require('../lib/orders');
const { validateOrderServices } = require('../lib/pricing');

const BOOKINGS_PATH = 'bookings-data.json';
const AVAILABILITY_PATH = 'availability-config.json';
const MANAGER_DEVICES_PATH = 'manager-devices.json';
const SUPPORT_TICKETS_PATH = 'manager-support-tickets.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const MANAGER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const JSON_CONTENT_TYPE = 'application/json';
const JSON_BLOB_MAX_ATTEMPTS = 3;
const DEFAULT_BLOCKED_SLOT_DURATION_MINUTES = 30;
const MAX_BLOCK_DURATION_MINUTES = 24 * 60;
const RECURRING_PATTERNS = new Set(['daily', 'weekdays', 'weekends', 'weekly', 'custom']);
const SUPPORT_TICKET_TYPES = new Set(['error', 'fix', 'question', 'other']);
const SUPPORT_TICKET_PRIORITIES = new Set(['low', 'normal', 'urgent']);
const SUPPORT_TICKET_STATUSES = new Set(['open', 'in-progress', 'resolved', 'closed']);
const SUPPORT_TICKETS_MAX = 200;
const CUSTOMER_PAYMENT_METHODS = new Set(['card', 'cash']);
const CANCELLATION_FREE_WINDOW_MS = 24 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = 'America/New_York';
const FRITZ_PHONE_DISPLAY = '(276) 247-0921';

function buildDefaultAvailability() {
  return {
    weeklyHours: {
      mon: { open: true, start: '08:00', end: '18:00' },
      tue: { open: true, start: '08:00', end: '18:00' },
      wed: { open: true, start: '08:00', end: '18:00' },
      thu: { open: true, start: '08:00', end: '18:00' },
      fri: { open: true, start: '08:00', end: '18:00' },
      sat: { open: true, start: '09:00', end: '17:00' },
      sun: { open: false, start: '09:00', end: '17:00' }
    },
    slotDuration: 120,
    customerBlockMinutes: 120,
    privateBlockMinutes: 120,
    travelBufferMinutes: 30,
    blockedDates: [],
    blockedSlots: [],
    recurringBlocks: [],
    maxAdvanceDays: 30
  };
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

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function getManagerSessionSecret() {
  return process.env.MANAGER_SESSION_SECRET || '';
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getManagerTokenFromRequest(req, body) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  if (body && typeof body.managerToken === 'string') return body.managerToken;
  if (body && typeof body.token === 'string') return body.token;
  return '';
}

function verifyManagerToken(token) {
  if (!token) return null;
  const secret = getManagerSessionSecret();
  if (!secret) return null;

  const [encodedPayload, signature] = String(token).split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = base64UrlEncode(
    crypto
      .createHmac('sha256', secret)
      .update(encodedPayload)
      .digest()
  );

  if (!timingSafeEqualString(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.role !== 'manager') return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= nowSeconds) return null;
    if (!Number.isInteger(payload.iat) || payload.iat > nowSeconds + 60) return null;
    if (payload.exp - payload.iat > MANAGER_TOKEN_TTL_SECONDS + 60) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function normalizeAvailability(availability) {
  const defaults = buildDefaultAvailability();
  const weeklyHours = { ...defaults.weeklyHours, ...((availability && availability.weeklyHours) || {}) };
  const slotDuration =
    Number.isInteger(availability && availability.slotDuration) && availability.slotDuration > 0
      ? availability.slotDuration
      : defaults.slotDuration;
  const customerBlockMinutes =
    Number.isInteger(availability && availability.customerBlockMinutes) && availability.customerBlockMinutes > 0
      ? availability.customerBlockMinutes
      : defaults.customerBlockMinutes;
  const privateBlockMinutes =
    Number.isInteger(availability && availability.privateBlockMinutes) && availability.privateBlockMinutes > 0
      ? availability.privateBlockMinutes
      : defaults.privateBlockMinutes;
  const travelBufferMinutes =
    Number.isInteger(availability && availability.travelBufferMinutes) && availability.travelBufferMinutes > 0
      ? availability.travelBufferMinutes
      : defaults.travelBufferMinutes;
  const maxAdvanceDays =
    Number.isInteger(availability && availability.maxAdvanceDays) && availability.maxAdvanceDays >= 0
      ? availability.maxAdvanceDays
      : defaults.maxAdvanceDays;

  const normalizedAvailability = {
    ...defaults,
    ...(availability || {}),
    weeklyHours,
    blockedDates: normalizeBlockedDates(availability && availability.blockedDates),
    slotDuration,
    customerBlockMinutes,
    privateBlockMinutes,
    travelBufferMinutes,
    maxAdvanceDays,
    updatedAt: typeof (availability && availability.updatedAt) === 'string' ? availability.updatedAt : null
  };

  normalizedAvailability.blockedSlots = normalizeBlockedSlots(
    availability && availability.blockedSlots,
    normalizedAvailability
  );
  normalizedAvailability.recurringBlocks = normalizeRecurringBlocks(
    availability && availability.recurringBlocks,
    normalizedAvailability
  );

  return normalizedAvailability;
}

function normalizeBookingType(value) {
  return value === 'private' || value === 'travel' ? value : 'customer';
}

function normalizeBookingStatus(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return 'confirmed';
  }

  return value.trim().toLowerCase();
}

function normalizeBlockedDateEntry(entry) {
  if (typeof entry === 'string') {
    return { date: entry };
  }

  if (!entry || typeof entry !== 'object' || typeof entry.date !== 'string') {
    return null;
  }

  return {
    date: entry.date,
    ...(typeof entry.reason === 'string' && entry.reason.trim()
      ? { reason: entry.reason.trim() }
      : {})
  };
}

function normalizeBlockedDates(blockedDates) {
  if (!blockedDates) {
    return [];
  }

  if (Array.isArray(blockedDates)) {
    return blockedDates
      .map(normalizeBlockedDateEntry)
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  if (typeof blockedDates === 'object') {
    return Object.entries(blockedDates)
      .map(([date, value]) => {
        if (typeof value === 'string') {
          return normalizeBlockedDateEntry({
            date,
            reason: value
          });
        }

        return normalizeBlockedDateEntry({
          date,
          ...(value && typeof value === 'object' ? value : {})
        });
      })
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  return [];
}

function isDateBlocked(dateStr, blockedDates) {
  return normalizeBlockedDates(blockedDates).some((entry) => entry.date === dateStr);
}

function upsertBlockedDate(blockedDates, date, reason) {
  const nextBlockedDates = normalizeBlockedDates(blockedDates).filter((entry) => entry.date !== date);
  nextBlockedDates.push({
    date,
    ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {})
  });
  return nextBlockedDates.sort((left, right) => left.date.localeCompare(right.date));
}

function removeBlockedDate(blockedDates, date) {
  return normalizeBlockedDates(blockedDates).filter((entry) => entry.date !== date);
}

function upsertBlockedSlot(blockedSlots, nextEntry, availability) {
  const normalizedEntry = normalizeBlockedSlotEntry(nextEntry, availability);
  if (!normalizedEntry) {
    return normalizeBlockedSlots(blockedSlots, availability);
  }

  const nextBlockedSlots = normalizeBlockedSlots(blockedSlots, availability).filter((blockedSlot) => {
    if (normalizedEntry.id && blockedSlot.id === normalizedEntry.id) {
      return false;
    }

    return !(blockedSlot.date === normalizedEntry.date && blockedSlot.time === normalizedEntry.time);
  });

  nextBlockedSlots.push(normalizedEntry);
  return normalizeBlockedSlots(nextBlockedSlots, availability);
}

function removeBlockedSlot(blockedSlots, { blockId, date, time }, availability) {
  return normalizeBlockedSlots(blockedSlots, availability).filter((blockedSlot) => {
    if (blockId && blockedSlot.id === blockId) {
      return false;
    }

    return !(blockedSlot.date === date && blockedSlot.time === time);
  });
}

function normalizeRecurringPattern(value) {
  if (typeof value !== 'string') {
    return 'weekly';
  }

  const normalizedValue = value.trim().toLowerCase();
  return RECURRING_PATTERNS.has(normalizedValue) ? normalizedValue : 'weekly';
}

function normalizeRecurringCustomDays(customDays, fallbackDate) {
  const nextDays = Array.isArray(customDays)
    ? customDays
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
    : [];

  const uniqueDays = [...new Set(nextDays)].sort((left, right) => left - right);
  if (uniqueDays.length > 0) {
    return uniqueDays;
  }

  const parsedFallbackDate = parseDateValue(fallbackDate);
  return parsedFallbackDate ? [parsedFallbackDate.getUTCDay()] : [];
}

function normalizeRecurringBlockEntry(entry, availability) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const parsedDate = parseDateValue(entry.date);
  const parsedTime = parseTimeValue(entry.time);
  if (!parsedDate || !parsedTime) {
    return null;
  }

  const recurrence = normalizeRecurringPattern(entry.recurrence);
  const durationMinutes = Math.min(
    MAX_BLOCK_DURATION_MINUTES,
    getBlockedSlotDurationMinutes(entry, availability)
  );
  if (!durationMinutes || durationMinutes <= 0) {
    return null;
  }

  const customDays = normalizeRecurringCustomDays(entry.customDays, entry.date);
  const normalizedDate = formatDateValue(parsedDate);
  const parsedEndDate = parseDateValue(entry.endDate);
  const normalizedEndDate =
    parsedEndDate && parsedEndDate.getTime() >= parsedDate.getTime()
      ? formatDateValue(parsedEndDate)
      : undefined;
  const label =
    (typeof entry.label === 'string' && entry.label.trim()) ||
    (typeof entry.reason === 'string' && entry.reason.trim()) ||
    'Recurring Hold';
  const idSource = [normalizedDate, parsedTime.normalized, recurrence, customDays.join('')].join('-');

  return {
    id:
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : `RB-${idSource}`,
    label,
    date: normalizedDate,
    time: parsedTime.normalized,
    endTime: minutesToTimeValue(parsedTime.totalMinutes + durationMinutes),
    durationMinutes,
    recurrence,
    customDays: recurrence === 'custom' ? customDays : [],
    ...(normalizedEndDate ? { endDate: normalizedEndDate } : {}),
    ...(typeof entry.notes === 'string' && entry.notes.trim() ? { notes: entry.notes.trim() } : {}),
    ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {})
  };
}

function normalizeRecurringBlocks(recurringBlocks, availability) {
  if (!Array.isArray(recurringBlocks)) {
    return [];
  }

  return recurringBlocks
    .map((entry) => normalizeRecurringBlockEntry(entry, availability))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.date !== right.date) {
        return left.date.localeCompare(right.date);
      }

      if (left.time !== right.time) {
        return left.time.localeCompare(right.time);
      }

      return left.label.localeCompare(right.label);
    });
}

function upsertRecurringBlock(recurringBlocks, nextEntry, availability) {
  const normalizedEntry = normalizeRecurringBlockEntry(nextEntry, availability);
  if (!normalizedEntry) {
    return normalizeRecurringBlocks(recurringBlocks, availability);
  }

  const nextRecurringBlocks = normalizeRecurringBlocks(recurringBlocks, availability).filter(
    (recurringBlock) => recurringBlock.id !== normalizedEntry.id
  );
  nextRecurringBlocks.push(normalizedEntry);
  return normalizeRecurringBlocks(nextRecurringBlocks, availability);
}

function removeRecurringBlock(recurringBlocks, recurringBlockId, availability) {
  return normalizeRecurringBlocks(recurringBlocks, availability).filter(
    (recurringBlock) => recurringBlock.id !== recurringBlockId
  );
}

function getDefaultDurationMinutes(bookingType, availability) {
  const normalizedType = normalizeBookingType(bookingType);

  if (normalizedType === 'private') {
    return availability.privateBlockMinutes || availability.slotDuration || 120;
  }

  if (normalizedType === 'travel') {
    return availability.travelBufferMinutes || availability.slotDuration || 30;
  }

  return availability.customerBlockMinutes || availability.slotDuration || 120;
}

function normalizeBooking(booking) {
  const parsedFallbackDate = Date.parse(`${booking.date || '1970-01-01'}T${booking.time || '00:00'}:00.000Z`);
  const fallbackUpdatedAt =
    typeof booking.createdAt === 'string'
      ? booking.createdAt
      : new Date(Number.isNaN(parsedFallbackDate) ? 0 : parsedFallbackDate).toISOString();

  return {
    ...booking,
    bookingType: normalizeBookingType(booking.bookingType),
    durationMinutes:
      Number.isInteger(booking.durationMinutes) && booking.durationMinutes > 0
        ? booking.durationMinutes
        : undefined,
    status: normalizeBookingStatus(booking.status),
    updatedAt: typeof booking.updatedAt === 'string' ? booking.updatedAt : fallbackUpdatedAt
  };
}

function sortBookings(bookings) {
  bookings.sort((left, right) => (left.date + left.time).localeCompare(right.date + right.time));
  return bookings;
}

function getLatestSyncAt(bookings, availability, orders = []) {
  const candidates = [];

  for (const booking of bookings) {
    if (typeof booking.updatedAt === 'string') candidates.push(booking.updatedAt);
  }
  for (const order of orders) {
    if (typeof order.updatedAt === 'string') candidates.push(order.updatedAt);
  }
  if (availability && typeof availability.updatedAt === 'string') candidates.push(availability.updatedAt);

  candidates.push(new Date().toISOString());
  return candidates.sort().slice(-1)[0];
}

function parseSyncTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function cleanString(value, maxLength = 240) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'site-config.json'), 'utf8'));
  } catch(e) {
    return {};
  }
}

function normalizePaymentSettings(payments) {
  const pm = payments && typeof payments === 'object' ? payments : {};
  return {
    cash: pm.cash !== false && pm.invoice !== false,
    card: pm.card !== false,
    cashApp: pm.cashApp === true,
    paypal: pm.paypal === true,
    crypto: pm.crypto === true
  };
}

function isCustomerPaymentMethodEnabled(paymentMethod) {
  const payments = normalizePaymentSettings(readConfig().payments);
  return paymentMethod === 'card' ? payments.card !== false : paymentMethod === 'cash' ? payments.cash !== false : false;
}

function getStripeSecretCandidates(preferTestMode) {
  const candidates = [];
  const testKey = process.env.STRIPE_SECRET_KEY_TEST;
  const liveKey = process.env.STRIPE_SECRET_KEY;

  if (preferTestMode && testKey) candidates.push({ key: testKey, isTest: true });
  if (liveKey) candidates.push({ key: liveKey, isTest: false });
  if (!preferTestMode && testKey) candidates.push({ key: testKey, isTest: true });

  return candidates;
}

async function retrieveStripePaymentIntent(paymentIntentId, preferTestMode) {
  if (typeof paymentIntentId !== 'string' || !paymentIntentId.startsWith('pi_')) {
    throw createHttpError(400, 'A valid Stripe payment id is required.');
  }

  const candidates = getStripeSecretCandidates(preferTestMode);
  if (candidates.length === 0) {
    throw createHttpError(500, 'Stripe secret key is not configured.');
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const stripe = require('stripe')(candidate.key);
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return { paymentIntent, isTest: candidate.isTest, stripe };
    } catch (error) {
      lastError = error;
    }
  }

  throw createHttpError(400, lastError?.message || 'Could not verify Stripe payment.');
}

async function refundStripePayment(paymentIntentId, preferTestMode) {
  const { paymentIntent, isTest, stripe } = await retrieveStripePaymentIntent(paymentIntentId, preferTestMode);
  if (paymentIntent.status !== 'succeeded') {
    throw createHttpError(409, 'Only completed card payments can be refunded.');
  }

  const refund = await stripe.refunds.create({
    payment_intent: paymentIntent.id
  });

  return {
    refund,
    isTest,
    amount: (refund.amount || paymentIntent.amount_received || paymentIntent.amount) / 100
  };
}

function buildServiceSummary(services) {
  return Array.isArray(services) && services.length > 0
    ? services.map((service) => service.name).join(' + ')
    : 'Detailing Service';
}

function getOrderBookingUrl(order) {
  return `/book.html?orderId=${encodeURIComponent(order.id)}&token=${encodeURIComponent(order.publicToken)}`;
}

function zonedTimeToUtcMs(dateStr, timeStr, timeZone = BUSINESS_TIME_ZONE) {
  const [year, month, day] = String(dateStr || '').split('-').map((value) => Number(value));
  const [hour, minute] = String(timeStr || '').split(':').map((value) => Number(value));
  if (![year, month, day, hour, minute].every(Number.isFinite)) return NaN;

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcGuess)).map((part) => [part.type, part.value])
  );
  const zonedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = zonedAsUtc - utcGuess;
  return utcGuess - offsetMs;
}

function isInsideCancellationCallWindow(booking, nowMs = Date.now()) {
  const appointmentStartMs = zonedTimeToUtcMs(booking.date, booking.time);
  if (!Number.isFinite(appointmentStartMs)) return true;
  return appointmentStartMs - nowMs <= CANCELLATION_FREE_WINDOW_MS;
}

function normalizeManagerDevice(device) {
  return {
    pushToken: typeof device.pushToken === 'string' ? device.pushToken : '',
    deviceId: typeof device.deviceId === 'string' ? device.deviceId : '',
    platform: typeof device.platform === 'string' ? device.platform : 'unknown',
    deviceName: typeof device.deviceName === 'string' ? device.deviceName : '',
    appVersion: typeof device.appVersion === 'string' ? device.appVersion : '',
    createdAt: typeof device.createdAt === 'string' ? device.createdAt : new Date().toISOString(),
    updatedAt: typeof device.updatedAt === 'string' ? device.updatedAt : new Date().toISOString(),
    lastSeenAt: typeof device.lastSeenAt === 'string' ? device.lastSeenAt : null
  };
}

function isExpoPushToken(value) {
  return typeof value === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(value);
}

function sortManagerDevices(devices) {
  return [...devices].sort((left, right) => {
    const leftKey = left.lastSeenAt || left.updatedAt || left.createdAt || '';
    const rightKey = right.lastSeenAt || right.updatedAt || right.createdAt || '';
    return rightKey.localeCompare(leftKey);
  });
}

function upsertManagerDevice(devices, nextDevice) {
  const normalizedDevice = normalizeManagerDevice(nextDevice);
  const existingIndex = devices.findIndex((device) =>
    (normalizedDevice.pushToken && device.pushToken === normalizedDevice.pushToken) ||
    (normalizedDevice.deviceId && device.deviceId === normalizedDevice.deviceId)
  );

  if (existingIndex >= 0) {
    const existingDevice = devices[existingIndex];
    devices[existingIndex] = normalizeManagerDevice({
      ...existingDevice,
      ...normalizedDevice,
      createdAt: existingDevice.createdAt || normalizedDevice.createdAt
    });
    return devices[existingIndex];
  }

  devices.push(normalizedDevice);
  return normalizedDevice;
}

function serializeManagerDevice(device) {
  const normalizedDevice = normalizeManagerDevice(device);
  return {
    deviceId: normalizedDevice.deviceId || null,
    platform: normalizedDevice.platform,
    deviceName: normalizedDevice.deviceName || null,
    appVersion: normalizedDevice.appVersion || null,
    createdAt: normalizedDevice.createdAt,
    updatedAt: normalizedDevice.updatedAt,
    lastSeenAt: normalizedDevice.lastSeenAt,
    pushReady: isExpoPushToken(normalizedDevice.pushToken),
    pushTokenPreview: isExpoPushToken(normalizedDevice.pushToken)
      ? normalizedDevice.pushToken.slice(0, 20) + '...'
      : null
  };
}

function cleanTicketString(value, fallback, maxLength) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const nextValue = normalized || fallback;
  return nextValue.slice(0, maxLength);
}

function cleanTicketBody(value, fallback, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const nextValue = normalized || fallback;
  return nextValue.slice(0, maxLength);
}

function normalizeSupportTicketType(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SUPPORT_TICKET_TYPES.has(normalized) ? normalized : 'error';
}

function normalizeSupportTicketPriority(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SUPPORT_TICKET_PRIORITIES.has(normalized) ? normalized : 'normal';
}

function normalizeSupportTicketStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SUPPORT_TICKET_STATUSES.has(normalized) ? normalized : 'open';
}

function normalizeSupportTicket(ticket) {
  ticket = ticket && typeof ticket === 'object' ? ticket : {};
  const nowIso = new Date().toISOString();
  const createdAt = typeof ticket.createdAt === 'string' ? ticket.createdAt : nowIso;
  const updatedAt = typeof ticket.updatedAt === 'string' ? ticket.updatedAt : createdAt;
  const status = normalizeSupportTicketStatus(ticket.status);

  return {
    id:
      typeof ticket.id === 'string' && ticket.id.trim()
        ? ticket.id.trim()
        : `ST-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    type: normalizeSupportTicketType(ticket.type),
    priority: normalizeSupportTicketPriority(ticket.priority),
    status,
    title: cleanTicketString(ticket.title, 'Manager support request', 140),
    message: cleanTicketBody(ticket.message, '', 4000),
    reporterName: cleanTicketString(ticket.reporterName, 'Manager', 80),
    contact: cleanTicketString(ticket.contact, '', 120),
    deviceId: cleanTicketString(ticket.deviceId, '', 120),
    deviceName: cleanTicketString(ticket.deviceName, '', 120),
    appVersion: cleanTicketString(ticket.appVersion, '', 40),
    context: cleanTicketBody(ticket.context, '', 1200),
    adminNote: cleanTicketBody(ticket.adminNote, '', 2000),
    createdAt,
    updatedAt,
    ...(typeof ticket.resolvedAt === 'string' && status === 'resolved' ? { resolvedAt: ticket.resolvedAt } : {}),
    ...(typeof ticket.closedAt === 'string' && status === 'closed' ? { closedAt: ticket.closedAt } : {})
  };
}

function sortSupportTickets(tickets) {
  return [...tickets]
    .map(normalizeSupportTicket)
    .sort((left, right) => {
      const leftOpen = left.status === 'open' || left.status === 'in-progress';
      const rightOpen = right.status === 'open' || right.status === 'in-progress';
      if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

function serializeSupportTicket(ticket) {
  return normalizeSupportTicket(ticket);
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function formatBookingPushBody(booking) {
  const details = [];
  if (booking.service) details.push(booking.service);
  if (booking.vehicle) details.push(booking.vehicle);
  if (booking.phone) details.push(booking.phone);
  return details.join(' | ');
}

function minutesToTimeValue(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((Math.floor(totalMinutes) % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatDateValue(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function shiftDateValue(dateStr, days) {
  const parsedDate = parseDateValue(dateStr);
  if (!parsedDate) {
    return null;
  }

  parsedDate.setUTCDate(parsedDate.getUTCDate() + days);
  return formatDateValue(parsedDate);
}

function parseDateValue(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;

  const [year, month, day] = dateStr.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function parseTimeValue(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{2}:\d{2}$/.test(timeStr)) return null;

  const [hours, minutes] = timeStr.split(':').map(Number);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return {
    normalized: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    totalMinutes: hours * 60 + minutes
  };
}

function getBlockedSlotDurationMinutes(blockedSlot, availability) {
  if (Number.isInteger(blockedSlot && blockedSlot.durationMinutes) && blockedSlot.durationMinutes > 0) {
    return blockedSlot.durationMinutes;
  }

  const startTime = parseTimeValue(blockedSlot && blockedSlot.time);
  const endTime = parseTimeValue(blockedSlot && blockedSlot.endTime);

  if (startTime && endTime) {
    let durationMinutes = endTime.totalMinutes - startTime.totalMinutes;

    if (durationMinutes <= 0) {
      durationMinutes += 24 * 60;
    }

    if (durationMinutes > 0) {
      return durationMinutes;
    }
  }

  if (Number.isInteger(availability && availability.slotDuration) && availability.slotDuration > 0) {
    return availability.slotDuration;
  }

  return DEFAULT_BLOCKED_SLOT_DURATION_MINUTES;
}

function normalizeBlockedSlotEntry(entry, availability) {
  if (!entry || typeof entry !== 'object' || typeof entry.date !== 'string') {
    return null;
  }

  const parsedTime = parseTimeValue(entry.time);
  if (!parsedTime) {
    return null;
  }

  const durationMinutes = getBlockedSlotDurationMinutes(entry, availability);

  return {
    id:
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : `${entry.date}-${parsedTime.normalized}`,
    date: entry.date,
    time: parsedTime.normalized,
    endTime: minutesToTimeValue(parsedTime.totalMinutes + durationMinutes),
    durationMinutes,
    ...(typeof entry.reason === 'string' && entry.reason.trim() ? { reason: entry.reason.trim() } : {}),
    ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {})
  };
}

function normalizeBlockedSlots(blockedSlots, availability) {
  if (!Array.isArray(blockedSlots)) {
    return [];
  }

  return blockedSlots
    .map((entry) => normalizeBlockedSlotEntry(entry, availability))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.date !== right.date) {
        return left.date.localeCompare(right.date);
      }

      return left.time.localeCompare(right.time);
    });
}

function getBlockedSlotRange(blockedSlot, availability) {
  const parsedTime = parseTimeValue(blockedSlot && blockedSlot.time);
  if (!parsedTime) {
    return null;
  }

  return {
    startMinutes: parsedTime.totalMinutes,
    endMinutes: parsedTime.totalMinutes + getBlockedSlotDurationMinutes(blockedSlot, availability)
  };
}

function doesRecurringBlockOccurOnDate(recurringBlock, dateStr) {
  const targetDate = parseDateValue(dateStr);
  const startDate = parseDateValue(recurringBlock && recurringBlock.date);
  if (!targetDate || !startDate) {
    return false;
  }

  const targetKey = formatDateValue(targetDate);
  if (targetKey < recurringBlock.date) {
    return false;
  }

  if (recurringBlock.endDate && targetKey > recurringBlock.endDate) {
    return false;
  }

  const dayOfWeek = targetDate.getUTCDay();

  switch (normalizeRecurringPattern(recurringBlock.recurrence)) {
    case 'daily':
      return true;
    case 'weekdays':
      return dayOfWeek >= 1 && dayOfWeek <= 5;
    case 'weekends':
      return dayOfWeek === 0 || dayOfWeek === 6;
    case 'custom':
      return normalizeRecurringCustomDays(recurringBlock.customDays, recurringBlock.date).includes(dayOfWeek);
    case 'weekly':
    default:
      return dayOfWeek === startDate.getUTCDay();
  }
}

function getBlockedSlotRangesForDate(dateStr, availability) {
  const previousDate = shiftDateValue(dateStr, -1);

  return normalizeBlockedSlots(availability && availability.blockedSlots, availability).flatMap((blockedSlot) => {
    const blockedRange = getBlockedSlotRange(blockedSlot, availability);
    if (!blockedRange) {
      return [];
    }

    const ranges = [];

    if (blockedSlot.date === dateStr) {
      ranges.push(blockedRange);
    }

    if (
      previousDate &&
      blockedSlot.date === previousDate &&
      blockedRange.endMinutes > 24 * 60
    ) {
      ranges.push({
        startMinutes: 0,
        endMinutes: blockedRange.endMinutes - 24 * 60
      });
    }

    return ranges;
  });
}

function getRecurringBlockRangesForDate(dateStr, availability) {
  const previousDate = shiftDateValue(dateStr, -1);

  return normalizeRecurringBlocks(availability && availability.recurringBlocks, availability).flatMap(
    (recurringBlock) => {
      const parsedTime = parseTimeValue(recurringBlock.time);
      if (!parsedTime) {
        return [];
      }

      const durationMinutes = Math.min(
        MAX_BLOCK_DURATION_MINUTES,
        getBlockedSlotDurationMinutes(recurringBlock, availability)
      );
      const ranges = [];

      if (doesRecurringBlockOccurOnDate(recurringBlock, dateStr)) {
        ranges.push({
          startMinutes: parsedTime.totalMinutes,
          endMinutes: parsedTime.totalMinutes + durationMinutes
        });
      }

      if (
        previousDate &&
        parsedTime.totalMinutes + durationMinutes > 24 * 60 &&
        doesRecurringBlockOccurOnDate(recurringBlock, previousDate)
      ) {
        ranges.push({
          startMinutes: 0,
          endMinutes: parsedTime.totalMinutes + durationMinutes - 24 * 60
        });
      }

      return ranges;
    }
  );
}

function getRequestedDurationMinutes(durationMinutes, bookingType, availability) {
  if (Number.isInteger(durationMinutes) && durationMinutes > 0) {
    return durationMinutes;
  }

  return getDefaultDurationMinutes(bookingType, availability);
}

function getBookingTimeRange(booking, availability) {
  const parsedTime = parseTimeValue(booking.time);
  if (!parsedTime) return null;

  const durationMinutes = getRequestedDurationMinutes(
    booking.durationMinutes,
    booking.bookingType,
    availability
  );

  return {
    startMinutes: parsedTime.totalMinutes,
    endMinutes: parsedTime.totalMinutes + durationMinutes
  };
}

function hasBlockedSlotConflict({ dateStr, startMinutes, durationMinutes, availability }) {
  const endMinutes = startMinutes + durationMinutes;

  return [
    ...getBlockedSlotRangesForDate(dateStr, availability),
    ...getRecurringBlockRangesForDate(dateStr, availability)
  ].some(
    (blockedRange) =>
      startMinutes < blockedRange.endMinutes && endMinutes > blockedRange.startMinutes
  );
}

function hasBookingConflict({
  dateStr,
  startMinutes,
  durationMinutes,
  bookings,
  availability,
  excludeBookingId
}) {
  const endMinutes = startMinutes + durationMinutes;

  return bookings.some((booking) => {
    if (
      booking.date !== dateStr ||
      booking.status === 'cancelled' ||
      (excludeBookingId && booking.id === excludeBookingId)
    ) {
      return false;
    }

    const existingRange = getBookingTimeRange(booking, availability);
    if (!existingRange) return false;

    return startMinutes < existingRange.endMinutes && endMinutes > existingRange.startMinutes;
  });
}

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
}

function getDateRules(dateStr, availability) {
  const date = parseDateValue(dateStr);
  if (!date) {
    return { ok: false, status: 400, error: 'Invalid date' };
  }

  const maxAdvanceDays =
    Number.isInteger(availability.maxAdvanceDays) && availability.maxAdvanceDays >= 0
      ? availability.maxAdvanceDays
      : 30;
  const diffDays = Math.floor((date.getTime() - todayUtc().getTime()) / DAY_MS);
  if (diffDays < 0) {
    return { ok: false, status: 400, error: 'Past dates are not available.' };
  }
  if (diffDays > maxAdvanceDays) {
    return {
      ok: false,
      status: 400,
      error: `Bookings are only available ${maxAdvanceDays} day(s) in advance.`
    };
  }

  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getUTCDay()];
  const dayConfig = availability.weeklyHours && availability.weeklyHours[dayKey];
  if (!dayConfig || !dayConfig.open) {
    return { ok: false, status: 400, error: 'This day is not available for booking.', closed: true };
  }
  if (isDateBlocked(dateStr, availability.blockedDates)) {
    return { ok: false, status: 400, error: 'This date is blocked.', blocked: true };
  }

  const start = parseTimeValue(dayConfig.start);
  const end = parseTimeValue(dayConfig.end);
  const slotDuration =
    Number.isInteger(availability.slotDuration) && availability.slotDuration > 0
      ? availability.slotDuration
      : 120;

  if (!start || !end || start.totalMinutes >= end.totalMinutes) {
    return { ok: false, status: 500, error: 'Availability configuration is invalid.' };
  }

  return {
    ok: true,
    startMinutes: start.totalMinutes,
    endMinutes: end.totalMinutes,
    slotDuration
  };
}

function getAvailableSlots(dateStr, availability, bookings, options = {}) {
  const rules = getDateRules(dateStr, availability);
  if (!rules.ok) return rules;

  const durationMinutes = getRequestedDurationMinutes(
    options.durationMinutes,
    options.bookingType,
    availability
  );

  const slots = [];
  for (
    let totalMinutes = rules.startMinutes;
    totalMinutes + durationMinutes <= rules.endMinutes;
    totalMinutes += rules.slotDuration
  ) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    const blocked = hasBlockedSlotConflict({
      dateStr,
      startMinutes: totalMinutes,
      durationMinutes,
      availability
    });
    const booked = hasBookingConflict({
      dateStr,
      startMinutes: totalMinutes,
      durationMinutes,
      bookings,
      availability,
      excludeBookingId: options.excludeBookingId
    });

    if (!blocked && !booked) {
      const hours12 = hours > 12 ? hours - 12 : hours === 0 ? 12 : hours;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      slots.push({ time, label: `${hours12}:${String(minutes).padStart(2, '0')} ${ampm}` });
    }
  }

  return { ok: true, slots };
}

function validateBookingRequest(dateStr, timeStr, availability, bookings, options = {}) {
  const rules = getDateRules(dateStr, availability);
  if (!rules.ok) return rules;

  const time = parseTimeValue(timeStr);
  if (!time) {
    return { ok: false, status: 400, error: 'Invalid time' };
  }
  const durationMinutes = getRequestedDurationMinutes(
    options.durationMinutes,
    options.bookingType,
    availability
  );
  if (time.totalMinutes < rules.startMinutes || time.totalMinutes + durationMinutes > rules.endMinutes) {
    return { ok: false, status: 400, error: 'That time is outside business hours.' };
  }
  if (options.requireSlotAlignment !== false && (time.totalMinutes - rules.startMinutes) % rules.slotDuration !== 0) {
    return { ok: false, status: 400, error: 'That time is not a valid booking slot.' };
  }
  if (
    hasBlockedSlotConflict({
      dateStr,
      startMinutes: time.totalMinutes,
      durationMinutes,
      availability
    })
  ) {
    return { ok: false, status: 409, error: 'That slot is blocked. Please pick another.' };
  }
  if (
    hasBookingConflict({
      dateStr,
      startMinutes: time.totalMinutes,
      durationMinutes,
      bookings,
      availability,
      excludeBookingId: options.excludeBookingId
    })
  ) {
    return { ok: false, status: 409, error: 'That slot was just booked. Please pick another.' };
  }

  return { ok: true, time: time.normalized, durationMinutes };
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

    const readError = createHttpError(503, 'Schedule storage is temporarily unavailable. Please try again.');
    readError.code = 'BLOB_READ_FAILED';
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

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const { action, password } = req.body || {};
  const managerSession = (
    (password && password === process.env.ADMIN_PASSWORD && { role: 'manager', auth: 'password' }) ||
    verifyManagerToken(getManagerTokenFromRequest(req, req.body || {}))
  );
  const authed = !!managerSession;

  async function readBookings() {
    const { data, etag } = await readJsonBlob(BOOKINGS_PATH, [], token);
    return {
      data: Array.isArray(data) ? data : [],
      etag
    };
  }

  async function writeBookings(bookings, etag) {
    await writeJsonBlob(BOOKINGS_PATH, bookings, etag, token);
  }

  async function readAvailability() {
    const { data, etag } = await readJsonBlob(AVAILABILITY_PATH, buildDefaultAvailability(), token);
    return {
      data: normalizeAvailability(data),
      etag
    };
  }

  async function writeAvailability(availability, etag) {
    await writeJsonBlob(AVAILABILITY_PATH, availability, etag, token);
  }

  async function readManagerDevices() {
    const { data, etag } = await readJsonBlob(MANAGER_DEVICES_PATH, [], token);
    const payload = Array.isArray(data) ? data : [];
    const devices = Array.isArray(payload)
      ? sortManagerDevices(payload.map(normalizeManagerDevice))
      : [];

    return { data: devices, etag };
  }

  async function writeManagerDevices(devices, etag) {
    await writeJsonBlob(MANAGER_DEVICES_PATH, devices, etag, token);
  }

  async function readSupportTickets() {
    const { data, etag } = await readJsonBlob(SUPPORT_TICKETS_PATH, [], token);
    const payload = Array.isArray(data) ? data : [];
    return {
      data: sortSupportTickets(payload).slice(0, SUPPORT_TICKETS_MAX),
      etag
    };
  }

  async function writeSupportTickets(tickets, etag) {
    await writeJsonBlob(
      SUPPORT_TICKETS_PATH,
      sortSupportTickets(tickets).slice(0, SUPPORT_TICKETS_MAX),
      etag,
      token
    );
  }

  async function sendExpoPushNotifications(devices, messageFactory) {
    const eligibleDevices = devices.filter((device) => isExpoPushToken(device.pushToken));
    if (eligibleDevices.length === 0) {
      return { attempted: 0, sent: 0, invalidTokens: [] };
    }

    const headers = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json'
    };
    if (process.env.EXPO_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    }

    const messages = eligibleDevices.map((device) => ({
      to: device.pushToken,
      sound: 'default',
      priority: 'high',
      channelId: 'default',
      ...messageFactory(device)
    }));

    const invalidTokens = [];
    let sent = 0;

    for (const chunk of chunkArray(messages, 100)) {
      const response = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(chunk)
      });

      if (!response.ok) {
        throw new Error(`Expo push send failed (${response.status})`);
      }

      const payload = await response.json();
      const tickets = Array.isArray(payload.data) ? payload.data : [];

      tickets.forEach((ticket, index) => {
        if (ticket && ticket.status === 'ok') {
          sent += 1;
          return;
        }

        const message = chunk[index];
        const details = ticket && ticket.details;
        if (details && details.error === 'DeviceNotRegistered' && message && message.to) {
          invalidTokens.push(message.to);
        }
      });
    }

    return {
      attempted: messages.length,
      sent,
      invalidTokens
    };
  }

  async function pruneManagerDevices(pushTokensToRemove) {
    if (!Array.isArray(pushTokensToRemove) || pushTokensToRemove.length === 0) return 0;

    const tokenSet = new Set(pushTokensToRemove);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: devices, etag } = await readManagerDevices();
      const nowIso = new Date().toISOString();
      let changed = 0;
      const nextDevices = devices.map((device) => {
        if (!tokenSet.has(device.pushToken)) {
          return device;
        }

        changed += 1;
        return {
          ...device,
          pushToken: '',
          updatedAt: nowIso
        };
      });

      if (changed === 0) return 0;

      try {
        await writeManagerDevices(sortManagerDevices(nextDevices), etag);
        return changed;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        throw error;
      }
    }

    return 0;
  }

  async function notifyManagersAboutBooking(booking) {
    const { data: devices } = await readManagerDevices();
    const result = await sendExpoPushNotifications(devices, () => ({
      title: 'New Booking',
      body: formatBookingPushBody(booking) || `${booking.name} booked ${booking.date} at ${booking.time}`,
      data: {
        type: 'booking-created',
        bookingId: booking.id,
        date: booking.date,
        time: booking.time,
        customerName: booking.name,
        phone: booking.phone,
        service: booking.service || '',
        vehicle: booking.vehicle || ''
      }
    }));

    if (result.invalidTokens.length > 0) {
      await pruneManagerDevices(result.invalidTokens);
    }

    return result;
  }

  async function notifyManagersAboutSupportTicket(ticket) {
    const { data: devices } = await readManagerDevices();
    const result = await sendExpoPushNotifications(devices, () => ({
      title: ticket.priority === 'urgent' ? 'Urgent Support Ticket' : 'Support Ticket',
      body: `${ticket.reporterName}: ${ticket.title}`,
      data: {
        type: 'support-ticket-created',
        ticketId: ticket.id,
        ticketType: ticket.type,
        priority: ticket.priority,
        status: ticket.status,
        createdAt: ticket.createdAt
      }
    }));

    if (result.invalidTokens.length > 0) {
      await pruneManagerDevices(result.invalidTokens);
    }

    return result;
  }

  async function notifyManagersAboutOrder(order, eventType) {
    const { data: devices } = await readManagerDevices();
    const normalizedOrder = normalizeOrder(order);
    const serviceSummary = normalizedOrder.serviceSummary || buildServiceSummary(normalizedOrder.services);
    const isCash = normalizedOrder.paymentMethod === 'cash';
    const title =
      eventType === 'order-cancelled'
        ? 'Booking Cancelled'
        : isCash
          ? 'Cash Booking Started'
          : 'Paid Order Ready';
    const body =
      eventType === 'order-cancelled'
        ? `${normalizedOrder.customer?.name || 'Customer'} cancelled ${serviceSummary}`
        : `${normalizedOrder.customer?.name || 'Customer'} - ${serviceSummary} - $${normalizedOrder.total}`;

    const result = await sendExpoPushNotifications(devices, () => ({
      title,
      body,
      data: {
        type: eventType,
        orderId: normalizedOrder.id,
        bookingId: normalizedOrder.bookingId || '',
        paymentMethod: normalizedOrder.paymentMethod,
        paymentStatus: normalizedOrder.paymentStatus,
        customerName: normalizedOrder.customer?.name || '',
        service: serviceSummary
      }
    }));

    if (result.invalidTokens.length > 0) {
      await pruneManagerDevices(result.invalidTokens);
    }

    return result;
  }

  try {
    if (action === 'get-slots') {
      const { date, bookingType, durationMinutes, excludeBookingId } = req.body;
      if (!date) return res.status(400).json({ error: 'Date required' });

      const [{ data: availability }, { data: bookings }] = await Promise.all([readAvailability(), readBookings()]);
      const result = getAvailableSlots(date, availability, bookings, {
        bookingType,
        durationMinutes,
        excludeBookingId
      });
      if (!result.ok) {
        return res.json({
          slots: [],
          closed: !!result.closed || !result.blocked,
          blocked: !!result.blocked,
          error: result.error
        });
      }

      return res.json({ slots: result.slots, date });
    }

    if (action === 'get-config') {
      const { data: availability } = await readAvailability();
      return res.json({
        maxAdvanceDays:
          Number.isInteger(availability.maxAdvanceDays) && availability.maxAdvanceDays >= 0
            ? availability.maxAdvanceDays
            : 30,
        slotDuration: availability.slotDuration,
        customerBlockMinutes: availability.customerBlockMinutes,
        privateBlockMinutes: availability.privateBlockMinutes,
        travelBufferMinutes: availability.travelBufferMinutes
      });
    }

    if (action === 'manager-bootstrap') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const [{ data: bookings }, { data: availability }, { data: orders }] = await Promise.all([
        readBookings(),
        readAvailability(),
        readOrders()
      ]);
      const normalizedBookings = sortBookings(bookings.map(normalizeBooking));
      return res.json({
        bookings: normalizedBookings,
        orders,
        availability,
        serverTime: new Date().toISOString(),
        latestSyncAt: getLatestSyncAt(normalizedBookings, availability, orders),
        version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
      });
    }

    if (action === 'manager-sync') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const sinceTimestamp = parseSyncTimestamp(req.body && req.body.since);
      const [{ data: bookings }, { data: availability }, { data: orders }] = await Promise.all([
        readBookings(),
        readAvailability(),
        readOrders()
      ]);
      const normalizedBookings = sortBookings(bookings.map(normalizeBooking));
      const changedBookings =
        sinceTimestamp === null
          ? normalizedBookings
          : normalizedBookings.filter((booking) => Date.parse(booking.updatedAt) > sinceTimestamp);
      const changedOrders =
        sinceTimestamp === null
          ? orders
          : orders.filter((order) => Date.parse(order.updatedAt) > sinceTimestamp);
      const availabilityChanged =
        sinceTimestamp === null ||
        (availability.updatedAt && Date.parse(availability.updatedAt) > sinceTimestamp);

      return res.json({
        bookings: changedBookings,
        orders: changedOrders,
        availability: availabilityChanged ? availability : null,
        serverTime: new Date().toISOString(),
        latestSyncAt: getLatestSyncAt(normalizedBookings, availability, orders),
        version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
      });
    }

    if (action === 'register-manager-device') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const { deviceId, platform, deviceName, appVersion } = req.body || {};
      const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
      if (!normalizedDeviceId) {
        return res.status(400).json({ error: 'A device id is required.' });
      }

      const nowIso = new Date().toISOString();
      const devices = await updateSingletonJsonBlob({
        read: readManagerDevices,
        write: async (nextDevices, etag) => {
          await writeManagerDevices(sortManagerDevices(nextDevices), etag);
        },
        errorMessage: 'Could not register the manager device. Please try again.',
        mutate: async (existingDevices) => {
          upsertManagerDevice(existingDevices, {
            deviceId: normalizedDeviceId,
            platform: typeof platform === 'string' ? platform : 'unknown',
            deviceName: typeof deviceName === 'string' ? deviceName : '',
            appVersion: typeof appVersion === 'string' ? appVersion : '',
            updatedAt: nowIso,
            lastSeenAt: nowIso
          });

          return existingDevices;
        }
      });

      const device = devices.find((entry) => entry.deviceId === normalizedDeviceId);
      return res.json({ success: true, device: serializeManagerDevice(device || { deviceId: normalizedDeviceId }) });
    }

    if (action === 'register-push-token') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const { pushToken, deviceId, platform, deviceName, appVersion } = req.body || {};
      if (!isExpoPushToken(pushToken)) {
        return res.status(400).json({ error: 'A valid Expo push token is required.' });
      }

      const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
      const nowIso = new Date().toISOString();

      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: devices, etag } = await readManagerDevices();
        const nextDevice = upsertManagerDevice(devices, {
          pushToken,
          deviceId: normalizedDeviceId,
          platform: typeof platform === 'string' ? platform : 'unknown',
          deviceName: typeof deviceName === 'string' ? deviceName : '',
          appVersion: typeof appVersion === 'string' ? appVersion : '',
          createdAt: nowIso,
          updatedAt: nowIso,
          lastSeenAt: nowIso
        });

        try {
          await writeManagerDevices(sortManagerDevices(devices), etag);
          return res.json({ success: true, device: serializeManagerDevice(nextDevice) });
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) continue;
          throw error;
        }
      }

      return res.status(409).json({ error: 'Could not register push token. Please try again.' });
    }

    if (action === 'unregister-push-token') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const { pushToken, deviceId } = req.body || {};
      const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
      if (!pushToken && !normalizedDeviceId) {
        return res.status(400).json({ error: 'A push token or device id is required.' });
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: devices, etag } = await readManagerDevices();
        const filteredDevices = devices.filter((device) =>
          device.pushToken !== pushToken && (!normalizedDeviceId || device.deviceId !== normalizedDeviceId)
        );
        const removed = devices.length - filteredDevices.length;

        if (removed === 0) {
          return res.json({ success: true, removed: 0 });
        }

        try {
          await writeManagerDevices(sortManagerDevices(filteredDevices), etag);
          return res.json({ success: true, removed });
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) continue;
          throw error;
        }
      }

      return res.status(409).json({ error: 'Could not unregister push token. Please try again.' });
    }

    if (action === 'list-manager-devices') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const { data: devices } = await readManagerDevices();
      const pushCapable = devices.filter((device) => isExpoPushToken(device.pushToken)).length;

      return res.json({
        devices: devices.map(serializeManagerDevice),
        registered: devices.length,
        pushCapable
      });
    }

    if (action === 'send-test-notification') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const { pushToken } = req.body || {};
      let devices;
      let shouldPrune = false;
      let registeredDevices = 0;

      if (pushToken) {
        if (!isExpoPushToken(pushToken)) {
          return res.status(400).json({ error: 'A valid Expo push token is required.' });
        }
        devices = [normalizeManagerDevice({ pushToken, platform: 'unknown' })];
        registeredDevices = devices.length;
      } else {
        const managerDevices = await readManagerDevices();
        devices = managerDevices.data;
        shouldPrune = true;
        registeredDevices = devices.length;
      }

      const result = await sendExpoPushNotifications(devices, () => ({
        title: 'Test Notification',
        body: 'Fritz management push notifications are working.',
        data: {
          type: 'test-notification',
          sentAt: new Date().toISOString()
        }
      }));

      if (shouldPrune && result.invalidTokens.length > 0) {
        await pruneManagerDevices(result.invalidTokens);
      }

      return res.json({
        success: true,
        ...result,
        registeredDevices,
        pushCapable: devices.filter((device) => isExpoPushToken(device.pushToken)).length
      });
    }

    if (action === 'list-support-tickets') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const { data: tickets } = await readSupportTickets();
      return res.json({
        tickets: tickets.map(serializeSupportTicket),
        openCount: tickets.filter((ticket) => ticket.status === 'open' || ticket.status === 'in-progress').length
      });
    }

    if (action === 'create-support-ticket') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const {
        type,
        priority,
        title,
        message,
        reporterName,
        contact,
        deviceId,
        deviceName,
        appVersion,
        context
      } = req.body || {};
      const normalizedTitle = cleanTicketString(title, '', 140);
      const normalizedMessage = cleanTicketBody(message, '', 4000);

      if (!normalizedTitle || !normalizedMessage) {
        return res.status(400).json({ error: 'A title and details are required.' });
      }

      const nowIso = new Date().toISOString();
      let savedTicket = null;

      await updateSingletonJsonBlob({
        read: readSupportTickets,
        write: writeSupportTickets,
        errorMessage: 'Could not create the support ticket. Please try again.',
        mutate: async (tickets) => {
          savedTicket = normalizeSupportTicket({
            id: `ST-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
            type,
            priority,
            status: 'open',
            title: normalizedTitle,
            message: normalizedMessage,
            reporterName,
            contact,
            deviceId,
            deviceName,
            appVersion,
            context,
            createdAt: nowIso,
            updatedAt: nowIso
          });

          return [savedTicket, ...tickets].slice(0, SUPPORT_TICKETS_MAX);
        }
      });

      let notificationResult = { attempted: 0, sent: 0, invalidTokens: [] };
      try {
        notificationResult = await notifyManagersAboutSupportTicket(savedTicket);
      } catch (notificationError) {
        console.error('Support ticket push notification error:', notificationError.message);
      }

      return res.json({
        success: true,
        ticket: serializeSupportTicket(savedTicket),
        notifications: notificationResult
      });
    }

    if (action === 'update-support-ticket') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const ticketId =
        typeof (req.body && req.body.ticketId) === 'string'
          ? req.body.ticketId.trim()
          : '';
      if (!ticketId) {
        return res.status(400).json({ error: 'A support ticket id is required.' });
      }

      const nextStatus = normalizeSupportTicketStatus(req.body && req.body.status);
      const adminNote = cleanTicketBody(req.body && req.body.adminNote, '', 2000);
      let updatedTicket = null;

      await updateSingletonJsonBlob({
        read: readSupportTickets,
        write: writeSupportTickets,
        errorMessage: 'Could not update the support ticket. Please try again.',
        mutate: async (tickets) => {
          const ticketIndex = tickets.findIndex((ticket) => ticket.id === ticketId);
          if (ticketIndex < 0) {
            const notFoundError = new Error('Support ticket not found.');
            notFoundError.statusCode = 404;
            throw notFoundError;
          }

          const nowIso = new Date().toISOString();
          updatedTicket = normalizeSupportTicket({
            ...tickets[ticketIndex],
            status: nextStatus,
            adminNote,
            updatedAt: nowIso,
            ...(nextStatus === 'resolved' ? { resolvedAt: nowIso } : {}),
            ...(nextStatus === 'closed' ? { closedAt: nowIso } : {})
          });

          tickets[ticketIndex] = updatedTicket;
          return tickets;
        }
      });

      return res.json({
        success: true,
        ticket: serializeSupportTicket(updatedTicket)
      });
    }

    if (action === 'get-version') {
      const commitSha = typeof process.env.VERCEL_GIT_COMMIT_SHA === 'string'
        ? process.env.VERCEL_GIT_COMMIT_SHA
        : '';

      return res.json({
        version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
        commit: commitSha ? commitSha.slice(0, 7) : null
      });
    }

    if (action === 'create-order') {
      const body = req.body || {};
      const paymentMethod = cleanString(body.paymentMethod, 20).toLowerCase();
      const customerInput = body.customer && typeof body.customer === 'object' ? body.customer : body;
      const name = cleanString(customerInput.name, 120);
      const email = cleanString(customerInput.email, 160).toLowerCase();
      const phone = cleanString(customerInput.phone, 60);
      const vehicle = cleanString(customerInput.vehicle || body.vehicle, 180);
      const paymentTermsAccepted = body.paymentTermsAccepted === true;

      if (!CUSTOMER_PAYMENT_METHODS.has(paymentMethod)) {
        return res.status(400).json({ error: 'Choose card or cash payment.' });
      }

      if (!isCustomerPaymentMethodEnabled(paymentMethod)) {
        return res.status(409).json({ error: 'This payment method is not available right now.' });
      }

      if (!name) {
        return res.status(400).json({ error: 'Name is required.' });
      }

      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
      }

      if (!phone) {
        return res.status(400).json({ error: 'Phone number is required.' });
      }

      if (!paymentTermsAccepted) {
        return res.status(400).json({ error: 'Payment terms must be accepted before checkout.' });
      }

      const cart = validateOrderServices(body.serviceIds);
      const nowIso = new Date().toISOString();
      const order = normalizeOrder({
        id: generateOrderId(),
        publicToken: generatePublicToken(),
        status: paymentMethod === 'card' ? 'requires_payment' : 'cash_due_on_site',
        paymentStatus: paymentMethod === 'card' ? 'requires_payment' : 'cash_due_on_site',
        paymentMethod,
        customer: { name, email, phone },
        vehicle,
        services: cart.services,
        serviceSummary: cart.serviceSummary,
        subtotal: cart.subtotal,
        managerFees: [],
        total: cart.subtotal,
        durationMinutes: cart.durationMinutes,
        cashVerificationCode: paymentMethod === 'cash' ? generateCashVerificationCode() : '',
        termsAcceptedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso
      });

      await updateOrders((orders) => [order, ...orders], 'Could not create the order. Please try again.');

      let notificationResult = { attempted: 0, sent: 0, invalidTokens: [] };
      if (paymentMethod === 'cash') {
        try {
          notificationResult = await notifyManagersAboutOrder(order, 'cash-order-created');
        } catch (notificationError) {
          console.error('Cash order push notification error:', notificationError.message);
        }
      }

      return res.json({
        success: true,
        order: serializeOrderForPublic(order),
        bookingUrl: getOrderBookingUrl(order),
        notifications: notificationResult
      });
    }

    if (action === 'get-order') {
      const { orderId, token: publicToken } = req.body || {};
      const { data: orders } = await readOrders();
      const order = findOrderByCredentials(orders, orderId, publicToken);
      if (!order) {
        return res.status(404).json({ error: 'Order not found. Start checkout again.' });
      }

      return res.json({
        success: true,
        order: serializeOrderForPublic(order),
        bookingUrl: getOrderBookingUrl(order)
      });
    }

    if (action === 'confirm-card-order') {
      const { orderId, token: publicToken, paymentIntentId } = req.body || {};
      const cfg = readConfig();
      const preferTestMode = cfg.stripeTestMode === true;
      const { paymentIntent, isTest } = await retrieveStripePaymentIntent(paymentIntentId, preferTestMode);

      if (paymentIntent.status !== 'succeeded') {
        return res.status(409).json({ error: 'Card payment has not been confirmed.' });
      }

      let savedOrder = null;
      await updateOrders((orders) => {
        const order = findOrderByCredentials(orders, orderId, publicToken);
        if (!order) throw createHttpError(404, 'Order not found. Start checkout again.');
        if (order.paymentMethod !== 'card') throw createHttpError(400, 'This order is not configured for card payment.');

        const expectedAmount = Math.round(Number(order.total) * 100);
        const paidAmount = paymentIntent.amount_received || paymentIntent.amount;
        if (!Number.isInteger(expectedAmount) || expectedAmount !== paidAmount) {
          throw createHttpError(400, 'Payment amount does not match the order total.');
        }

        if (paymentIntent.metadata?.order_id && paymentIntent.metadata.order_id !== order.id) {
          throw createHttpError(400, 'Payment does not match this order.');
        }

        const nowIso = new Date().toISOString();
        savedOrder = normalizeOrder({
          ...order,
          status: order.bookingId ? 'booked' : 'paid',
          paymentStatus: 'paid',
          stripePaymentIntentId: paymentIntent.id,
          paidAt: nowIso,
          updatedAt: nowIso
        });

        return orders.map((entry) => entry.id === savedOrder.id ? savedOrder : entry);
      }, 'Could not confirm payment. Please try again.');

      await appendSale(
        {
          ...saleInputFromPaymentIntent(paymentIntent, isTest, {
            orderId: savedOrder.id,
            vehicle: savedOrder.vehicle || ''
          }),
          customer: savedOrder.customer?.name || paymentIntent.receipt_email || 'Unknown',
          service: savedOrder.serviceSummary || buildServiceSummary(savedOrder.services),
          amount: savedOrder.total,
          orderId: savedOrder.id
        },
        { serverIsLive: !isTest }
      );

      let notificationResult = { attempted: 0, sent: 0, invalidTokens: [] };
      try {
        notificationResult = await notifyManagersAboutOrder(savedOrder, 'paid-order-created');
      } catch (notificationError) {
        console.error('Paid order push notification error:', notificationError.message);
      }

      return res.json({
        success: true,
        order: serializeOrderForPublic(savedOrder),
        bookingUrl: getOrderBookingUrl(savedOrder),
        notifications: notificationResult
      });
    }

    if (action === 'schedule-paid-order') {
      const { orderId, token: publicToken, date, time } = req.body || {};
      const phone = cleanString(req.body && req.body.phone, 60);
      const vehicle = cleanString(req.body && req.body.vehicle, 180);
      const notes = cleanString(req.body && req.body.notes, 1000);
      const { data: orders } = await readOrders();
      const order = findOrderByCredentials(orders, orderId, publicToken);

      if (!order) {
        return res.status(404).json({ error: 'Order not found. Start checkout again.' });
      }

      if (order.bookingId) {
        const { data: bookings } = await readBookings();
        const existingBooking = bookings.find((booking) => booking.id === order.bookingId);
        return res.json({
          success: true,
          booking: existingBooking ? normalizeBooking(existingBooking) : null,
          order: serializeOrderForPublic(order),
          alreadyBooked: true
        });
      }

      if (!['paid', 'cash_due_on_site'].includes(order.paymentStatus)) {
        return res.status(409).json({ error: 'Payment must be confirmed before booking.' });
      }

      if (!date || !time) {
        return res.status(400).json({ error: 'Date and time are required.' });
      }

      const { data: availability } = await readAvailability();
      let booking = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: bookings, etag } = await readBookings();
        const validation = validateBookingRequest(date, time, availability, bookings, {
          bookingType: 'customer',
          durationMinutes: order.durationMinutes
        });
        if (!validation.ok) {
          return res.status(validation.status).json({ error: validation.error });
        }

        const nowIso = new Date().toISOString();
        booking = {
          id: 'BK-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
          date,
          time: validation.time,
          name: order.customer?.name || '',
          email: order.customer?.email || '',
          phone: phone || order.customer?.phone || '',
          vehicle: vehicle || order.vehicle || '',
          service: order.serviceSummary || buildServiceSummary(order.services),
          services: order.services,
          notes: notes || '',
          status: 'confirmed',
          bookingType: 'customer',
          durationMinutes: validation.durationMinutes,
          source: 'public-checkout',
          orderId: order.id,
          paymentMethod: order.paymentMethod,
          paymentStatus: order.paymentStatus,
          total: order.total,
          cashVerificationCode: order.cashVerificationCode || '',
          createdAt: nowIso,
          updatedAt: nowIso
        };

        bookings.push(booking);

        try {
          await writeBookings(bookings, etag);
          break;
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) {
            booking = null;
            continue;
          }
          throw error;
        }
      }

      if (!booking) {
        return res.status(409).json({ error: 'That slot was just booked. Please pick another.' });
      }

      let savedOrder = null;
      await updateOrders((latestOrders) => {
        const latestOrder = findOrderByCredentials(latestOrders, orderId, publicToken);
        if (!latestOrder) throw createHttpError(404, 'Order not found. Start checkout again.');

        const nowIso = new Date().toISOString();
        savedOrder = normalizeOrder({
          ...latestOrder,
          status: 'booked',
          bookingId: booking.id,
          bookingDate: booking.date,
          bookingTime: booking.time,
          customer: {
            ...(latestOrder.customer || {}),
            phone: booking.phone
          },
          vehicle: booking.vehicle,
          scheduledAt: nowIso,
          updatedAt: nowIso
        });

        return latestOrders.map((entry) => entry.id === savedOrder.id ? savedOrder : entry);
      }, 'Could not link the booking to the order. Please contact Fritz.');

      let notificationResult = { attempted: 0, sent: 0, invalidTokens: [] };
      try {
        notificationResult = await notifyManagersAboutBooking(booking);
      } catch (notificationError) {
        console.error('Push notification error:', notificationError.message);
      }

      return res.json({
        success: true,
        booking,
        order: serializeOrderForPublic(savedOrder),
        notifications: notificationResult
      });
    }

    if (action === 'cancel-public-booking') {
      const { orderId, token: publicToken } = req.body || {};
      const { data: orders } = await readOrders();
      const order = findOrderByCredentials(orders, orderId, publicToken);
      if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      if (!order.bookingId) {
        return res.status(400).json({ error: 'No scheduled booking is attached to this order.' });
      }

      const { data: bookings } = await readBookings();
      const existingBooking = bookings.find((booking) => booking.id === order.bookingId);
      if (!existingBooking) {
        return res.status(404).json({ error: 'Booking not found.' });
      }

      if (normalizeBookingStatus(existingBooking.status) === 'cancelled') {
        return res.json({
          success: true,
          booking: normalizeBooking(existingBooking),
          order: serializeOrderForPublic(order),
          alreadyCancelled: true
        });
      }

      if (isInsideCancellationCallWindow(existingBooking)) {
        return res.status(409).json({
          error: `Bookings within 24 hours must be cancelled by phone. Call Fritz at ${FRITZ_PHONE_DISPLAY}.`,
          callRequired: true,
          phone: FRITZ_PHONE_DISPLAY
        });
      }

      let cancelledBooking = null;
      await updateSingletonJsonBlob({
        read: readBookings,
        write: writeBookings,
        errorMessage: 'Could not cancel the booking. Please try again.',
        mutate: async (latestBookings) => {
          const bookingIndex = latestBookings.findIndex((booking) => booking.id === order.bookingId);
          if (bookingIndex < 0) throw createHttpError(404, 'Booking not found.');

          const nowIso = new Date().toISOString();
          cancelledBooking = normalizeBooking({
            ...latestBookings[bookingIndex],
            status: 'cancelled',
            paymentStatus: order.paymentStatus,
            cancellationPolicy: 'free-before-24-hours',
            cancelledAt: nowIso,
            updatedAt: nowIso
          });
          latestBookings[bookingIndex] = cancelledBooking;
          return latestBookings;
        }
      });

      let refundResult = null;
      if (order.paymentMethod === 'card' && order.paymentStatus === 'paid' && order.stripePaymentIntentId) {
        const cfg = readConfig();
        refundResult = await refundStripePayment(order.stripePaymentIntentId, cfg.stripeTestMode === true);
        await markSaleRefunded({
          stripePaymentId: order.stripePaymentIntentId,
          orderId: order.id,
          refundId: refundResult.refund.id,
          refundAmount: refundResult.amount
        });
      }

      let savedOrder = null;
      await updateOrders((latestOrders) => {
        const latestOrder = findOrderByCredentials(latestOrders, orderId, publicToken);
        if (!latestOrder) throw createHttpError(404, 'Order not found.');

        const nowIso = new Date().toISOString();
        savedOrder = normalizeOrder({
          ...latestOrder,
          status: refundResult ? 'refunded' : 'cancelled',
          paymentStatus: refundResult ? 'refunded' : latestOrder.paymentStatus,
          cancellation: {
            policy: 'free-before-24-hours',
            cancelledAt: nowIso
          },
          refundId: refundResult?.refund?.id || latestOrder.refundId || '',
          refundedAt: refundResult ? nowIso : latestOrder.refundedAt,
          updatedAt: nowIso
        });

        return latestOrders.map((entry) => entry.id === savedOrder.id ? savedOrder : entry);
      }, 'Could not update cancelled order. Please contact Fritz.');

      let notificationResult = { attempted: 0, sent: 0, invalidTokens: [] };
      try {
        notificationResult = await notifyManagersAboutOrder(savedOrder, 'order-cancelled');
      } catch (notificationError) {
        console.error('Cancellation push notification error:', notificationError.message);
      }

      return res.json({
        success: true,
        booking: cancelledBooking,
        order: serializeOrderForPublic(savedOrder),
        refund: refundResult ? { id: refundResult.refund.id, amount: refundResult.amount } : null,
        notifications: notificationResult
      });
    }

    if (action === 'book') {
      return res.status(410).json({
        error: 'Public booking now starts at checkout. Select services and payment first.',
        checkoutUrl: '/checkout.html'
      });
    }

    if (!authed) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'manager-create-booking') {
      const {
        date,
        time,
        bookingType: rawBookingType,
        durationMinutes,
        name,
        phone,
        vehicle,
        service,
        notes
      } = req.body || {};
      const bookingType = normalizeBookingType(rawBookingType);

      if (!date || !time) {
        return res.status(400).json({ error: 'Date and time are required.' });
      }

      if (bookingType === 'customer' && (!name || !phone)) {
        return res.status(400).json({ error: 'Customer bookings require a name and phone number.' });
      }

      const { data: availability } = await readAvailability();

      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: bookings, etag } = await readBookings();
        const validation = validateBookingRequest(date, time, availability, bookings, {
          bookingType,
          durationMinutes,
          requireSlotAlignment: false
        });
        if (!validation.ok) {
          return res.status(validation.status).json({ error: validation.error });
        }

        const nowIso = new Date().toISOString();
        const defaultName = bookingType === 'travel' ? 'Travel Buffer' : bookingType === 'private' ? 'Private Hold' : '';
        const defaultService = bookingType === 'travel' ? 'Travel Interval' : bookingType === 'private' ? 'Private Block' : '';
        const booking = {
          id: 'BK-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
          date,
          time: validation.time,
          name: (typeof name === 'string' && name.trim()) || defaultName,
          phone: typeof phone === 'string' ? phone : '',
          vehicle: vehicle || '',
          service: service || defaultService,
          notes: notes || '',
          status: 'confirmed',
          bookingType,
          durationMinutes: validation.durationMinutes,
          source: 'manager',
          createdAt: nowIso,
          updatedAt: nowIso
        };

        bookings.push(booking);

        try {
          await writeBookings(bookings, etag);
          return res.json({ success: true, booking });
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) {
            continue;
          }

          throw error;
        }
      }

      return res.status(409).json({ error: 'That time block is no longer available. Please pick another.' });
    }

    if (action === 'manager-update-booking') {
      const {
        bookingId,
        date,
        time,
        bookingType: rawBookingType,
        durationMinutes,
        name,
        phone,
        vehicle,
        service,
        notes,
        status
      } = req.body || {};

      if (!bookingId || typeof bookingId !== 'string') {
        return res.status(400).json({ error: 'A booking id is required.' });
      }

      const bookingType = normalizeBookingType(rawBookingType);
      const nextStatus = normalizeBookingStatus(status);

      if (nextStatus !== 'cancelled') {
        if (!date || !time) {
          return res.status(400).json({ error: 'Date and time are required.' });
        }

        if (bookingType === 'customer' && (!name || !phone)) {
          return res.status(400).json({ error: 'Customer bookings require a name and phone number.' });
        }
      }

      const { data: availability } = await readAvailability();
      let savedBooking = null;

      await updateSingletonJsonBlob({
        read: readBookings,
        write: writeBookings,
        errorMessage: 'That time block changed before it could be saved. Please try again.',
        mutate: async (bookings) => {
          const bookingIndex = bookings.findIndex((entry) => entry.id === bookingId);

          if (bookingIndex < 0) {
            const notFoundError = new Error('Booking not found.');
            notFoundError.statusCode = 404;
            throw notFoundError;
          }

          const existingBooking = normalizeBooking(bookings[bookingIndex]);
          const nowIso = new Date().toISOString();
          let nextBooking;

          if (nextStatus === 'cancelled') {
            nextBooking = {
              ...existingBooking,
              status: 'cancelled',
              updatedAt: nowIso,
              cancelledAt: nowIso
            };
          } else {
            const validation = validateBookingRequest(date, time, availability, bookings, {
              bookingType,
              durationMinutes,
              excludeBookingId: bookingId,
              requireSlotAlignment: false
            });

            if (!validation.ok) {
              const validationError = new Error(validation.error);
              validationError.statusCode = validation.status;
              throw validationError;
            }

            const defaultName =
              bookingType === 'travel' ? 'Travel Buffer' : bookingType === 'private' ? 'Private Hold' : '';
            const defaultService =
              bookingType === 'travel' ? 'Travel Interval' : bookingType === 'private' ? 'Private Block' : '';

            nextBooking = {
              ...existingBooking,
              date,
              time: validation.time,
              name: (typeof name === 'string' && name.trim()) || defaultName,
              phone: typeof phone === 'string' ? phone : '',
              vehicle: vehicle || '',
              service: service || defaultService,
              notes: notes || '',
              status: nextStatus,
              bookingType,
              durationMinutes: validation.durationMinutes,
              source: existingBooking.source || 'manager',
              updatedAt: nowIso
            };

            if (nextBooking.cancelledAt) {
              delete nextBooking.cancelledAt;
            }
          }

          savedBooking = normalizeBooking(nextBooking);
          bookings[bookingIndex] = savedBooking;
          return bookings;
        }
      });

      return res.json({
        success: true,
        booking: savedBooking
      });
    }

    if (action === 'list-bookings') {
      const { data: bookings } = await readBookings();
      return res.json({ bookings: sortBookings(bookings.map(normalizeBooking)) });
    }

    if (action === 'list-orders') {
      const { data: orders } = await readOrders();
      return res.json({ orders });
    }

    if (action === 'mark-cash-paid') {
      const orderId = cleanString(req.body && (req.body.orderId || req.body.bookingId), 120);
      if (!orderId) {
        return res.status(400).json({ error: 'An order id or booking id is required.' });
      }

      let savedOrder = null;
      await updateOrders((orders) => {
        const order = orders.find((entry) => entry.id === orderId || entry.bookingId === orderId);
        if (!order) throw createHttpError(404, 'Order not found.');
        if (order.paymentMethod !== 'cash') throw createHttpError(400, 'Only cash orders can be marked paid this way.');

        const nowIso = new Date().toISOString();
        savedOrder = normalizeOrder({
          ...order,
          status: order.bookingId ? 'booked' : 'paid',
          paymentStatus: 'paid',
          cashPaidAt: nowIso,
          updatedAt: nowIso
        });

        return orders.map((entry) => entry.id === savedOrder.id ? savedOrder : entry);
      }, 'Could not mark cash paid. Please try again.');

      await appendSale({
        customer: savedOrder.customer?.name || 'Unknown',
        service: savedOrder.serviceSummary || buildServiceSummary(savedOrder.services),
        vehicle: savedOrder.vehicle || '',
        amount: savedOrder.total,
        commission: undefined,
        paymentMethod: 'cash',
        source: 'cash-order',
        orderId: savedOrder.id,
        notes: savedOrder.cashVerificationCode
          ? `Cash verification code ${savedOrder.cashVerificationCode}`
          : '',
        status: 'completed'
      });

      await updateSingletonJsonBlob({
        read: readBookings,
        write: writeBookings,
        errorMessage: 'Cash payment was recorded, but the booking could not be refreshed.',
        mutate: async (bookings) => {
          const booking = bookings.find((entry) => entry.orderId === savedOrder.id || entry.id === savedOrder.bookingId);
          if (booking) {
            booking.paymentStatus = 'paid';
            booking.updatedAt = new Date().toISOString();
          }
          return bookings;
        }
      }).catch((error) => {
        console.error('Cash booking status update error:', error.message);
      });

      return res.json({
        success: true,
        order: savedOrder
      });
    }

    if (action === 'add-manager-fee') {
      const orderId = cleanString(req.body && (req.body.orderId || req.body.bookingId), 120);
      const feeInput = req.body && req.body.fee && typeof req.body.fee === 'object' ? req.body.fee : req.body;
      const feeName = cleanString(feeInput.name || feeInput.feeName, 120);
      const feeDescription = cleanString(feeInput.description || feeInput.feeDescription, 240);
      const feeAmount = Number(feeInput.amount || feeInput.feeAmount);

      if (!orderId) return res.status(400).json({ error: 'An order id or booking id is required.' });
      if (!feeName || !Number.isFinite(feeAmount) || feeAmount <= 0) {
        return res.status(400).json({ error: 'Fee name and amount are required.' });
      }

      let savedOrder = null;
      await updateOrders((orders) => {
        const order = orders.find((entry) => entry.id === orderId || entry.bookingId === orderId);
        if (!order) throw createHttpError(404, 'Order not found.');

        const nowIso = new Date().toISOString();
        const managerFees = [
          ...(Array.isArray(order.managerFees) ? order.managerFees : []),
          {
            id: `FEE-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
            name: feeName,
            amount: Math.round(feeAmount * 100) / 100,
            description: feeDescription,
            addedAt: nowIso
          }
        ];
        const managerFeeTotal = managerFees.reduce((sum, fee) => sum + (Number(fee.amount) || 0), 0);

        savedOrder = normalizeOrder({
          ...order,
          managerFees,
          managerFeeTotal: Math.round(managerFeeTotal * 100) / 100,
          total: Math.round(((Number(order.subtotal) || 0) + managerFeeTotal) * 100) / 100,
          managerBalanceDue:
            order.paymentMethod === 'card'
              ? Math.round(managerFeeTotal * 100) / 100
              : 0,
          updatedAt: nowIso
        });

        return orders.map((entry) => entry.id === savedOrder.id ? savedOrder : entry);
      }, 'Could not add the fee. Please try again.');

      await updateSingletonJsonBlob({
        read: readBookings,
        write: writeBookings,
        errorMessage: 'Fee was saved, but the booking could not be refreshed.',
        mutate: async (bookings) => {
          const booking = bookings.find((entry) => entry.orderId === savedOrder.id || entry.id === savedOrder.bookingId);
          if (booking) {
            booking.managerFees = savedOrder.managerFees;
            booking.managerFeeTotal = savedOrder.managerFeeTotal;
            booking.total = savedOrder.total;
            booking.managerBalanceDue = savedOrder.managerBalanceDue || 0;
            booking.updatedAt = new Date().toISOString();
          }
          return bookings;
        }
      }).catch((error) => {
        console.error('Fee booking status update error:', error.message);
      });

      return res.json({
        success: true,
        order: savedOrder
      });
    }

    if (action === 'cancel-booking') {
      const { bookingId } = req.body;
      let linkedOrderId = null;
      await updateSingletonJsonBlob({
        read: readBookings,
        write: writeBookings,
        errorMessage: 'Could not update the booking. Please try again.',
        mutate: async (bookings) => {
          const booking = bookings.find((entry) => entry.id === bookingId);

          if (booking && booking.status !== 'cancelled') {
            linkedOrderId = typeof booking.orderId === 'string' ? booking.orderId : null;
            booking.status = 'cancelled';
            booking.updatedAt = new Date().toISOString();
            booking.cancelledAt = booking.updatedAt;
          }

          return bookings;
        }
      });
      if (linkedOrderId) {
        await updateOrders((orders) => {
          const nowIso = new Date().toISOString();
          return orders.map((order) => order.id === linkedOrderId
            ? normalizeOrder({
                ...order,
                status: order.paymentStatus === 'paid' ? 'cancelled' : order.status,
                cancellation: {
                  policy: 'manager-cancelled',
                  cancelledAt: nowIso
                },
                updatedAt: nowIso
              })
            : order);
        }).catch((error) => {
          console.error('Linked order cancel update error:', error.message);
        });
      }
      return res.json({ success: true });
    }

    if (action === 'get-availability') {
      const { data: availability } = await readAvailability();
      return res.json(availability);
    }

    if (action === 'save-availability') {
      const { availability } = req.body;
      await updateSingletonJsonBlob({
        read: readAvailability,
        write: writeAvailability,
        errorMessage: 'Could not update availability. Please try again.',
        mutate: async () => {
          const nextAvailability = normalizeAvailability(availability);
          nextAvailability.updatedAt = new Date().toISOString();
          return nextAvailability;
        }
      });
      return res.json({ success: true });
    }

    if (action === 'save-recurring-block') {
      const { recurringBlock } = req.body || {};
      let savedRecurringBlock = null;

      await updateSingletonJsonBlob({
        read: readAvailability,
        write: writeAvailability,
        errorMessage: 'Could not update the recurring block. Please try again.',
        mutate: async (availability) => {
          const nextRecurringBlock = normalizeRecurringBlockEntry(
            {
              ...(recurringBlock && typeof recurringBlock === 'object' ? recurringBlock : {}),
              updatedAt: new Date().toISOString()
            },
            availability
          );

          if (!nextRecurringBlock) {
            const validationError = new Error('Recurring block is invalid.');
            validationError.statusCode = 400;
            throw validationError;
          }

          availability.recurringBlocks = upsertRecurringBlock(
            availability.recurringBlocks,
            nextRecurringBlock,
            availability
          );
          availability.updatedAt = nextRecurringBlock.updatedAt;
          savedRecurringBlock = nextRecurringBlock;
          return availability;
        }
      });

      return res.json({
        success: true,
        recurringBlock: savedRecurringBlock
      });
    }

    if (action === 'delete-recurring-block') {
      const recurringBlockId =
        typeof (req.body && req.body.recurringBlockId) === 'string'
          ? req.body.recurringBlockId.trim()
          : '';

      if (!recurringBlockId) {
        return res.status(400).json({ error: 'A recurring block id is required.' });
      }

      await updateSingletonJsonBlob({
        read: readAvailability,
        write: writeAvailability,
        errorMessage: 'Could not remove the recurring block. Please try again.',
        mutate: async (availability) => {
          availability.recurringBlocks = removeRecurringBlock(
            availability.recurringBlocks,
            recurringBlockId,
            availability
          );
          availability.updatedAt = new Date().toISOString();
          return availability;
        }
      });

      return res.json({ success: true });
    }

    if (action === 'block') {
      const { date, time, endTime, durationMinutes, reason, blockId } = req.body;
      await updateSingletonJsonBlob({
        read: readAvailability,
        write: writeAvailability,
        errorMessage: 'Could not block that date. Please try again.',
        mutate: async (availability) => {
          if (time) {
            availability.blockedSlots = upsertBlockedSlot(
              availability.blockedSlots,
              {
                id: blockId,
                date,
                time,
                endTime,
                durationMinutes,
                reason: reason || 'Blocked',
                updatedAt: new Date().toISOString()
              },
              availability
            );
          } else {
            availability.blockedDates = upsertBlockedDate(availability.blockedDates, date, reason);
          }

          availability.updatedAt = new Date().toISOString();
          return availability;
        }
      });
      return res.json({ success: true });
    }

    if (action === 'unblock') {
      const { date, time, blockId } = req.body;
      await updateSingletonJsonBlob({
        read: readAvailability,
        write: writeAvailability,
        errorMessage: 'Could not unblock that date. Please try again.',
        mutate: async (availability) => {
          if (time) {
            availability.blockedSlots = removeBlockedSlot(
              availability.blockedSlots,
              { blockId, date, time },
              availability
            );
          } else {
            availability.blockedDates = removeBlockedDate(availability.blockedDates, date);
          }

          availability.updatedAt = new Date().toISOString();
          return availability;
        }
      });
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('Booking error:', error.storageDetail || error.message);
    const statusCode =
      Number.isInteger(error && error.statusCode) && error.statusCode >= 400
        ? error.statusCode
        : 500;
    res.status(statusCode).json({ error: error.message || 'Booking system error' });
  }
};
