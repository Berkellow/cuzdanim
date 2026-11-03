export const DATABASE_NAME = 'CuzdanimDB';
export const DATABASE_VERSION = 4;
export const TRANSACTIONS_STORE = 'transactions';
export const CATEGORIES_STORE = 'categories';
export const SUBSCRIPTIONS_STORE = 'subscriptions';
export const SUBSCRIPTION_PAYMENTS_STORE = 'subscriptionPayments';
export const BUDGETS_STORE = 'budgets';
export const APPLICATION_STORE_NAMES = [
  TRANSACTIONS_STORE,
  CATEGORIES_STORE,
  SUBSCRIPTIONS_STORE,
  SUBSCRIPTION_PAYMENTS_STORE,
  BUDGETS_STORE,
];

const DEFAULT_CATEGORIES = [
  { id: 'income-salary', name: 'Maaş', type: 'income', icon: 'briefcase', color: '#39d98a' },
  { id: 'income-extra', name: 'Ek gelir', type: 'income', icon: 'plus-circle', color: '#20c997' },
  { id: 'income-investment', name: 'Yatırım geliri', type: 'income', icon: 'chart', color: '#73d9b5' },
  { id: 'income-other', name: 'Diğer gelir', type: 'income', icon: 'dots', color: '#8db7a9' },
  { id: 'expense-groceries', name: 'Market', type: 'expense', icon: 'basket', color: '#f2bd72' },
  { id: 'expense-rent', name: 'Kira', type: 'expense', icon: 'home', color: '#91a8ff' },
  { id: 'expense-bills', name: 'Faturalar', type: 'expense', icon: 'receipt', color: '#f08e9a' },
  { id: 'expense-transport', name: 'Ulaşım', type: 'expense', icon: 'car', color: '#7fc8e8' },
  { id: 'expense-health', name: 'Sağlık', type: 'expense', icon: 'heart', color: '#fb8290' },
  { id: 'expense-education', name: 'Eğitim', type: 'expense', icon: 'book', color: '#c2a0f2' },
  { id: 'expense-entertainment', name: 'Eğlence', type: 'expense', icon: 'sparkles', color: '#e5a7ed' },
  { id: 'expense-shopping', name: 'Alışveriş', type: 'expense', icon: 'bag', color: '#e7aa75' },
  { id: 'expense-other', name: 'Diğer gider', type: 'expense', icon: 'dots', color: '#a3afc2' },
].map((category) => ({ ...category, createdAt: '2026-01-01T00:00:00.000Z' }));

let databasePromise;
const transactionChangeListeners = new Set();
let transactionChangeChannel;
const subscriptionChangeListeners = new Set();
let subscriptionChangeChannel;
const budgetChangeListeners = new Set();
let budgetChangeChannel;

/** Subscribe to committed transaction changes from this page and same-origin tabs. */
export function subscribeToTransactionChanges(listener) {
  if (typeof listener !== 'function') throw new TypeError('Değişiklik dinleyicisi fonksiyon olmalıdır.');
  transactionChangeListeners.add(listener);
  ensureTransactionChangeChannel();
  return () => transactionChangeListeners.delete(listener);
}

function ensureTransactionChangeChannel() {
  if (transactionChangeChannel || typeof BroadcastChannel === 'undefined') return;
  transactionChangeChannel = new BroadcastChannel(`${DATABASE_NAME}:transactions`);
  transactionChangeChannel.addEventListener('message', (event) => {
    dispatchTransactionChange(event.data);
  });
}

function publishTransactionChange(change) {
  ensureTransactionChangeChannel();
  const message = { ...change, committedAt: new Date().toISOString() };
  dispatchTransactionChange(message);
  transactionChangeChannel?.postMessage(message);
}

function dispatchTransactionChange(change) {
  for (const listener of transactionChangeListeners) {
    try {
      listener(change);
    } catch (error) {
      console.error('Dashboard işlem güncellemesi başarısız oldu:', error);
    }
  }
}

/** Subscribe to committed subscription changes in this page and same-origin tabs. */
export function subscribeToSubscriptionChanges(listener) {
  if (typeof listener !== 'function') throw new TypeError('Değişiklik dinleyicisi fonksiyon olmalıdır.');
  subscriptionChangeListeners.add(listener);
  ensureSubscriptionChangeChannel();
  return () => subscriptionChangeListeners.delete(listener);
}

function ensureSubscriptionChangeChannel() {
  if (subscriptionChangeChannel || typeof BroadcastChannel === 'undefined') return;
  subscriptionChangeChannel = new BroadcastChannel(`${DATABASE_NAME}:subscriptions`);
  subscriptionChangeChannel.addEventListener('message', (event) => dispatchSubscriptionChange(event.data));
}

function publishSubscriptionChange(change) {
  ensureSubscriptionChangeChannel();
  const message = { ...change, committedAt: new Date().toISOString() };
  dispatchSubscriptionChange(message);
  subscriptionChangeChannel?.postMessage(message);
}

function dispatchSubscriptionChange(change) {
  for (const listener of subscriptionChangeListeners) {
    try { listener(change); } catch (error) { console.error('Abonelik güncellemesi başarısız oldu:', error); }
  }
}

/** Subscribe to committed budget changes in this page and same-origin tabs. */
export function subscribeToBudgetChanges(listener) {
  if (typeof listener !== 'function') throw new TypeError('Değişiklik dinleyicisi fonksiyon olmalıdır.');
  budgetChangeListeners.add(listener);
  if (!budgetChangeChannel && typeof BroadcastChannel !== 'undefined') {
    budgetChangeChannel = new BroadcastChannel(`${DATABASE_NAME}:budgets`);
    budgetChangeChannel.addEventListener('message', (event) => dispatchBudgetChange(event.data));
  }
  return () => budgetChangeListeners.delete(listener);
}

function publishBudgetChange(change) {
  if (!budgetChangeChannel && typeof BroadcastChannel !== 'undefined') {
    budgetChangeChannel = new BroadcastChannel(`${DATABASE_NAME}:budgets`);
    budgetChangeChannel.addEventListener('message', (event) => dispatchBudgetChange(event.data));
  }
  const message = { ...change, committedAt: new Date().toISOString() };
  dispatchBudgetChange(message);
  budgetChangeChannel?.postMessage(message);
}

function dispatchBudgetChange(change) {
  for (const listener of budgetChangeListeners) {
    try { listener(change); } catch (error) { console.error('Bütçe güncellemesi başarısız oldu:', error); }
  }
}

/** Open and initialize the app's IndexedDB database. */
export function openDatabase() {
  if (databasePromise) return databasePromise;

  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('Bu tarayıcı IndexedDB desteği sunmuyor.'));
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      upgradeDatabaseSchema(request.result, request.transaction);
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = undefined;
      };
      resolve(db);
    };

    request.onerror = () => {
      databasePromise = undefined;
      reject(toDatabaseError('Veritabanı açılamadı.', request.error));
    };

    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error('Veritabanı yükseltmesi başka bir açık sekme tarafından engellendi.'));
    };
  });

  return databasePromise;
}

/** Apply the application's schema to an IndexedDB upgrade transaction. Exported for isolated migration tests. */
export function upgradeDatabaseSchema(db, upgradeTransaction) {
  const store = db.objectStoreNames.contains(TRANSACTIONS_STORE)
    ? upgradeTransaction.objectStore(TRANSACTIONS_STORE)
    : db.createObjectStore(TRANSACTIONS_STORE, { keyPath: 'id', autoIncrement: true });
  if (!store.indexNames.contains('byDate')) store.createIndex('byDate', 'date', { unique: false });
  if (!store.indexNames.contains('byType')) store.createIndex('byType', 'type', { unique: false });
  if (!store.indexNames.contains('byCategoryId')) store.createIndex('byCategoryId', 'categoryId', { unique: false });
  if (!store.indexNames.contains('bySubscriptionPaymentId')) {
    store.createIndex('bySubscriptionPaymentId', 'subscriptionPaymentId', { unique: false });
  }

  if (!db.objectStoreNames.contains(CATEGORIES_STORE)) {
    const categoryStore = db.createObjectStore(CATEGORIES_STORE, { keyPath: 'id' });
    categoryStore.createIndex('byType', 'type', { unique: false });
    categoryStore.createIndex('byName', 'name', { unique: false });
    const createdAt = new Date().toISOString();
    DEFAULT_CATEGORIES.forEach((category) => categoryStore.add({ ...category, createdAt }));
  } else {
    const categoryStore = upgradeTransaction.objectStore(CATEGORIES_STORE);
    if (!categoryStore.indexNames.contains('byType')) categoryStore.createIndex('byType', 'type', { unique: false });
    if (!categoryStore.indexNames.contains('byName')) categoryStore.createIndex('byName', 'name', { unique: false });
  }

  if (!db.objectStoreNames.contains(SUBSCRIPTIONS_STORE)) {
    const subscriptionStore = db.createObjectStore(SUBSCRIPTIONS_STORE, { keyPath: 'id' });
    subscriptionStore.createIndex('byStatus', 'status', { unique: false });
    subscriptionStore.createIndex('byNextPaymentDate', 'nextPaymentDate', { unique: false });
    subscriptionStore.createIndex('byCategoryId', 'categoryId', { unique: false });
  }

  if (!db.objectStoreNames.contains(SUBSCRIPTION_PAYMENTS_STORE)) {
    const paymentStore = db.createObjectStore(SUBSCRIPTION_PAYMENTS_STORE, { keyPath: 'id', autoIncrement: true });
    paymentStore.createIndex('bySubscriptionId', 'subscriptionId', { unique: false });
    paymentStore.createIndex('byPaidAt', 'paidAt', { unique: false });
    paymentStore.createIndex('bySubscriptionPeriod', ['subscriptionId', 'periodKey'], { unique: true });
  }

  if (!db.objectStoreNames.contains(BUDGETS_STORE)) {
    const budgetStore = db.createObjectStore(BUDGETS_STORE, { keyPath: 'id' });
    budgetStore.createIndex('byCategoryId', 'categoryId', { unique: true });
  }
}

/** Close the current connection (useful for lifecycle handling and tests). */
export async function closeDatabase() {
  if (!databasePromise) return;
  try {
    const db = await databasePromise;
    db.close();
  } finally {
    databasePromise = undefined;
  }
}

/** Read a consistent snapshot of all application stores. */
export async function readAllApplicationData() {
  const db = await openDatabase();
  const tx = db.transaction(APPLICATION_STORE_NAMES, 'readonly');
  const done = transactionDone(tx);
  try {
    const entries = await Promise.all(APPLICATION_STORE_NAMES.map(async (name) => [
      name,
      await requestResult(tx.objectStore(name).getAll()),
    ]));
    await done;
    return Object.fromEntries(entries);
  } catch (error) {
    await done.catch(() => {});
    throw toDatabaseError('Uygulama verileri okunamadı.', error);
  }
}

/** Replace all application data atomically; callers must validate the snapshot first. */
export async function replaceAllApplicationData(data) {
  const db = await openDatabase();
  const tx = db.transaction(APPLICATION_STORE_NAMES, 'readwrite');
  const done = transactionDone(tx);
  try {
    const requests = [];
    for (const name of APPLICATION_STORE_NAMES) {
      const store = tx.objectStore(name);
      requests.push(requestResult(store.clear()));
      for (const record of data[name]) requests.push(requestResult(store.add(record)));
    }
    await Promise.all(requests);
    await done;
    publishTransactionChange({ operation: 'restore' });
    publishSubscriptionChange({ operation: 'restore' });
    publishBudgetChange({ operation: 'restore' });
    return true;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be inactive */ }
    await done.catch(() => {});
    throw toDatabaseError('Yedek geri yüklenemedi; mevcut veriler korunuyor.', error);
  }
}

/** Remove user data while retaining schema and the standard starter categories. */
export async function resetAllApplicationData() {
  const db = await openDatabase();
  const tx = db.transaction(APPLICATION_STORE_NAMES, 'readwrite');
  const done = transactionDone(tx);
  try {
    const requests = APPLICATION_STORE_NAMES.map((name) => requestResult(tx.objectStore(name).clear()));
    const categoryStore = tx.objectStore(CATEGORIES_STORE);
    const createdAt = new Date().toISOString();
    for (const category of DEFAULT_CATEGORIES) requests.push(requestResult(categoryStore.add({ ...category, createdAt })));
    await Promise.all(requests);
    await done;
    publishTransactionChange({ operation: 'reset' });
    publishSubscriptionChange({ operation: 'reset' });
    publishBudgetChange({ operation: 'reset' });
    return true;
  } catch (error) {
    try { tx.abort(); } catch { /* transaction may already be inactive */ }
    await done.catch(() => {});
    throw toDatabaseError('Uygulama verileri sıfırlanamadı.', error);
  }
}

export const transactions = {
  async add(transaction) {
    const record = normalizeTransaction(transaction);
    const db = await openDatabase();
    const tx = db.transaction(TRANSACTIONS_STORE, 'readwrite');
    const done = transactionDone(tx);
    const request = tx.objectStore(TRANSACTIONS_STORE).add(record);
    try {
      const id = await requestResult(request);
      await done;
      const saved = { ...record, id };
      publishTransactionChange({ operation: 'add', id });
      return saved;
    } catch (error) {
      throw toDatabaseError('İşlem eklenemedi.', error);
    }
  },

  async get(id) {
    const db = await openDatabase();
    const tx = db.transaction(TRANSACTIONS_STORE, 'readonly');
    const done = transactionDone(tx);
    const request = tx.objectStore(TRANSACTIONS_STORE).get(id);
    try {
      const value = await requestResult(request);
      await done;
      return value;
    } catch (error) {
      throw toDatabaseError('İşlem okunamadı.', error);
    }
  },

  async update(id, changes) {
    if (!Number.isSafeInteger(id) && typeof id !== 'string') {
      throw new TypeError('İşlem kimliği metin veya tam sayı olmalıdır.');
    }
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new TypeError('Güncellenecek alanlar bir nesne olmalıdır.');
    }
    if (Object.hasOwn(changes, 'id') && changes.id !== id) {
      throw new TypeError('İşlem kimliği güncelleme sırasında değiştirilemez.');
    }

    const db = await openDatabase();
    const tx = db.transaction([TRANSACTIONS_STORE, SUBSCRIPTION_PAYMENTS_STORE], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(TRANSACTIONS_STORE);
    try {
      const existing = await requestResult(store.get(id));
      if (!existing) {
        tx.abort();
        await done.catch(() => {});
        return undefined;
      }
      const record = normalizeTransaction({ ...existing, ...changes, id });
      if (existing.subscriptionPaymentId !== undefined) {
        const paymentStore = tx.objectStore(SUBSCRIPTION_PAYMENTS_STORE);
        const payment = await requestResult(paymentStore.get(existing.subscriptionPaymentId));
        if (!payment) throw new Error('Abonelik ödeme geçmişi bulunamadığı için gider güncellenemedi.');
        payment.amountKurus = record.amountKurus;
        payment.paidAt = normalizePaidAt(record.date);
        paymentStore.put(payment);
      }
      store.put(record);
      await done;
      publishTransactionChange({ operation: 'update', id });
      if (existing.subscriptionPaymentId !== undefined) publishSubscriptionChange({ operation: 'payment-updated', id: existing.subscriptionId });
      return record;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('İşlem güncellenemedi.', error);
    }
  },

  async delete(id) {
    const db = await openDatabase();
    const tx = db.transaction([TRANSACTIONS_STORE, SUBSCRIPTION_PAYMENTS_STORE], 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore(TRANSACTIONS_STORE);
      const existing = await requestResult(store.get(id));
      if (!existing) {
        await done;
        publishTransactionChange({ operation: 'delete', id });
        return true;
      }
      if (existing.subscriptionPaymentId !== undefined) {
        const paymentStore = tx.objectStore(SUBSCRIPTION_PAYMENTS_STORE);
        const payment = await requestResult(paymentStore.get(existing.subscriptionPaymentId));
        if (!payment) throw new Error('Abonelik ödeme geçmişi bulunamadığı için gider silinemedi.');
        payment.status = 'reversed';
        payment.reversedAt = new Date().toISOString();
        paymentStore.put(payment);
      }
      store.delete(id);
      await done;
      publishTransactionChange({ operation: 'delete', id });
      if (existing.subscriptionPaymentId !== undefined) {
        publishSubscriptionChange({ operation: 'payment-reversed', id: existing.subscriptionId });
      }
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('İşlem silinemedi.', error);
    }
  },

  async list({ type, categoryId, fromDate, toDate } = {}) {
    if (type !== undefined && !['income', 'expense'].includes(type)) {
      throw new TypeError('İşlem türü income veya expense olmalıdır.');
    }
    const db = await openDatabase();
    const tx = db.transaction(TRANSACTIONS_STORE, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(TRANSACTIONS_STORE);

    let request;
    if (type !== undefined) request = store.index('byType').getAll(type);
    else if (categoryId !== undefined) request = store.index('byCategoryId').getAll(categoryId);
    else if (fromDate !== undefined || toDate !== undefined) {
      const lower = fromDate ?? '';
      const upper = toDate ?? '\uffff';
      request = store.index('byDate').getAll(IDBKeyRange.bound(lower, upper));
    } else request = store.getAll();

    try {
      let records = await requestResult(request);
      await done;
      if (type !== undefined) records = records.filter((item) => item.type === type);
      if (categoryId !== undefined) records = records.filter((item) => item.categoryId === categoryId);
      if (fromDate !== undefined) records = records.filter((item) => item.date >= fromDate);
      if (toDate !== undefined) records = records.filter((item) => item.date <= toDate);
      return records.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)
        || String(b.id).localeCompare(String(a.id), 'en', { numeric: true }));
    } catch (error) {
      throw toDatabaseError('İşlemler listelenemedi.', error);
    }
  },
};

export const subscriptions = {
  async add(input) {
    const record = normalizeSubscription(input);
    const category = await categories.get(record.categoryId);
    if (!category || category.type !== 'expense') throw new TypeError('Abonelik için geçerli bir gider kategorisi seçilmelidir.');
    const db = await openDatabase();
    const tx = db.transaction(SUBSCRIPTIONS_STORE, 'readwrite');
    const done = transactionDone(tx);
    try {
      await requestResult(tx.objectStore(SUBSCRIPTIONS_STORE).add(record));
      await done;
      publishSubscriptionChange({ operation: 'add', id: record.id });
      return record;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('Abonelik eklenemedi.', error);
    }
  },

  async get(id) {
    const db = await openDatabase();
    const tx = db.transaction(SUBSCRIPTIONS_STORE, 'readonly');
    const done = transactionDone(tx);
    try {
      const result = await requestResult(tx.objectStore(SUBSCRIPTIONS_STORE).get(id));
      await done;
      return result;
    } catch (error) {
      throw toDatabaseError('Abonelik okunamadı.', error);
    }
  },

  async list({ status, period, categoryId } = {}) {
    if (status !== undefined && !['active', 'cancelled'].includes(status)) throw new TypeError('Abonelik durumu active veya cancelled olmalıdır.');
    if (period !== undefined && !['monthly', 'yearly'].includes(period)) throw new TypeError('Abonelik periyodu monthly veya yearly olmalıdır.');
    const db = await openDatabase();
    const tx = db.transaction(SUBSCRIPTIONS_STORE, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(SUBSCRIPTIONS_STORE);
    const request = status === undefined ? store.getAll() : store.index('byStatus').getAll(status);
    try {
      let records = await requestResult(request);
      await done;
      if (period !== undefined) records = records.filter((item) => item.period === period);
      if (categoryId !== undefined) records = records.filter((item) => item.categoryId === categoryId);
      return records.sort((a, b) => a.nextPaymentDate.localeCompare(b.nextPaymentDate) || a.name.localeCompare(b.name, 'tr'));
    } catch (error) {
      throw toDatabaseError('Abonelikler listelenemedi.', error);
    }
  },

  async update(id, changes) {
    if (typeof id !== 'string' || !id) throw new TypeError('Abonelik kimliği boş olmayan bir metin olmalıdır.');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Güncellenecek abonelik alanları bir nesne olmalıdır.');
    if (Object.hasOwn(changes, 'id') && changes.id !== id) throw new TypeError('Abonelik kimliği değiştirilemez.');
    if (Object.hasOwn(changes, 'status')) throw new TypeError('Durum yalnızca iptal API’siyle değiştirilebilir.');
    if (Object.hasOwn(changes, 'categoryId')) {
      const category = await categories.get(changes.categoryId);
      if (!category || category.type !== 'expense') throw new TypeError('Abonelik için geçerli bir gider kategorisi seçilmelidir.');
    }
    const db = await openDatabase();
    const tx = db.transaction(SUBSCRIPTIONS_STORE, 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore(SUBSCRIPTIONS_STORE);
      const existing = await requestResult(store.get(id));
      if (!existing) {
        tx.abort();
        await done.catch(() => {});
        return undefined;
      }
      const dateChanged = Object.hasOwn(changes, 'nextPaymentDate') && changes.nextPaymentDate !== existing.nextPaymentDate;
      const merged = { ...existing, ...changes, id, updatedAt: new Date().toISOString() };
      if (dateChanged && !Object.hasOwn(changes, 'billingDay')) merged.billingDay = dayOfDate(merged.nextPaymentDate);
      if (dateChanged && merged.period === 'yearly' && !Object.hasOwn(changes, 'billingMonth')) merged.billingMonth = monthOfDate(merged.nextPaymentDate);
      const record = normalizeSubscription(merged, { preserveStatus: existing.status });
      store.put(record);
      await done;
      publishSubscriptionChange({ operation: 'update', id });
      return record;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('Abonelik güncellenemedi.', error);
    }
  },

  async cancel(id) {
    const db = await openDatabase();
    const tx = db.transaction(SUBSCRIPTIONS_STORE, 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore(SUBSCRIPTIONS_STORE);
      const existing = await requestResult(store.get(id));
      if (!existing) {
        tx.abort();
        await done.catch(() => {});
        return undefined;
      }
      if (existing.status === 'cancelled') {
        await done;
        return existing;
      }
      const record = { ...existing, status: 'cancelled', updatedAt: new Date().toISOString(), cancelledAt: new Date().toISOString() };
      store.put(record);
      await done;
      publishSubscriptionChange({ operation: 'cancel', id });
      return record;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('Abonelik iptal edilemedi.', error);
    }
  },

  async delete(id) {
    const db = await openDatabase();
    const tx = db.transaction([SUBSCRIPTIONS_STORE, SUBSCRIPTION_PAYMENTS_STORE], 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore(SUBSCRIPTIONS_STORE);
      const existing = await requestResult(store.get(id));
      if (!existing) {
        await done;
        return false;
      }
      const paymentCount = await requestResult(tx.objectStore(SUBSCRIPTION_PAYMENTS_STORE).index('bySubscriptionId').count(id));
      if (paymentCount > 0) {
        tx.abort();
        await done.catch(() => {});
        return false;
      }
      store.delete(id);
      await done;
      publishSubscriptionChange({ operation: 'delete', id });
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('Abonelik silinemedi.', error);
    }
  },
};

export const subscriptionPayments = {
  async list({ subscriptionId, status } = {}) {
    if (status !== undefined && !['paid', 'reversed'].includes(status)) throw new TypeError('Ödeme durumu paid veya reversed olmalıdır.');
    const db = await openDatabase();
    const tx = db.transaction(SUBSCRIPTION_PAYMENTS_STORE, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(SUBSCRIPTION_PAYMENTS_STORE);
    const request = subscriptionId === undefined ? store.getAll() : store.index('bySubscriptionId').getAll(subscriptionId);
    try {
      let records = await requestResult(request);
      await done;
      if (status !== undefined) records = records.filter((item) => item.status === status);
      return records.sort((a, b) => b.paidAt.localeCompare(a.paidAt) || b.id - a.id);
    } catch (error) {
      throw toDatabaseError('Abonelik ödemeleri listelenemedi.', error);
    }
  },

  /** Atomically records one subscription period and its linked normal expense. */
  async record(subscriptionId, { paidAt = new Date().toISOString(), periodKey: requestedPeriodKey } = {}) {
    if (typeof subscriptionId !== 'string' || !subscriptionId) throw new TypeError('Abonelik kimliği boş olmayan bir metin olmalıdır.');
    if (requestedPeriodKey !== undefined && (typeof requestedPeriodKey !== 'string' || !requestedPeriodKey)) throw new TypeError('periodKey boş olmayan bir metin olmalıdır.');
    const normalizedPaidAt = normalizePaidAt(paidAt);
    const db = await openDatabase();
    const storeNames = [SUBSCRIPTIONS_STORE, SUBSCRIPTION_PAYMENTS_STORE, TRANSACTIONS_STORE, CATEGORIES_STORE];
    const tx = db.transaction(storeNames, 'readwrite');
    let result;
    let failure;

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        publishTransactionChange({ operation: 'add', id: result.transaction.id, source: 'subscription-payment' });
        publishSubscriptionChange({ operation: 'payment', id: subscriptionId, paymentId: result.payment.id });
        resolve(result);
      };
      tx.onerror = () => {};
      tx.onabort = () => reject(toDatabaseError('Abonelik ödemesi kaydedilemedi.', failure ?? tx.error));

      const abort = (error) => {
        failure = error;
        try { tx.abort(); } catch { reject(toDatabaseError('Abonelik ödemesi kaydedilemedi.', error)); }
      };

      try {
        const subscriptionsStore = tx.objectStore(SUBSCRIPTIONS_STORE);
        const paymentsStore = tx.objectStore(SUBSCRIPTION_PAYMENTS_STORE);
        const transactionsStore = tx.objectStore(TRANSACTIONS_STORE);
        const categoriesStore = tx.objectStore(CATEGORIES_STORE);
        const subscriptionRequest = subscriptionsStore.get(subscriptionId);
        subscriptionRequest.onerror = () => { failure = subscriptionRequest.error; };
        subscriptionRequest.onsuccess = () => {
          const subscription = subscriptionRequest.result;
          if (!subscription) return abort(new TypeError('Abonelik bulunamadı.'));
          if (subscription.status !== 'active') return abort(new TypeError('İptal edilmiş aboneliğe ödeme kaydedilemez.'));
          let periodKey;
          try { periodKey = periodKeyFor(subscription.period, subscription.nextPaymentDate); }
          catch (error) { return abort(error); }

          const targetPeriodKey = requestedPeriodKey ?? periodKey;
          const existingRequest = paymentsStore.index('bySubscriptionPeriod').getKey([subscriptionId, targetPeriodKey]);
          existingRequest.onerror = () => { failure = existingRequest.error; };
          existingRequest.onsuccess = () => {
            if (existingRequest.result !== undefined) return abort(new DOMException('Bu abonelik dönemi daha önce kaydedilmiş.', 'ConstraintError'));
            if (targetPeriodKey !== periodKey) return abort(new TypeError('Ödeme dönemi aboneliğin sıradaki dönem anahtarıyla eşleşmiyor.'));

            const categoryRequest = categoriesStore.get(subscription.categoryId);
            categoryRequest.onerror = () => { failure = categoryRequest.error; };
            categoryRequest.onsuccess = () => {
              const category = categoryRequest.result;
              if (!category || category.type !== 'expense') return abort(new TypeError('Abonelik gider kategorisi bulunamadı.'));

              const payment = {
                subscriptionId,
                periodKey,
                dueDate: subscription.nextPaymentDate,
                paidAt: normalizedPaidAt,
                amountKurus: subscription.amountKurus,
                transactionId: null,
                status: 'paid',
              };
              let paymentId;
              try { paymentId = paymentsStore.add(payment); }
              catch (error) { return abort(error); }
              paymentId.onsuccess = () => {
                let transactionRecord;
                try {
                  transactionRecord = normalizeTransaction({
                    type: 'expense',
                    amountKurus: subscription.amountKurus,
                    categoryId: subscription.categoryId,
                    description: `Abonelik ödemesi · ${subscription.name}`,
                    date: normalizedPaidAt.slice(0, 10),
                    subscriptionId,
                    subscriptionPaymentId: paymentId.result,
                    subscriptionPeriodKey: periodKey,
                  });
                } catch (error) { return abort(error); }

                let transactionRequest;
                try { transactionRequest = transactionsStore.add(transactionRecord); }
                catch (error) { return abort(error); }
                transactionRequest.onerror = () => { failure = transactionRequest.error; };
                transactionRequest.onsuccess = () => {
                  let nextPaymentDate;
                  try { nextPaymentDate = nextDateForSubscription(subscription); }
                  catch (error) { return abort(error); }
                  const savedPayment = { ...payment, id: paymentId.result, transactionId: transactionRequest.result };
                  const savedTransaction = { ...transactionRecord, id: transactionRequest.result };
                  try {
                    paymentsStore.put(savedPayment);
                    subscriptionsStore.put({ ...subscription, nextPaymentDate, updatedAt: new Date().toISOString() });
                  } catch (error) { return abort(error); }
                  result = { payment: savedPayment, transaction: savedTransaction, nextPaymentDate };
                };
              };
            };
          };
        };
      } catch (error) {
        abort(error);
      }
    });
  },
};

export const budgets = {
  async add(input) {
    const record = normalizeBudget(input);
    const category = await categories.get(record.categoryId);
    if (!category || category.type !== 'expense') throw new TypeError('Bütçe için geçerli bir gider kategorisi seçilmelidir.');
    const db = await openDatabase();
    const tx = db.transaction(BUDGETS_STORE, 'readwrite');
    const done = transactionDone(tx);
    try {
      await requestResult(tx.objectStore(BUDGETS_STORE).add(record));
      await done;
      publishBudgetChange({ operation: 'add', id: record.id });
      return record;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('Bütçe eklenemedi.', error);
    }
  },

  async get(id) {
    const db = await openDatabase();
    const tx = db.transaction(BUDGETS_STORE, 'readonly');
    const done = transactionDone(tx);
    try {
      const record = await requestResult(tx.objectStore(BUDGETS_STORE).get(id));
      await done;
      return record;
    } catch (error) { throw toDatabaseError('Bütçe okunamadı.', error); }
  },

  async list({ categoryId } = {}) {
    const db = await openDatabase();
    const tx = db.transaction(BUDGETS_STORE, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(BUDGETS_STORE);
    try {
      const records = await requestResult(categoryId === undefined
        ? store.getAll()
        : store.index('byCategoryId').getAll(categoryId));
      await done;
      return records.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    } catch (error) { throw toDatabaseError('Bütçeler listelenemedi.', error); }
  },

  async update(id, changes) {
    if (typeof id !== 'string' || !id) throw new TypeError('Bütçe kimliği boş olmayan bir metin olmalıdır.');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Güncellenecek bütçe alanları bir nesne olmalıdır.');
    if (Object.hasOwn(changes, 'id')) throw new TypeError('Bütçe kimliği güncellenemez.');
    const db = await openDatabase();
    const tx = db.transaction([BUDGETS_STORE, CATEGORIES_STORE], 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore(BUDGETS_STORE);
      const existing = await requestResult(store.get(id));
      if (!existing) {
        tx.abort();
        await done.catch(() => {});
        return undefined;
      }
      const merged = normalizeBudget({ ...existing, ...changes, id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
      const category = await requestResult(tx.objectStore(CATEGORIES_STORE).get(merged.categoryId));
      if (!category || category.type !== 'expense') throw new TypeError('Bütçe için geçerli bir gider kategorisi seçilmelidir.');
      store.put(merged);
      await done;
      publishBudgetChange({ operation: 'update', id });
      return merged;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('Bütçe güncellenemedi.', error);
    }
  },

  async delete(id) {
    const db = await openDatabase();
    const tx = db.transaction(BUDGETS_STORE, 'readwrite');
    const done = transactionDone(tx);
    try {
      const store = tx.objectStore(BUDGETS_STORE);
      const existing = await requestResult(store.get(id));
      if (!existing) {
        await done;
        return false;
      }
      store.delete(id);
      await done;
      publishBudgetChange({ operation: 'delete', id });
      return true;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await done.catch(() => {});
      throw toDatabaseError('Bütçe silinemedi.', error);
    }
  },
};

export const categories = {
  async add(category) {
    const record = normalizeCategory(category);
    const db = await openDatabase();
    const tx = db.transaction(CATEGORIES_STORE, 'readwrite');
    const done = transactionDone(tx);
    const request = tx.objectStore(CATEGORIES_STORE).add(record);
    try {
      await requestResult(request);
      await done;
      return record;
    } catch (error) {
      throw toDatabaseError('Kategori eklenemedi.', error);
    }
  },

  async get(id) {
    const db = await openDatabase();
    const tx = db.transaction(CATEGORIES_STORE, 'readonly');
    const done = transactionDone(tx);
    const request = tx.objectStore(CATEGORIES_STORE).get(id);
    try {
      const result = await requestResult(request);
      await done;
      return result;
    } catch (error) {
      throw toDatabaseError('Kategori okunamadı.', error);
    }
  },

  async list({ type } = {}) {
    if (type !== undefined && !['income', 'expense'].includes(type)) {
      throw new TypeError('Kategori türü income veya expense olmalıdır.');
    }
    const db = await openDatabase();
    const tx = db.transaction(CATEGORIES_STORE, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(CATEGORIES_STORE);
    const request = type === undefined ? store.getAll() : store.index('byType').getAll(type);
    try {
      const result = await requestResult(request);
      await done;
      return result.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    } catch (error) {
      throw toDatabaseError('Kategoriler listelenemedi.', error);
    }
  },

  async update(id, changes) {
    if (typeof id !== 'string' || !id) throw new TypeError('Kategori kimliği boş olmayan bir metin olmalıdır.');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Güncellenecek kategori alanları bir nesne olmalıdır.');
    if (Object.hasOwn(changes, 'id') && changes.id !== id) throw new TypeError('Kategori kimliği değiştirilemez.');
    const db = await openDatabase();
    const tx = db.transaction(CATEGORIES_STORE, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(CATEGORIES_STORE);
    try {
      const existing = await requestResult(store.get(id));
      if (!existing) {
        tx.abort();
        await done.catch(() => {});
        return undefined;
      }
      const record = normalizeCategory({ ...existing, ...changes, id });
      store.put(record);
      await done;
      return record;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      throw toDatabaseError('Kategori güncellenemedi.', error);
    }
  },

  async delete(id) {
    const db = await openDatabase();
    const tx = db.transaction(CATEGORIES_STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(CATEGORIES_STORE).delete(id);
    try {
      await done;
      return true;
    } catch (error) {
      throw toDatabaseError('Kategori silinemedi.', error);
    }
  },
};

function normalizeTransaction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('İşlem verisi bir nesne olmalıdır.');
  }
  const { id, type, amountKurus, categoryId, description, date, createdAt, subscriptionId, subscriptionPaymentId, subscriptionPeriodKey } = input;
  if (type !== 'income' && type !== 'expense') {
    throw new TypeError('İşlem türü income veya expense olmalıdır.');
  }
  if (!Number.isSafeInteger(amountKurus) || amountKurus <= 0) {
    throw new TypeError('amountKurus pozitif güvenli bir tam sayı olmalıdır.');
  }
  if (typeof categoryId !== 'string' || !categoryId.trim()) {
    throw new TypeError('categoryId boş olmayan bir metin olmalıdır.');
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new TypeError('description boş olmayan bir metin olmalıdır.');
  }
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) {
    throw new TypeError('date geçerli bir tarih metni olmalıdır.');
  }
  if (id !== undefined && !Number.isSafeInteger(id) && typeof id !== 'string') {
    throw new TypeError('id metin veya tam sayı olmalıdır.');
  }
  const record = {
    type,
    amountKurus,
    categoryId: categoryId.trim(),
    description: description.trim(),
    date,
    createdAt: createdAt ?? new Date().toISOString(),
  };
  if (subscriptionId !== undefined) {
    if (typeof subscriptionId !== 'string' || !subscriptionId) throw new TypeError('subscriptionId boş olmayan bir metin olmalıdır.');
    record.subscriptionId = subscriptionId;
  }
  if (subscriptionPaymentId !== undefined) {
    if (!Number.isSafeInteger(subscriptionPaymentId) || subscriptionPaymentId <= 0) throw new TypeError('subscriptionPaymentId pozitif bir tam sayı olmalıdır.');
    record.subscriptionPaymentId = subscriptionPaymentId;
  }
  if (subscriptionPeriodKey !== undefined) {
    if (typeof subscriptionPeriodKey !== 'string' || !subscriptionPeriodKey) throw new TypeError('subscriptionPeriodKey boş olmayan bir metin olmalıdır.');
    record.subscriptionPeriodKey = subscriptionPeriodKey;
  }
  if ((subscriptionId === undefined) !== (subscriptionPaymentId === undefined)
    || (subscriptionId === undefined) !== (subscriptionPeriodKey === undefined)) {
    throw new TypeError('Abonelik bağlantı alanları birlikte tanımlanmalıdır.');
  }
  if (id !== undefined) record.id = id;
  return record;
}

function normalizeSubscription(input, { preserveStatus } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Abonelik verisi bir nesne olmalıdır.');
  const id = input.id ?? createId();
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Abonelik kimliği boş olmayan bir metin olmalıdır.');
  if (typeof input.name !== 'string' || !input.name.trim()) throw new TypeError('Abonelik adı boş olamaz.');
  if (!Number.isSafeInteger(input.amountKurus) || input.amountKurus <= 0) throw new TypeError('amountKurus pozitif güvenli bir tam sayı olmalıdır.');
  if (!['monthly', 'yearly'].includes(input.period)) throw new TypeError('Abonelik periyodu monthly veya yearly olmalıdır.');
  if (!isDateKey(input.nextPaymentDate)) throw new TypeError('nextPaymentDate YYYY-MM-DD biçiminde geçerli bir tarih olmalıdır.');
  if (typeof input.categoryId !== 'string' || !input.categoryId.trim()) throw new TypeError('categoryId boş olmayan bir metin olmalıdır.');
  const status = preserveStatus ?? input.status ?? 'active';
  if (!['active', 'cancelled'].includes(status)) throw new TypeError('Abonelik durumu active veya cancelled olmalıdır.');
  const billingDay = input.billingDay ?? dayOfDate(input.nextPaymentDate);
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) throw new TypeError('billingDay 1 ile 31 arasında olmalıdır.');
  const billingMonth = input.period === 'yearly' ? (input.billingMonth ?? monthOfDate(input.nextPaymentDate)) : null;
  if (input.period === 'yearly' && (!Number.isInteger(billingMonth) || billingMonth < 1 || billingMonth > 12)) {
    throw new TypeError('Yıllık abonelik billingMonth 1 ile 12 arasında olmalıdır.');
  }
  const now = new Date().toISOString();
  const record = {
    id: id.trim(),
    name: input.name.trim(),
    amountKurus: input.amountKurus,
    period: input.period,
    nextPaymentDate: input.nextPaymentDate,
    categoryId: input.categoryId.trim(),
    status,
    billingDay,
    billingMonth,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  if (input.cancelledAt !== undefined) record.cancelledAt = input.cancelledAt;
  if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new TypeError('createdAt ve updatedAt geçerli tarih değerleri olmalıdır.');
  }
  return record;
}

function normalizeBudget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Bütçe verisi bir nesne olmalıdır.');
  const id = input.id ?? createId();
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Bütçe kimliği boş olmayan bir metin olmalıdır.');
  if (typeof input.name !== 'string' || !input.name.trim()) throw new TypeError('Bütçe adı boş olamaz.');
  if (typeof input.categoryId !== 'string' || !input.categoryId.trim()) throw new TypeError('categoryId boş olmayan bir metin olmalıdır.');
  if (!Number.isSafeInteger(input.amountKurus) || input.amountKurus <= 0) throw new TypeError('amountKurus pozitif güvenli bir tam sayı olmalıdır.');
  const period = input.period ?? 'monthly';
  if (period !== 'monthly') throw new TypeError('Bütçe periyodu monthly olmalıdır.');
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new TypeError('createdAt ve updatedAt geçerli tarih değerleri olmalıdır.');
  return { id: id.trim(), name: input.name.trim(), categoryId: input.categoryId.trim(), amountKurus: input.amountKurus, period, createdAt, updatedAt };
}

function createId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInCalendarMonth(year, month);
}

function dayOfDate(dateKey) { return Number(dateKey.slice(8, 10)); }
function monthOfDate(dateKey) { return Number(dateKey.slice(5, 7)); }

function periodKeyFor(period, dueDate) {
  if (!isDateKey(dueDate)) throw new TypeError('Abonelik ödeme tarihi geçersiz.');
  return period === 'monthly' ? `monthly:${dueDate.slice(0, 7)}` : `yearly:${dueDate.slice(0, 4)}`;
}

function nextDateForSubscription(subscription) {
  const [year, month] = subscription.nextPaymentDate.split('-').map(Number);
  const nextYear = subscription.period === 'yearly' ? year + 1 : year + (month === 12 ? 1 : 0);
  const nextMonth = subscription.period === 'yearly' ? subscription.billingMonth : (month === 12 ? 1 : month + 1);
  if (nextYear > 9999) throw new RangeError('Sonraki ödeme tarihi desteklenen takvim aralığını aşıyor.');
  const monthLength = daysInCalendarMonth(nextYear, nextMonth);
  const day = Math.min(subscription.billingDay, monthLength);
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInCalendarMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function normalizePaidAt(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('paidAt geçerli bir tarih metni olmalıdır.');
  if (isDateKey(value)) return `${value}T12:00:00.000Z`;
  return new Date(value).toISOString();
}

function normalizeCategory(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Kategori verisi bir nesne olmalıdır.');
  const { id, name, type, icon, color, createdAt } = input;
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('id boş olmayan bir metin olmalıdır.');
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('Kategori adı boş olamaz.');
  if (!['income', 'expense'].includes(type)) throw new TypeError('Kategori türü income veya expense olmalıdır.');
  if (typeof icon !== 'string' || !icon.trim()) throw new TypeError('Kategori ikonu boş olamaz.');
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError('Kategori rengi altı haneli HEX olmalıdır.');
  return { id: id.trim(), name: name.trim(), type, icon: icon.trim(), color, createdAt: createdAt ?? new Date().toISOString() };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB isteği başarısız oldu.'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Veritabanı işlemi iptal edildi.'));
    tx.onerror = () => reject(tx.error ?? new Error('Veritabanı işlemi başarısız oldu.'));
  });
}

function toDatabaseError(message, cause) {
  const error = new Error(message, { cause });
  if (cause?.name) error.name = cause.name;
  return error;
}
