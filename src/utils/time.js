// Time helpers that respect each station's time zone.

export function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// The instant when a given local calendar day starts in the station's zone
export function zonedStart(year, month, day, tz) {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  let off = tzOffsetMinutes(tz, guess);
  let t = new Date(guess.getTime() - off * 60000);
  off = tzOffsetMinutes(tz, t);
  t = new Date(guess.getTime() - off * 60000);
  return t;
}

export function localParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}

export const monthKey = (date, tz) => {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
};

export function monthRange(key, tz) {
  const [y, m] = key.split('-').map(Number);
  const start = zonedStart(y, m, 1, tz);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = zonedStart(ny, nm, 1, tz);
  return { start, end };
}

export function todayRange(tz, now = new Date()) {
  const p = localParts(now, tz);
  const start = zonedStart(p.year, p.month, p.day, tz);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}

export function isLastDayOfMonth(tz, now = new Date()) {
  const p = localParts(now, tz);
  const tomorrow = localParts(new Date(now.getTime() + 24 * 3600 * 1000), tz);
  return tomorrow.month !== p.month;
}

export const fmtMoney = (n, currency = 'NGN') =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n || 0));
export const fmtNum = (n) => new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 }).format(Number(n || 0));
