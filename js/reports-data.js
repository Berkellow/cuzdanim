import { sumKurus } from './money.js';

const DAY_MS = 86_400_000;
const EMPTY_CATEGORY = 'missing-category';

/** Build a selected range and its immediately preceding equivalent range. */
export function getReportDateRange(preset, now = new Date(), customStart, customEnd) {
  if (preset === 'custom') {
    if (!isDateKey(customStart) || !isDateKey(customEnd) || customStart > customEnd) {
      throw new TypeError('Özel rapor aralığı için geçerli başlangıç ve bitiş tarihleri seç.');
    }
    const start = fromDateKey(customStart);
    const endExclusive = addDays(fromDateKey(customEnd), 1);
    const duration = Math.round((endExclusive.getTime() - start.getTime()) / DAY_MS);
    return makeRange(customStart, toDateKey(endExclusive), toDateKey(addDays(start, -duration)), customStart);
  }

  const monthCount = preset === 'last-6-months' ? 6 : preset === 'last-12-months' ? 12 : 1;
  if (!['this-month', 'last-month', 'last-6-months', 'last-12-months'].includes(preset)) {
    throw new TypeError('Bilinmeyen rapor dönemi.');
  }
  const currentMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const endMonth = preset === 'last-month' ? currentMonth : addMonths(currentMonth, 1);
  const startMonth = addMonths(endMonth, -monthCount);
  const previousStart = addMonths(startMonth, -monthCount);
  return makeRange(toDateKey(startMonth), toDateKey(endMonth), toDateKey(previousStart), toDateKey(startMonth));
}

/** Summarize actual transaction records in a selected and preceding date range. */
export function buildReportsData(records, categories, range) {
  const currentRecords = inRange(records, range.startDate, range.endDateExclusive);
  const previousRecords = inRange(records, range.previousStartDate, range.previousEndDateExclusive);
  const current = summarize(currentRecords);
  const previous = summarize(previousRecords);
  const categoryMap = new Map(categories.map((category) => [category.id, category.name]));
  const expenseGroups = new Map();
  for (const record of currentRecords) {
    if (record.type !== 'expense') continue;
    const key = record.categoryId || EMPTY_CATEGORY;
    expenseGroups.set(key, sumKurus([expenseGroups.get(key) ?? 0, record.amountKurus]));
  }
  const categoriesByExpense = [...expenseGroups]
    .map(([categoryId, amountKurus]) => ({
      categoryId,
      name: categoryMap.get(categoryId) ?? 'Silinmiş veya bilinmeyen kategori',
      amountKurus,
      sharePercent: percentageOf(amountKurus, current.expenseKurus),
    }))
    .sort((a, b) => b.amountKurus - a.amountKurus || a.name.localeCompare(b.name, 'tr'));
  const monthKeys = listMonthKeys(range.startDate, range.endDateExclusive);
  const monthly = monthKeys.map((key) => {
    const monthRecords = currentRecords.filter((record) => record.date.slice(0, 7) === key);
    const totals = summarize(monthRecords);
    const [year, month] = key.split('-').map(Number);
    const date = new Date(year, month - 1, 1, 12);
    return {
      key,
      label: new Intl.DateTimeFormat('tr-TR', { month: 'short', year: '2-digit' }).format(date),
      incomeKurus: totals.incomeKurus,
      expenseKurus: totals.expenseKurus,
      netKurus: totals.netKurus,
    };
  });

  return {
    current,
    previous,
    changes: {
      income: compare(current.incomeKurus, previous.incomeKurus),
      expense: compare(current.expenseKurus, previous.expenseKurus),
      net: compare(current.netKurus, previous.netKurus),
    },
    savingsRatePercent: current.incomeKurus === 0 ? null : percentage(current.netKurus, current.incomeKurus),
    monthly,
    expenseCategories: categoriesByExpense,
    topCategories: categoriesByExpense.slice(0, 5),
    hasTransactions: currentRecords.length > 0,
  };
}

function inRange(records, startDate, endExclusive) {
  return records.filter((record) => {
    if (!['income', 'expense'].includes(record.type) || typeof record.date !== 'string' || !isDateKey(record.date.slice(0, 10))) return false;
    const date = record.date.slice(0, 10);
    return date >= startDate && date < endExclusive;
  });
}

function summarize(records) {
  const incomeKurus = sumKurus(records.filter((item) => item.type === 'income').map((item) => item.amountKurus));
  const expenseKurus = sumKurus(records.filter((item) => item.type === 'expense').map((item) => item.amountKurus));
  return { incomeKurus, expenseKurus, netKurus: sumKurus([incomeKurus, -expenseKurus]) };
}

function compare(current, previous) {
  const differenceKurus = sumKurus([current, -previous]);
  return {
    currentKurus: current,
    previousKurus: previous,
    differenceKurus,
    percent: previous === 0 ? null : percentage(differenceKurus, Math.abs(previous)),
    direction: differenceKurus > 0 ? 'up' : differenceKurus < 0 ? 'down' : 'same',
  };
}

function percentage(numerator, denominator) {
  if (denominator === 0) return null;
  const numeratorBig = BigInt(numerator);
  const denominatorBig = BigInt(denominator);
  const sign = numeratorBig < 0n ? -1n : 1n;
  return Number(((numeratorBig < 0n ? -numeratorBig : numeratorBig) * 10000n / denominatorBig) * sign) / 100;
}

function percentageOf(value, total) { return percentage(value, total) ?? 0; }

function makeRange(startDate, endDateExclusive, previousStartDate, previousEndDateExclusive) {
  return { startDate, endDateExclusive, previousStartDate, previousEndDateExclusive };
}

function listMonthKeys(startDate, endDateExclusive) {
  const keys = [];
  let cursor = fromDateKey(startDate);
  const end = fromDateKey(endDateExclusive);
  while (cursor < end) {
    keys.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor = addMonths(cursor, 1);
  }
  return keys;
}

function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = fromDateKey(value);
  return Number.isFinite(date.getTime()) && toDateKey(date) === value;
}

function fromDateKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(date, days) { return new Date(date.getTime() + days * DAY_MS); }

function addMonths(date, offset) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
  return result;
}
