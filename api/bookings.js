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
  const authed = password && password === process.env.ADMIN_PASSWORD;

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

  async function writeBookings(bookings) {
    await put('bookings-data.json', JSON.stringify(bookings), {
      access: 'public',
      contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token
    });
  }

  async function readAvailability() {
    try {
      const { blobs } = await list({ prefix: 'availability-config', token });
      if (blobs.length > 0) {
        const r = await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return await r.json();
      }
    } catch(e) {}
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
      access: 'public',
      contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, token
    });
  }

  try {
    if (action === 'get-slots') {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: 'Date required' });

      const avail = await readAvailability();
      const bookings = await readBookings();
      const dayOfWeek = ['sun','mon','tue','wed','thu','fri','sat'][new Date(date + 'T12:00:00').getDay()];
      const dayConfig = avail.weeklyHours[dayOfWeek];

      if (!dayConfig || !dayConfig.open) return res.json({ slots: [], closed: true });
      if (avail.blockedDates.includes(date)) return res.json({ slots: [], blocked: true });

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

    if (action === 'book') {
      const { date, time, name, phone, vehicle, service, notes } = req.body;
      if (!date || !time || !name || !phone) {
        return res.status(400).json({ error: 'Date, time, name, and phone are required' });
      }

      const bookings = await readBookings();
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

    if (!authed) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'list-bookings') {
      const bookings = await readBookings();
      bookings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return res.json({ bookings });
    }

    if (action === 'cancel-booking') {
      const { bookingId } = req.body;
      const bookings = await readBookings();
      const bk = bookings.find(b => b.id === bookingId);
      if (bk) bk.status = 'cancelled';
      await writeBookings(bookings);
      return res.json({ success: true });
    }

    if (action === 'get-availability') {
      return res.json(await readAvailability());
    }

    if (action === 'save-availability') {
      const { availability } = req.body;
      await writeAvailability(availability);
      return res.json({ success: true });
    }

    if (action === 'block') {
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

    if (action === 'unblock') {
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
