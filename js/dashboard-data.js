import { calculateNetKurus, sumKurus } from './money.js';

/** Calculate all-time income, expense, and net balance using integer kuruş. */
export function summarizeTransactions(records) {
  const incomeKurus = sumKurus(records.filter((item) => item.type === 'income').map((item) => item.amountKurus));
  const expenseKurus = sumKurus(records.filter((item) => item.type === 'expense').map((item) => item.amountKurus));
  return {
    incomeKurus,
    expenseKurus,
    balanceKurus: calculateNetKurus(incomeKurus, expenseKurus),
  };
}

/** Return seven daily buckets ending today, including zero-value days. */
export function buildWeeklySeries(records, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const buckets = [];
  const byDate = new Map();

  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    const key = localDateKey(date);
    const bucket = {
      date: key,
      label: new Intl.DateTimeFormat('tr-TR', { weekday: 'short' }).format(date),
      incomeKurus: 0,
      expenseKurus: 0,
    };
    buckets.push(bucket);
    byDate.set(key, bucket);
  }

  for (const record of records) {
    const key = dateKeyForTransaction(record.date);
    const bucket = byDate.get(key);
    if (!bucket) continue;
    if (record.type === 'income') bucket.incomeKurus = sumKurus([bucket.incomeKurus, record.amountKurus]);
    if (record.type === 'expense') bucket.expenseKurus = sumKurus([bucket.expenseKurus, record.amountKurus]);
  }

  return buckets;
}

/** Pick an integer axis with headroom so a higher maximum stays visible in the chart. */
export function chartAxisMaximumKurus(weekly) {
  const largest = Math.max(0, ...weekly.flatMap((day) => [day.incomeKurus, day.expenseKurus]));
  if (largest === 0) return 100;

  const amount = BigInt(largest);
  const rawStep = (amount * 5n + 15n) / 16n; // ceil(largest * 1.25 / 4)
  let magnitude = 1n;
  while (magnitude * 10n <= rawStep) magnitude *= 10n;
  const stepFactor = rawStep <= magnitude ? 1n
    : rawStep <= magnitude * 2n ? 2n
      : rawStep <= magnitude * 5n ? 5n
        : 10n;
  const maximum = stepFactor * magnitude * 4n;
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(maximum > safeMaximum ? safeMaximum : maximum);
}

/** Return newest transactions by transaction date, with creation time as a tiebreaker. */
export function latestTransactions(records, limit = 5) {
  return [...records]
    .sort((a, b) => dateTime(b.date) - dateTime(a.date)
      || dateTime(b.createdAt) - dateTime(a.createdAt)
      || String(b.id).localeCompare(String(a.id), 'en', { numeric: true }))
    .slice(0, Math.max(0, limit));
}

export function buildDashboardData(records, now = new Date()) {
  return {
    ...summarizeTransactions(records),
    weekly: buildWeeklySeries(records, now),
    recent: latestTransactions(records, 5),
  };
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateKeyForTransaction(value) {
  if (typeof value !== 'string') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : localDateKey(parsed);
}

function dateTime(value) {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}
