import { APPLICATION_STORE_NAMES, DATABASE_VERSION } from './database.js';

export const BACKUP_FORMAT = 'cuzdanim-data-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const THEME_STORAGE_KEY = 'cuzdanim.theme';
export const LAST_BACKUP_STORAGE_KEY = 'cuzdanim.lastBackupAt';

/** Build a validated, versioned backup object suitable for UTF-8 JSON export. */
export function createBackupObject(stores, preferences = {}, createdAt = new Date().toISOString()) {
  const backup = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    databaseVersion: DATABASE_VERSION,
    createdAt,
    preferences: normalizePreferences(preferences),
    stores,
  };
  return validateBackupObject(backup);
}

export function serializeBackup(backup) {
  return `${JSON.stringify(validateBackupObject(backup), null, 2)}\n`;
}

export function parseBackupText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('Yedek dosyası boş.');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new TypeError('Dosya geçerli bir JSON yedeği değil.'); }
  return validateBackupObject(parsed);
}

export function validateBackupObject(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new TypeError('Yedek dosyasının ana yapısı geçersiz.');
  if (backup.format !== BACKUP_FORMAT || backup.formatVersion !== BACKUP_FORMAT_VERSION) throw new TypeError('Dosya Cüzdanım tarafından oluşturulmuş desteklenen bir yedek değil.');
  if (backup.databaseVersion !== DATABASE_VERSION) throw new TypeError(`Yedek veritabanı v${backup.databaseVersion ?? '?'}; bu uygulama v${DATABASE_VERSION} bekliyor.`);
  if (!isDateTime(backup.createdAt)) throw new TypeError('Yedek oluşturulma tarihi geçersiz.');
  if (!backup.preferences || typeof backup.preferences !== 'object' || Array.isArray(backup.preferences)) throw new TypeError('Yedekte tema ve para birimi tercihleri bulunamadı.');
  const preferences = normalizePreferences(backup.preferences);
  const stores = backup.stores;
  if (!stores || typeof stores !== 'object' || Array.isArray(stores)) throw new TypeError('Yedekte veri depoları bulunamadı.');
  for (const name of APPLICATION_STORE_NAMES) {
    if (!Array.isArray(stores[name])) throw new TypeError(`Yedekte ${name} listesi bulunamadı veya geçersiz.`);
  }
  validateUniqueIds(stores);
  const categoryById = new Map(stores.categories.map((item) => [item.id, item]));
  const subscriptionById = new Map(stores.subscriptions.map((item) => [item.id, item]));
  const paymentById = new Map(stores.subscriptionPayments.map((item) => [item.id, item]));
  const transactionById = new Map(stores.transactions.map((item) => [item.id, item]));
  const categoryByPeriod = new Set();
  const paymentPeriods = new Set();

  stores.categories.forEach(validateCategory);
  stores.transactions.forEach((item) => validateTransaction(item, subscriptionById, paymentById));
  stores.subscriptions.forEach((item) => {
    validateSubscription(item);
    const category = categoryById.get(item.categoryId);
    if (!category || category.type !== 'expense') throw new TypeError(`“${item.name}” aboneliğinin gider kategorisi yedekte bulunamadı.`);
  });
  stores.budgets.forEach((item) => {
    validateBudget(item);
    const category = categoryById.get(item.categoryId);
    if (!category || category.type !== 'expense') throw new TypeError(`“${item.name}” bütçesinin gider kategorisi yedekte bulunamadı.`);
    if (categoryByPeriod.has(item.categoryId)) throw new TypeError('Bir gider kategorisi için birden fazla bütçe var.');
    categoryByPeriod.add(item.categoryId);
  });
  stores.subscriptionPayments.forEach((item) => {
    validatePayment(item);
    if (!subscriptionById.has(item.subscriptionId)) throw new TypeError('Bir abonelik ödeme kaydı için abonelik bulunamadı.');
    const periodKey = `${item.subscriptionId}\u0000${item.periodKey}`;
    if (paymentPeriods.has(periodKey)) throw new TypeError('Yedekte aynı abonelik dönemi birden fazla kez bulunuyor.');
    paymentPeriods.add(periodKey);
    const transaction = item.transactionId === null ? undefined : transactionById.get(item.transactionId);
    if (item.status === 'paid' && (!transaction || transaction.type !== 'expense' || transaction.id !== item.transactionId
      || transaction.subscriptionPaymentId !== item.id || transaction.subscriptionId !== item.subscriptionId
      || transaction.subscriptionPeriodKey !== item.periodKey)) {
      throw new TypeError('Ödenmiş abonelik dönemiyle ilişkili gider kaydı bulunamadı.');
    }
  });

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    databaseVersion: DATABASE_VERSION,
    createdAt: backup.createdAt,
    preferences,
    stores: Object.fromEntries(APPLICATION_STORE_NAMES.map((name) => [name, stores[name]])),
  };
}

function normalizePreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Yedek tercihleri geçersiz.');
  const theme = value.theme ?? 'dark';
  if (!['dark', 'light'].includes(theme)) throw new TypeError('Yedekte tema tercihi geçersiz.');
  // Older backups may still include a currency display preference; it is ignored.
  return { theme };
}

function validateUniqueIds(stores) {
  for (const name of APPLICATION_STORE_NAMES) {
    const seen = new Set();
    for (const item of stores[name]) {
      const id = item?.id;
      if ((typeof id !== 'string' && !Number.isSafeInteger(id)) || id === '') throw new TypeError(`${name} deposunda geçersiz ID var.`);
      if (seen.has(id)) throw new TypeError(`${name} deposunda yinelenen ID var.`);
      seen.add(id);
    }
  }
}

function validateCategory(item) {
  if (!nonEmpty(item.name) || !['income', 'expense'].includes(item.type) || !nonEmpty(item.icon)
    || typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color) || !isDateTime(item.createdAt)) {
    throw new TypeError('Yedekte geçersiz kategori kaydı var.');
  }
}

function validateTransaction(item, subscriptions, payments) {
  if (!['income', 'expense'].includes(item.type) || !positiveKurus(item.amountKurus) || !nonEmpty(item.categoryId)
    || !nonEmpty(item.description) || !isDateTime(item.date) || !isDateTime(item.createdAt)) {
    throw new TypeError('Yedekte geçersiz işlem kaydı var.');
  }
  const linked = item.subscriptionId !== undefined || item.subscriptionPaymentId !== undefined || item.subscriptionPeriodKey !== undefined;
  if (!linked) return;
  if (typeof item.subscriptionId !== 'string' || !subscriptions.has(item.subscriptionId)
    || !positiveId(item.subscriptionPaymentId) || !nonEmpty(item.subscriptionPeriodKey)) {
    throw new TypeError('Yedekte aboneliğe bağlı işlem alanları tutarsız.');
  }
  const payment = payments.get(item.subscriptionPaymentId);
  if (item.type !== 'expense' || !payment || payment.status !== 'paid' || payment.transactionId !== item.id
    || payment.subscriptionId !== item.subscriptionId || payment.periodKey !== item.subscriptionPeriodKey) {
    throw new TypeError('Yedekte gider ve abonelik ödeme bağlantısı tutarsız.');
  }
}

function validateSubscription(item) {
  if (!nonEmpty(item.name) || !positiveKurus(item.amountKurus) || !['monthly', 'yearly'].includes(item.period)
    || !isDate(item.nextPaymentDate) || !nonEmpty(item.categoryId) || !['active', 'cancelled'].includes(item.status)
    || !Number.isInteger(item.billingDay) || item.billingDay < 1 || item.billingDay > 31
    || !isDateTime(item.createdAt) || !isDateTime(item.updatedAt)) {
    throw new TypeError('Yedekte geçersiz abonelik kaydı var.');
  }
  if (item.period === 'yearly' && (!Number.isInteger(item.billingMonth) || item.billingMonth < 1 || item.billingMonth > 12)) {
    throw new TypeError('Yedekte yıllık aboneliğin ödeme ayı geçersiz.');
  }
  if (item.cancelledAt !== undefined && !isDateTime(item.cancelledAt)) throw new TypeError('Yedekte abonelik iptal tarihi geçersiz.');
}

function validatePayment(item) {
  if (!positiveId(item.id) || !nonEmpty(item.subscriptionId) || !nonEmpty(item.periodKey) || !isDate(item.dueDate)
    || !isDateTime(item.paidAt) || !positiveKurus(item.amountKurus) || !['paid', 'reversed'].includes(item.status)) {
    throw new TypeError('Yedekte geçersiz abonelik ödeme kaydı var.');
  }
  if (item.transactionId !== null && !positiveId(item.transactionId)) throw new TypeError('Yedekte abonelik gider bağlantısı geçersiz.');
  if (item.status === 'reversed' && item.reversedAt !== undefined && !isDateTime(item.reversedAt)) throw new TypeError('Yedekte ödeme geri alma tarihi geçersiz.');
}

function validateBudget(item) {
  if (!nonEmpty(item.name) || !nonEmpty(item.categoryId) || !positiveKurus(item.amountKurus)
    || item.period !== 'monthly' || !isDateTime(item.createdAt) || !isDateTime(item.updatedAt)) {
    throw new TypeError('Yedekte geçersiz bütçe kaydı var.');
  }
}

function nonEmpty(value) { return typeof value === 'string' && Boolean(value.trim()); }
function positiveKurus(value) { return Number.isSafeInteger(value) && value > 0; }
function positiveId(value) { return Number.isSafeInteger(value) && value > 0; }
function isDateTime(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
