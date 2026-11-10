/** Floor division, so dates before the epoch come out right too. */
const floorDiv = (a: number, b: number) => Math.floor(a / b);

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** Format Unix epoch milliseconds as RFC 3339 UTC with millisecond precision. */
export const formatTs = (ms: number): string => {
  const secs = floorDiv(ms, 1000);
  const millis = ms - secs * 1000;
  const dayNumber = floorDiv(secs, 86_400);
  const secsOfDay = secs - dayNumber * 86_400;
  const hour = floorDiv(secsOfDay, 3_600);
  const minute = floorDiv(secsOfDay % 3_600, 60);
  const second = secsOfDay % 60;
  // Days since 1970-01-01 to a civil date (Howard Hinnant's `civil_from_days`).
  const z = dayNumber + 719_468;
  const era = floorDiv(z, 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = floorDiv(
    dayOfEra - floorDiv(dayOfEra, 1_460) + floorDiv(dayOfEra, 36_524) - floorDiv(dayOfEra, 146_096),
    365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100));
  const mp = floorDiv(5 * dayOfYear + 2, 153);
  const day = dayOfYear - floorDiv(153 * mp + 2, 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millis, 3)}Z`;
};

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})$/;

/**
 * Unix epoch milliseconds from RFC 3339 UTC as `formatTs` writes it: `YYYY-MM-DDTHH:MM:SSZ`,
 * with a fraction of one to three digits before the `Z` when there is one. Anything else, such
 * as an offset in place of the `Z`, a date that is not on the calendar, a trailing newline or a
 * time before the epoch, is `null`.
 */
export const parseTs = (text: string): number | null => {
  if (!text.endsWith("Z")) return null;
  const body = text.slice(0, -1);
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? null : body.slice(dot + 1);
  const match = TIMESTAMP.exec(whole);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (monthDays === undefined) return null;
  if (day < 1 || day > monthDays || hour > 23 || minute > 59 || second > 59) return null;
  let millis = 0;
  if (fraction !== null) {
    if (!/^[0-9]{1,3}$/.test(fraction)) return null;
    // `.1` is a tenth of a second: pad on the right to three digits.
    millis = Number(fraction.padEnd(3, "0"));
  }
  // A civil date to days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
  const y = year - (month <= 2 ? 1 : 0);
  const era = floorDiv(y, 400);
  const yearOfEra = y - era * 400;
  const mp = (month + 9) % 12;
  const dayOfYear = floorDiv(153 * mp + 2, 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear;
  const days = era * 146_097 + dayOfEra - 719_468;
  const ms = (days * 86_400 + hour * 3_600 + minute * 60 + second) * 1000 + millis;
  return ms >= 0 ? ms : null;
};

/**
 * A length of time as softfac prints it: `12s`, `5m`, `2h05m` or `1d01h`, by the largest unit
 * that fits.
 */
export const duration = (ms: number): string => {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3_600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) {
    return `${Math.floor(secs / 3_600)}h${pad(Math.floor((secs % 3_600) / 60), 2)}m`;
  }
  return `${Math.floor(secs / 86_400)}d${pad(Math.floor((secs % 86_400) / 3_600), 2)}h`;
};
