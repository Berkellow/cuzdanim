import {
  APPLICATION_STORE_NAMES, budgets, categories, closeDatabase, DATABASE_NAME, DATABASE_VERSION, openDatabase, readAllApplicationData, subscriptionPayments,
  subscriptions, SUBSCRIPTIONS_STORE, SUBSCRIPTION_PAYMENTS_STORE, subscribeToSubscriptionChanges,
  transactions, upgradeDatabaseSchema, BUDGETS_STORE,
} from '../js/database.js';
import { buildDashboardData, buildWeeklySeries, chartAxisMaximumKurus, latestTransactions, summarizeTransactions } from '../js/dashboard-data.js';
import { formatKurus, sumKurus } from '../js/money.js';
import { summarizeBudgets } from '../js/budget-data.js';
import { buildReportsData, getReportDateRange } from '../js/reports-data.js';
import { createBackupObject, parseBackupText, serializeBackup } from '../js/data-backup.js';

const STATE_KEY = 'cuzdanim-indexeddb-test-state-v1';
const RESULTS_KEY = 'cuzdanim-indexeddb-test-results-v1';
const resultsElement = document.querySelector('#results');
const summaryElement = document.querySelector('#summary');
const migrationTestConnections = new Map();

function recordResult(name, passed, details = '') {
  const results = JSON.parse(sessionStorage.getItem(RESULTS_KEY) ?? '[]');
  results.push({ name, passed, details });
  sessionStorage.setItem(RESULTS_KEY, JSON.stringify(results));
  renderResults(results);
}

function renderResults(results) {
  resultsElement.replaceChildren(...results.map(({ name, passed, details }) => {
    const item = document.createElement('li');
    item.className = passed ? 'pass' : 'fail';
    item.textContent = `${passed ? 'BAŞARILI' : 'BAŞARISIZ'} — ${name}${details ? `: ${details}` : ''}`;
    return item;
  }));
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  summaryElement.textContent = `${passed} başarılı · ${failed} başarısız · ${results.length} kontrol`;
  summaryElement.style.color = failed ? '#ff6b75' : '#39d98a';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB işlemi iptal edildi.'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB işlemi başarısız oldu.'));
  });
}

async function waitUntil(predicate, message, { timeoutMs = 6000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastError ? ` (${lastError.message})` : '';
  throw new Error(`${message}${detail}`);
}

async function waitForCategoryOption(select, categoryId, message) {
  await waitUntil(
    () => [...select.options].some((option) => option.value === categoryId),
    message,
  );
}

async function waitForDashboardTotals(totals) {
  const frame = document.querySelector('#app-frame');
  await waitUntil(() => frame.contentDocument?.readyState === 'complete' && frame.contentDocument.querySelector('#dashboard-income'), 'Dashboard çerçevesi hazır değil');
  const frameDocument = frame.contentDocument;
  await waitUntil(() => frameDocument.querySelector('#dashboard-income').textContent === formatKurus(totals.incomeKurus)
    && frameDocument.querySelector('#dashboard-expense').textContent === formatKurus(totals.expenseKurus)
    && frameDocument.querySelector('#dashboard-balance').textContent === formatKurus(totals.balanceKurus), 'Dashboard toplamları beklenen değere gelmedi');
}

async function deleteByDescriptions(descriptions) {
  if (!descriptions?.length) return;
  const expected = new Set(descriptions);
  const records = await transactions.list();
  for (const record of records) {
    if (expected.has(record.description)) await transactions.delete(record.id);
  }
}

async function cleanupTestRecords({ ids = [], descriptions = [], categoryId } = {}) {
  const errors = [];
  for (const id of ids) {
    try { await transactions.delete(id); } catch (error) { errors.push(error.message); }
  }
  try { await deleteByDescriptions(descriptions); } catch (error) { errors.push(error.message); }
  if (categoryId) {
    try { await categories.delete(categoryId); } catch (error) { errors.push(error.message); }
  }

  const remaining = await transactions.list();
  const idSet = new Set(ids);
  const descriptionSet = new Set(descriptions);
  const leftovers = remaining.filter((record) => idSet.has(record.id) || descriptionSet.has(record.description));
  if (leftovers.length) errors.push(`${leftovers.length} test işlemi veritabanında kaldı`);
  if (errors.length) throw new Error(errors.join('; '));
}

async function cleanupSubscriptionFixtures(subscriptionIds = []) {
  for (const subscriptionId of subscriptionIds) {
    const payments = await subscriptionPayments.list({ subscriptionId });
    for (const payment of payments) {
      if (payment.transactionId !== null && payment.transactionId !== undefined) {
        await transactions.delete(payment.transactionId);
      }
    }
    const db = await openDatabase();
    const tx = db.transaction([SUBSCRIPTIONS_STORE, SUBSCRIPTION_PAYMENTS_STORE], 'readwrite');
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error('Test abonelik temizliği iptal edildi.'));
      tx.onerror = () => reject(tx.error ?? new Error('Test abonelik temizliği başarısız oldu.'));
    });
    const paymentStore = tx.objectStore(SUBSCRIPTION_PAYMENTS_STORE);
    const cursorRequest = paymentStore.index('bySubscriptionId').openCursor(subscriptionId);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.objectStore(SUBSCRIPTIONS_STORE).delete(subscriptionId);
    await done;
  }
}

function makeSubscription(overrides = {}) {
  return {
    name: `Test aboneliği ${crypto.randomUUID()}`,
    amountKurus: 12990,
    period: 'monthly',
    nextPaymentDate: '2026-01-31',
    categoryId: 'expense-bills',
    ...overrides,
  };
}

function createLegacyDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transactionsStore = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
      transactionsStore.createIndex('byDate', 'date', { unique: false });
      transactionsStore.createIndex('byType', 'type', { unique: false });
      transactionsStore.createIndex('byCategoryId', 'categoryId', { unique: false });
      transactionsStore.add({ type: 'expense', amountKurus: 1450, categoryId: 'legacy-category', description: 'Migration eski gider', date: '2026-01-02', createdAt: '2026-01-02T10:00:00.000Z' });
      const categoriesStore = db.createObjectStore('categories', { keyPath: 'id' });
      categoriesStore.createIndex('byType', 'type', { unique: false });
      categoriesStore.createIndex('byName', 'name', { unique: false });
      categoriesStore.add({ id: 'legacy-category', name: 'Eski kategori', type: 'expense', icon: 'receipt', color: '#123456', createdAt: '2026-01-01T00:00:00.000Z' });
    };
    request.onsuccess = () => resolve(trackMigrationTestConnection(name, request.result));
    request.onerror = () => {
      request.result?.close();
      reject(request.error);
    };
  });
}

function createVersionThreeDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transactionsStore = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
      transactionsStore.createIndex('byDate', 'date', { unique: false });
      transactionsStore.createIndex('byType', 'type', { unique: false });
      transactionsStore.createIndex('byCategoryId', 'categoryId', { unique: false });
      transactionsStore.createIndex('bySubscriptionPaymentId', 'subscriptionPaymentId', { unique: false });
      transactionsStore.add({ type: 'expense', amountKurus: 2450, categoryId: 'v3-category', description: 'v3 eski kayıt', date: '2026-03-04', createdAt: '2026-03-04T10:00:00.000Z' });
      const categoriesStore = db.createObjectStore('categories', { keyPath: 'id' });
      categoriesStore.createIndex('byType', 'type', { unique: false });
      categoriesStore.createIndex('byName', 'name', { unique: false });
      categoriesStore.add({ id: 'v3-category', name: 'v3 kategorisi', type: 'expense', icon: 'receipt', color: '#123456', createdAt: '2026-03-01T00:00:00.000Z' });
      const subscriptionStore = db.createObjectStore('subscriptions', { keyPath: 'id' });
      subscriptionStore.createIndex('byStatus', 'status', { unique: false });
      subscriptionStore.createIndex('byNextPaymentDate', 'nextPaymentDate', { unique: false });
      subscriptionStore.createIndex('byCategoryId', 'categoryId', { unique: false });
      subscriptionStore.add({ id: 'v3-subscription', name: 'v3 aboneliği', amountKurus: 1200, period: 'monthly', nextPaymentDate: '2026-04-04', categoryId: 'v3-category', status: 'active', billingDay: 4, billingMonth: null, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' });
      const paymentStore = db.createObjectStore('subscriptionPayments', { keyPath: 'id', autoIncrement: true });
      paymentStore.createIndex('bySubscriptionId', 'subscriptionId', { unique: false });
      paymentStore.createIndex('byPaidAt', 'paidAt', { unique: false });
      paymentStore.createIndex('bySubscriptionPeriod', ['subscriptionId', 'periodKey'], { unique: true });
      paymentStore.add({ subscriptionId: 'v3-subscription', periodKey: 'monthly:2026-03', dueDate: '2026-03-04', paidAt: '2026-03-04T12:00:00.000Z', amountKurus: 1200, transactionId: 1, status: 'paid' });
    };
    request.onsuccess = () => resolve(trackMigrationTestConnection(name, request.result));
    request.onerror = () => {
      request.result?.close();
      reject(request.error);
    };
  });
}

function migrateLegacyDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => upgradeDatabaseSchema(request.result, request.transaction);
    request.onsuccess = () => resolve(trackMigrationTestConnection(name, request.result));
    request.onerror = () => {
      request.result?.close();
      reject(request.error);
    };
  });
}

function trackMigrationTestConnection(name, db) {
  if (!migrationTestConnections.has(name)) migrationTestConnections.set(name, new Set());
  migrationTestConnections.get(name).add(db);
  db.addEventListener('versionchange', () => closeMigrationTestConnection(name, db));
  return db;
}

function closeMigrationTestConnection(name, db) {
  try { db.close(); } finally {
    const connections = migrationTestConnections.get(name);
    connections?.delete(db);
    if (connections?.size === 0) migrationTestConnections.delete(name);
  }
}

function closeMigrationTestConnections(name) {
  for (const db of [...(migrationTestConnections.get(name) ?? [])]) closeMigrationTestConnection(name, db);
}

function deleteDatabase(name, { timeoutMs = 10000 } = {}) {
  if (!name.startsWith('CuzdanimMigrationTest_') && !name.startsWith('CuzdanimV3MigrationTest_')) {
    return Promise.reject(new Error('Yalnızca test fixture veritabanları silinebilir.'));
  }
  closeMigrationTestConnections(name);
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    let blockedTimer;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(blockedTimer);
      callback(value);
    };
    request.onsuccess = () => finish(resolve);
    request.onerror = () => finish(reject, request.error ?? new Error(`Test veritabanı silinemedi: ${name}`));
    request.onblocked = () => {
      // A blocked delete remains pending. Close any test-owned handles, then wait
      // for IndexedDB to finish this request before allowing the next test to run.
      closeMigrationTestConnections(name);
      if (!blockedTimer) {
        blockedTimer = setTimeout(() => finish(reject, new Error(`Test veritabanı ${timeoutMs} ms içinde silinemedi; açık bağlantı hâlâ var: ${name}`)), timeoutMs);
      }
    };
  });
}

function dateAtOffset(reference, offset) {
  const date = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + offset, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function check(name, test) {
  try {
    await test();
    recordResult(name, true);
    return true;
  } catch (error) {
    recordResult(name, false, error.message);
    return false;
  }
}

function makeTestRecord(type, categoryId, date, description) {
  return {
    type,
    amountKurus: type === 'income' ? 125075 : 2580,
    categoryId,
    description,
    date,
    createdAt: new Date().toISOString(),
  };
}

async function verifyRefresh(state) {
  await check('Sayfa yenilendikten sonra kayıt korunuyor', async () => {
    const saved = await transactions.get(state.incomeId);
    assert(saved, `ID ${state.incomeId} yenilemeden sonra bulunamadı`);
    assert(saved.description === state.updatedDescription, 'Güncellenmiş açıklama kalıcı değil');
    assert(saved.amountKurus === 125999, 'Güncellenmiş kuruş tutarı kalıcı değil');
  });

  await check('Yenilenen dashboard IndexedDB toplamlarını yüklüyor', async () => {
    const frame = document.querySelector('#app-frame');
    await waitUntil(() => frame.contentDocument?.readyState === 'complete' && frame.contentDocument.querySelector('#dashboard-income'), 'Dashboard yenileme sonrası yüklenmedi');
    const totals = summarizeTransactions(await transactions.list());
    const frameDocument = frame.contentDocument;
    await waitUntil(() => frameDocument.querySelector('#dashboard-income').textContent === formatKurus(totals.incomeKurus)
      && frameDocument.querySelector('#dashboard-expense').textContent === formatKurus(totals.expenseKurus)
      && frameDocument.querySelector('#dashboard-balance').textContent === formatKurus(totals.balanceKurus), 'Yenilenen dashboard kayıtlı toplamları göstermedi');
  });

  const cleanupErrors = [];
  try { await cleanupTestRecords({ ids: state.ids, descriptions: state.formDescriptions, categoryId: state.categoryId }); }
  catch (error) { cleanupErrors.push(error.message); }
  try { await cleanupSubscriptionFixtures(state.subscriptionIds ?? []); }
  catch (error) { cleanupErrors.push(error.message); }
  try {
    if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
    recordResult('Test kayıtları temizlendi', true);
  } catch (error) {
    recordResult('Test kayıtları temizlendi', false, error.message);
  } finally {
    sessionStorage.removeItem(STATE_KEY);
    await closeDatabase();
    renderResults(JSON.parse(sessionStorage.getItem(RESULTS_KEY) ?? '[]'));
  }
}

async function runSuite() {
  const refreshState = sessionStorage.getItem(STATE_KEY);
  if (refreshState) {
    await verifyRefresh(JSON.parse(refreshState));
    return;
  }

  sessionStorage.removeItem(RESULTS_KEY);
  renderResults([]);
  let income;
  let expense;
  const formRecordIds = [];
  const formDescriptions = [];
  const subscriptionIds = [];
  let categoryId;
  let budgetCategoryId;
  const date = new Date().toISOString();
  const updatedDescription = `Test gelir güncellendi ${crypto.randomUUID()}`;

  try {
    const db = await openDatabase();
    categoryId = `__test__${crypto.randomUUID()}`;
    await check(`CuzdanimDB v${DATABASE_VERSION} başarıyla açılıyor`, async () => {
      assert(db.name === DATABASE_NAME, `Beklenen DB ${DATABASE_NAME}, gelen ${db.name}`);
      assert(db.version === DATABASE_VERSION, `Beklenen sürüm ${DATABASE_VERSION}, gelen ${db.version}`);
      assert(db.objectStoreNames.contains('transactions'), 'transactions deposu bulunamadı');
      assert(db.objectStoreNames.contains(SUBSCRIPTIONS_STORE) && db.objectStoreNames.contains(SUBSCRIPTION_PAYMENTS_STORE), 'Abonelik depoları bulunamadı');
      assert(db.objectStoreNames.contains(BUDGETS_STORE), 'budgets deposu bulunamadı');
      const tx = db.transaction('transactions', 'readonly');
      const indexes = tx.objectStore('transactions').indexNames;
      assert(indexes.contains('byDate') && indexes.contains('byType') && indexes.contains('byCategoryId'), 'Gerekli indekslerden biri eksik');
    });

    await check('Veri yedeği tüm depoları UTF-8 JSON olarak doğrulayıp bozuk sürüm ve kayıtları reddediyor', async () => {
      const snapshot = await readAllApplicationData();
      const backup = createBackupObject(snapshot, { theme: 'light' }, '2026-11-03T12:00:00.000Z');
      const encoded = serializeBackup(backup);
      const restored = parseBackupText(encoded);
      assert(restored.databaseVersion === DATABASE_VERSION, 'Yedek veritabanı sürümünü taşımıyor');
      assert(restored.preferences.theme === 'light' && !Object.hasOwn(restored.preferences, 'currency'), 'Tema tercihi doğru saklanmadı veya kaldırılmış para birimi tercihi yeniden eklendi');
      const olderBackup = parseBackupText(JSON.stringify({ ...backup, preferences: { theme: 'dark', currency: 'EUR' } }));
      assert(olderBackup.preferences.theme === 'dark' && !Object.hasOwn(olderBackup.preferences, 'currency'), 'Eski yedekteki para birimi tercihi uygulamaya geri taşındı');
      assert(APPLICATION_STORE_NAMES.every((name) => restored.stores[name].length === snapshot[name].length), 'Yedekteki bir veri deposu eksik');
      let invalidVersionRejected = false;
      try { parseBackupText(JSON.stringify({ ...backup, databaseVersion: DATABASE_VERSION - 1 })); }
      catch { invalidVersionRejected = true; }
      assert(invalidVersionRejected, 'Başka veritabanı sürümündeki yedek kabul edildi');
      let invalidRecordRejected = false;
      const broken = structuredClone(backup);
      broken.stores.transactions.push({ id: 987654321, type: 'expense', amountKurus: 0, categoryId: 'expense-other', description: 'bozuk', date: '2026-11-03', createdAt: '2026-11-03T12:00:00.000Z' });
      try { parseBackupText(JSON.stringify(broken)); }
      catch { invalidRecordRejected = true; }
      assert(invalidRecordRejected, 'Bozuk işlem içeren yedek kabul edildi');
    });

    await check('v2 veritabanı v4’e yükselirken mevcut işlem ve kategoriler korunuyor', async () => {
      const fixtureName = `CuzdanimMigrationTest_${crypto.randomUUID()}`;
      let migrated;
      try {
        const legacy = await createLegacyDatabase(fixtureName);
        closeMigrationTestConnection(fixtureName, legacy);
        migrated = await migrateLegacyDatabase(fixtureName);
        assert(migrated.version === DATABASE_VERSION, `Test veritabanı v${DATABASE_VERSION} olmadı: ${migrated.version}`);
        assert(migrated.objectStoreNames.contains('subscriptions') && migrated.objectStoreNames.contains('subscriptionPayments'), 'Yeni depolar migration sonrası yok');
        assert(migrated.objectStoreNames.contains(BUDGETS_STORE), 'Bütçe deposu migration sonrası yok');
        const read = migrated.transaction(['transactions', 'categories', 'subscriptionPayments'], 'readonly');
        const readDone = transactionComplete(read);
        const [oldTransactions, oldCategories, payments] = await Promise.all([
          requestValue(read.objectStore('transactions').getAll()),
          requestValue(read.objectStore('categories').getAll()),
          requestValue(read.objectStore('subscriptionPayments').getAll()),
        ]);
        await readDone;
        assert(oldTransactions.length === 1 && oldTransactions[0].description === 'Migration eski gider', 'Eski işlem kaydı değişti veya kayboldu');
        assert(oldCategories.length === 1 && oldCategories[0].name === 'Eski kategori', 'Eski kategori değişti veya kayboldu');
        assert(payments.length === 0, 'Boş migration fixture ödeme verisi içeriyor');
        const indexRead = migrated.transaction([SUBSCRIPTION_PAYMENTS_STORE, BUDGETS_STORE], 'readonly');
        const indexReadDone = transactionComplete(indexRead);
        const paymentIndex = indexRead.objectStore(SUBSCRIPTION_PAYMENTS_STORE).index('bySubscriptionPeriod');
        assert(paymentIndex.unique, 'Abonelik+dönem indeksi benzersiz değil');
        const budgetIndex = indexRead.objectStore(BUDGETS_STORE).index('byCategoryId');
        assert(budgetIndex.unique, 'Kategori başına bütçe indeksi benzersiz değil');
        await indexReadDone;
      } finally {
        if (migrated) closeMigrationTestConnection(fixtureName, migrated);
        await deleteDatabase(fixtureName);
      }
    });

    await check('v3 veritabanından v4 bütçe deposu güvenle ekleniyor ve kayıtlar korunuyor', async () => {
      const fixtureName = `CuzdanimV3MigrationTest_${crypto.randomUUID()}`;
      let migrated;
      try {
        const legacy = await createVersionThreeDatabase(fixtureName);
        closeMigrationTestConnection(fixtureName, legacy);
        migrated = await migrateLegacyDatabase(fixtureName);
        assert(migrated.version === DATABASE_VERSION, `Migration sürümü ${DATABASE_VERSION} değil`);
        const read = migrated.transaction(['transactions', 'categories', 'subscriptions', 'subscriptionPayments', BUDGETS_STORE], 'readonly');
        const readDone = transactionComplete(read);
        const [oldTransactions, oldCategories, subscriptionRows, payments, budgetRows] = await Promise.all([
          requestValue(read.objectStore('transactions').getAll()),
          requestValue(read.objectStore('categories').getAll()),
          requestValue(read.objectStore('subscriptions').getAll()),
          requestValue(read.objectStore('subscriptionPayments').getAll()),
          requestValue(read.objectStore(BUDGETS_STORE).getAll()),
        ]);
        await readDone;
        assert(oldTransactions.length === 1 && oldTransactions[0].description === 'v3 eski kayıt', 'v3 işlem kaydı değişti veya kayboldu');
        assert(oldCategories.length === 1 && oldCategories[0].id === 'v3-category', 'v3 kategorisi değişti veya kayboldu');
        assert(subscriptionRows.length === 1 && subscriptionRows[0].id === 'v3-subscription', 'v3 abonelik kaydı değişti veya kayboldu');
        assert(payments.length === 1 && payments[0].periodKey === 'monthly:2026-03', 'v3 abonelik ödeme kaydı değişti veya kayboldu');
        assert(budgetRows.length === 0, 'Migration beklenmeyen bütçe oluşturdu');
        assert(migrated.objectStoreNames.contains(SUBSCRIPTIONS_STORE) && migrated.objectStoreNames.contains(SUBSCRIPTION_PAYMENTS_STORE), 'v3 abonelik depoları kayboldu');
      } finally {
        if (migrated) closeMigrationTestConnection(fixtureName, migrated);
        await deleteDatabase(fixtureName);
      }
    });

    await check('Bütçe CRUD, kategori tekilliği ve gider değişiklikleri sonrası aylık hesaplama çalışıyor', async () => {
      const fixtureTransactions = [];
      let created;
      budgetCategoryId = `__budget_test__${crypto.randomUUID()}`;
      try {
        await categories.add({ id: budgetCategoryId, name: 'Test bütçe kategorisi', type: 'expense', icon: 'receipt', color: '#123456' });
        created = await budgets.add({ name: 'Test bütçesi', categoryId: budgetCategoryId, amountKurus: 10000, period: 'monthly' });
        assert((await budgets.get(created.id))?.amountKurus === 10000, 'Bütçe detayı okunamadı');
        assert((await budgets.list()).some((item) => item.id === created.id), 'Bütçe listede bulunamadı');
        let duplicateRejected = false;
        try { await budgets.add({ name: 'Yinelenen bütçe', categoryId: budgetCategoryId, amountKurus: 20000 }); }
        catch (error) { duplicateRejected = error.name === 'ConstraintError'; }
        assert(duplicateRejected, 'Aynı kategori için ikinci bütçe kabul edildi');
        const updated = await budgets.update(created.id, { amountKurus: 12000, name: 'Güncel bütçe' });
        assert(updated.amountKurus === 12000 && updated.name === 'Güncel bütçe', 'Bütçe güncellenmedi');

        const now = new Date();
        const currentDate = dateAtOffset(now, 0);
        const previousMonthDate = dateAtOffset(new Date(now.getFullYear(), now.getMonth(), 1, 12), -1);
        const currentExpense = await transactions.add({ type: 'expense', amountKurus: 7000, categoryId: budgetCategoryId, description: `Bütçe test gideri ${crypto.randomUUID()}`, date: currentDate });
        fixtureTransactions.push(currentExpense.id);
        const oldExpense = await transactions.add({ type: 'expense', amountKurus: 50000, categoryId: budgetCategoryId, description: `Önceki ay bütçe testi ${crypto.randomUUID()}`, date: previousMonthDate });
        fixtureTransactions.push(oldExpense.id);
        const incomeRecord = await transactions.add({ type: 'income', amountKurus: 90000, categoryId: budgetCategoryId, description: `Bütçe test geliri ${crypto.randomUUID()}`, date: currentDate });
        fixtureTransactions.push(incomeRecord.id);
        let usage = summarizeBudgets([updated], await transactions.list({ categoryId: budgetCategoryId }), now);
        assert(usage.totalSpentKurus === 7000 && usage.items[0].percentage === 58.33 && usage.items[0].level === 'normal', 'Aylık gider filtresi veya bütçe kullanım oranı hatalı');

        await transactions.update(currentExpense.id, { amountKurus: 13000 });
        usage = summarizeBudgets([updated], await transactions.list({ categoryId: budgetCategoryId }), now);
        assert(usage.items[0].spentKurus === 13000 && usage.items[0].level === 'exceeded', 'İşlem düzenleme bütçe aşımını yansıtmadı');
        await transactions.delete(currentExpense.id);
        usage = summarizeBudgets([updated], await transactions.list({ categoryId: budgetCategoryId }), now);
        assert(usage.items[0].spentKurus === 0 && usage.items[0].level === 'normal', 'İşlem silme sonrası bütçe yeniden hesaplanmadı');
        assert(await budgets.delete(created.id), 'Bütçe silinemedi');
        assert(!(await budgets.list()).some((item) => item.id === created.id), 'Silinen bütçe listede kaldı');
      } finally {
        for (const id of fixtureTransactions) await transactions.delete(id).catch(() => {});
        if (created) await budgets.delete(created.id).catch(() => {});
        if (budgetCategoryId) await categories.delete(budgetCategoryId).catch(() => {});
        budgetCategoryId = undefined;
      }
    });

    await check('Bütçe uyarı düzeyleri %70, %90 ve %100 üzeri eşiklerinde doğru', async () => {
      const reference = new Date(2026, 4, 15, 12);
      const category = 'budget-threshold-test';
      const budget = { id: 'budget-threshold', name: 'Eşik testi', categoryId: category, amountKurus: 10000 };
      const samples = [7000, 9000, 10000, 10001].map((amountKurus) => ({ type: 'expense', categoryId: category, amountKurus, date: '2026-05-10' }));
      const levels = samples.map((expense) => summarizeBudgets([budget], [expense], reference).items[0].level);
      assert(levels.join(',') === 'warning,critical,critical,exceeded', `Bütçe uyarı eşikleri hatalı: ${levels.join(',')}`);
    });

    await check('Rapor tarih aralıkları ay başı, ay sonu ve önceki eşdeğer dönemi doğru hesaplıyor', async () => {
      const now = new Date(2026, 5, 15, 12);
      const current = getReportDateRange('this-month', now);
      assert(current.startDate === '2026-06-01' && current.endDateExclusive === '2026-07-01', 'Bu ay aralığı ay sınırlarını yanlış hesapladı');
      assert(current.previousStartDate === '2026-05-01' && current.previousEndDateExclusive === '2026-06-01', 'Önceki eşdeğer ay aralığı yanlış');
      const sixMonths = getReportDateRange('last-6-months', now);
      const twelveMonths = getReportDateRange('last-12-months', now);
      assert(sixMonths.startDate === '2026-01-01' && sixMonths.endDateExclusive === '2026-07-01', 'Son 6 aylık dönem yanlış');
      assert(twelveMonths.startDate === '2025-07-01' && twelveMonths.endDateExclusive === '2026-07-01', 'Son 12 aylık dönem yanlış');
      const custom = getReportDateRange('custom', now, '2026-03-30', '2026-03-31');
      assert(custom.startDate === '2026-03-30' && custom.endDateExclusive === '2026-04-01', 'Özel aralık bitiş gününü dahil etmedi');
      assert(custom.previousStartDate === '2026-03-28' && custom.previousEndDateExclusive === '2026-03-30', 'Özel aralığın önceki eşdeğer dönemi hatalı');
    });

    await check('Raporlar sıfır gelir ve gideri, önceki sıfır dönemi ve yüzdeyi güvenli hesaplıyor', async () => {
      const range = getReportDateRange('this-month', new Date(2026, 5, 15, 12));
      const empty = buildReportsData([], [], range);
      assert(empty.current.incomeKurus === 0 && empty.current.expenseKurus === 0 && empty.current.netKurus === 0, 'Boş dönemin özetleri sıfır değil');
      assert(empty.savingsRatePercent === null && empty.changes.income.percent === null, 'Sıfır payda için yüzde hesaplanmış');
      assert(empty.monthly.length === 1 && empty.monthly[0].incomeKurus === 0 && empty.monthly[0].expenseKurus === 0, 'Boş aylık grafik sıfır veri üretmedi');
      const onlyIncome = buildReportsData([{ type: 'income', amountKurus: 25000, categoryId: 'income-extra', date: '2026-06-05' }], [], range);
      assert(onlyIncome.current.incomeKurus === 25000 && onlyIncome.current.expenseKurus === 0 && onlyIncome.current.netKurus === 25000, 'Sıfır giderli dönem hesabı yanlış');
      assert(onlyIncome.savingsRatePercent === 100, 'Gider olmayan dönemin tasarruf oranı %100 değil');
      assert(onlyIncome.changes.income.percent === null, 'Önceki dönem sıfırken karşılaştırma yüzdesi üretildi');
    });

    await check('Raporlar negatif tasarrufu ve aylık net farkı gösteriyor', async () => {
      const range = getReportDateRange('last-6-months', new Date(2026, 5, 15, 12));
      const data = buildReportsData([
        { type: 'income', amountKurus: 10000, categoryId: 'income-extra', date: '2026-01-10' },
        { type: 'expense', amountKurus: 13000, categoryId: 'expense-groceries', date: '2026-01-11' },
        { type: 'expense', amountKurus: 2500, categoryId: 'expense-groceries', date: '2026-06-30' },
        { type: 'income', amountKurus: 90000, categoryId: 'income-extra', date: '2025-12-31' },
      ], [], range);
      assert(data.current.incomeKurus === 10000 && data.current.expenseKurus === 15500 && data.current.netKurus === -5500, 'Negatif net tasarruf hesabı yanlış');
      assert(data.savingsRatePercent === -55, 'Negatif tasarruf oranı yanlış');
      assert(data.monthly.length === 6 && data.monthly[0].netKurus === -3000 && data.monthly[5].netKurus === -2500, 'Aylık net serisi tarih aralığına uymuyor');
    });

    await check('Rapor kategori dağılımı toplamları, payları, ilk beşi ve silinmiş kategoriyi hesaplıyor', async () => {
      const range = getReportDateRange('custom', new Date(2026, 5, 15, 12), '2026-06-01', '2026-06-30');
      const categories = [{ id: 'expense-groceries', name: 'Market' }];
      const records = [
        { type: 'expense', amountKurus: 5000, categoryId: 'expense-groceries', date: '2026-06-03' },
        { type: 'expense', amountKurus: 3000, categoryId: 'expense-rent', date: '2026-06-04' },
        { type: 'expense', amountKurus: 2000, categoryId: 'expense-health', date: '2026-06-05' },
        { type: 'expense', amountKurus: 1000, categoryId: 'expense-transport', date: '2026-06-06' },
        { type: 'expense', amountKurus: 500, categoryId: 'expense-other', date: '2026-06-07' },
        { type: 'expense', amountKurus: 500, categoryId: 'removed-category', date: '2026-06-08' },
        { type: 'expense', amountKurus: 7000, categoryId: 'expense-groceries', date: '2026-07-01' },
        { type: 'income', amountKurus: 50000, categoryId: 'income-salary', date: '2026-06-12' },
      ];
      const data = buildReportsData(records, categories, range);
      assert(data.current.expenseKurus === 12000 && data.expenseCategories.length === 6, 'Dönem içindeki kategori giderleri yanlış toplandı');
      assert(data.expenseCategories[0].name === 'Market' && data.expenseCategories[0].amountKurus === 5000 && data.expenseCategories[0].sharePercent === 41.66, 'İlk kategori tutarı veya payı yanlış');
      assert(data.expenseCategories.find((item) => item.categoryId === 'expense-rent').name === 'Silinmiş veya bilinmeyen kategori', 'Kayıp kategori güvenli varsayılanla gösterilmedi');
      assert(data.topCategories.length === 5, 'En çok harcama yapılan ilk beş kategori dönmedi');
    });

    await check('İşlem ekleme, düzenleme ve silme açık Bütçeler ekranını anlık güncelliyor', async () => {
      const fixtureCategory = `__budget_ui_test__${crypto.randomUUID()}`;
      const description = `Bütçe canlı güncelleme testi ${crypto.randomUUID()}`;
      let fixtureBudget;
      let fixtureTransaction;
      const frame = document.querySelector('#app-frame');
      const frameDocument = frame.contentDocument;
      try {
        await categories.add({ id: fixtureCategory, name: 'Canlı bütçe testi', type: 'expense', icon: 'receipt', color: '#123456' });
        fixtureBudget = await budgets.add({ name: 'Canlı bütçe testi', categoryId: fixtureCategory, amountKurus: 10000 });
        frame.contentWindow.location.hash = '#budgets';
        await waitUntil(() => !frameDocument.querySelector('#budgets-view').hidden, 'Bütçeler görünümü açılmadı');
        await waitUntil(() => [...frameDocument.querySelectorAll('.budget-card')].some((card) => card.textContent.includes('Canlı bütçe testi')), 'Bütçe kartı yüklenmedi');
        fixtureTransaction = await transactions.add({ type: 'expense', amountKurus: 7000, categoryId: fixtureCategory, description, date: dateAtOffset(new Date(), 0) });
        await waitUntil(() => [...frameDocument.querySelectorAll('.budget-card')].some((card) => card.textContent.includes(formatKurus(7000))), 'Yeni gider bütçe kartında görünmedi');
        await transactions.update(fixtureTransaction.id, { amountKurus: 15000 });
        await waitUntil(() => [...frameDocument.querySelectorAll('.budget-card')].some((card) => card.textContent.includes(formatKurus(15000)) && card.textContent.includes('Bütçe aşıldı')), 'Düzenlenen gider bütçe aşımını anlık güncellemedi');
        await transactions.delete(fixtureTransaction.id);
        fixtureTransaction = undefined;
        await waitUntil(() => [...frameDocument.querySelectorAll('.budget-card')].some((card) => card.textContent.includes(formatKurus(0))), 'Silinen gider bütçe kartından düşmedi');
      } finally {
        if (fixtureTransaction) await transactions.delete(fixtureTransaction.id).catch(() => {});
        if (fixtureBudget) await budgets.delete(fixtureBudget.id).catch(() => {});
        await categories.delete(fixtureCategory).catch(() => {});
        frame.contentWindow.location.hash = '#home';
      }
    });

    await check('Abonelik ekleme, listeleme, güncelleme, iptal ve güvenli silme çalışıyor', async () => {
      const events = [];
      const unsubscribe = subscribeToSubscriptionChanges((event) => events.push(event.operation));
      try {
        const created = await subscriptions.add(makeSubscription());
        subscriptionIds.push(created.id);
        assert(created.status === 'active' && created.billingDay === 31, 'Yeni aboneliğin varsayılanları veya tekrar günü hatalı');
        assert((await subscriptions.get(created.id))?.id === created.id, 'Abonelik detayı bulunamadı');
        assert((await subscriptions.list({ status: 'active', period: 'monthly' })).some((item) => item.id === created.id), 'Abonelik filtreli listede yok');
        const updated = await subscriptions.update(created.id, { name: 'Test aboneliği güncellendi', nextPaymentDate: '2026-03-30', amountKurus: 15990 });
        assert(updated.name === 'Test aboneliği güncellendi' && updated.amountKurus === 15990 && updated.billingDay === 30, 'Abonelik düzenleme alanları uygulanmadı');
        const cancelled = await subscriptions.cancel(created.id);
        assert(cancelled.status === 'cancelled' && cancelled.cancelledAt, 'İptal durumu ve zamanı kaydedilmedi');
        assert((await subscriptions.list({ status: 'cancelled' })).some((item) => item.id === created.id), 'İptal edilen abonelik listelenmedi');
        assert(await subscriptions.delete(created.id), 'Ödeme geçmişi olmayan iptal edilmiş abonelik silinemedi');
        subscriptionIds.splice(subscriptionIds.indexOf(created.id), 1);
        assert(events.includes('add') && events.includes('update') && events.includes('cancel') && events.includes('delete'), `Abonelik olayları eksik: ${events.join(', ')}`);
      } finally {
        unsubscribe();
      }
    });

    await check('Abonelik ödemesi gider oluşturuyor, dönem tekilleştiriliyor ve iptal geçmişi koruyor', async () => {
      const record = await subscriptions.add(makeSubscription({ name: 'Test dönemsel abonelik', nextPaymentDate: '2026-01-31' }));
      subscriptionIds.push(record.id);
      const first = await subscriptionPayments.record(record.id, { paidAt: '2026-01-31T12:00:00.000Z' });
      assert(first.payment.periodKey === 'monthly:2026-01' && first.payment.status === 'paid', 'Ödeme dönem anahtarı hatalı');
      assert(first.transaction.type === 'expense' && first.transaction.amountKurus === record.amountKurus, 'Ödeme normal gider oluşturmadı');
      assert(first.transaction.subscriptionPaymentId === first.payment.id && first.payment.transactionId === first.transaction.id, 'Gider ve ödeme geçmişi bağlantısı eksik');
      assert(first.nextPaymentDate === '2026-02-28', `Ay sonu tarihi yanlış ilerledi: ${first.nextPaymentDate}`);
      const currentCount = (await transactions.list()).length;
      let duplicateRejected = false;
      try { await subscriptionPayments.record(record.id, { paidAt: '2026-01-31T12:00:00.000Z', periodKey: first.payment.periodKey }); }
      catch (error) { duplicateRejected = error.name === 'ConstraintError'; }
      assert(duplicateRejected, 'Aynı dönem için ikinci ödeme reddedilmedi');
      assert((await subscriptionPayments.list({ subscriptionId: record.id })).length === 1, 'Yinelenen ödeme geçmişe eklendi');
      assert((await transactions.list()).length === currentCount, 'Yinelenen ödeme ikinci gideri oluşturdu');

      const second = await subscriptionPayments.record(record.id, { paidAt: '2026-02-28T12:00:00.000Z' });
      assert(second.nextPaymentDate === '2026-03-31', `Ay sonu ankrajı korunmadı: ${second.nextPaymentDate}`);
      assert(!(await subscriptions.delete(record.id)), 'Ödeme geçmişi bulunan abonelik güvenli olmayan biçimde silindi');
      await transactions.update(second.transaction.id, { amountKurus: 14000 });
      assert((await subscriptionPayments.list({ subscriptionId: record.id })).find((payment) => payment.id === second.payment.id)?.amountKurus === 14000, 'İşlemler düzenlemesi ödeme geçmişi tutarına yansımadı');
      await transactions.delete(first.transaction.id);
      const history = await subscriptionPayments.list({ subscriptionId: record.id });
      assert(history.some((payment) => payment.id === first.payment.id && payment.status === 'reversed'), 'Gider silinince ödeme geçmişi reversed olmadı');
      let reversedPeriodRejected = false;
      try { await subscriptionPayments.record(record.id, { periodKey: first.payment.periodKey }); }
      catch (error) { reversedPeriodRejected = error.name === 'ConstraintError'; }
      assert(reversedPeriodRejected, 'Geri alınmış dönem yeniden tahsil edilebilir hale geldi');
      const cancelled = await subscriptions.cancel(record.id);
      assert(cancelled.status === 'cancelled' && (await subscriptionPayments.list({ subscriptionId: record.id })).length === 2, 'İptal ödeme geçmişini silmiş veya değiştirmiş');
      let cancelledRejected = false;
      try { await subscriptionPayments.record(record.id); } catch { cancelledRejected = true; }
      assert(cancelledRejected, 'İptal edilmiş aboneliğe ödeme kaydedildi');
    });

    await check('Ödeme yazım hatasında çoklu depo değişiklikleri atomik geri alınıyor', async () => {
      const record = await subscriptions.add(makeSubscription({ name: 'Test atomik geri alma', nextPaymentDate: '9999-12-31' }));
      subscriptionIds.push(record.id);
      const transactionCount = (await transactions.list()).length;
      let rejected = false;
      try { await subscriptionPayments.record(record.id, { paidAt: '9999-12-31T12:00:00.000Z' }); }
      catch { rejected = true; }
      assert(rejected, 'Takvim aralığı hatası reddedilmedi');
      assert((await subscriptionPayments.list({ subscriptionId: record.id })).length === 0, 'Başarısız ödeme kaydı kısmen kaldı');
      assert((await transactions.list()).length === transactionCount, 'Başarısız ödeme gider kaydı bıraktı');
      assert((await subscriptions.get(record.id)).nextPaymentDate === '9999-12-31', 'Başarısız ödeme abonelik tarihini değiştirdi');
    });

    await check('Yıllık tekrar tarihi artık yıldaki 29 Şubat ankrajını koruyor', async () => {
      const record = await subscriptions.add(makeSubscription({
        name: 'Test artık yıl aboneliği', period: 'yearly', nextPaymentDate: '2028-02-29',
      }));
      subscriptionIds.push(record.id);
      const expectedDates = ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'];
      for (const [index, expectedDate] of expectedDates.entries()) {
        const paid = await subscriptionPayments.record(record.id, { paidAt: `${2028 + index}-02-28T12:00:00.000Z` });
        assert(paid.nextPaymentDate === expectedDate, `Yıllık tekrar tarihi beklenenden farklı: ${paid.nextPaymentDate}, beklenen ${expectedDate}`);
      }
    });

    await check('Gelir, gider ve bakiye kuruş hassasiyetinde hesaplanıyor', async () => {
      const totals = summarizeTransactions([
        { type: 'income', amountKurus: 125075 },
        { type: 'income', amountKurus: 250 },
        { type: 'expense', amountKurus: 1050 },
      ]);
      assert(totals.incomeKurus === 125325, `Gelir toplamı hatalı: ${totals.incomeKurus}`);
      assert(totals.expenseKurus === 1050, `Gider toplamı hatalı: ${totals.expenseKurus}`);
      assert(totals.balanceKurus === 124275, `Bakiye hatalı: ${totals.balanceKurus}`);
    });

    await check('Boş veritabanı özeti sıfır ve boş kayıt listesi döndürüyor', async () => {
      const empty = buildDashboardData([]);
      assert(empty.incomeKurus === 0 && empty.expenseKurus === 0 && empty.balanceKurus === 0, 'Boş toplamlar sıfır değil');
      assert(empty.recent.length === 0, 'Boş son işlem listesi boş değil');
      assert(empty.weekly.length === 7 && empty.weekly.every((day) => day.incomeKurus === 0 && day.expenseKurus === 0), 'Boş grafik yedi sıfır gün içermiyor');
    });

    await check('Son yedi gün serisi bugünü kapsıyor, eski kayıtları dışarıda bırakıyor', async () => {
      const reference = new Date(2026, 5, 10, 12);
      const series = buildWeeklySeries([
        { type: 'income', amountKurus: 250, date: dateAtOffset(reference, -6) },
        { type: 'expense', amountKurus: 450, date: dateAtOffset(reference, 0) },
        { type: 'income', amountKurus: 99999, date: dateAtOffset(reference, -7) },
      ], reference);
      assert(series.length === 7, 'Grafik yedi günlük değil');
      assert(series[0].incomeKurus === 250 && series[0].expenseKurus === 0, 'İlk gün gelir/gider değerleri hatalı');
      assert(series[3].incomeKurus === 0 && series[3].expenseKurus === 0, 'Verisiz gün sıfır değil');
      assert(series[6].expenseKurus === 450, 'Bugünün gideri seriye eklenmedi');
      assert(series.every((day) => day.incomeKurus !== 99999), 'Yedi günden eski kayıt grafiğe girdi');
    });

    await check('Grafik ölçeği artan günlük geliri çizgide görünür tutuyor', async () => {
      const reference = new Date(2026, 5, 10, 12);
      const today = dateAtOffset(reference, 0);
      const before = buildWeeklySeries([{ type: 'income', amountKurus: 40000, date: today }], reference);
      const after = buildWeeklySeries([{ type: 'income', amountKurus: 80000, date: today }], reference);
      const beforeMaximum = chartAxisMaximumKurus(before);
      const afterMaximum = chartAxisMaximumKurus(after);
      const beforeHeightRatio = 40000 / beforeMaximum;
      const afterHeightRatio = 80000 / afterMaximum;
      assert(beforeMaximum > 40000 && afterMaximum > 80000, 'Grafik ölçeğinde tepe boşluğu yok');
      assert(beforeHeightRatio !== afterHeightRatio, 'Günlük gelir artışına rağmen çizgi yüksekliği değişmiyor');
    });

    await check('Son beş işlem tarih sırasıyla seçiliyor', async () => {
      const reference = new Date(2026, 5, 10, 12);
      const offsets = [-5, -1, -4, 0, -2, -3];
      const input = offsets.map((offset, index) => ({ id: index + 1, date: dateAtOffset(reference, offset), createdAt: dateAtOffset(reference, offset), type: 'expense', amountKurus: 100 }));
      const latest = latestTransactions(input, 5);
      assert(latest.length === 5, 'Son beş kayıt dönmedi');
      assert(latest.map((item) => item.id).join(',') === '4,2,5,6,3', `Sıralama hatalı: ${latest.map((item) => item.id).join(',')}`);
    });

    await check('Varsayılan gelir ve gider kategorileri ilk kurulumda mevcut', async () => {
      const income = await categories.list({ type: 'income' });
      const expense = await categories.list({ type: 'expense' });
      const expectedIncome = ['income-salary', 'income-extra', 'income-investment', 'income-other'];
      const expectedExpense = ['expense-groceries', 'expense-rent', 'expense-bills', 'expense-transport', 'expense-health', 'expense-education', 'expense-entertainment', 'expense-shopping', 'expense-other'];
      assert(expectedIncome.every((id) => income.some((item) => item.id === id)), 'Varsayılan gelir kategorilerinden biri eksik');
      assert(expectedExpense.every((id) => expense.some((item) => item.id === id)), 'Varsayılan gider kategorilerinden biri eksik');
      assert(income.filter((item) => expectedIncome.includes(item.id)).length === 4, 'Varsayılan gelir kategorileri yinelenmiş');
      assert(expense.filter((item) => expectedExpense.includes(item.id)).length === 9, 'Varsayılan gider kategorileri yinelenmiş');
      assert(income.every((item) => item.icon && item.color && item.createdAt), 'Gelir kategorilerinde zorunlu alan eksik');
      assert(expense.every((item) => item.icon && item.color && item.createdAt), 'Gider kategorilerinde zorunlu alan eksik');
    });

    await check('Kategori varsayılanları tekrar açılışta yinelenmiyor', async () => {
      await closeDatabase();
      await openDatabase();
      const income = await categories.list({ type: 'income' });
      const expense = await categories.list({ type: 'expense' });
      assert(income.filter((item) => item.id.startsWith('income-')).length === 4, 'Tekrar açılışta gelir varsayılanları yinelendi');
      assert(expense.filter((item) => item.id.startsWith('expense-')).length === 9, 'Tekrar açılışta gider varsayılanları yinelendi');
    });

    await check('Gelir formu kaydı kuruş olarak IndexedDB’ye yazıyor', async () => {
      const previousTotals = summarizeTransactions(await transactions.list());
      const frame = document.querySelector('#app-frame');
      await waitUntil(
        () => frame.contentDocument?.readyState === 'complete' && frame.contentDocument.querySelector('.dialog-form'),
        'Dashboard test çerçevesi ve uygulama betikleri yüklenmedi',
      );
      const frameDocument = frame.contentDocument;
      await waitForDashboardTotals(previousTotals);
      const previousIncomePath = frameDocument.querySelector('.chart-line:not(.chart-line-expense)').getAttribute('d');
      const description = `Form gelir testi ${crypto.randomUUID()}`;
      formDescriptions.push(description);
      frameDocument.querySelector('[data-transaction="income"]').click();
      const categorySelect = frameDocument.querySelector('#transaction-category');
      await waitForCategoryOption(categorySelect, 'income-extra', 'Gelir kategorileri forma yüklenmedi');
      categorySelect.value = 'income-extra';
      frameDocument.querySelector('#transaction-amount').value = '42,25';
      frameDocument.querySelector('#transaction-date').value = dateAtOffset(new Date(), 0);
      frameDocument.querySelector('#transaction-description').value = description;
      frameDocument.querySelector('.dialog-form').requestSubmit();
      await waitUntil(() => frameDocument.querySelector('.form-feedback').classList.contains('is-success'), frameDocument.querySelector('.form-feedback').textContent || 'Gelir formu kaydı tamamlanmadı');
      const saved = (await transactions.list({ type: 'income', categoryId: 'income-extra' })).find((item) => item.description === description);
      if (saved?.id !== undefined) formRecordIds.push(saved.id);
      assert(saved?.amountKurus === 4225, 'Gelir formu 42,25 TL tutarını kuruş olarak kaydetmedi');
      await waitForDashboardTotals({
        incomeKurus: sumKurus([previousTotals.incomeKurus, 4225]),
        expenseKurus: previousTotals.expenseKurus,
        balanceKurus: sumKurus([previousTotals.balanceKurus, 4225]),
      });
      await waitUntil(() => frameDocument.querySelector('.chart-line:not(.chart-line-expense)').getAttribute('d') !== previousIncomePath, 'Gelir eklendikten sonra haftalık grafik değişmedi');
      assert([...frameDocument.querySelectorAll('.transaction-row strong')].some((item) => item.textContent === description), 'Yeni gelir dashboard son işlemlerine gelmedi');
    });

    await check('Gider formu gider kategorileriyle kaydediliyor', async () => {
      const previousTotals = summarizeTransactions(await transactions.list());
      const frameDocument = document.querySelector('#app-frame').contentDocument;
      await waitForDashboardTotals(previousTotals);
      const previousExpensePath = frameDocument.querySelector('.chart-line-expense').getAttribute('d');
      if (frameDocument.querySelector('.transaction-dialog').open) frameDocument.querySelector('.dialog-close').click();
      const description = `Form gider testi ${crypto.randomUUID()}`;
      formDescriptions.push(description);
      frameDocument.querySelector('[data-transaction="expense"]').click();
      const categorySelect = frameDocument.querySelector('#transaction-category');
      await waitForCategoryOption(categorySelect, 'expense-groceries', 'Gider kategorileri forma yüklenmedi');
      categorySelect.value = 'expense-groceries';
      frameDocument.querySelector('#transaction-amount').value = '16,80';
      frameDocument.querySelector('#transaction-date').value = dateAtOffset(new Date(), 0);
      frameDocument.querySelector('#transaction-description').value = description;
      frameDocument.querySelector('.dialog-form').requestSubmit();
      await waitUntil(() => frameDocument.querySelector('.form-feedback').classList.contains('is-success'), frameDocument.querySelector('.form-feedback').textContent || 'Gider formu kaydı tamamlanmadı');
      const saved = (await transactions.list({ type: 'expense', categoryId: 'expense-groceries' })).find((item) => item.description === description);
      if (saved?.id !== undefined) formRecordIds.push(saved.id);
      assert(saved?.amountKurus === 1680, 'Gider formu 16,80 TL tutarını kuruş olarak kaydetmedi');
      await waitForDashboardTotals({
        incomeKurus: previousTotals.incomeKurus,
        expenseKurus: sumKurus([previousTotals.expenseKurus, 1680]),
        balanceKurus: sumKurus([previousTotals.balanceKurus, -1680]),
      });
      await waitUntil(() => frameDocument.querySelector('.chart-line-expense').getAttribute('d') !== previousExpensePath, 'Gider eklendikten sonra haftalık grafik değişmedi');
      assert([...frameDocument.querySelectorAll('.transaction-row strong')].some((item) => item.textContent === description), 'Yeni gider dashboard son işlemlerine gelmedi');
    });

    await check('Form sıfır veya geçersiz tutarı reddediyor', async () => {
      const frameDocument = document.querySelector('#app-frame').contentDocument;
      if (frameDocument.querySelector('.transaction-dialog').open) frameDocument.querySelector('.dialog-close').click();
      frameDocument.querySelector('[data-transaction="income"]').click();
      const categorySelect = frameDocument.querySelector('#transaction-category');
      await waitForCategoryOption(categorySelect, 'income-extra', 'Gelir kategorileri forma yüklenmedi');
      const invalidDescription = `Geçersiz form testi ${crypto.randomUUID()}`;
      formDescriptions.push(invalidDescription);
      const input = frameDocument.querySelector('#transaction-amount');
      const dialog = frameDocument.querySelector('.transaction-dialog');
      const acceptedAmounts = [];
      try {
        for (const amount of ['0', '12,345']) {
          categorySelect.value = 'income-extra';
          frameDocument.querySelector('#transaction-date').value = dateAtOffset(new Date(), 0);
          frameDocument.querySelector('#transaction-description').value = invalidDescription;
          frameDocument.querySelector('.form-feedback').className = 'form-feedback';
          input.value = amount;
          frameDocument.querySelector('.dialog-form').requestSubmit();
          await waitUntil(() => frameDocument.querySelector('.form-feedback').classList.contains('is-error') || frameDocument.querySelector('.form-feedback').classList.contains('is-success'), `Tutar ${amount} için form yanıt vermedi`);
          if (frameDocument.querySelector('.form-feedback').classList.contains('is-success')) {
            acceptedAmounts.push(amount);
            const saved = (await transactions.list({ categoryId: 'income-extra' })).find((item) => item.description === invalidDescription);
            if (saved) await transactions.delete(saved.id);
          }
        }
      } finally {
        dialog.close();
      }
      const persisted = (await transactions.list({ categoryId: 'income-extra' })).some((item) => item.description === invalidDescription);
      assert(acceptedAmounts.length === 0, `Geçersiz tutarlar kabul edildi: ${acceptedAmounts.join(', ')}`);
      assert(!persisted, 'Geçersiz tutarlı form veritabanına yazıldı');
    });

    await check('İşlemler görünümü filtre, arama, sıralama, sayfalama, düzenleme ve silmeyi destekliyor', async () => {
      const fixtureIds = [];
      const frame = document.querySelector('#app-frame');
      const frameDocument = frame.contentDocument;
      const descriptions = [];
      const initialCount = (await transactions.list()).length;
      for (let index = 0; index < 31; index += 1) {
        const description = `İşlemler görünüm testi ${index} ${crypto.randomUUID()}`;
        descriptions.push(description);
        formDescriptions.push(description);
        const record = await transactions.add({
          type: index % 2 ? 'expense' : 'income',
          amountKurus: 1000 + index,
          categoryId: index % 2 ? 'expense-groceries' : 'income-extra',
          description,
          date: dateAtOffset(new Date(), index % 7 - 3),
        });
        fixtureIds.push(record.id);
        formRecordIds.push(record.id);
      }
      try {
        frameDocument.querySelector('.mobile-nav a[href="#transactions"], .desktop-nav a[href="#transactions"]').click();
        await waitUntil(() => !frameDocument.querySelector('#transactions-view').hidden, 'İşlemler görünümü açılmadı');
        await waitUntil(() => frameDocument.querySelectorAll('.manage-transaction-row').length > 0, 'İşlem kayıtları listelenmedi');
        const rows = () => [...frameDocument.querySelectorAll('.manage-transaction-row')];
        assert(rows().length === 30, `İlk sayfada 30 kayıt bekleniyordu, ${rows().length} geldi`);
        const more = frameDocument.querySelector('#transactions-load-more');
        assert(!more.hidden, 'Daha fazla yükle kontrolü görünmüyor');
        more.click();
        await waitUntil(() => rows().length === Math.min(60, initialCount + 31), 'İkinci sayfa yüklenmedi');

        const typeFilter = frameDocument.querySelector('#transactions-type');
        const categoryFilter = frameDocument.querySelector('#transactions-category');
        typeFilter.value = 'income';
        typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
        await waitUntil(() => rows().length > 0 && rows().every((row) => row.classList.contains('is-income')), 'Gelir filtresi doğru kayıtları göstermedi');
        categoryFilter.value = 'income-extra';
        categoryFilter.dispatchEvent(new Event('change', { bubbles: true }));
        await waitUntil(() => rows().length > 0 && rows().every((row) => row.textContent.includes('Ek gelir')), 'Kategori filtresi çalışmadı');

        typeFilter.value = 'all';
        typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
        categoryFilter.value = 'all';
        categoryFilter.dispatchEvent(new Event('change', { bubbles: true }));
        const search = frameDocument.querySelector('#transactions-search');
        search.value = descriptions[0];
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await waitUntil(() => rows().length === 1 && rows()[0].textContent.includes(descriptions[0]), 'Açıklama araması doğru kayıt döndürmedi');
        search.value = 'Ek gelir';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await waitUntil(() => rows().length > 0 && rows().every((row) => row.textContent.includes('Ek gelir')), 'Kategori adıyla arama çalışmadı');

        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const sort = frameDocument.querySelector('#transactions-sort');
        sort.value = 'asc';
        sort.dispatchEvent(new Event('change', { bubbles: true }));
        assert(frameDocument.querySelector('#transactions-count').textContent.includes(`${initialCount + 31} işlem`), 'Tarih sıralama seçimi sonrası tüm kayıtlar sayılmadı');

        const editRecord = await transactions.get(fixtureIds[0]);
        search.value = editRecord.description;
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await waitUntil(() => rows().length === 1, 'Düzenlenecek işlem bulunamadı');
        rows()[0].querySelector('[data-edit-transaction]').click();
        const form = frameDocument.querySelector('.dialog-form');
        await waitUntil(() => frameDocument.querySelector('.transaction-dialog').open && frameDocument.querySelector('#dialog-title').textContent === 'İşlemi düzenle', 'Düzenleme formu açılmadı');
        const updatedDescription = `${editRecord.description} düzenlendi`;
        form.elements.description.value = updatedDescription;
        form.requestSubmit();
        await waitUntil(() => frameDocument.querySelector('.form-feedback').classList.contains('is-success'), 'İşlem güncellenemedi');
        assert((await transactions.get(editRecord.id)).description === updatedDescription, 'Düzenleme IndexedDB kaydına yazılmadı');

        search.value = updatedDescription;
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await waitUntil(() => rows().length === 1, 'Silinecek güncel kayıt bulunamadı');
        rows()[0].querySelector('[data-delete-transaction]').click();
        const confirm = frameDocument.querySelector('#delete-confirm-dialog');
        await waitUntil(() => confirm.open, 'Silme onayı gösterilmedi');
        confirm.querySelector('[value="confirm"]').click();
        await waitUntil(() => rows().length === 0, 'Onaylanan işlem listeden kalkmadı');
        assert((await transactions.get(editRecord.id)) === undefined, 'Onaylanan işlem IndexedDB’den silinmedi');
      } finally {
        location.hash = '#home';
      }
    });

    await check('Hatalı işlem kayıtları reddediliyor', async () => {
      const invalid = [
        { ...makeTestRecord('transfer', categoryId, date, 'geçersiz tür') },
        { ...makeTestRecord('income', categoryId, date, 'ondalıklı kuruş'), amountKurus: 12.5 },
        { ...makeTestRecord('expense', categoryId, date, 'açıklama yok'), description: '   ' },
      ];
      for (const record of invalid) {
        let rejected = false;
        try { await transactions.add(record); } catch { rejected = true; }
        assert(rejected, 'Geçersiz kayıt kabul edildi');
      }
    });

    await check('Gelir ve gider kaydı eklenebiliyor', async () => {
      const previousTotals = summarizeTransactions(await transactions.list());
      income = await transactions.add(makeTestRecord('income', categoryId, date, `Test gelir ${crypto.randomUUID()}`));
      expense = await transactions.add(makeTestRecord('expense', categoryId, date, `Test gider ${crypto.randomUUID()}`));
      assert(income.type === 'income' && expense.type === 'expense', 'İşlem türleri kayıtta korunmadı');
      assert(income.amountKurus === 125075 && expense.amountKurus === 2580, 'Kuruş tutarı kayıtta korunmadı');
      await waitForDashboardTotals({
        incomeKurus: sumKurus([previousTotals.incomeKurus, income.amountKurus]),
        expenseKurus: sumKurus([previousTotals.expenseKurus, expense.amountKurus]),
        balanceKurus: sumKurus([previousTotals.balanceKurus, income.amountKurus, -expense.amountKurus]),
      });
    });

    if (income && expense) {
      await check('ID otomatik ve benzersiz oluşturuluyor', async () => {
        assert(income.id !== undefined && expense.id !== undefined, 'Otomatik ID atanmadı');
        assert(income.id !== expense.id, 'İki kayda aynı ID verildi');
      });

      await check('Kayıtlar listelenebiliyor', async () => {
        const listed = await transactions.list({ categoryId });
        assert(listed.length === 2, `2 test kaydı bekleniyordu, ${listed.length} geldi`);
        assert(listed.some((item) => item.id === income.id) && listed.some((item) => item.id === expense.id), 'Eklenen kayıtlar listede yok');
      });

      await check('ID üzerinden kayıt güncellenebiliyor', async () => {
        const previousTotals = summarizeTransactions(await transactions.list());
        const updated = await transactions.update(income.id, { description: updatedDescription, amountKurus: 125999 });
        assert(updated?.description === updatedDescription, 'Güncellenmiş açıklama dönmedi');
        assert((await transactions.get(income.id))?.amountKurus === 125999, 'Güncellenmiş tutar okunamadı');
        await waitForDashboardTotals({
          incomeKurus: sumKurus([previousTotals.incomeKurus, 924]),
          expenseKurus: previousTotals.expenseKurus,
          balanceKurus: sumKurus([previousTotals.balanceKurus, 924]),
        });
      });

      await check('Tarih, tür ve kategori filtreleri çalışıyor', async () => {
        const byDate = await transactions.list({ fromDate: date, toDate: date });
        const byType = await transactions.list({ type: 'expense', categoryId });
        const byCategory = await transactions.list({ categoryId });
        assert(byDate.some((item) => item.id === income.id) && byDate.some((item) => item.id === expense.id), 'Tarih filtresi kayıtları döndürmedi');
        assert(byType.length === 1 && byType[0].id === expense.id, 'Tür filtresi yanlış sonuç döndürdü');
        assert(byCategory.length === 2, 'Kategori filtresi yanlış sonuç döndürdü');
      });

      await check('ID üzerinden kayıt silinebiliyor', async () => {
        const previousTotals = summarizeTransactions(await transactions.list());
        await transactions.delete(expense.id);
        assert((await transactions.get(expense.id)) === undefined, 'Silinen kayıt hâlâ bulunuyor');
        await waitForDashboardTotals({
          incomeKurus: previousTotals.incomeKurus,
          expenseKurus: sumKurus([previousTotals.expenseKurus, -expense.amountKurus]),
          balanceKurus: sumKurus([previousTotals.balanceKurus, expense.amountKurus]),
        });
      });

      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        ids: [income.id, expense.id, ...formRecordIds],
        formDescriptions,
        subscriptionIds,
        incomeId: income.id,
        categoryId,
        updatedDescription,
      }));
      await closeDatabase();
      location.reload();
      return;
    }
  } catch (error) {
    recordResult('Test kurulumu', false, error.message);
  }

  const cleanupErrors = [];
  try {
    await cleanupTestRecords({
      ids: [income?.id, expense?.id, ...formRecordIds].filter((id) => id !== undefined),
      descriptions: formDescriptions,
      categoryId,
    });
  } catch (error) { cleanupErrors.push(error.message); }
  try { await cleanupSubscriptionFixtures(subscriptionIds); }
  catch (error) { cleanupErrors.push(error.message); }
  try {
    if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
  } catch (error) {
    recordResult('Test kayıtlarını temizleme', false, error.message);
  }
  await closeDatabase();
}

runSuite().catch((error) => {
  recordResult('Test çalıştırıcısı', false, error.message);
});
