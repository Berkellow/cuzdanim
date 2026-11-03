const MAX_SAFE_KURUS = BigInt(Number.MAX_SAFE_INTEGER);
const groupFormatter = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
export const CURRENCY_SYMBOL = '₺';

/** Parse a Turkish-formatted TL string into an integer kuruş amount. */
export function tlToKurus(value) {
  if (typeof value !== 'string') {
    throw new TypeError('TL tutarı, kayan noktalı sayı hatalarını önlemek için metin olarak verilmelidir.');
  }

  const normalized = value.trim().replace(/₺/g, '').replace(/\s/g, '');
  const match = normalized.match(/^(-?)(?:(\d+)|(\d{1,3}(?:\.\d{3})+))(?:,(\d{1,2}))?$/);
  if (!match) throw new TypeError('Geçersiz TL tutarı. Örnek: 1.250,75');

  const sign = match[1] === '-' ? -1n : 1n;
  const liraDigits = (match[2] ?? match[3]).replace(/\./g, '');
  const kurusDigits = (match[4] ?? '').padEnd(2, '0');
  const kurus = BigInt(liraDigits) * 100n + BigInt(kurusDigits || '0');
  const signedKurus = sign * kurus;

  if (signedKurus > MAX_SAFE_KURUS || signedKurus < -MAX_SAFE_KURUS) {
    throw new RangeError('Tutar güvenli tam sayı aralığını aşıyor.');
  }
  return Number(signedKurus);
}

/** Convert safe integer kuruş to a Turkish decimal string without floats. */
export function kurusToTLString(amountKurus) {
  assertKurus(amountKurus);
  const amount = BigInt(amountKurus);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const lira = absolute / 100n;
  const kurus = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${groupFormatter.format(lira)},${kurus}`;
}

/** Format kuruş as Turkish lira, e.g. ₺ 1.250,75. */
export function formatKurus(amountKurus, { symbol = true } = {}) {
  const formatted = kurusToTLString(amountKurus);
  return symbol ? `${CURRENCY_SYMBOL} ${formatted}` : formatted;
}

/** Sum integer kuruş values while checking safe-integer bounds. */
export function sumKurus(amounts) {
  let total = 0n;
  for (const amount of amounts) {
    assertKurus(amount);
    total += BigInt(amount);
  }
  if (total > MAX_SAFE_KURUS || total < -MAX_SAFE_KURUS) {
    throw new RangeError('Toplam güvenli tam sayı aralığını aşıyor.');
  }
  return Number(total);
}

/** Calculate an income-minus-expense balance using integer kuruş. */
export function calculateNetKurus(incomeKurus, expenseKurus) {
  assertKurus(incomeKurus);
  assertKurus(expenseKurus);
  return sumKurus([incomeKurus, -expenseKurus]);
}

function assertKurus(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('Kuruş tutarı güvenli bir tam sayı olmalıdır.');
  }
}
