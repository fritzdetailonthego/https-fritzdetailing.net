// Booking system — stores in Vercel Blob, manages availability
const { put, list } = require('@vercel/blob');

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
  const { action, password } = req.body;

  // Helper: read bookings
  async function readBookings() {
    try {
      const { blobs } = await list({ prefix: 'bookings-data', token });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return await r.json();
      }
    } catch(e) {}
    return [];
  }

  // Helper: write bookings
  async function writeBookings(bookings) {
    await put('bookings-data.json', JSON.stringify(bookings), {
      access: 'private',
      contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token
    });
  }

  // Helper: read availability config
  async function readAvailability() {
    try {
      const { blobs } = await list({ prefix: 'availability-config', token });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return await r.json();
      }
    } catch(e) {}
    // Default availability
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
      slotDuration: 120, // minutes per slot
      blockedDates: [], // ["2026-04-01", "2026-04-02"]
      blockedSlots: [], // [{ date: "2026-04-03", time: "10:00", reason: "School" }]
      maxAdvanceDays: 30
    };
  }

  async function writeAvailability(config) {
    await put('availability-config.json', JSON.stringify(config), {
      access: 'private',
      contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token
    });
  }

  try {
    // PUBLIC: Get available slots for a date
    if (action === 'get-slots') {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: 'Date required' });

      const avail = await readAvailability();
      const bookings = await readBookings();
      const dayOfWeek = ['sun','mon','tue','wed','thu','fri','sat'][new Date(date + 'T12:00:00').getDay()];
      const dayConfig = avail.weeklyHours[dayOfWeek];

      if (!dayConfig || !dayConfig.open) return res.json({ slots: [], closed: true });
      if (avail.blockedDates.includes(date)) return res.json({ slots: [], blocked: true });

      // Generate slots
      const slots = [];
      const startMin = parseInt(dayConfig.start.split(':')[0]) * 60 + parseInt(dayConfig.start.split(':')[1]);
      const endMin = parseInt(dayConfig.end.split(':')[0]) * 60 + parseInt(dayConfig.end.split(':')[1]);
      const duration = avail.slotDuration || 120;

      for (let m = startMin; m + duration <= endMin; m += duration) {
        const h = Math.floor(m / 60);
        const mm = m % 60;
        const timeStr = `${h.toString().padStart(2,'0')}:${mm.toString().padStart(2,'0')}`;
        const isBlocked = (avail.blockedSlots || []).some(b => b.date === date && b.time === timeStr);
        const isBooked = bookings.some(b => b.date === date && b.time === timeStr && b.status !== 'cancelled');

        if (!isBlocked && !isBooked) {
          const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
          const ampm = h >= 12 ? 'PM' : 'AM';
          slots.push({ time: timeStr, label: `${h12}:${mm.toString().padStart(2,'0')} ${ampm}` });
        }
      }

      return res.json({ slots, date });
    }

    // PUBLIC: Book a slot
    if (action === 'book') {
      const { date, time, name, phone, vehicle, service, notes } = req.body;
      if (!date || !time || !name || !phone) {
        return res.status(400).json({ error: 'Date, time, name, and phone are required' });
      }

      const bookings = await readBookings();

      // Check if slot is still available
      const taken = bookings.some(b => b.date === date && b.time === time && b.status !== 'cancelled');
      if (taken) return res.status(409).json({ error: 'That slot was just booked. Please pick another.' });

      const booking = {
        id: 'BK-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
        date, time, name, phone,
        vehicle: vehicle || '',
        service: service || '',
        notes: notes || '',
        status: 'confirmed',
        createdAt: new Date().toISOString()
      };

      bookings.push(booking);
      await writeBookings(bookings);

      return res.json({ success: true, booking });
    }

    // ADMIN: Get all bookings
    if (action === 'list-bookings') {
      if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const bookings = await readBookings();
      bookings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return res.json({ bookings });
    }

    // ADMIN: Cancel a booking
    if (action === 'cancel-booking') {
      if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { bookingId } = req.body;
      const bookings = await readBookings();
      const bk = bookings.find(b => b.id === bookingId);
      if (bk) bk.status = 'cancelled';
      await writeBookings(bookings);
      return res.json({ success: true });
    }

    // ADMIN: Get availability config
    if (action === 'get-availability') {
      if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      return res.json(await readAvailability());
    }

    // ADMIN: Save availability config
    if (action === 'save-availability') {
      if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { availability } = req.body;
      await writeAvailability(availability);
      return res.json({ success: true });
    }

    // ADMIN: Block a date or slot
    if (action === 'block') {
      if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { date, time, reason } = req.body;
      const avail = await readAvailability();
      if (time) {
        avail.blockedSlots = avail.blockedSlots || [];
        avail.blockedSlots.push({ date, time, reason: reason || 'Blocked' });
      } else {
        avail.blockedDates = avail.blockedDates || [];
        if (!avail.blockedDates.includes(date)) avail.blockedDates.push(date);
      }
      await writeAvailability(avail);
      return res.json({ success: true });
    }

    // ADMIN: Unblock
    if (action === 'unblock') {
      if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
      const { date, time } = req.body;
      const avail = await readAvailability();
      if (time) {
        avail.blockedSlots = (avail.blockedSlots || []).filter(b => !(b.date === date && b.time === time));
      } else {
        avail.blockedDates = (avail.blockedDates || []).filter(d => d !== date);
      }
      await writeAvailability(avail);
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    console.error('Booking error:', error.message);
    res.status(500).json({ error: error.message || 'Booking system error' });
  }
};
