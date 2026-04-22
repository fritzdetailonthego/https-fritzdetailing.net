const { put, list, head, BlobPreconditionFailedError } = require('@vercel/blob');
const packageJson = require('../package.json');

const BOOKINGS_PATH = 'bookings-data.json';
const AVAILABILITY_PATH = 'availability-config.json';
const DAY_MS = 24 * 60 * 60 * 1000;

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

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const { action, password } = req.body || {};
  const authed = password && password === process.env.ADMIN_PASSWORD;

  async function readBookings() {
    const { blobs } = await list({ prefix: 'bookings-data', token });
    if (blobs.length === 0) return { bookings: [], etag: null };

    const metadata = await head(BOOKINGS_PATH, { token });
    const response = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('Failed to read bookings data');

    return { bookings: await response.json(), etag: metadata.etag };
  }

  async function writeBookings(bookings, etag) {
    const options = {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      token
    };

    if (etag) {
      options.allowOverwrite = true;
      options.ifMatch = etag;
    }

    await put(BOOKINGS_PATH, JSON.stringify(bookings), options);
  }

  async function readAvailability() {
    const { blobs } = await list({ prefix: 'availability-config', token });
    if (blobs.length === 0) return { availability: buildDefaultAvailability(), etag: null };

    const metadata = await head(AVAILABILITY_PATH, { token });
    const response = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('Failed to read availability data');

    return { availability: await response.json(), etag: metadata.etag };
  }

  async function writeAvailability(availability, etag) {
    const options = {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      token
    };

    if (etag) {
      options.allowOverwrite = true;
      options.ifMatch = etag;
    }

    await put(AVAILABILITY_PATH, JSON.stringify(availability), options);
  }

  try {
    if (action === 'get-slots') {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: 'Date required' });

      const [{ availability }, { bookings }] = await Promise.all([readAvailability(), readBookings()]);
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
      const { availability } = await readAvailability();
      return res.json({
        maxAdvanceDays:
          Number.isInteger(availability.maxAdvanceDays) && availability.maxAdvanceDays >= 0
            ? availability.maxAdvanceDays
            : 30
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

    if (action === 'book') {
      const { date, time, name, phone, vehicle, service, notes } = req.body;
      if (!date || !time || !name || !phone) {
        return res.status(400).json({ error: 'Date, time, name, and phone are required' });
      }

      const { availability } = await readAvailability();

      for (let attempt = 0; attempt < 3; attempt++) {
        const { bookings, etag } = await readBookings();
        const validation = validateBookingRequest(date, time, availability, bookings);
        if (!validation.ok) {
          return res.status(validation.status).json({ error: validation.error });
        }

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
          createdAt: new Date().toISOString()
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

      return res.status(409).json({ error: 'That slot was just booked. Please pick another.' });
    }

    if (!authed) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'list-bookings') {
      const { bookings } = await readBookings();
      bookings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return res.json({ bookings });
    }

    if (action === 'cancel-booking') {
      const { bookingId } = req.body;
      const { bookings, etag } = await readBookings();
      const booking = bookings.find((entry) => entry.id === bookingId);
      if (booking) booking.status = 'cancelled';
      await writeBookings(bookings, etag);
      return res.json({ success: true });
    }

    if (action === 'get-availability') {
      const { availability } = await readAvailability();
      return res.json(availability);
    }

    if (action === 'save-availability') {
      const { availability } = req.body;
      const current = await readAvailability();
      await writeAvailability(availability, current.etag);
      return res.json({ success: true });
    }

    if (action === 'block') {
      const { date, time, reason } = req.body;
      const current = await readAvailability();
      const availability = current.availability;

      if (time) {
        availability.blockedSlots = availability.blockedSlots || [];
        availability.blockedSlots.push({ date, time, reason: reason || 'Blocked' });
      } else {
        availability.blockedDates = availability.blockedDates || [];
        if (!availability.blockedDates.includes(date)) availability.blockedDates.push(date);
      }

      await writeAvailability(availability, current.etag);
      return res.json({ success: true });
    }

    if (action === 'unblock') {
      const { date, time } = req.body;
      const current = await readAvailability();
      const availability = current.availability;

      if (time) {
        availability.blockedSlots = (availability.blockedSlots || []).filter((slot) => !(slot.date === date && slot.time === time));
      } else {
        availability.blockedDates = (availability.blockedDates || []).filter((blockedDate) => blockedDate !== date);
      }

      await writeAvailability(availability, current.etag);
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('Booking error:', error.message);
    res.status(500).json({ error: error.message || 'Booking system error' });
  }
};
