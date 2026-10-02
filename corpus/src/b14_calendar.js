// Date-free calendar math: Zeller, leap years, day counts, formatting
'use strict';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  switch (month) {
    case 2:
      return isLeap(year) ? 29 : 28;
    case 4: case 6: case 9: case 11:
      return 30;
    default:
      return 31;
  }
}

// Zeller's congruence: 0=Saturday..6=Friday -> convert to 0=Sunday
function zeller(year, month, day) {
  let m = month;
  let y = year;
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const K = y % 100;
  const J = Math.floor(y / 100);
  const h = (day + Math.floor((13 * (m + 1)) / 5) + K + Math.floor(K / 4) + Math.floor(J / 4) + 5 * J) % 7;
  return (h + 6) % 7;
}

// Days since 0000-03-01 style epoch (civil algorithm)
function toDayNumber(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

class CalDate {
  #y; #m; #d;
  static FORMATS = {
    iso: ({ y, m, d }) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`,
    us: ({ y, m, d }) => `${pad(m)}/${pad(d)}/${y}`,
    long: ({ y, m, d, dow }) => `${DAY_NAMES[dow]}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`,
  };

  constructor(y, m = 1, d = 1) {
    if (m < 1 || m > 12) throw new RangeError(`bad month ${m}`);
    if (d < 1 || d > daysInMonth(y, m)) throw new RangeError(`bad day ${y}-${m}-${d}`);
    this.#y = y;
    this.#m = m;
    this.#d = d;
  }

  static parse(str) {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str.trim());
    if (!match) throw new SyntaxError(`cannot parse "${str}"`);
    const [, y, m, d] = match.map(Number);
    return new CalDate(y, m, d);
  }

  static fromNumber(n) {
    const { y, m, d } = fromDayNumber(n);
    return new CalDate(y, m, d);
  }

  get year() { return this.#y; }
  get month() { return this.#m; }
  get day() { return this.#d; }
  get dayOfWeek() { return zeller(this.#y, this.#m, this.#d); }
  get dayOfYear() {
    let n = this.#d;
    for (let m = 1; m < this.#m; m++) n += daysInMonth(this.#y, m);
    return n;
  }
  get number() { return toDayNumber(this.#y, this.#m, this.#d); }

  addDays(n) {
    return CalDate.fromNumber(this.number + n);
  }

  addMonths(n) {
    const total = this.#y * 12 + (this.#m - 1) + n;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return new CalDate(y, m, Math.min(this.#d, daysInMonth(y, m)));
  }

  diff(other) {
    return this.number - other.number;
  }

  format(kind = 'iso') {
    const fn = CalDate.FORMATS[kind] ?? CalDate.FORMATS.iso;
    return fn({ y: this.#y, m: this.#m, d: this.#d, dow: this.dayOfWeek });
  }

  [Symbol.toPrimitive](hint) {
    return hint === 'number' ? this.number : this.format();
  }

  toJSON() {
    return this.format();
  }
}

function isoWeek(date) {
  const dow = (date.dayOfWeek + 6) % 7; // Monday=0
  const thursday = date.addDays(3 - dow);
  const jan1 = new CalDate(thursday.year, 1, 1);
  return { year: thursday.year, week: Math.floor(thursday.diff(jan1) / 7) + 1 };
}

function renderMonth(year, month) {
  const lines = [];
  const title = `${MONTH_NAMES[month - 1]} ${year}`;
  lines.push(title.padStart(Math.floor((20 + title.length) / 2)).padEnd(20));
  lines.push('Su Mo Tu We Th Fr Sa');
  let row = '   '.repeat(zeller(year, month, 1));
  const dim = daysInMonth(year, month);
  for (let d = 1; d <= dim; d++) {
    row += String(d).padStart(2) + ' ';
    if ((zeller(year, month, d)) === 6) {
      lines.push(row.trimEnd());
      row = '';
    }
  }
  if (row) lines.push(row.trimEnd());
  return lines;
}

function easter(year) {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new CalDate(year, month, day);
}

function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = zeller(year, month, 1);
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= daysInMonth(year, month) ? new CalDate(year, month, day) : null;
  }
  const dim = daysInMonth(year, month);
  const last = zeller(year, month, dim);
  return new CalDate(year, month, dim - ((last - weekday + 7) % 7));
}

function* businessDays(start, count, holidays = new Set()) {
  let cur = start;
  let produced = 0;
  while (produced < count) {
    const dow = cur.dayOfWeek;
    if (dow !== 0 && dow !== 6 && !holidays.has(cur.format())) {
      produced++;
      yield cur;
    }
    cur = cur.addDays(1);
  }
}

function countFridays13(fromYear, toYear) {
  const hits = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      if (zeller(y, m, 13) === 5) hits.push(`${y}-${pad(m)}`);
    }
  }
  return hits;
}

function ageBreakdown(birth, today) {
  let years = today.year - birth.year;
  let months = today.month - birth.month;
  let days = today.day - birth.day;
  if (days < 0) {
    months--;
    const pm = today.month === 1 ? 12 : today.month - 1;
    const py = today.month === 1 ? today.year - 1 : today.year;
    days += daysInMonth(py, pm);
  }
  if (months < 0) {
    years--;
    months += 12;
  }
  return { years, months, days };
}

function durationText(days) {
  const parts = [];
  const weeks = Math.floor(days / 7);
  const rest = days % 7;
  weeks && parts.push(`${weeks} week${weeks === 1 ? '' : 's'}`);
  rest && parts.push(`${rest} day${rest === 1 ? '' : 's'}`);
  return parts.join(' and ') || 'no time';
}

function main() {
  console.log('--- leap years ---');
  const years = [1900, 2000, 2004, 2023, 2024, 2100, 2400];
  console.log(years.map((y) => `${y}:${isLeap(y) ? 'L' : '-'}`).join(' '));
  let leapCount = 0;
  for (let y = 1901; y <= 2000; y++) if (isLeap(y)) leapCount++;
  console.log('leap years in 20th century:', leapCount);

  console.log('--- day of week ---');
  const samples = ['1969-07-20', '2000-01-01', '1776-07-04', '2024-02-29', '1999-12-31', '2038-01-19'];
  for (const s of samples) {
    const d = CalDate.parse(s);
    console.log(`${s} -> ${d.format('long')} doy=${d.dayOfYear} num=${+d}`);
  }

  console.log('--- round trips ---');
  let ok = 0, checked = 0;
  for (let n = -1000; n <= 30000; n += 97) {
    const { y, m, d } = fromDayNumber(n);
    checked++;
    if (toDayNumber(y, m, d) === n && zeller(y, m, d) === (((n % 7) + 7 + 4) % 7)) ok++;
  }
  console.log(`round trip ok ${ok}/${checked}`);

  console.log('--- arithmetic ---');
  const base = new CalDate(2024, 1, 31);
  for (const k of [1, 2, 13, -1, -12]) console.log(`${base} + ${k} months = ${base.addMonths(k)}`);
  for (const k of [1, 29, 30, 365, 366, -60]) console.log(`${base} + ${k} days = ${base.addDays(k).format('us')}`);
  const moon = CalDate.parse('1969-07-20');
  console.log('days since moon landing to 2000-01-01:', CalDate.parse('2000-01-01').diff(moon), durationText(CalDate.parse('2000-01-01').diff(moon)));
  console.log('duration small', durationText(8), '|', durationText(14), '|', durationText(0));

  console.log('--- iso weeks ---');
  for (const s of ['2021-01-03', '2021-01-04', '2020-12-31', '2026-06-15', '2027-01-01']) {
    const { year, week } = isoWeek(CalDate.parse(s));
    console.log(`${s} -> ${year}-W${pad(week)}`);
  }

  console.log('--- calendars ---');
  for (const line of renderMonth(2024, 2)) console.log(line);
  for (const line of renderMonth(2026, 9)) console.log(line);

  console.log('--- holidays ---');
  for (const y of [2019, 2024, 2025, 2038]) {
    const e = easter(y);
    const thanks = nthWeekday(y, 11, 4, 4);
    const memorial = nthWeekday(y, 5, 1, -1);
    console.log(`${y}: easter=${e} thanksgiving=${thanks} memorial=${memorial} fifthMondayJan=${nthWeekday(y, 1, 1, 5) ?? 'none'}`);
  }

  console.log('--- business days ---');
  const holidays = new Set(['2024-12-25', '2024-12-26', '2025-01-01']);
  const bd = [...businessDays(new CalDate(2024, 12, 20), 8, holidays)];
  console.log(bd.map((d) => `${d.format()}(${DAY_NAMES[d.dayOfWeek].slice(0, 3)})`).join(' '));

  console.log('--- friday 13th ---');
  const f13 = countFridays13(2020, 2026);
  console.log(f13.length, f13.join(','));

  console.log('--- ages ---');
  const today = new CalDate(2026, 9, 29);
  const people = { ada: '1815-12-10', alan: '1912-06-23', grace: '1906-12-09', leap: '2000-02-29' };
  for (const [name, bday] of Object.entries(people)) {
    const { years, months, days } = ageBreakdown(CalDate.parse(bday), today);
    console.log(`${name.padEnd(6)} ${years}y ${months}m ${days}d`);
  }

  console.log('--- errors ---');
  const bad = ['2023-02-29', '2024-13-01', 'hello', '2024-4-31'];
  for (const s of bad) {
    try {
      CalDate.parse(s);
      console.log('unexpected ok', s);
    } catch (err) {
      console.log(`${s}: ${err.name} ${err.message}`);
    }
  }
  console.log('json', JSON.stringify({ start: base, list: [moon, today] }));
  const sorted = [today, moon, base, easter(2000)].sort((a, b) => a - b);
  console.log('sorted', sorted.map(String).join(' < '));
}

main();
