// All times are stored as UTC epoch milliseconds. The user lives in IST (UTC+05:30, no DST).
export const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

export function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

/** "2026-10-15 18:00" in IST */
export function formatIST(ms) {
  const p = istParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

/** "2026-10-15 18:00 (Thursday)" in IST */
export function describeIST(ms) {
  return `${formatIST(ms)} (${DAYS[istParts(ms).wd]})`;
}

/**
 * Parse "YYYY-MM-DD HH:MM" (IST) into UTC epoch ms. Returns null if invalid.
 * If only a date is given, `defaultTime` ("HH:MM") is used; without it, date-only is invalid.
 */
export function parseIST(input, defaultTime) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  let y = +m[1];
  let mo = +m[2];
  let d = +m[3];
  let h;
  let mi;
  if (m[4] === undefined) {
    if (!defaultTime) return null;
    [h, mi] = defaultTime.split(':').map(Number);
  } else {
    h = +m[4];
    mi = +m[5];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;
  const p = istParts(ms);
  if (p.y !== y || p.mo !== mo || p.d !== d) return null; // e.g. Feb 31 rolled over
  return ms;
}

export function startOfISTDay(ms) {
  const p = istParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d) - IST_OFFSET_MS;
}

/** Start of 'today' | 'week' (Monday) | 'month' | 'all' in IST, as UTC epoch ms. */
export function startOfPeriod(period, ms) {
  const dayStart = startOfISTDay(ms);
  if (period === 'today') return dayStart;
  if (period === 'week') {
    const sinceMonday = (istParts(ms).wd + 6) % 7;
    return dayStart - sinceMonday * DAY_MS;
  }
  if (period === 'month') {
    const p = istParts(ms);
    return Date.UTC(p.y, p.mo - 1, 1) - IST_OFFSET_MS;
  }
  return 0;
}

/** Add n months in IST, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsIST(ms, n) {
  const p = istParts(ms);
  const total = p.y * 12 + (p.mo - 1) + n;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const daysInMonth = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(p.d, daysInMonth);
  return Date.UTC(ty, tm, day, p.h, p.mi) - IST_OFFSET_MS;
}

/** First occurrence of a repeating reminder strictly after `nowMs`. */
export function nextOccurrence(dueMs, repeat, nowMs) {
  for (let i = 1; i < 5000; i++) {
    let candidate;
    if (repeat === 'daily') candidate = dueMs + i * DAY_MS;
    else if (repeat === 'weekly') candidate = dueMs + i * 7 * DAY_MS;
    else if (repeat === 'monthly') candidate = addMonthsIST(dueMs, i);
    else return null;
    if (candidate > nowMs) return candidate;
  }
  return null;
}
