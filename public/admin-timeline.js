(function () {
  const root = document.getElementById('timeline-root');
  if (!root) return;

  const HOURS = Array.from({ length: 24 }, (_, index) => index);
  const DAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const TYPE_META = {
    customer: {
      label: 'Customer',
      copy: 'Live appointment on the board',
      className: 'tk-entry--customer',
      dot: '#9B4FDE',
      defaultName: '',
      defaultService: ''
    },
    private: {
      label: 'Private',
      copy: 'Internal hold or admin block',
      className: 'tk-entry--private',
      dot: '#F59E0B',
      defaultName: 'Private Hold',
      defaultService: 'Private Block'
    },
    travel: {
      label: 'Travel',
      copy: 'Drive interval between jobs',
      className: 'tk-entry--travel',
      dot: '#1D9E75',
      defaultName: 'Travel Buffer',
      defaultService: 'Travel Interval'
    },
    blocked: {
      label: 'Unavailable',
      copy: 'Hard availability block on the board',
      className: 'tk-entry--blocked',
      dot: '#E24B4A',
      defaultName: 'Unavailable',
      defaultService: 'Availability Block'
    },
    recurring: {
      label: 'Recurring',
      copy: 'Repeating unavailable hold',
      className: 'tk-entry--blocked',
      dot: '#E24B4A',
      defaultName: 'Recurring Hold',
      defaultService: 'Recurring Hold'
    }
  };
  const RECURRENCE_OPTIONS = [
    { value: 'none', label: 'One Time' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekdays', label: 'Weekdays' },
    { value: 'weekends', label: 'Weekends' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'custom', label: 'Custom' }
  ];
  const CUSTOM_DAY_OPTIONS = [
    { value: 0, label: 'S' },
    { value: 1, label: 'M' },
    { value: 2, label: 'T' },
    { value: 3, label: 'W' },
    { value: 4, label: 'T' },
    { value: 5, label: 'F' },
    { value: 6, label: 'S' }
  ];

  const state = {
    initialized: false,
    loading: false,
    syncing: false,
    selectedDate: startOfDay(new Date()),
    viewMonth: new Date().getMonth(),
    viewYear: new Date().getFullYear(),
    latestSyncAt: null,
    serverTime: null,
    version: null,
    bookings: [],
    availability: null,
    activeType: 'customer',
    editingBookingId: null,
    editingBlockedId: null,
    editingRecurringId: null,
    startTime: '',
    endTime: '',
    durationInput: '2:00',
    recurrence: 'none',
    customDays: [],
    recurrenceStartDate: dateKey(new Date()),
    recurrenceEndDate: '',
    name: '',
    phone: '',
    vehicle: '',
    service: '',
    notes: '',
    slotSuggestions: [],
    slotError: '',
    savePending: false,
    lastError: '',
    statusMessage: '',
    pollTimer: null
  };

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  }

  function parseLocalDate(value) {
    if (!value) return startOfDay(new Date());
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1, 0, 0, 0, 0);
  }

  function dateKey(date) {
    const current = date instanceof Date ? date : parseLocalDate(date);
    return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
  }

  function formatMonthYear(year, month) {
    return new Date(year, month, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  }

  function formatLongDate(date) {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function formatRelativeDateMeta(date) {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  }

  function minutesToTimeValue(totalMinutes) {
    const normalized = ((Math.floor(totalMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  function timeValueToMinutes(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function formatTimelineTime(totalMinutes) {
    const normalized = ((Math.floor(totalMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60);
    const hours = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    const suffix = hours >= 12 ? 'PM' : 'AM';
    const display = hours % 12 === 0 ? 12 : hours % 12;
    return minutes === 0 ? `${display} ${suffix}` : `${display}:${String(minutes).padStart(2, '0')} ${suffix}`;
  }

  function formatDuration(totalMinutes) {
    if (!totalMinutes || totalMinutes <= 0) return '0m';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes}m`;
    if (!minutes) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function getManagerFacingErrorMessage(error) {
    if (typeof window.getManagerFacingErrorMessage === 'function') {
      return window.getManagerFacingErrorMessage(error);
    }

    const message = error && error.message ? String(error.message) : String(error || 'Request failed');
    const normalized = message.toLowerCase();
    if (
      normalized.includes('failed to read') ||
      normalized.includes('storage is temporarily unavailable') ||
      normalized.includes('store is blocked') ||
      normalized.includes('store has been suspended') ||
      normalized.includes('bookings-data.json') ||
      normalized.includes('orders-data.json') ||
      normalized.includes('availability-config.json')
    ) {
      return 'Live data storage is temporarily unavailable. Please refresh and try again.';
    }

    return message;
  }

  function durationToInput(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}`;
  }

  function parseDurationInput(value) {
    const trimmed = String(value || '').trim().toLowerCase();
    if (!trimmed) return null;

    const hoursMinutes = trimmed.match(/^(\d+)\s*h\s*(?:(\d+)\s*m)?$/);
    if (hoursMinutes) {
      return Number(hoursMinutes[1]) * 60 + Number(hoursMinutes[2] || 0);
    }

    const minutesOnly = trimmed.match(/^(\d+)\s*m$/);
    if (minutesOnly) {
      return Number(minutesOnly[1]);
    }

    const parts = trimmed.split(':');
    if (parts.length >= 2 && parts.every((part) => /^\d+$/.test(part))) {
      return Number(parts[0]) * 60 + Number(parts[1]);
    }

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return numeric <= 24 ? numeric * 60 : numeric;
    }

    return null;
  }

  function normalizeRecurringPattern(value) {
    if (value === 'daily' || value === 'weekdays' || value === 'weekends' || value === 'custom') {
      return value;
    }

    if (value === 'weekly') {
      return value;
    }

    return 'weekly';
  }

  function normalizeCustomDays(days, fallbackDate) {
    const nextDays = Array.isArray(days)
      ? [...new Set(days.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort((left, right) => left - right)
      : [];

    if (nextDays.length > 0) {
      return nextDays;
    }

    return [parseLocalDate(fallbackDate || dateKey(new Date())).getDay()];
  }

  function formatRecurringPatternLabel(value) {
    switch (normalizeRecurringPattern(value)) {
      case 'daily':
        return 'Every day';
      case 'weekdays':
        return 'Weekdays';
      case 'weekends':
        return 'Weekends';
      case 'custom':
        return 'Custom days';
      case 'weekly':
      default:
        return 'Weekly';
    }
  }

  function doesRecurringBlockOccurOnDate(block, targetDateValue) {
    const targetDate = parseLocalDate(targetDateValue);
    const startDate = parseLocalDate(block.date);
    targetDate.setHours(0, 0, 0, 0);
    startDate.setHours(0, 0, 0, 0);

    if (targetDate < startDate) return false;
    if (block.endDate && dateKey(targetDate) > block.endDate) return false;

    const dayOfWeek = targetDate.getDay();
    switch (normalizeRecurringPattern(block.recurrence)) {
      case 'daily':
        return true;
      case 'weekdays':
        return dayOfWeek >= 1 && dayOfWeek <= 5;
      case 'weekends':
        return dayOfWeek === 0 || dayOfWeek === 6;
      case 'custom':
        return normalizeCustomDays(block.customDays, block.date).includes(dayOfWeek);
      case 'weekly':
      default:
        return dayOfWeek === startDate.getDay();
    }
  }

  function getMonthGrid(year, month) {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const rows = [];
    let week = Array(first.getDay()).fill(null);

    for (let day = 1; day <= last.getDate(); day += 1) {
      week.push(day);
      if (week.length === 7) {
        rows.push(week);
        week = [];
      }
    }

    if (week.length) {
      while (week.length < 7) week.push(null);
      rows.push(week);
    }

    return rows;
  }

  function getAvailability() {
    return state.availability || {
      weeklyHours: {},
      slotDuration: 120,
      customerBlockMinutes: 120,
      privateBlockMinutes: 120,
      travelBufferMinutes: 30,
      blockedDates: [],
      blockedSlots: [],
      recurringBlocks: []
    };
  }

  function getDefaultDuration(type) {
    const availability = getAvailability();
    if (type === 'private') return Number(availability.privateBlockMinutes) || Number(availability.slotDuration) || 120;
    if (type === 'travel') return Number(availability.travelBufferMinutes) || Number(availability.slotDuration) || 30;
    if (type === 'blocked') return Number(availability.slotDuration) || 60;
    return Number(availability.customerBlockMinutes) || Number(availability.slotDuration) || 120;
  }

  function getTimelineStepMinutes() {
    const slotDuration = Number(getAvailability().slotDuration) || 30;
    if (slotDuration < 15) return 15;
    if (slotDuration > 60) return 60;
    return slotDuration;
  }

  function getTimelineRowHeight() {
    const stepMinutes = getTimelineStepMinutes();
    if (stepMinutes >= 60) return 64;
    if (stepMinutes >= 30) return 36;
    return 24;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getDayHoursEntry(date) {
    const targetDate = date instanceof Date ? date : state.selectedDate;
    const availability = getAvailability();
    const keys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const entry = availability.weeklyHours && availability.weeklyHours[keys[targetDate.getDay()]];
    if (!entry || entry.open === false || entry.closed) return null;
    return entry;
  }

  function getTimelineWindow(entries) {
    const stepMinutes = getTimelineStepMinutes();
    const dayEntry = getDayHoursEntry(state.selectedDate);
    const scheduledStart = timeValueToMinutes(dayEntry && (dayEntry.start || dayEntry.open));
    const scheduledEnd = timeValueToMinutes(dayEntry && (dayEntry.end || dayEntry.close));
    const activeEntries = Array.isArray(entries) ? entries : [];
    const earliestEntry = activeEntries.length ? Math.min(...activeEntries.map((entry) => entry.startMinutes)) : null;
    const latestEntry = activeEntries.length ? Math.max(...activeEntries.map((entry) => entry.endMinutes)) : null;

    let startMinutes = scheduledStart;
    let endMinutes = scheduledEnd;

    if (earliestEntry != null) {
      const bufferedStart = Math.max(0, earliestEntry - stepMinutes);
      startMinutes = startMinutes == null ? bufferedStart : Math.min(startMinutes, bufferedStart);
    }

    if (latestEntry != null) {
      const bufferedEnd = Math.min(24 * 60, latestEntry + stepMinutes);
      endMinutes = endMinutes == null ? bufferedEnd : Math.max(endMinutes, bufferedEnd);
    }

    if (startMinutes == null) startMinutes = 8 * 60;
    if (endMinutes == null) endMinutes = 18 * 60;

    startMinutes = Math.floor(startMinutes / stepMinutes) * stepMinutes;
    endMinutes = Math.ceil(endMinutes / stepMinutes) * stepMinutes;

    if (endMinutes <= startMinutes) {
      endMinutes = Math.min(24 * 60, startMinutes + Math.max(stepMinutes * 6, 6 * 60));
    }

    const minimumSpan = Math.max(stepMinutes * 6, 6 * 60);
    if (endMinutes - startMinutes < minimumSpan) {
      endMinutes = Math.min(24 * 60, startMinutes + minimumSpan);
    }

    if (endMinutes > 24 * 60) {
      const overshoot = endMinutes - (24 * 60);
      startMinutes = Math.max(0, startMinutes - overshoot);
      endMinutes = 24 * 60;
    }

    return { startMinutes, endMinutes };
  }

  function getTimelineMetrics(entries) {
    const stepMinutes = getTimelineStepMinutes();
    const windowRange = getTimelineWindow(entries);
    const slotCount = Math.max(1, Math.ceil((windowRange.endMinutes - windowRange.startMinutes) / stepMinutes));
    const viewportHeight = typeof globalThis.window !== 'undefined' ? globalThis.window.innerHeight || 900 : 900;
    const viewportWidth = typeof globalThis.window !== 'undefined' ? globalThis.window.innerWidth || 1280 : 1280;
    const targetCanvasHeight = clamp(
      viewportHeight - (viewportWidth <= 680 ? 300 : 320),
      viewportWidth <= 680 ? 320 : 400,
      viewportWidth <= 680 ? 520 : 640
    );
    const minRowHeight = stepMinutes >= 60 ? 34 : stepMinutes >= 30 ? 18 : 12;
    const maxRowHeight = stepMinutes >= 60 ? 68 : stepMinutes >= 30 ? 36 : 24;
    const idealRowHeight = Math.floor(targetCanvasHeight / slotCount);
    const rowHeight = clamp(idealRowHeight, minRowHeight, maxRowHeight);
    const canvasHeight = slotCount * rowHeight;
    const scrollable = canvasHeight > targetCanvasHeight;
    const containerHeight = scrollable ? targetCanvasHeight : canvasHeight;
    const slots = Array.from({ length: slotCount }, (_, index) => windowRange.startMinutes + index * stepMinutes);

    return {
      ...windowRange,
      stepMinutes,
      slotCount,
      rowHeight,
      canvasHeight,
      containerHeight,
      scrollable,
      slots
    };
  }

  function getDisplayEntries(entries, metrics) {
    return entries
      .map((entry) => {
        const displayStartMinutes = Math.max(metrics.startMinutes, entry.startMinutes);
        const displayEndMinutes = Math.min(metrics.endMinutes, entry.endMinutes);
        if (displayEndMinutes <= displayStartMinutes) return null;

        return {
          ...entry,
          displayStartMinutes,
          displayEndMinutes
        };
      })
      .filter(Boolean);
  }

  function shouldShowSlotLabel(minutes, stepMinutes) {
    if (stepMinutes >= 60) return true;
    return minutes % 60 === 0;
  }

  function getDurationForBooking(booking) {
    if (Number.isInteger(booking.durationMinutes) && booking.durationMinutes > 0) {
      return booking.durationMinutes;
    }
    return getDefaultDuration(booking.bookingType || 'customer');
  }

  function normalizeBlockedDateEntries() {
    const raw = getAvailability().blockedDates || [];
    if (Array.isArray(raw)) {
      return raw.map((entry) => typeof entry === 'string'
        ? { date: entry, reason: '' }
        : { date: entry && entry.date, reason: entry && entry.reason ? entry.reason : '' })
        .filter((entry) => entry.date);
    }

    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([date, value]) => ({
        date,
        reason: typeof value === 'string' ? value : (value && value.reason ? value.reason : '')
      }));
    }

    return [];
  }

  function normalizeBlockedSlots() {
    const slotDuration = Number(getAvailability().slotDuration) || 60;
    const rawSlots = Array.isArray(getAvailability().blockedSlots) ? getAvailability().blockedSlots : [];
    return rawSlots.map((slot) => {
      const startMinutes = timeValueToMinutes(slot.time);
      const durationMinutes = Number(slot.durationMinutes) > 0
        ? Number(slot.durationMinutes)
        : (timeValueToMinutes(slot.endTime) != null && startMinutes != null
          ? Math.max(15, timeValueToMinutes(slot.endTime) - startMinutes)
          : slotDuration);

      return {
        id: slot.id || `${slot.date}-${slot.time}`,
        date: slot.date,
        time: slot.time,
        durationMinutes,
        endTime: slot.endTime || (startMinutes != null ? minutesToTimeValue(startMinutes + durationMinutes) : ''),
        reason: slot.reason || ''
      };
    }).filter((slot) => slot.date && slot.time);
  }

  function normalizeRecurringBlocks() {
    const slotDuration = Number(getAvailability().slotDuration) || 60;
    const rawBlocks = Array.isArray(getAvailability().recurringBlocks) ? getAvailability().recurringBlocks : [];
    return rawBlocks.map((block) => {
      const startMinutes = timeValueToMinutes(block.time);
      const durationMinutes = Number(block.durationMinutes) > 0
        ? Math.min(Number(block.durationMinutes), 24 * 60)
        : (timeValueToMinutes(block.endTime) != null && startMinutes != null
          ? Math.max(15, timeValueToMinutes(block.endTime) - startMinutes || slotDuration)
          : slotDuration);

      return {
        id: block.id || `RB-${block.date}-${block.time}`,
        label: block.label || 'Recurring Hold',
        date: block.date,
        time: block.time,
        durationMinutes,
        endTime: block.endTime || (startMinutes != null ? minutesToTimeValue(startMinutes + durationMinutes) : ''),
        recurrence: normalizeRecurringPattern(block.recurrence),
        customDays: normalizeCustomDays(block.customDays, block.date),
        endDate: block.endDate || '',
        notes: block.notes || '',
        updatedAt: block.updatedAt || ''
      };
    }).filter((block) => block.date && block.time);
  }

  function getTimelineEntriesForDate(date) {
    const selectedKey = typeof date === 'string' ? date : dateKey(date);
    const previousKeyDate = parseLocalDate(selectedKey);
    previousKeyDate.setDate(previousKeyDate.getDate() - 1);
    const previousKey = dateKey(previousKeyDate);
    const dayStart = parseLocalDate(selectedKey);
    const nextDay = new Date(dayStart);
    nextDay.setDate(nextDay.getDate() + 1);

    const bookingEntries = state.bookings
      .filter((booking) => String(booking.status || '').toLowerCase() !== 'cancelled')
      .map((booking) => {
        const startsAt = new Date(`${booking.date}T${booking.time || '00:00'}:00`);
        if (Number.isNaN(startsAt.getTime())) return null;
        const durationMinutes = getDurationForBooking(booking);
        const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);
        if (endsAt <= dayStart || startsAt >= nextDay) return null;

        const visibleStart = startsAt < dayStart ? dayStart : startsAt;
        const visibleEnd = endsAt > nextDay ? nextDay : endsAt;
        return {
          kind: booking.bookingType || 'customer',
          id: booking.id,
          bookingId: booking.id,
          title: booking.name || TYPE_META[booking.bookingType || 'customer'].label,
          subtitle: booking.service || 'No service label',
          note: booking.notes || '',
          phone: booking.phone || '',
          startMinutes: Math.max(0, Math.round((visibleStart.getTime() - dayStart.getTime()) / 60000)),
          endMinutes: Math.min(24 * 60, Math.round((visibleEnd.getTime() - dayStart.getTime()) / 60000)),
          durationMinutes,
          meta: booking,
          continuesFromPreviousDay: startsAt < dayStart,
          continuesToNextDay: endsAt > nextDay
        };
      })
      .filter(Boolean);

    const blockedEntries = normalizeBlockedSlots()
      .flatMap((slot) => {
        const startMinutes = timeValueToMinutes(slot.time);
        if (startMinutes == null) return [];

        const entries = [];
        if (slot.date === selectedKey) {
          entries.push({
            kind: 'blocked',
            id: slot.id,
            blockedId: slot.id,
            title: slot.reason || TYPE_META.blocked.label,
            subtitle: slot.reason || 'Availability block',
            note: slot.reason || '',
            phone: '',
            startMinutes,
            endMinutes: Math.min(24 * 60, startMinutes + slot.durationMinutes),
            durationMinutes: slot.durationMinutes,
            meta: slot,
            continuesFromPreviousDay: false,
            continuesToNextDay: startMinutes + slot.durationMinutes > 24 * 60
          });
        }

        if (slot.date === previousKey && startMinutes + slot.durationMinutes > 24 * 60) {
          entries.push({
            kind: 'blocked',
            id: `${slot.id}-carry`,
            blockedId: slot.id,
            title: slot.reason || TYPE_META.blocked.label,
            subtitle: slot.reason || 'Availability block',
            note: slot.reason || '',
            phone: '',
            startMinutes: 0,
            endMinutes: Math.min(24 * 60, startMinutes + slot.durationMinutes - 24 * 60),
            durationMinutes: slot.durationMinutes,
            meta: slot,
            continuesFromPreviousDay: true,
            continuesToNextDay: false
          });
        }

        return entries;
      })
      .filter(Boolean);

    const recurringEntries = normalizeRecurringBlocks()
      .flatMap((block) => {
        const startMinutes = timeValueToMinutes(block.time);
        if (startMinutes == null) return [];

        const entries = [];
        if (doesRecurringBlockOccurOnDate(block, selectedKey)) {
          entries.push({
            kind: 'recurring',
            id: block.id,
            recurringId: block.id,
            title: block.label || TYPE_META.recurring.label,
            subtitle: block.notes || formatRecurringPatternLabel(block.recurrence),
            note: block.notes || '',
            phone: '',
            startMinutes,
            endMinutes: Math.min(24 * 60, startMinutes + block.durationMinutes),
            durationMinutes: block.durationMinutes,
            meta: block,
            continuesFromPreviousDay: false,
            continuesToNextDay: startMinutes + block.durationMinutes > 24 * 60
          });
        }

        if (doesRecurringBlockOccurOnDate(block, previousKey) && startMinutes + block.durationMinutes > 24 * 60) {
          entries.push({
            kind: 'recurring',
            id: `${block.id}-carry`,
            recurringId: block.id,
            title: block.label || TYPE_META.recurring.label,
            subtitle: block.notes || formatRecurringPatternLabel(block.recurrence),
            note: block.notes || '',
            phone: '',
            startMinutes: 0,
            endMinutes: Math.min(24 * 60, startMinutes + block.durationMinutes - 24 * 60),
            durationMinutes: block.durationMinutes,
            meta: block,
            continuesFromPreviousDay: true,
            continuesToNextDay: false
          });
        }

        return entries;
      })
      .filter(Boolean);

    return [...bookingEntries, ...blockedEntries, ...recurringEntries].sort((left, right) =>
      left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes
    );
  }

  function getDayHours() {
    const entry = getDayHoursEntry(state.selectedDate);
    if (!entry || entry.open === false || entry.closed) return 'Closed';
    return `${entry.start || entry.open || '--:--'} - ${entry.end || entry.close || '--:--'}`;
  }

  function getSelectedEntries() {
    return getTimelineEntriesForDate(state.selectedDate);
  }

  function getSelectedBlockedDate() {
    return normalizeBlockedDateEntries().find((entry) => entry.date === dateKey(state.selectedDate)) || null;
  }

  function getOverlapWarnings() {
    const startMinutes = timeValueToMinutes(state.startTime);
    const durationMinutes = parseDurationInput(state.durationInput);
    if (startMinutes == null || !durationMinutes) return [];
    const endMinutes = startMinutes + durationMinutes;

    return getSelectedEntries().filter((entry) => {
      if (state.editingBookingId && entry.bookingId === state.editingBookingId) return false;
      if (state.editingBlockedId && entry.blockedId === state.editingBlockedId) return false;
      if (state.editingRecurringId && entry.recurringId === state.editingRecurringId) return false;
      return startMinutes < entry.endMinutes && endMinutes > entry.startMinutes;
    });
  }

  async function fetchJson(body) {
    const password = typeof window.getAdminPassword === 'function' ? window.getAdminPassword() : '';
    if (!password) throw new Error('Admin password missing');

    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(getManagerFacingErrorMessage(data.error || data.message || 'Request failed'));
    }
    return data;
  }

  function setDefaultComposerForType(type, preserveClock) {
    const defaults = TYPE_META[type];
    const nextDuration = durationToInput(getDefaultDuration(type));
    const currentStart = preserveClock ? state.startTime : '';
    const startMinutes = timeValueToMinutes(currentStart);
    const durationMinutes = parseDurationInput(nextDuration);
    state.activeType = type;
    state.durationInput = nextDuration;
    state.startTime = currentStart;
    state.endTime = startMinutes != null && durationMinutes ? minutesToTimeValue(startMinutes + durationMinutes) : '';
    state.name = defaults.defaultName;
    state.phone = '';
    state.vehicle = '';
    state.service = defaults.defaultService;
    state.notes = '';
    state.editingBookingId = null;
    state.editingBlockedId = null;
    state.editingRecurringId = null;
    state.recurrence = 'none';
    state.customDays = [];
    state.recurrenceStartDate = dateKey(state.selectedDate);
    state.recurrenceEndDate = '';
  }

  function clearComposer(nextType) {
    setDefaultComposerForType(nextType || state.activeType, false);
    state.lastError = '';
    render();
    void refreshSlots();
  }

  function updateEndFromDuration() {
    const startMinutes = timeValueToMinutes(state.startTime);
    const durationMinutes = parseDurationInput(state.durationInput);
    if (startMinutes != null && durationMinutes) {
      state.endTime = minutesToTimeValue(startMinutes + durationMinutes);
    }
  }

  function updateDurationFromEnd() {
    const startMinutes = timeValueToMinutes(state.startTime);
    const endMinutes = timeValueToMinutes(state.endTime);
    if (startMinutes == null || endMinutes == null) return;
    let totalMinutes = endMinutes - startMinutes;
    if (totalMinutes <= 0) totalMinutes += 24 * 60;
    state.durationInput = durationToInput(totalMinutes);
  }

  function beginEditEntry(entry) {
    state.activeType = entry.kind === 'recurring' ? 'blocked' : entry.kind;
    state.startTime = minutesToTimeValue(entry.startMinutes);
    state.durationInput = durationToInput(entry.durationMinutes);
    state.endTime = minutesToTimeValue(entry.endMinutes);
    state.lastError = '';

    if (entry.kind === 'recurring') {
      state.editingRecurringId = entry.recurringId;
      state.editingBlockedId = null;
      state.editingBookingId = null;
      state.recurrence = normalizeRecurringPattern(entry.meta.recurrence);
      state.customDays = normalizeCustomDays(entry.meta.customDays, entry.meta.date);
      state.recurrenceStartDate = entry.meta.date || dateKey(state.selectedDate);
      state.recurrenceEndDate = entry.meta.endDate || '';
      state.name = entry.meta.label || TYPE_META.recurring.defaultName;
      state.phone = '';
      state.vehicle = '';
      state.service = formatRecurringPatternLabel(entry.meta.recurrence);
      state.notes = entry.meta.notes || '';
    } else if (entry.kind === 'blocked') {
      state.editingBlockedId = entry.blockedId;
      state.editingBookingId = null;
      state.editingRecurringId = null;
      state.recurrence = 'none';
      state.customDays = [];
      state.recurrenceStartDate = entry.meta.date || dateKey(state.selectedDate);
      state.recurrenceEndDate = '';
      state.name = TYPE_META.blocked.defaultName;
      state.phone = '';
      state.vehicle = '';
      state.service = entry.meta.reason || TYPE_META.blocked.defaultService;
      state.notes = entry.meta.reason || '';
    } else {
      state.editingBlockedId = null;
      state.editingBookingId = entry.bookingId;
      state.editingRecurringId = null;
      state.recurrence = 'none';
      state.customDays = [];
      state.recurrenceStartDate = entry.meta.date || dateKey(state.selectedDate);
      state.recurrenceEndDate = '';
      state.name = entry.meta.name || '';
      state.phone = entry.meta.phone || '';
      state.vehicle = entry.meta.vehicle || '';
      state.service = entry.meta.service || TYPE_META[entry.kind].defaultService;
      state.notes = entry.meta.notes || '';
    }

    render();
    void refreshSlots();
  }

  async function refreshSlots() {
    const type = state.activeType;
    if (type === 'blocked') {
      state.slotSuggestions = [];
      state.slotError = '';
      render();
      return;
    }

    const durationMinutes = parseDurationInput(state.durationInput);
    if (!durationMinutes || durationMinutes <= 0) {
      state.slotSuggestions = [];
      state.slotError = 'Enter a valid duration to load start times.';
      render();
      return;
    }

    try {
      const data = await fetchJson({
        action: 'get-slots',
        date: dateKey(state.selectedDate),
        bookingType: type,
        durationMinutes,
        excludeBookingId: state.editingBookingId || undefined
      });
      state.slotSuggestions = Array.isArray(data.slots) ? data.slots : [];
      state.slotError = data.error || '';
    } catch (error) {
      state.slotSuggestions = [];
      state.slotError = error.message || 'Could not load slot suggestions.';
    }

    render();
  }

  let bootstrapPromise = null;

  async function bootstrap(force) {
    const password = typeof window.getAdminPassword === 'function' ? window.getAdminPassword() : '';
    if (!password) return;
    if (bootstrapPromise) {
      await bootstrapPromise.catch(() => {});
      return;
    }
    if (state.initialized && !force) {
      await syncNow();
      return;
    }

    state.loading = true;
    state.lastError = '';
    render();

    bootstrapPromise = (async () => {
      const data = await fetchJson({ action: 'manager-bootstrap' });
      state.bookings = Array.isArray(data.bookings) ? data.bookings : [];
      state.availability = data.availability || null;
      state.latestSyncAt = data.latestSyncAt || null;
      state.serverTime = data.serverTime || null;
      state.version = data.version || null;
      state.initialized = true;
      syncViewToSelectedDate();
      refreshUpcomingTabs();
      render();
      void refreshSlots();
      requestAnimationFrame(scrollTimelineToAnchor);
      schedulePoll();
    })();

    try {
      await bootstrapPromise;
    } catch (error) {
      state.lastError = getManagerFacingErrorMessage(error);
      render();
    } finally {
      state.loading = false;
      bootstrapPromise = null;
      render();
    }
  }

  async function syncNow() {
    const password = typeof window.getAdminPassword === 'function' ? window.getAdminPassword() : '';
    if (!password || !state.latestSyncAt || state.syncing) return;

    state.syncing = true;
    render();

    try {
      const data = await fetchJson({
        action: 'manager-sync',
        since: state.latestSyncAt
      });
      const incomingBookings = Array.isArray(data.bookings) ? data.bookings : [];
      if (incomingBookings.length) {
        const byId = new Map(state.bookings.map((booking) => [booking.id, booking]));
        incomingBookings.forEach((booking) => byId.set(booking.id, booking));
        state.bookings = [...byId.values()];
      }
      if (data.availability) {
        state.availability = data.availability;
      }
      state.latestSyncAt = data.latestSyncAt || state.latestSyncAt;
      state.serverTime = data.serverTime || state.serverTime;
      state.version = data.version || state.version;
      refreshUpcomingTabs();
      render();
    } catch (error) {
      state.statusMessage = getManagerFacingErrorMessage(error);
      render();
    } finally {
      state.syncing = false;
      render();
    }
  }

  function schedulePoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
    }
    state.pollTimer = setInterval(() => {
      void syncNow();
    }, 30000);
  }

  function refreshUpcomingTabs() {
    const activeScheduleTab = typeof window.getActiveScheduleTab === 'function'
      ? window.getActiveScheduleTab()
      : '';
    if (activeScheduleTab === 'upcoming' && typeof window.loadBookings === 'function') window.loadBookings({ force: true });
    if (activeScheduleTab === 'availability' && typeof window.loadAvailability === 'function') window.loadAvailability({ force: true });
  }

  function syncViewToSelectedDate() {
    state.viewMonth = state.selectedDate.getMonth();
    state.viewYear = state.selectedDate.getFullYear();
  }

  function changeSelectedDate(nextDate) {
    state.selectedDate = startOfDay(nextDate);
    syncViewToSelectedDate();
    if (!state.editingBookingId && !state.editingBlockedId && !state.editingRecurringId) {
      state.startTime = '';
      state.endTime = '';
      state.recurrenceStartDate = dateKey(state.selectedDate);
    }
    render();
    void refreshSlots();
    requestAnimationFrame(scrollTimelineToAnchor);
  }

  function getMonthlyDots(dayKeyValue) {
    const entries = getTimelineEntriesForDate(dayKeyValue);
    const blockedDay = normalizeBlockedDateEntries().find((entry) => entry.date === dayKeyValue);
    const colors = [];
    if (blockedDay) colors.push(TYPE_META.blocked.dot);
    entries.forEach((entry) => {
      const color = TYPE_META[entry.kind] ? TYPE_META[entry.kind].dot : TYPE_META.blocked.dot;
      if (!colors.includes(color)) colors.push(color);
    });
    return colors.slice(0, 4);
  }

  function getSelectedDaySummary(entries, totalRangeMinutes) {
    const occupied = entries.reduce((total, entry) => total + Math.max(0, entry.endMinutes - entry.startMinutes), 0);
    return {
      count: entries.length,
      occupied,
      free: Math.max(0, totalRangeMinutes - occupied)
    };
  }

  function getTimelineMessages() {
    const messages = [];
    const blockedDay = getSelectedBlockedDate();
    const overlapWarnings = getOverlapWarnings();
    const selectedStart = state.startTime && state.slotSuggestions.some((slot) => slot.time === state.startTime);

    if (blockedDay) {
      messages.push({
        className: 'tk-status-card is-warn',
        text: blockedDay.reason
          ? `This full day is blocked: ${blockedDay.reason}`
          : 'This full day is currently blocked in availability settings.'
      });
    }

    if (state.activeType !== 'blocked' && state.startTime && !selectedStart && state.slotSuggestions.length > 0) {
      messages.push({
        className: 'tk-status-card',
        text: 'The chosen start time is outside the suggested grid, but manager save can still override it if the block fits.'
      });
    }

    if (state.activeType === 'blocked' && state.recurrence !== 'none') {
      messages.push({
        className: 'tk-status-card',
        text:
          `Repeats ${formatRecurringPatternLabel(state.recurrence)} starting ${state.recurrenceStartDate || dateKey(state.selectedDate)}` +
          (state.recurrenceEndDate ? ` until ${state.recurrenceEndDate}` : '') +
          '.'
      });
    }

    if (overlapWarnings.length > 0) {
      messages.push({
        className: 'tk-status-card is-warn',
        text: 'Overlap warning: ' + overlapWarnings.map((entry) => entry.title).slice(0, 4).join(', ')
      });
    }

    if (state.slotError) {
      messages.push({
        className: 'tk-status-card',
        text: state.slotError
      });
    }

    if (state.lastError) {
      messages.push({
        className: 'tk-status-card is-warn',
        text: state.lastError
      });
    }

    return messages;
  }

  async function saveComposer() {
    const durationMinutes = parseDurationInput(state.durationInput);
    const shouldSaveRecurring = state.activeType === 'blocked' && (state.recurrence !== 'none' || state.editingRecurringId);
    if (!state.startTime) {
      state.lastError = 'Choose a start time first.';
      render();
      return;
    }
    if (!durationMinutes || durationMinutes <= 0) {
      state.lastError = 'Duration must be greater than zero.';
      render();
      return;
    }
    if (state.activeType === 'customer' && (!state.name.trim() || !state.phone.trim())) {
      state.lastError = 'Customer bookings require a name and phone number.';
      render();
      return;
    }

    state.savePending = true;
    state.lastError = '';
    render();

    try {
      if (shouldSaveRecurring) {
        if (state.recurrence === 'none') {
          state.lastError = 'Choose a repeat pattern for this recurring hold.';
          render();
          return;
        }

        if (state.recurrence === 'custom' && state.customDays.length === 0) {
          state.lastError = 'Choose at least one weekday for a custom recurring hold.';
          render();
          return;
        }

        await fetchJson({
          action: 'save-recurring-block',
          recurringBlock: {
            id: state.editingRecurringId || undefined,
            label: state.name.trim() || state.service.trim() || state.notes.trim() || 'Recurring Hold',
            date: state.recurrenceStartDate || dateKey(state.selectedDate),
            time: state.startTime,
            durationMinutes,
            recurrence: state.recurrence,
            customDays: state.recurrence === 'custom' ? state.customDays : undefined,
            endDate: state.recurrenceEndDate || undefined,
            notes: state.notes.trim() || undefined
          }
        });
        if (typeof window.showToast === 'function') {
          window.showToast(state.editingRecurringId ? 'Recurring hold updated' : 'Recurring hold saved');
        }
      } else if (state.activeType === 'blocked') {
        await fetchJson({
          action: 'block',
          date: dateKey(state.selectedDate),
          time: state.startTime,
          durationMinutes,
          blockId: state.editingBlockedId || undefined,
          reason: state.notes.trim() || state.service.trim() || 'Blocked'
        });
        if (typeof window.showToast === 'function') window.showToast(state.editingBlockedId ? 'Blocked time updated' : 'Blocked time saved');
      } else if (state.editingBookingId) {
        await fetchJson({
          action: 'manager-update-booking',
          bookingId: state.editingBookingId,
          date: dateKey(state.selectedDate),
          time: state.startTime,
          bookingType: state.activeType,
          durationMinutes,
          name: state.name.trim() || TYPE_META[state.activeType].defaultName,
          phone: state.phone.trim(),
          vehicle: state.vehicle.trim(),
          service: state.service.trim() || TYPE_META[state.activeType].defaultService,
          notes: state.notes.trim()
        });
        if (typeof window.showToast === 'function') window.showToast('Timeline block updated');
      } else {
        await fetchJson({
          action: 'manager-create-booking',
          date: dateKey(state.selectedDate),
          time: state.startTime,
          bookingType: state.activeType,
          durationMinutes,
          name: state.name.trim() || TYPE_META[state.activeType].defaultName,
          phone: state.phone.trim(),
          vehicle: state.vehicle.trim(),
          service: state.service.trim() || TYPE_META[state.activeType].defaultService,
          notes: state.notes.trim()
        });
        if (typeof window.showToast === 'function') window.showToast('Timeline block saved');
      }

      const nextType = state.activeType;
      await bootstrap(true);
      clearComposer(nextType);
    } catch (error) {
      state.lastError = error.message || 'Save failed';
      render();
    } finally {
      state.savePending = false;
      render();
    }
  }

  async function removeCurrentEntry() {
    if (state.editingRecurringId) {
      const confirmed = typeof window.customConfirm === 'function'
        ? await window.customConfirm('Remove this recurring hold?')
        : window.confirm('Remove this recurring hold?');
      if (!confirmed) return;

      try {
        await fetchJson({
          action: 'delete-recurring-block',
          recurringBlockId: state.editingRecurringId
        });
        if (typeof window.showToast === 'function') window.showToast('Recurring hold removed');
        await bootstrap(true);
        clearComposer('blocked');
      } catch (error) {
        state.lastError = error.message || 'Could not remove the recurring hold.';
        render();
      }
      return;
    }

    if (state.editingBlockedId) {
      const confirmed = typeof window.customConfirm === 'function'
        ? await window.customConfirm('Remove this blocked time?')
        : window.confirm('Remove this blocked time?');
      if (!confirmed) return;

      try {
        await fetchJson({
          action: 'unblock',
          date: dateKey(state.selectedDate),
          time: state.startTime,
          blockId: state.editingBlockedId
        });
        if (typeof window.showToast === 'function') window.showToast('Blocked time removed');
        await bootstrap(true);
        clearComposer('blocked');
      } catch (error) {
        state.lastError = error.message || 'Could not remove the blocked time.';
        render();
      }
      return;
    }

    if (!state.editingBookingId) return;
    const confirmed = typeof window.customConfirm === 'function'
      ? await window.customConfirm('Cancel this booking block?')
      : window.confirm('Cancel this booking block?');
    if (!confirmed) return;

    try {
      await fetchJson({
        action: 'cancel-booking',
        bookingId: state.editingBookingId
      });
      if (typeof window.showToast === 'function') window.showToast('Booking cancelled');
      const nextType = state.activeType;
      await bootstrap(true);
      clearComposer(nextType);
    } catch (error) {
      state.lastError = error.message || 'Could not cancel this booking.';
      render();
    }
  }

  function renderCalendar() {
    const today = dateKey(new Date());
    const grid = getMonthGrid(state.viewYear, state.viewMonth);
    return `
      <div class="tk-surface">
        <div class="tk-month-bar">
          <div class="tk-month-title">${formatMonthYear(state.viewYear, state.viewMonth)}</div>
          <div class="tk-toolbar">
            <button type="button" data-action="prev-month">Prev Month</button>
            <button type="button" data-action="next-month">Next Month</button>
            <button type="button" class="is-primary" data-action="today">Today</button>
          </div>
        </div>
        <div class="tk-calendar-labels">
          ${DAYS_SHORT.map((day) => `<div class="tk-calendar-label">${day}</div>`).join('')}
        </div>
        <div class="tk-calendar-grid">
          ${grid.flat().map((day) => {
            if (!day) return '<div></div>';
            const currentDate = new Date(state.viewYear, state.viewMonth, day, 0, 0, 0, 0);
            const currentKey = dateKey(currentDate);
            const dots = getMonthlyDots(currentKey);
            const classes = [
              'tk-calendar-cell',
              currentKey === dateKey(state.selectedDate) ? 'is-selected' : '',
              currentKey === today ? 'is-today' : ''
            ].filter(Boolean).join(' ');
            return `
              <button type="button" class="${classes}" data-date="${currentKey}">
                <span>${day}</span>
                <span class="tk-calendar-dots">
                  ${dots.map((color) => `<span class="tk-calendar-dot" style="background:${color}"></span>`).join('')}
                </span>
              </button>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderBoard() {
    const timelineEntries = getSelectedEntries();
    const metrics = getTimelineMetrics(timelineEntries);
    const selectedSummary = getSelectedDaySummary(timelineEntries, metrics.endMinutes - metrics.startMinutes);
    const displayEntries = getDisplayEntries(timelineEntries, metrics);
    const blockedDay = getSelectedBlockedDate();
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const nowTop = ((currentMinutes - metrics.startMinutes) / metrics.stepMinutes) * metrics.rowHeight;
    const messages = getTimelineMessages();

    return `
      <div class="tk-surface">
        <div class="tk-header">
          <div>
            <div class="tk-kicker">Integrated Timekeeper</div>
            <div class="tk-title">Daily Timeline</div>
            <div class="tk-copy">This board pulls live bookings and availability from the backend, polls every 30 seconds, and lets you edit customer, private, travel, one-time unavailable blocks, and repeating holds in one place.</div>
          </div>
          <div class="tk-toolbar">
            <button type="button" data-action="refresh-board">${state.syncing ? 'Syncing...' : 'Refresh'}</button>
            <button type="button" class="is-primary" data-action="reset-composer">New Block</button>
          </div>
        </div>

        <div class="tk-stat-row" style="margin-top:18px">
          <div class="tk-stat">
            <div class="tk-stat-label">Board Items</div>
            <div class="tk-stat-value">${selectedSummary.count}</div>
          </div>
          <div class="tk-stat">
            <div class="tk-stat-label">Occupied</div>
            <div class="tk-stat-value">${formatDuration(selectedSummary.occupied)}</div>
          </div>
          <div class="tk-stat">
            <div class="tk-stat-label">Free Space</div>
            <div class="tk-stat-value">${formatDuration(selectedSummary.free)}</div>
          </div>
          <div class="tk-stat">
            <div class="tk-stat-label">Backend</div>
            <div class="tk-stat-value">${state.version || '...'}</div>
          </div>
        </div>
      </div>

      ${renderCalendar()}

      <div class="tk-day-board">
        <div class="tk-surface">
          <div class="tk-day-controls">
            <button type="button" data-action="prev-day">Prev Day</button>
            <button type="button" class="is-primary" data-action="today">Today</button>
            <button type="button" data-action="next-day">Next Day</button>
          </div>
          <div style="margin-top:14px">
            <div class="tk-day-label">${formatLongDate(state.selectedDate)}</div>
            <div class="tk-day-meta">${getDayHours()}${blockedDay ? ' • Full-day block active' : ''}</div>
          </div>
          <div class="tk-legend" style="margin-top:14px">
            ${Object.entries(TYPE_META).filter(([key]) => key !== 'recurring').map(([key, value]) => `
              <span class="tk-legend-chip" style="background:${value.dot}20;color:${value.dot};border:1px solid ${value.dot}44">${value.label}</span>
            `).join('')}
          </div>
          <div class="tk-board-card" style="margin-top:14px">
            <div class="tk-scroll${metrics.scrollable ? ' is-scrollable' : ' is-fitted'}" id="timeline-scroll" style="height:${metrics.containerHeight}px">
              <div class="tk-canvas" style="height:${metrics.canvasHeight}px">
                ${metrics.slots.map((slotMinutes) => `
                  <button type="button" class="tk-hour-row" data-time="${minutesToTimeValue(slotMinutes)}" style="top:${((slotMinutes - metrics.startMinutes) / metrics.stepMinutes) * metrics.rowHeight}px;height:${metrics.rowHeight}px">
                    ${shouldShowSlotLabel(slotMinutes, metrics.stepMinutes) ? `<span class="tk-hour-label">${formatTimelineTime(slotMinutes)}</span>` : ''}
                  </button>
                `).join('')}
                ${dateKey(state.selectedDate) === dateKey(new Date()) && currentMinutes >= metrics.startMinutes && currentMinutes <= metrics.endMinutes ? `
                  <div class="tk-now-line" style="top:${nowTop}px">
                    <span class="tk-now-dot"></span>
                  </div>
                ` : ''}
                ${displayEntries.map((entry) => `
                  <button type="button" class="tk-entry ${TYPE_META[entry.kind].className}" data-entry-kind="${entry.kind}" data-entry-id="${entry.id}" style="top:${((entry.displayStartMinutes - metrics.startMinutes) / metrics.stepMinutes) * metrics.rowHeight}px;height:${Math.max(((entry.displayEndMinutes - entry.displayStartMinutes) / metrics.stepMinutes) * metrics.rowHeight - 4, 28)}px">
                    <div class="tk-entry__title">${escapeHtml(entry.title)}</div>
                    <div class="tk-entry__sub">${escapeHtml(entry.subtitle)}</div>
                    ${entry.kind === 'recurring' ? `<div class="tk-entry__sub">${escapeHtml(formatRecurringPatternLabel(entry.meta.recurrence))}</div>` : ''}
                    <div class="tk-entry__meta">${formatTimelineTime(entry.startMinutes)} - ${formatTimelineTime(entry.endMinutes)} • ${formatDuration(entry.durationMinutes)}</div>
                  </button>
                `).join('')}
                ${timelineEntries.length === 0 ? `<div class="tk-empty" style="padding-top:${Math.max(80, Math.round(metrics.canvasHeight * 0.42))}px">Nothing is on the board for this date yet. Tap any hour lane to start a block.</div>` : ''}
              </div>
            </div>
          </div>
        </div>

        <div class="tk-shell">
          <div class="tk-surface">
            <div class="tk-kicker">${state.editingBookingId || state.editingBlockedId || state.editingRecurringId ? 'Editing Existing Item' : 'Compose on the Board'}</div>
            <div class="tk-title" style="font-size:26px">${TYPE_META[state.activeType].label} Block</div>
            <div class="tk-copy">${TYPE_META[state.activeType].copy}</div>

            <div class="tk-type-grid" style="margin-top:16px">
              ${Object.entries(TYPE_META).filter(([key]) => key !== 'recurring').map(([key, value]) => `
                <button type="button" class="tk-type-card ${state.activeType === key ? 'is-active' : ''}" data-type="${key}">
                  <div class="tk-type-title">${value.label}</div>
                  <div class="tk-type-copy">${value.copy}</div>
                </button>
              `).join('')}
            </div>

            <div class="tk-compose-grid" style="margin-top:16px">
              <div class="tk-field" style="flex:1;min-width:110px">
                <label>Start</label>
                <input type="time" id="tk-start-time" value="${state.startTime}">
              </div>
              <div class="tk-field" style="flex:1;min-width:110px">
                <label>End</label>
                <input type="time" id="tk-end-time" value="${state.endTime}">
              </div>
              <div class="tk-field" style="flex:1;min-width:110px">
                <label>Duration</label>
                <input type="text" id="tk-duration" value="${state.durationInput}" placeholder="2:00">
              </div>
            </div>

            ${state.activeType !== 'blocked' ? `
              <div style="margin-top:14px">
                <div class="tk-kicker" style="font-size:11px">Suggested Starts</div>
                <div class="tk-slot-row" style="margin-top:8px">
                  ${state.slotSuggestions.length > 0
                    ? state.slotSuggestions.map((slot) => `
                        <button type="button" class="tk-slot-chip ${state.startTime === slot.time ? 'is-active' : ''}" data-slot="${slot.time}">${slot.label}</button>
                      `).join('')
                    : '<div class="tk-empty" style="padding:6px 0 0;text-align:left">No slot suggestions loaded for this duration yet.</div>'}
                </div>
              </div>
            ` : ''}

            <div class="tk-compose-grid" style="margin-top:16px">
              <div class="tk-field" style="flex:1;min-width:220px">
                <label>Name</label>
                <input type="text" id="tk-name" value="${escapeAttribute(state.name)}" placeholder="${TYPE_META[state.activeType].defaultName || 'Customer name'}">
              </div>
              <div class="tk-field" style="flex:1;min-width:220px">
                <label>Phone</label>
                <input type="text" id="tk-phone" value="${escapeAttribute(state.phone)}" placeholder="Phone number" ${state.activeType !== 'customer' ? 'disabled' : ''}>
              </div>
            </div>

            <div class="tk-compose-grid" style="margin-top:10px">
              <div class="tk-field" style="flex:1;min-width:220px">
                <label>Vehicle</label>
                <input type="text" id="tk-vehicle" value="${escapeAttribute(state.vehicle)}" placeholder="Vehicle" ${state.activeType === 'blocked' ? 'disabled' : ''}>
              </div>
              <div class="tk-field" style="flex:1;min-width:220px">
                <label>Service / Label</label>
                <input type="text" id="tk-service" value="${escapeAttribute(state.service)}" placeholder="Service or label">
              </div>
            </div>

            <div class="tk-field" style="margin-top:10px">
              <label>${state.activeType === 'blocked' ? 'Reason' : 'Notes'}</label>
              <textarea id="tk-notes" placeholder="${state.activeType === 'blocked' ? 'Why this time is unavailable' : 'Extra context'}">${escapeHtml(state.notes)}</textarea>
            </div>

            ${state.activeType === 'blocked' ? `
              <div style="margin-top:14px">
                <div class="tk-kicker" style="font-size:11px">Repeat</div>
                <div class="tk-slot-row" style="margin-top:8px">
                  ${RECURRENCE_OPTIONS.map((option) => `
                    <button type="button" class="tk-slot-chip ${state.recurrence === option.value ? 'is-active' : ''}" data-recurrence="${option.value}">${option.label}</button>
                  `).join('')}
                </div>
                ${state.recurrence !== 'none' ? `
                  <div class="tk-compose-grid" style="margin-top:12px">
                    <div class="tk-field" style="flex:1;min-width:160px">
                      <label>Starts on</label>
                      <input type="date" id="tk-recurring-start" value="${escapeAttribute(state.recurrenceStartDate)}">
                    </div>
                    <div class="tk-field" style="flex:1;min-width:160px">
                      <label>Ends on</label>
                      <input type="date" id="tk-recurring-end" value="${escapeAttribute(state.recurrenceEndDate)}">
                    </div>
                  </div>
                  ${state.recurrence === 'custom' ? `
                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
                      ${CUSTOM_DAY_OPTIONS.map((option) => `
                        <button type="button" class="tk-slot-chip ${state.customDays.includes(option.value) ? 'is-active' : ''}" data-recurring-day="${option.value}" style="min-width:42px">${option.label}</button>
                      `).join('')}
                    </div>
                  ` : ''}
                ` : ''}
              </div>
            ` : ''}

            <div class="tk-toolbar" style="margin-top:16px">
              <button type="button" class="is-primary" data-action="save-composer">${state.savePending ? 'Saving...' : (state.editingBookingId || state.editingBlockedId || state.editingRecurringId ? 'Update Block' : 'Save to Board')}</button>
              ${(state.editingBookingId || state.editingBlockedId || state.editingRecurringId) ? '<button type="button" class="is-danger" data-action="remove-current">Remove</button>' : ''}
              <button type="button" data-action="reset-composer">Reset</button>
            </div>
          </div>

          ${messages.map((message) => `<div class="${message.className}">${escapeHtml(message.text)}</div>`).join('')}
        </div>
      </div>
    `;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  function render() {
    if (!state.initialized && !state.loading) {
      root.innerHTML = '<div class="tk-surface"><div class="tk-title" style="font-size:24px">Timekeeper</div><div class="tk-copy">Unlock the admin panel to load the live schedule board.</div></div>';
      return;
    }

    root.innerHTML = state.loading
      ? '<div class="tk-surface"><div class="tk-title" style="font-size:24px">Loading board...</div><div class="tk-copy">Pulling the latest bookings and availability from the backend.</div></div>'
      : `<div class="tk-shell">${renderBoard()}</div>`;

    bindEvents();
  }

  function bindEvents() {
    root.querySelectorAll('[data-date]').forEach((button) => {
      button.addEventListener('click', () => changeSelectedDate(parseLocalDate(button.getAttribute('data-date'))));
    });

    root.querySelectorAll('[data-type]').forEach((button) => {
      button.addEventListener('click', () => {
        const nextType = button.getAttribute('data-type');
        setDefaultComposerForType(nextType, true);
        render();
        void refreshSlots();
      });
    });

    root.querySelectorAll('[data-slot]').forEach((button) => {
      button.addEventListener('click', () => {
        state.startTime = button.getAttribute('data-slot') || '';
        updateEndFromDuration();
        render();
      });
    });

    root.querySelectorAll('[data-recurrence]').forEach((button) => {
      button.addEventListener('click', () => {
        state.recurrence = button.getAttribute('data-recurrence') || 'none';
        if (state.recurrence !== 'custom') {
          state.customDays = [];
        }
        render();
      });
    });

    root.querySelectorAll('[data-recurring-day]').forEach((button) => {
      button.addEventListener('click', () => {
        const dayValue = Number(button.getAttribute('data-recurring-day'));
        if (!Number.isInteger(dayValue)) return;
        state.customDays = state.customDays.includes(dayValue)
          ? state.customDays.filter((value) => value !== dayValue)
          : [...state.customDays, dayValue].sort((left, right) => left - right);
        render();
      });
    });

    root.querySelectorAll('.tk-hour-row').forEach((button) => {
      button.addEventListener('click', () => {
        state.startTime = button.getAttribute('data-time') || '';
        updateEndFromDuration();
        render();
      });
    });

    root.querySelectorAll('.tk-entry').forEach((button) => {
      button.addEventListener('click', () => {
        const kind = button.getAttribute('data-entry-kind');
        const entryId = button.getAttribute('data-entry-id');
        const entry = getSelectedEntries().find((item) => item.kind === kind && item.id === entryId);
        if (entry) {
          beginEditEntry(entry);
        }
      });
    });

    root.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => handleAction(button.getAttribute('data-action')));
    });

    const startInput = document.getElementById('tk-start-time');
    const endInput = document.getElementById('tk-end-time');
    const durationInput = document.getElementById('tk-duration');
    const nameInput = document.getElementById('tk-name');
    const phoneInput = document.getElementById('tk-phone');
    const vehicleInput = document.getElementById('tk-vehicle');
    const serviceInput = document.getElementById('tk-service');
    const notesInput = document.getElementById('tk-notes');
    const recurringStartInput = document.getElementById('tk-recurring-start');
    const recurringEndInput = document.getElementById('tk-recurring-end');

    if (startInput) {
      startInput.addEventListener('change', () => {
        state.startTime = startInput.value;
        updateEndFromDuration();
        render();
      });
    }

    if (endInput) {
      endInput.addEventListener('change', () => {
        state.endTime = endInput.value;
        updateDurationFromEnd();
        render();
        void refreshSlots();
      });
    }

    if (durationInput) {
      durationInput.addEventListener('input', () => {
        state.durationInput = durationInput.value;
        updateEndFromDuration();
        render();
      });
      durationInput.addEventListener('change', () => {
        void refreshSlots();
      });
    }

    if (nameInput) nameInput.addEventListener('input', () => { state.name = nameInput.value; });
    if (phoneInput) phoneInput.addEventListener('input', () => { state.phone = phoneInput.value; });
    if (vehicleInput) vehicleInput.addEventListener('input', () => { state.vehicle = vehicleInput.value; });
    if (serviceInput) serviceInput.addEventListener('input', () => { state.service = serviceInput.value; });
    if (notesInput) notesInput.addEventListener('input', () => { state.notes = notesInput.value; });
    if (recurringStartInput) recurringStartInput.addEventListener('change', () => { state.recurrenceStartDate = recurringStartInput.value; });
    if (recurringEndInput) recurringEndInput.addEventListener('change', () => { state.recurrenceEndDate = recurringEndInput.value; });
  }

  function handleAction(action) {
    if (action === 'prev-day') changeSelectedDate(new Date(state.selectedDate.getFullYear(), state.selectedDate.getMonth(), state.selectedDate.getDate() - 1));
    if (action === 'next-day') changeSelectedDate(new Date(state.selectedDate.getFullYear(), state.selectedDate.getMonth(), state.selectedDate.getDate() + 1));
    if (action === 'today') changeSelectedDate(startOfDay(new Date()));
    if (action === 'prev-month') {
      const nextDate = new Date(state.viewYear, state.viewMonth - 1, 1);
      state.viewMonth = nextDate.getMonth();
      state.viewYear = nextDate.getFullYear();
      render();
    }
    if (action === 'next-month') {
      const nextDate = new Date(state.viewYear, state.viewMonth + 1, 1);
      state.viewMonth = nextDate.getMonth();
      state.viewYear = nextDate.getFullYear();
      render();
    }
    if (action === 'refresh-board') void bootstrap(true);
    if (action === 'reset-composer') clearComposer(state.activeType);
    if (action === 'save-composer') void saveComposer();
    if (action === 'remove-current') void removeCurrentEntry();
  }

  function scrollTimelineToAnchor() {
    const timelineScroll = document.getElementById('timeline-scroll');
    if (!timelineScroll) return;
    const entries = getSelectedEntries();
    const metrics = getTimelineMetrics(entries);
    if (!metrics.scrollable) {
      timelineScroll.scrollTop = 0;
      return;
    }
    const anchorMinutes = dateKey(state.selectedDate) === dateKey(new Date())
      ? Math.max(metrics.startMinutes, nowMinutes() - 90)
      : Math.max(metrics.startMinutes, (entries[0] ? entries[0].startMinutes : metrics.startMinutes) - metrics.stepMinutes);
    timelineScroll.scrollTop = Math.round(((anchorMinutes - metrics.startMinutes) / metrics.stepMinutes) * metrics.rowHeight);
  }

  function nowMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function isTimelineVisible() {
    const adminTab = typeof window.getActiveAdminTab === 'function' ? window.getActiveAdminTab() : 'bookings';
    const scheduleTab = typeof window.getActiveScheduleTab === 'function' ? window.getActiveScheduleTab() : 'timeline';
    return adminTab === 'bookings' && scheduleTab === 'timeline';
  }

  function handleTimelineVisible() {
    if (!isTimelineVisible()) return;
    if (!state.initialized) {
      void bootstrap(true);
      return;
    }
    requestAnimationFrame(scrollTimelineToAnchor);
    void syncNow();
  }

  window.addEventListener('admin-auth-ready', () => {
    void bootstrap(true);
  });

  window.addEventListener('admin-bookings-opened', () => {
    handleTimelineVisible();
  });

  window.addEventListener('admin-schedule-tab-changed', (event) => {
    if ((event && event.detail) === 'timeline') {
      handleTimelineVisible();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void syncNow();
    }
  });

  setDefaultComposerForType('customer', false);
  render();
})();
