const crypto = require('crypto');
const { put, head, BlobPreconditionFailedError } = require('@vercel/blob');
const packageJson = require('../package.json');

const BOOKINGS_PATH = 'bookings-data.json';
const AVAILABILITY_PATH = 'availability-config.json';
const MANAGER_DEVICES_PATH = 'manager-devices.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const MANAGER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const JSON_CONTENT_TYPE = 'application/json';
const JSON_BLOB_MAX_ATTEMPTS = 3;

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
    blockedDates: [],
    blockedSlots: [],
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
  return process.env.MANAGER_SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
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

  const [encodedPayload, signature] = String(token).split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = base64UrlEncode(
    crypto
      .createHmac('sha256', getManagerSessionSecret())
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

  return {
    ...defaults,
    ...(availability || {}),
    weeklyHours,
    blockedDates: Array.isArray(availability && availability.blockedDates) ? availability.blockedDates : [],
    blockedSlots: Array.isArray(availability && availability.blockedSlots) ? availability.blockedSlots : [],
    slotDuration:
      Number.isInteger(availability && availability.slotDuration) && availability.slotDuration > 0
        ? availability.slotDuration
        : defaults.slotDuration,
    maxAdvanceDays:
      Number.isInteger(availability && availability.maxAdvanceDays) && availability.maxAdvanceDays >= 0
        ? availability.maxAdvanceDays
        : defaults.maxAdvanceDays,
    updatedAt: typeof (availability && availability.updatedAt) === 'string' ? availability.updatedAt : null
  };
}

function normalizeBooking(booking) {
  const parsedFallbackDate = Date.parse(`${booking.date || '1970-01-01'}T${booking.time || '00:00'}:00.000Z`);
  const fallbackUpdatedAt =
    typeof booking.createdAt === 'string'
      ? booking.createdAt
      : new Date(Number.isNaN(parsedFallbackDate) ? 0 : parsedFallbackDate).toISOString();

  return {
    ...booking,
    status: booking.status || 'confirmed',
    updatedAt: typeof booking.updatedAt === 'string' ? booking.updatedAt : fallbackUpdatedAt
  };
}

function sortBookings(bookings) {
  bookings.sort((left, right) => (left.date + left.time).localeCompare(right.date + right.time));
  return bookings;
}

function getLatestSyncAt(bookings, availability) {
  const candidates = [];

  for (const booking of bookings) {
    if (typeof booking.updatedAt === 'string') candidates.push(booking.updatedAt);
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
  return details.join(' · ');
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
  if ((availability.blockedDates || []).includes(dateStr)) {
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

function getAvailableSlots(dateStr, availability, bookings) {
  const rules = getDateRules(dateStr, availability);
  if (!rules.ok) return rules;

  const slots = [];
  for (
    let totalMinutes = rules.startMinutes;
    totalMinutes + rules.slotDuration <= rules.endMinutes;
    totalMinutes += rules.slotDuration
  ) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    const blocked = (availability.blockedSlots || []).some((slot) => slot.date === dateStr && slot.time === time);
    const booked = bookings.some((booking) => booking.date === dateStr && booking.time === time && booking.status !== 'cancelled');

    if (!blocked && !booked) {
      const hours12 = hours > 12 ? hours - 12 : hours === 0 ? 12 : hours;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      slots.push({ time, label: `${hours12}:${String(minutes).padStart(2, '0')} ${ampm}` });
    }
  }

  return { ok: true, slots };
}

function validateBookingRequest(dateStr, timeStr, availability, bookings) {
  const rules = getDateRules(dateStr, availability);
  if (!rules.ok) return rules;

  const time = parseTimeValue(timeStr);
  if (!time) {
    return { ok: false, status: 400, error: 'Invalid time' };
  }
  if (time.totalMinutes < rules.startMinutes || time.totalMinutes + rules.slotDuration > rules.endMinutes) {
    return { ok: false, status: 400, error: 'That time is outside business hours.' };
  }
  if ((time.totalMinutes - rules.startMinutes) % rules.slotDuration !== 0) {
    return { ok: false, status: 400, error: 'That time is not a valid booking slot.' };
  }
  if ((availability.blockedSlots || []).some((slot) => slot.date === dateStr && slot.time === time.normalized)) {
    return { ok: false, status: 409, error: 'That slot is blocked. Please pick another.' };
  }
  if (bookings.some((booking) => booking.date === dateStr && booking.time === time.normalized && booking.status !== 'cancelled')) {
    return { ok: false, status: 409, error: 'That slot was just booked. Please pick another.' };
  }

  return { ok: true, time: time.normalized };
}

async function readJsonBlob(path, fallbackValue, token) {
  try {
    const metadata = await head(path, { token });
    const response = await fetch(metadata.url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: JSON_CONTENT_TYPE
      },
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`Failed to read ${path}`);
    }

    return {
      data: await response.json(),
      etag: metadata.etag
    };
  } catch (error) {
    if (isBlobNotFoundError(error)) {
      return {
        data: cloneJson(fallbackValue),
        etag: null
      };
    }

    throw error;
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
      ? payload.map(normalizeManagerDevice).filter((device) => device.pushToken)
      : [];

    return { data: devices, etag };
  }

  async function writeManagerDevices(devices, etag) {
    await writeJsonBlob(MANAGER_DEVICES_PATH, devices, etag, token);
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
      const filteredDevices = devices.filter((device) => !tokenSet.has(device.pushToken));
      if (filteredDevices.length === devices.length) return 0;

      try {
        await writeManagerDevices(filteredDevices, etag);
        return devices.length - filteredDevices.length;
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

  try {
    if (action === 'get-slots') {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: 'Date required' });

      const [{ data: availability }, { data: bookings }] = await Promise.all([readAvailability(), readBookings()]);
      const result = getAvailableSlots(date, availability, bookings);
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
            : 30
      });
    }

    if (action === 'manager-bootstrap') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const [{ data: bookings }, { data: availability }] = await Promise.all([readBookings(), readAvailability()]);
      const normalizedBookings = sortBookings(bookings.map(normalizeBooking));
      return res.json({
        bookings: normalizedBookings,
        availability,
        serverTime: new Date().toISOString(),
        latestSyncAt: getLatestSyncAt(normalizedBookings, availability),
        version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
      });
    }

    if (action === 'manager-sync') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const sinceTimestamp = parseSyncTimestamp(req.body && req.body.since);
      const [{ data: bookings }, { data: availability }] = await Promise.all([readBookings(), readAvailability()]);
      const normalizedBookings = sortBookings(bookings.map(normalizeBooking));
      const changedBookings =
        sinceTimestamp === null
          ? normalizedBookings
          : normalizedBookings.filter((booking) => Date.parse(booking.updatedAt) > sinceTimestamp);
      const availabilityChanged =
        sinceTimestamp === null ||
        (availability.updatedAt && Date.parse(availability.updatedAt) > sinceTimestamp);

      return res.json({
        bookings: changedBookings,
        availability: availabilityChanged ? availability : null,
        serverTime: new Date().toISOString(),
        latestSyncAt: getLatestSyncAt(normalizedBookings, availability),
        version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
      });
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
        const existingIndex = devices.findIndex((device) =>
          device.pushToken === pushToken || (normalizedDeviceId && device.deviceId === normalizedDeviceId)
        );

        const existingDevice = existingIndex >= 0 ? devices[existingIndex] : null;
        const nextDevice = normalizeManagerDevice({
          ...existingDevice,
          pushToken,
          deviceId: normalizedDeviceId,
          platform: typeof platform === 'string' ? platform : existingDevice && existingDevice.platform,
          deviceName: typeof deviceName === 'string' ? deviceName : existingDevice && existingDevice.deviceName,
          appVersion: typeof appVersion === 'string' ? appVersion : existingDevice && existingDevice.appVersion,
          createdAt: existingDevice && existingDevice.createdAt ? existingDevice.createdAt : nowIso,
          updatedAt: nowIso,
          lastSeenAt: nowIso
        });

        if (existingIndex >= 0) {
          devices[existingIndex] = nextDevice;
        } else {
          devices.push(nextDevice);
        }

        try {
          await writeManagerDevices(devices, etag);
          return res.json({ success: true, device: nextDevice });
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
          await writeManagerDevices(filteredDevices, etag);
          return res.json({ success: true, removed });
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) continue;
          throw error;
        }
      }

      return res.status(409).json({ error: 'Could not unregister push token. Please try again.' });
    }

    if (action === 'send-test-notification') {
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });

      const { pushToken } = req.body || {};
      let devices;
      let shouldPrune = false;

      if (pushToken) {
        if (!isExpoPushToken(pushToken)) {
          return res.status(400).json({ error: 'A valid Expo push token is required.' });
        }
        devices = [normalizeManagerDevice({ pushToken, platform: 'unknown' })];
      } else {
        const managerDevices = await readManagerDevices();
        devices = managerDevices.data;
        shouldPrune = true;
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

      return res.json({ success: true, ...result });
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

    if (action === 'book') {
      const { date, time, name, phone, vehicle, service, notes } = req.body;
      if (!date || !time || !name || !phone) {
        return res.status(400).json({ error: 'Date, time, name, and phone are required' });
      }

      const { data: availability } = await readAvailability();

      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: bookings, etag } = await readBookings();
        const validation = validateBookingRequest(date, time, availability, bookings);
        if (!validation.ok) {
          return res.status(validation.status).json({ error: validation.error });
        }

        const nowIso = new Date().toISOString();
        const booking = {
          id: 'BK-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
          date,
          time: validation.time,
          name,
          phone,
          vehicle: vehicle || '',
          service: service || '',
          notes: notes || '',
          status: 'confirmed',
          createdAt: nowIso,
          updatedAt: nowIso
        };

        bookings.push(booking);

        try {
          await writeBookings(bookings, etag);

          let notificationResult = { attempted: 0, sent: 0, invalidTokens: [] };
          try {
            notificationResult = await notifyManagersAboutBooking(booking);
          } catch (notificationError) {
            console.error('Push notification error:', notificationError.message);
          }

          return res.json({ success: true, booking, notifications: notificationResult });
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) {
            continue;
          }
          throw error;
        }
      }

      return res.status(409).json({ error: 'That slot was just booked. Please pick another.' });
    }

    if (!authed) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'list-bookings') {
      const { data: bookings } = await readBookings();
      return res.json({ bookings: sortBookings(bookings.map(normalizeBooking)) });
    }

    if (action === 'cancel-booking') {
      const { bookingId } = req.body;
      await updateSingletonJsonBlob({
        read: readBookings,
        write: writeBookings,
        errorMessage: 'Could not update the booking. Please try again.',
        mutate: async (bookings) => {
          const booking = bookings.find((entry) => entry.id === bookingId);

          if (booking && booking.status !== 'cancelled') {
            booking.status = 'cancelled';
            booking.updatedAt = new Date().toISOString();
            booking.cancelledAt = booking.updatedAt;
          }

          return bookings;
        }
      });
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

    if (action === 'block') {
      const { date, time, reason } = req.body;
      await updateSingletonJsonBlob({
        read: readAvailability,
        write: writeAvailability,
        errorMessage: 'Could not block that date. Please try again.',
        mutate: async (availability) => {
          if (time) {
            availability.blockedSlots = availability.blockedSlots || [];
            availability.blockedSlots.push({ date, time, reason: reason || 'Blocked' });
          } else {
            availability.blockedDates = availability.blockedDates || [];
            if (!availability.blockedDates.includes(date)) availability.blockedDates.push(date);
          }

          availability.updatedAt = new Date().toISOString();
          return availability;
        }
      });
      return res.json({ success: true });
    }

    if (action === 'unblock') {
      const { date, time } = req.body;
      await updateSingletonJsonBlob({
        read: readAvailability,
        write: writeAvailability,
        errorMessage: 'Could not unblock that date. Please try again.',
        mutate: async (availability) => {
          if (time) {
            availability.blockedSlots = (availability.blockedSlots || []).filter((slot) => !(slot.date === date && slot.time === time));
          } else {
            availability.blockedDates = (availability.blockedDates || []).filter((blockedDate) => blockedDate !== date);
          }

          availability.updatedAt = new Date().toISOString();
          return availability;
        }
      });
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('Booking error:', error.message);
    res.status(500).json({ error: error.message || 'Booking system error' });
  }
};
