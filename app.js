import {
  categories,
  budgets,
  DATABASE_VERSION,
  openDatabase,
  readAllApplicationData,
  replaceAllApplicationData,
  resetAllApplicationData,
  subscribeToBudgetChanges,
  subscribeToSubscriptionChanges,
  subscribeToTransactionChanges,
  subscriptionPayments,
  subscriptions,
  transactions,
} from './js/database.js';
import { buildDashboardData, chartAxisMaximumKurus } from './js/dashboard-data.js';
import { CURRENCY_SYMBOL, formatKurus, tlToKurus } from './js/money.js';
import { summarizeBudgets } from './js/budget-data.js';
import { buildReportsData, getReportDateRange } from './js/reports-data.js';
import { createBackupObject, parseBackupText, serializeBackup, THEME_STORAGE_KEY, LAST_BACKUP_STORAGE_KEY } from './js/data-backup.js';

const NOTIFICATION_READ_STORAGE_KEY = 'cuzdanim.readNotifications';
const LEGACY_CATEGORY_IDS = new Set(['income-other', 'expense-other']);

function isLegacyOtherCategory(category) {
  return LEGACY_CATEGORY_IDS.has(category.id) || /^diğer(?:\s|$)/i.test(category.name.trim());
}

const app = {
  init() {
    this.applySavedPreferences();
    this.bindQuickActions();
    this.bindTransactionsView();
    this.bindSubscriptionsView();
    this.bindBudgetsView();
    this.bindReportsView();
    this.bindSettingsView();
    this.bindNotifications();
    this.bindViewNavigation();
    this.pageSize = 30;
    this.visibleCount = this.pageSize;
    this.initializeStorage();
  },

  async initializeStorage() {
    try {
      await openDatabase();
      this.unsubscribeFromTransactions = subscribeToTransactionChanges(() => {
        this.refreshDashboard();
        this.refreshNotifications();
        if (location.hash === '#budgets') this.refreshBudgets();
        if (location.hash === '#reports') this.refreshReports();
        if (location.hash === '#settings') this.refreshSettingsOverview();
      });
      this.unsubscribeFromSubscriptions = subscribeToSubscriptionChanges(() => {
        this.refreshSubscriptions();
        this.refreshNotifications();
        if (location.hash === '#settings') this.refreshSettingsOverview();
      });
      this.unsubscribeFromBudgets = subscribeToBudgetChanges(() => {
        if (location.hash === '#budgets') this.refreshBudgets();
        this.refreshNotifications();
        if (location.hash === '#settings') this.refreshSettingsOverview();
      });
      await this.refreshDashboard();
      await this.refreshNotifications();
      if (location.hash === '#subscriptions') await this.refreshSubscriptions();
      if (location.hash === '#budgets') await this.refreshBudgets();
      if (location.hash === '#reports') await this.refreshReports();
      if (location.hash === '#settings') await this.refreshSettingsOverview();
    } catch (error) {
      console.error('Cüzdanım veritabanı başlatılamadı:', error);
    }
  },

  async refreshDashboard() {
    const refreshId = (this.dashboardRefreshId ?? 0) + 1;
    this.dashboardRefreshId = refreshId;
    try {
      const [records, categoryRecords] = await Promise.all([transactions.list(), categories.list()]);
      if (refreshId !== this.dashboardRefreshId) return;
      this.allTransactions = records;
      this.categoryRecords = categoryRecords;
      this.populateTransactionsCategories();
      this.renderDashboard(buildDashboardData(records), categoryRecords);
      this.renderTransactionsView();
    } catch (error) {
      console.error('Dashboard verileri yüklenemedi:', error);
      this.showNotice('Dashboard verileri yüklenemedi. Daha sonra tekrar dene.');
    }
  },

  async refreshSubscriptions() {
    const view = document.querySelector('#subscriptions-view');
    if (!view) return;
    const requestId = (this.subscriptionRefreshId ?? 0) + 1;
    this.subscriptionRefreshId = requestId;
    const summary = document.querySelector('.subscription-summary-grid');
    const activeList = document.querySelector('#active-subscriptions');
    const cancelledList = document.querySelector('#cancelled-subscriptions');
    const feedback = document.querySelector('#subscriptions-feedback');
    summary?.setAttribute('aria-busy', 'true');
    if (activeList && !this.subscriptionDataLoaded) activeList.innerHTML = '<div class="subscription-loading">Abonelikler yükleniyor…</div>';
    if (cancelledList && !this.subscriptionDataLoaded) cancelledList.innerHTML = '<div class="subscription-loading">Abonelikler yükleniyor…</div>';
    try {
      const [records, categoryRecords, paymentRecords] = await Promise.all([
        subscriptions.list(),
        categories.list({ type: 'expense' }),
        subscriptionPayments.list(),
      ]);
      if (requestId !== this.subscriptionRefreshId) return;
      this.subscriptionRecords = records;
      this.subscriptionCategories = categoryRecords;
      this.subscriptionPaymentRecords = paymentRecords;
      this.renderSubscriptions();
      this.subscriptionDataLoaded = true;
      summary?.setAttribute('aria-busy', 'false');
      if (feedback) feedback.textContent = '';
    } catch (error) {
      if (requestId !== this.subscriptionRefreshId) return;
      summary?.setAttribute('aria-busy', 'false');
      if (activeList) activeList.innerHTML = '<div class="subscription-error">Abonelikler yüklenemedi.</div>';
      if (cancelledList) cancelledList.replaceChildren();
      if (feedback) feedback.textContent = error.message || 'Abonelik bilgileri yüklenemedi. Yeniden deneyebilirsin.';
      this.subscriptionDataLoaded = false;
    }
  },

  async refreshBudgets() {
    const list = document.querySelector('#budget-list');
    if (!list) return;
    const requestId = (this.budgetRefreshId ?? 0) + 1;
    this.budgetRefreshId = requestId;
    const summary = document.querySelector('.budget-summary-grid');
    const feedback = document.querySelector('#budgets-feedback');
    summary?.setAttribute('aria-busy', 'true');
    if (!this.budgetDataLoaded) list.innerHTML = '<div class="budget-loading">Bütçeler yükleniyor…</div>';
    try {
      const [budgetRecords, categoryRecords, monthTransactions] = await Promise.all([
        budgets.list(),
        categories.list({ type: 'expense' }),
        this.currentMonthExpenses(),
      ]);
      if (requestId !== this.budgetRefreshId) return;
      this.budgetCategories = categoryRecords;
      this.budgetRecords = budgetRecords;
      this.budgetSummary = summarizeBudgets(budgetRecords, monthTransactions);
      this.renderBudgets();
      this.budgetDataLoaded = true;
      summary?.setAttribute('aria-busy', 'false');
      if (feedback) feedback.textContent = '';
    } catch (error) {
      if (requestId !== this.budgetRefreshId) return;
      summary?.setAttribute('aria-busy', 'false');
      list.innerHTML = '<div class="budget-error">Bütçe bilgileri yüklenemedi.</div>';
      if (feedback) feedback.textContent = error.message || 'Bütçe bilgileri yüklenemedi. Yeniden deneyebilirsin.';
      this.budgetDataLoaded = false;
    }
  },

  async currentMonthExpenses() {
    const now = new Date();
    const fromDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const toDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`;
    const records = await transactions.list({ type: 'expense', fromDate });
    return records.filter((item) => item.date.slice(0, 10) < toDate);
  },

  renderBudgets() {
    const summary = this.budgetSummary;
    if (!summary) return;
    document.querySelector('#budget-total-amount').textContent = formatKurus(summary.totalBudgetKurus);
    document.querySelector('#budget-total-spent').textContent = formatKurus(summary.totalSpentKurus);
    document.querySelector('#budget-total-remaining').textContent = formatKurus(summary.remainingKurus);
    const categoryMap = new Map((this.budgetCategories ?? []).map((item) => [item.id, item]));
    const list = document.querySelector('#budget-list');
    if (!list) return;
    if (!summary.items.length) {
      const empty = document.createElement('div');
      empty.className = 'budget-empty-card';
      empty.innerHTML = '<strong>Henüz bütçe oluşturulmadı.</strong><span>Bir gider kategorisi seçip aylık sınır belirleyebilirsin.</span>';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...summary.items.map((item) => this.createBudgetCard(item, categoryMap.get(item.budget.categoryId))));
  },

  createBudgetCard(item, category) {
    const { budget, spentKurus, remainingKurus, percentage, level } = item;
    const card = document.createElement('article');
    card.className = `card budget-card budget-${level}`;
    const heading = document.createElement('div');
    heading.className = 'budget-card-heading';
    const labels = document.createElement('div');
    const categoryName = document.createElement('span');
    categoryName.className = 'budget-category-name';
    categoryName.textContent = category?.name ?? 'Gider kategorisi';
    const budgetName = document.createElement('h3');
    budgetName.textContent = budget.name;
    labels.append(categoryName, budgetName);
    const status = document.createElement('span');
    status.className = 'budget-status';
    status.textContent = level === 'exceeded' ? 'Bütçe aşıldı' : level === 'critical' ? 'Kritik' : level === 'warning' ? 'Dikkat' : 'Normal';
    heading.append(labels, status);
    const figures = document.createElement('div');
    figures.className = 'budget-figures';
    const spent = this.createBudgetFigure('Harcanan', formatKurus(spentKurus));
    const limit = this.createBudgetFigure('Bütçe', formatKurus(budget.amountKurus));
    const remaining = this.createBudgetFigure('Kalan', formatKurus(remainingKurus));
    figures.append(spent, limit, remaining);
    const progressLabel = document.createElement('div');
    progressLabel.className = 'budget-progress-label';
    const percentText = document.createElement('span'); percentText.textContent = `${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(percentage)}% kullanıldı`;
    const percentMeter = document.createElement('span'); percentMeter.textContent = `${Math.min(100, Math.round(percentage))}%`;
    progressLabel.append(percentText, percentMeter);
    const progress = document.createElement('div');
    progress.className = 'budget-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', `${category?.name ?? budget.name} bütçesi kullanımı`);
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    progress.setAttribute('aria-valuenow', String(Math.min(100, Math.round(percentage))));
    const bar = document.createElement('span'); bar.style.width = `${Math.min(100, Math.max(0, percentage))}%`; progress.append(bar);
    const actions = document.createElement('div'); actions.className = 'budget-card-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button'; edit.textContent = 'Düzenle'; edit.dataset.editBudget = budget.id;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button budget-delete-button'; remove.textContent = 'Sil'; remove.dataset.deleteBudget = budget.id;
    actions.append(edit, remove);
    card.append(heading, figures, progressLabel, progress, actions);
    return card;
  },

  createBudgetFigure(label, value) {
    const figure = document.createElement('div'); figure.className = 'budget-figure';
    const caption = document.createElement('span'); caption.textContent = label;
    const amount = document.createElement('strong'); amount.textContent = value;
    figure.append(caption, amount); return figure;
  },

  bindBudgetsView() {
    const form = document.querySelector('#budget-form');
    const dialog = document.querySelector('#budget-dialog');
    const feedback = document.querySelector('#budget-form-feedback');
    document.querySelector('.budget-add-button')?.addEventListener('click', () => this.openBudgetForm());
    document.querySelector('#budget-category')?.addEventListener('change', (event) => {
      const selected = this.budgetCategories?.find((item) => item.id === event.currentTarget.value);
      const nameInput = document.querySelector('#budget-name');
      if (selected && !nameInput.value.trim()) nameInput.value = selected.name;
    });
    dialog?.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close());
    dialog?.addEventListener('close', () => this.setFormFeedback(feedback, ''));
    form?.addEventListener('submit', (event) => this.submitBudgetForm(event));
    document.querySelector('#budget-list')?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-edit-budget], [data-delete-budget]');
      if (!button) return;
      if (button.dataset.editBudget) await this.openBudgetForm(button.dataset.editBudget);
      else await this.deleteBudget(button.dataset.deleteBudget);
    });
  },

  async loadBudgetCategoryOptions(select, selectedId) {
    const used = new Set((await budgets.list()).map((item) => item.categoryId));
    const available = (this.budgetCategories ?? []).filter((item) => (!used.has(item.id) || item.id === selectedId) && !isLegacyOtherCategory(item));
    if (selectedId && !available.some((item) => item.id === selectedId)) {
      const retained = this.budgetCategories?.find((item) => item.id === selectedId);
      if (retained) available.push(retained);
    }
    select.replaceChildren(new Option('Kategori seç', ''), ...available.map((item) => new Option(isLegacyOtherCategory(item) ? 'Mevcut eski kategori (korunuyor)' : item.name, item.id)));
    select.value = selectedId ?? '';
    select.disabled = available.length === 0;
    if (!available.length) throw new Error('Bütçe oluşturmak için kullanılabilir gider kategorisi kalmadı.');
  },

  async openBudgetForm(id) {
    const form = document.querySelector('#budget-form');
    const dialog = document.querySelector('#budget-dialog');
    const feedback = document.querySelector('#budget-form-feedback');
    form.reset(); this.setFormFeedback(feedback, '');
    try {
      const record = id ? await budgets.get(id) : undefined;
      if (id && !record) throw new Error('Bütçe artık bulunamıyor.');
      if (record) {
        form.dataset.editId = id;
        document.querySelector('#budget-dialog-title').textContent = 'Bütçeyi düzenle';
        document.querySelector('#budget-submit').textContent = 'Değişiklikleri kaydet';
        form.elements.name.value = record.name;
        form.elements.amount.value = formatKurus(record.amountKurus, { symbol: false });
      } else {
        delete form.dataset.editId;
        document.querySelector('#budget-dialog-title').textContent = 'Bütçe ekle';
        document.querySelector('#budget-submit').textContent = 'Bütçeyi kaydet';
      }
      await this.loadBudgetCategoryOptions(form.elements.categoryId, record?.categoryId);
      if (!record && form.elements.categoryId.value) form.elements.name.value = this.budgetCategories.find((item) => item.id === form.elements.categoryId.value)?.name ?? '';
      dialog.showModal();
    } catch (error) {
      if (id) this.showNotice(error.message || 'Bütçe formu açılamadı.');
      else {
        dialog.showModal();
        this.setFormFeedback(feedback, error.message || 'Bütçe formu açılamadı.', 'error');
      }
    }
  },

  async submitBudgetForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#budget-form-feedback');
    this.setFormFeedback(feedback, '');
    if (!form.reportValidity()) return;
    try {
      const amountKurus = tlToKurus(form.elements.amount.value);
      if (amountKurus <= 0) throw new TypeError('Bütçe tutarı sıfırdan büyük olmalıdır.');
      const values = { name: form.elements.name.value.trim(), categoryId: form.elements.categoryId.value, amountKurus, period: 'monthly' };
      if (!values.name) throw new TypeError('Bütçe adı boş olamaz.');
      if (form.dataset.editId) await budgets.update(form.dataset.editId, values);
      else await budgets.add(values);
      const editing = Boolean(form.dataset.editId);
      delete form.dataset.editId;
      document.querySelector('#budget-dialog').close();
      await this.refreshBudgets();
      this.showNotice(editing ? 'Bütçe güncellendi.' : 'Bütçe oluşturuldu.');
    } catch (error) { this.setFormFeedback(feedback, error.name === 'ConstraintError' ? 'Bu kategori için zaten bir bütçe var.' : error.message || 'Bütçe kaydedilemedi.', 'error'); }
  },

  async deleteBudget(id) {
    const record = await budgets.get(id);
    if (!record || !window.confirm(`“${record.name}” bütçesi silinsin mi?`)) return;
    try { await budgets.delete(id); await this.refreshBudgets(); this.showNotice('Bütçe silindi.'); }
    catch (error) { this.showNotice(error.message || 'Bütçe silinemedi.'); }
  },

  applySavedPreferences() {
    let theme = 'dark';
    try {
      if (localStorage.getItem(THEME_STORAGE_KEY) === 'light') theme = 'light';
      localStorage.removeItem('cuzdanim.currency');
    } catch { /* use default */ }
    document.documentElement.dataset.theme = theme;
    const themeSelect = document.querySelector('#settings-theme');
    if (themeSelect) themeSelect.value = theme;
  },

  bindNotifications() {
    const button = document.querySelector('.notification-button');
    const panel = document.querySelector('#notification-panel');
    const list = document.querySelector('#notification-list');
    const readAll = document.querySelector('#notifications-read-all');
    button?.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) this.refreshNotifications();
    });
    document.addEventListener('click', (event) => {
      if (!panel || panel.hidden || panel.contains(event.target) || button?.contains(event.target)) return;
      panel.hidden = true;
      button?.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || panel?.hidden) return;
      panel.hidden = true;
      button?.setAttribute('aria-expanded', 'false');
      button?.focus();
    });
    list?.addEventListener('click', (event) => {
      const markRead = event.target.closest('[data-notification-read]');
      if (markRead) this.markNotificationsRead([markRead.dataset.notificationRead]);
    });
    readAll?.addEventListener('click', () => this.markNotificationsRead((this.notifications ?? []).map((item) => item.id)));
    window.addEventListener('storage', (event) => {
      if (event.key === NOTIFICATION_READ_STORAGE_KEY) this.renderNotifications();
    });
  },

  getReadNotificationIds() {
    const remembered = this.notificationReadIds ?? new Set();
    try {
      const parsed = JSON.parse(localStorage.getItem(NOTIFICATION_READ_STORAGE_KEY) ?? '[]');
      if (Array.isArray(parsed)) parsed.filter((id) => typeof id === 'string').forEach((id) => remembered.add(id));
    } catch { /* keep the in-memory read state for this session */ }
    this.notificationReadIds = remembered;
    return new Set(remembered);
  },

  async refreshNotifications() {
    const list = document.querySelector('#notification-list');
    if (!list) return;
    const requestId = (this.notificationRefreshId ?? 0) + 1;
    this.notificationRefreshId = requestId;
    list.replaceChildren(Object.assign(document.createElement('p'), { className: 'notification-empty', textContent: 'Bildirimler yükleniyor…' }));
    try {
      const [allTransactions, activeSubscriptions, allBudgets, expenseCategories, reversedPayments] = await Promise.all([
        transactions.list(), subscriptions.list({ status: 'active' }), budgets.list(), categories.list({ type: 'expense' }), subscriptionPayments.list({ status: 'reversed' }),
      ]);
      if (requestId !== this.notificationRefreshId) return;
      const notifications = [];
      const today = this.todayInputValue();
      const todayUtc = Date.parse(`${today}T00:00:00.000Z`);
      const reversedTransactionIds = new Set(reversedPayments.map((payment) => payment.transactionId).filter((id) => id !== null));
      const monthTransactions = allTransactions.filter((record) => {
        if (record.type !== 'expense' || reversedTransactionIds.has(record.id)) return false;
        const date = record.date.slice(0, 10);
        return date.slice(0, 7) === today.slice(0, 7);
      });
      const budgetSummary = summarizeBudgets(allBudgets, monthTransactions);
      const categoryById = new Map(expenseCategories.map((category) => [category.id, category]));
      for (const item of budgetSummary.items) {
        if (item.percentage < 70) continue;
        const level = item.percentage > 100 ? 'aşıldı' : item.percentage >= 90 ? 'kritik' : 'dikkat';
        notifications.push({
          id: `budget:${item.budget.id}:${today.slice(0, 7)}:${level}`,
          kind: 'budget',
          priority: item.percentage >= 90 ? 1 : 2,
          title: `Bütçe ${level}`,
          message: `${categoryById.get(item.budget.categoryId)?.name ?? item.budget.name}: ${formatKurus(item.spentKurus)} / ${formatKurus(item.budget.amountKurus)} kullanıldı (%${Math.round(item.percentage)}).`,
        });
      }
      for (const subscription of activeSubscriptions) {
        const dueUtc = Date.parse(`${subscription.nextPaymentDate}T00:00:00.000Z`);
        const daysRemaining = Math.round((dueUtc - todayUtc) / 86_400_000);
        if (daysRemaining > 7) continue;
        notifications.push({
          id: `subscription:${subscription.id}:${subscription.nextPaymentDate}`,
          kind: 'subscription',
          priority: daysRemaining < 0 ? 0 : 1,
          title: daysRemaining < 0 ? 'Abonelik ödemesi gecikti' : 'Yaklaşan abonelik ödemesi',
          message: `${subscription.name} · ${formatKurus(subscription.amountKurus)} · ${daysRemaining < 0 ? `${Math.abs(daysRemaining)} gün gecikti` : daysRemaining === 0 ? 'Bugün ödenecek' : `${daysRemaining} gün kaldı`}.`,
        });
      }
      notifications.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title, 'tr'));
      this.notifications = notifications;
      this.renderNotifications();
    } catch (error) {
      if (requestId !== this.notificationRefreshId) return;
      this.notifications = null;
      const empty = document.createElement('p');
      empty.className = 'notification-error';
      empty.textContent = error.message || 'Bildirimler yüklenemedi.';
      list.replaceChildren(empty);
      document.querySelector('#notification-summary').textContent = 'Veriler okunamadı';
      document.querySelector('#notifications-read-all').hidden = true;
      document.querySelector('#notification-count').hidden = true;
      document.querySelector('.notification-button').setAttribute('aria-label', 'Bildirimler');
    }
  },

  renderNotifications() {
    const list = document.querySelector('#notification-list');
    const summary = document.querySelector('#notification-summary');
    const badge = document.querySelector('#notification-count');
    const readAll = document.querySelector('#notifications-read-all');
    const button = document.querySelector('.notification-button');
    if (!list || !summary || !badge || !readAll) return;
    if (this.notifications === null) return;
    const items = this.notifications ?? [];
    const readIds = this.getReadNotificationIds();
    const unreadCount = items.filter((item) => !readIds.has(item.id)).length;
    summary.textContent = items.length ? `${unreadCount} okunmamış · ${items.length} bildirim` : 'Şu anda etkin uyarı yok';
    badge.hidden = unreadCount === 0;
    badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    button?.setAttribute('aria-label', unreadCount ? `Bildirimler, ${unreadCount} okunmamış` : 'Bildirimler');
    readAll.hidden = unreadCount === 0;
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'notification-empty';
      empty.textContent = 'Şu anda yaklaşan abonelik ödemesi veya bütçe uyarısı yok.';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...items.map((item) => {
      const row = document.createElement('article');
      const isRead = readIds.has(item.id);
      row.className = `notification-item notification-${item.kind}${isRead ? ' is-read' : ' is-unread'}`;
      const copy = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = item.title;
      const message = document.createElement('p'); message.textContent = item.message;
      copy.append(title, message);
      row.append(copy);
      const mark = document.createElement('button');
      mark.type = 'button'; mark.className = 'notification-mark-read';
      mark.dataset.notificationRead = item.id;
      mark.textContent = isRead ? 'Okundu' : 'Okundu işaretle';
      mark.disabled = isRead;
      row.append(mark);
      return row;
    }));
  },

  markNotificationsRead(ids) {
    const readIds = this.getReadNotificationIds();
    ids.forEach((id) => readIds.add(id));
    this.notificationReadIds = readIds;
    try { localStorage.setItem(NOTIFICATION_READ_STORAGE_KEY, JSON.stringify([...readIds])); } catch { /* in-memory state still updates for this session */ }
    this.renderNotifications();
  },

  bindSettingsView() {
    const theme = document.querySelector('#settings-theme');
    theme?.addEventListener('change', () => {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme.value);
        document.documentElement.dataset.theme = theme.value;
        this.setSettingsFeedback(`${theme.value === 'light' ? 'Açık' : 'Koyu'} tema tercihi kaydedildi.`, 'success');
      } catch {
        theme.value = document.documentElement.dataset.theme || 'dark';
        this.setSettingsFeedback('Tema tercihi bu tarayıcıda kaydedilemedi.', 'error');
      }
    });
    document.querySelector('#backup-export')?.addEventListener('click', () => this.exportBackup());
    document.querySelector('#backup-file')?.addEventListener('change', async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      await this.restoreBackup(file);
      event.currentTarget.value = '';
    });
    document.querySelector('#data-reset')?.addEventListener('click', () => this.confirmDataReset());
  },

  async refreshSettingsOverview() {
    const stats = document.querySelector('#settings-stat-list');
    if (!stats) return;
    stats.setAttribute('aria-busy', 'true');
    try {
      const [db, transactionRecords, activeSubscriptions, budgetRecords] = await Promise.all([
        openDatabase(), transactions.list(), subscriptions.list({ status: 'active' }), budgets.list(),
      ]);
      document.querySelector('#settings-transaction-count').textContent = new Intl.NumberFormat('tr-TR').format(transactionRecords.length);
      document.querySelector('#settings-subscription-count').textContent = new Intl.NumberFormat('tr-TR').format(activeSubscriptions.length);
      document.querySelector('#settings-budget-count').textContent = new Intl.NumberFormat('tr-TR').format(budgetRecords.length);
      document.querySelector('#settings-database-version').textContent = `v${db.version}`;
      let lastBackupAt;
      try { lastBackupAt = localStorage.getItem(LAST_BACKUP_STORAGE_KEY); } catch { /* no local storage */ }
      document.querySelector('#settings-last-backup').textContent = lastBackupAt ? this.formatTransactionDate(lastBackupAt) : 'Henüz yedek alınmadı';
      stats.setAttribute('aria-busy', 'false');
    } catch (error) {
      stats.setAttribute('aria-busy', 'false');
      this.setSettingsFeedback(error.message || 'Veri özeti yüklenemedi.', 'error');
    }
  },

  async exportBackup() {
    this.setSettingsFeedback('Yedek hazırlanıyor…', 'loading');
    try {
      const stores = await readAllApplicationData();
      const createdAt = new Date().toISOString();
      const backup = createBackupObject(stores, { theme: document.documentElement.dataset.theme || 'dark' }, createdAt);
      const blob = new Blob([serializeBackup(backup)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cuzdanim-yedek-${this.todayInputValue()}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      try { localStorage.setItem(LAST_BACKUP_STORAGE_KEY, createdAt); } catch { /* download succeeded; local history is optional */ }
      await this.refreshSettingsOverview();
      this.setSettingsFeedback('Yedek UTF-8 JSON dosyası olarak indirildi.', 'success');
    } catch (error) {
      this.setSettingsFeedback(error.message || 'Yedek oluşturulamadı.', 'error');
    }
  },

  async restoreBackup(file) {
    let recoverySnapshot;
    try {
      this.setSettingsFeedback('Yedek dosyası okunuyor ve doğrulanıyor…', 'loading');
      const backup = parseBackupText(await file.text());
      const accepted = window.confirm(`Bu yedek ${this.formatTransactionDate(backup.createdAt)} tarihinde oluşturulmuş. Geri yükleme bu cihazdaki tüm işlemleri, kategorileri, abonelikleri, ödeme geçmişini ve bütçeleri yedektekilerle değiştirecek. Devam edilsin mi?`);
      if (!accepted) return;
      this.setSettingsFeedback('Mevcut veriler korunarak geri yükleme yapılıyor…', 'loading');
      recoverySnapshot = await readAllApplicationData();
      try {
        await replaceAllApplicationData(backup.stores);
      } catch (error) {
        // The complete readwrite transaction aborts without committing partial changes.
        if (!recoverySnapshot) throw new Error('Geri yükleme öncesi koruma kopyası alınamadı.');
        throw error;
      }
      try {
        localStorage.setItem(THEME_STORAGE_KEY, backup.preferences.theme);
        localStorage.setItem(LAST_BACKUP_STORAGE_KEY, backup.createdAt);
      } catch { /* restored financial data remains valid even if browser preferences cannot be saved */ }
      this.applySavedPreferences();
      await this.reloadAllModuleData();
      await this.refreshSettingsOverview();
      this.setSettingsFeedback('Yedek geri yüklendi. Uygulama verileri yeniden yüklendi.', 'success');
    } catch (error) {
      this.setSettingsFeedback(error.message || 'Yedek geri yüklenemedi. Mevcut veriler korunuyor.', 'error');
    }
  },

  async confirmDataReset() {
    const first = window.confirm('Tüm işlem, özel kategori, abonelik, ödeme geçmişi ve bütçe verileri silinecek. Varsayılan kategoriler kalacak. Bu işlem geri alınamaz. Devam etmek istiyor musun?');
    if (!first) return;
    const second = window.prompt('İkinci onay için SIFIRLA yaz.');
    if (second !== 'SIFIRLA') {
      this.setSettingsFeedback('Veri sıfırlama iptal edildi.', '');
      return;
    }
    this.setSettingsFeedback('Veriler sıfırlanıyor…', 'loading');
    try {
      await resetAllApplicationData();
      await this.reloadAllModuleData();
      await this.refreshSettingsOverview();
      this.setSettingsFeedback('Tüm veriler silindi; veritabanı ve varsayılan kategoriler korundu.', 'success');
    } catch (error) { this.setSettingsFeedback(error.message || 'Veriler sıfırlanamadı.', 'error'); }
  },

  async reloadAllModuleData() {
    await Promise.all([
      this.refreshDashboard(),
      this.refreshSubscriptions(),
      this.refreshBudgets(),
      this.refreshReports(),
    ]);
  },

  setSettingsFeedback(message, kind = '') {
    const element = document.querySelector('#settings-feedback');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-success', kind === 'success');
    element.classList.toggle('is-error', kind === 'error');
    element.classList.toggle('is-loading', kind === 'loading');
    element.setAttribute('aria-busy', kind === 'loading' ? 'true' : 'false');
  },

  bindReportsView() {
    const period = document.querySelector('#reports-period');
    const customRange = document.querySelector('#reports-custom-range');
    const apply = document.querySelector('#reports-apply-range');
    period?.addEventListener('change', () => {
      customRange.hidden = period.value !== 'custom';
      if (period.value !== 'custom') this.refreshReports();
    });
    apply?.addEventListener('click', () => this.refreshReports());
  },

  async refreshReports() {
    const view = document.querySelector('#reports-view');
    if (!view) return;
    const requestId = (this.reportsRefreshId ?? 0) + 1;
    this.reportsRefreshId = requestId;
    const summary = document.querySelector('.reports-summary-grid');
    const feedback = document.querySelector('#reports-feedback');
    summary?.setAttribute('aria-busy', 'true');
    const list = document.querySelector('#reports-monthly-chart');
    if (!this.reportsDataLoaded && list) list.innerHTML = '<p class="report-loading">Rapor verileri yükleniyor…</p>';
    try {
      const [records, categoryRecords, reversedPayments] = await Promise.all([
        transactions.list(),
        categories.list(),
        subscriptionPayments.list({ status: 'reversed' }),
      ]);
      if (requestId !== this.reportsRefreshId) return;
      const reversedTransactionIds = new Set(reversedPayments.map((payment) => payment.transactionId).filter((id) => id !== null && id !== undefined));
      const reportRecords = records.filter((record) => !reversedTransactionIds.has(record.id));
      const period = document.querySelector('#reports-period').value;
      const range = getReportDateRange(
        period,
        new Date(),
        document.querySelector('#reports-start-date').value,
        document.querySelector('#reports-end-date').value,
      );
      this.reportsData = buildReportsData(reportRecords, categoryRecords, range);
      this.reportsRange = range;
      this.renderReports();
      this.reportsDataLoaded = true;
      summary?.setAttribute('aria-busy', 'false');
      if (feedback) feedback.textContent = '';
    } catch (error) {
      if (requestId !== this.reportsRefreshId) return;
      summary?.setAttribute('aria-busy', 'false');
      if (feedback) feedback.textContent = error.message || 'Raporlar yüklenemedi. Tarih aralığını kontrol edip tekrar dene.';
      if (list) list.innerHTML = '<p class="report-error">Rapor verileri yüklenemedi.</p>';
      this.reportsDataLoaded = false;
    }
  },

  renderReports() {
    const data = this.reportsData;
    if (!data) return;
    document.querySelector('#report-income').textContent = formatKurus(data.current.incomeKurus);
    document.querySelector('#report-expense').textContent = formatKurus(data.current.expenseKurus);
    const netElement = document.querySelector('#report-net');
    netElement.textContent = formatKurus(data.current.netKurus);
    netElement.classList.toggle('is-negative', data.current.netKurus < 0);
    document.querySelector('#report-savings-rate').textContent = data.savingsRatePercent === null ? '—' : `${formatReportPercent(data.savingsRatePercent)}%`;
    this.renderReportComparison('#report-income-change', data.changes.income, 'income');
    this.renderReportComparison('#report-expense-change', data.changes.expense, 'expense');
    this.renderReportComparison('#report-net-change', data.changes.net, 'net');
    document.querySelector('#reports-range-label').textContent = `${this.formatTransactionDate(this.reportsRange.startDate)} – ${this.formatTransactionDate(addReportDays(this.reportsRange.endDateExclusive, -1))}`;
    this.renderReportsMonthlyChart(data.monthly);
    this.renderReportCategories(data.expenseCategories, data.current.expenseKurus);
    this.renderTopReportCategories(data.topCategories);
    this.renderReportSavings(data.monthly, data.current.netKurus);
  },

  renderReportComparison(selector, comparison, kind) {
    const element = document.querySelector(selector);
    const { differenceKurus, previousKurus, percent, direction } = comparison;
    const signed = differenceKurus > 0 ? '+' : differenceKurus < 0 ? '−' : '';
    const amount = `${signed}${formatKurus(Math.abs(differenceKurus))}`;
    const percentText = percent === null ? 'önceki dönem sıfırdı; yüzde hesaplanamadı' : `${formatReportPercent(percent, { signed: true })}%`;
    element.textContent = `${direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→'} ${amount} (${percentText}) · Önceki ${formatKurus(previousKurus)}`;
    element.classList.remove('change-positive', 'change-negative', 'change-neutral');
    const favorable = kind === 'expense' ? direction === 'down' : direction === 'up';
    element.classList.add(direction === 'same' ? 'change-neutral' : favorable ? 'change-positive' : 'change-negative');
  },

  renderReportsMonthlyChart(monthly) {
    const container = document.querySelector('#reports-monthly-chart');
    const empty = document.querySelector('#reports-monthly-empty');
    const hasActivity = monthly.some((item) => item.incomeKurus > 0 || item.expenseKurus > 0);
    empty.hidden = hasActivity;
    if (!hasActivity) { container.replaceChildren(); return; }
    const maximum = Math.max(1, ...monthly.flatMap((item) => [item.incomeKurus, item.expenseKurus]));
    container.replaceChildren(...monthly.map((item) => {
      const column = document.createElement('div'); column.className = 'report-month-column';
      const bars = document.createElement('div'); bars.className = 'report-month-bars';
      for (const [kind, amount] of [['income', item.incomeKurus], ['expense', item.expenseKurus]]) {
        const bar = document.createElement('span');
        bar.className = `report-month-bar report-${kind}-bar`;
        bar.style.height = `${amount === 0 ? 2 : Math.max(3, amount / maximum * 100)}%`;
        bar.title = `${kind === 'income' ? 'Gelir' : 'Gider'} ${formatKurus(amount)}`;
        bar.setAttribute('aria-label', `${kind === 'income' ? 'Gelir' : 'Gider'} ${formatKurus(amount)}`);
        bars.append(bar);
      }
      const label = document.createElement('span'); label.className = 'report-month-label'; label.textContent = item.label;
      const amounts = document.createElement('small'); amounts.className = 'report-month-values';
      amounts.textContent = `${CURRENCY_SYMBOL} ${formatKurus(item.incomeKurus, { symbol: false })} / ${CURRENCY_SYMBOL} ${formatKurus(item.expenseKurus, { symbol: false })}`;
      column.append(bars, label, amounts); return column;
    }));
  },

  renderReportCategories(categoriesByExpense, totalExpense) {
    const donut = document.querySelector('#reports-donut');
    const legend = document.querySelector('#reports-category-legend');
    const empty = document.querySelector('#reports-category-empty');
    document.querySelector('#reports-donut-total').textContent = formatKurus(totalExpense);
    const colors = ['#20c997', '#ff6b75', '#7fc8e8', '#f2bd72', '#c2a0f2', '#73d9b5', '#e5a7ed', '#91a8ff', '#a3afc2'];
    let cursor = 0;
    const slices = categoriesByExpense.map((category, index) => {
      const start = cursor;
      cursor += category.amountKurus / (totalExpense || 1) * 100;
      return `${colors[index % colors.length]} ${start}% ${cursor}%`;
    });
    donut.style.background = categoriesByExpense.length ? `conic-gradient(${slices.join(', ')})` : '#26354a';
    empty.hidden = categoriesByExpense.length > 0;
    legend.replaceChildren(...categoriesByExpense.map((category, index) => {
      const item = document.createElement('li');
      const label = document.createElement('span'); label.className = 'report-category-label';
      const dot = document.createElement('i'); dot.style.backgroundColor = colors[index % colors.length];
      const name = document.createElement('span'); name.textContent = category.name;
      label.append(dot, name);
      const amount = document.createElement('strong'); amount.textContent = `${formatKurus(category.amountKurus)} · ${formatReportPercent(category.sharePercent)}%`;
      item.append(label, amount); return item;
    }));
  },

  renderTopReportCategories(categories) {
    const list = document.querySelector('#reports-top-categories');
    const empty = document.querySelector('#reports-top-empty');
    empty.hidden = categories.length > 0;
    list.replaceChildren(...categories.map((category) => {
      const item = document.createElement('li');
      const name = document.createElement('span'); name.textContent = category.name;
      const value = document.createElement('strong'); value.textContent = formatKurus(category.amountKurus);
      const share = document.createElement('small'); share.textContent = `${formatReportPercent(category.sharePercent)}% gider payı`;
      item.append(name, value, share); return item;
    }));
  },

  renderReportSavings(monthly, periodNetKurus) {
    const total = document.querySelector('#reports-period-net');
    total.textContent = `${periodNetKurus > 0 ? '+' : ''}${formatKurus(periodNetKurus)}`;
    total.classList.toggle('is-negative', periodNetKurus < 0);
    const list = document.querySelector('#reports-savings-months');
    const empty = document.querySelector('#reports-savings-empty');
    const hasActivity = monthly.some((item) => item.incomeKurus > 0 || item.expenseKurus > 0);
    empty.hidden = hasActivity;
    const max = Math.max(1, ...monthly.map((item) => Math.abs(item.netKurus)));
    list.replaceChildren(...monthly.map((item) => {
      const row = document.createElement('div'); row.className = `report-saving-row${item.netKurus < 0 ? ' is-negative' : ''}`;
      const label = document.createElement('span'); label.textContent = item.label;
      const track = document.createElement('div'); track.className = 'report-saving-track';
      const bar = document.createElement('span'); bar.style.width = `${item.netKurus === 0 ? 0 : Math.max(3, Math.abs(item.netKurus) / max * 100)}%`; track.append(bar);
      const amount = document.createElement('strong'); amount.textContent = `${item.netKurus > 0 ? '+' : ''}${formatKurus(item.netKurus)}`;
      row.append(label, track, amount); return row;
    }));
  },

  renderSubscriptions() {
    const all = this.subscriptionRecords ?? [];
    const active = all.filter((item) => item.status === 'active');
    const cancelled = all.filter((item) => item.status === 'cancelled');
    const monthly = active.filter((item) => item.period === 'monthly').reduce((sum, item) => sum + BigInt(item.amountKurus), 0n);
    const yearly = active.filter((item) => item.period === 'yearly').reduce((sum, item) => sum + BigInt(item.amountKurus), 0n);
    const monthlyTotal = safeKurusNumber(monthly + (yearly + 6n) / 12n);
    const yearlyTotal = safeKurusNumber(monthly * 12n + yearly);
    document.querySelector('#subscription-monthly-cost').textContent = formatKurus(monthlyTotal);
    document.querySelector('#subscription-yearly-cost').textContent = formatKurus(yearlyTotal);
    document.querySelector('#subscription-active-count').textContent = new Intl.NumberFormat('tr-TR').format(active.length);

    const categoryMap = new Map((this.subscriptionCategories ?? []).map((category) => [category.id, category]));
    const paymentMap = new Map();
    for (const payment of this.subscriptionPaymentRecords ?? []) {
      const history = paymentMap.get(payment.subscriptionId) ?? [];
      history.push(payment);
      paymentMap.set(payment.subscriptionId, history);
    }
    this.renderUpcomingPayments(active, categoryMap);
    const activeElement = document.querySelector('#active-subscriptions');
    const cancelledElement = document.querySelector('#cancelled-subscriptions');
    if (activeElement) activeElement.replaceChildren(...(active.length
      ? active.map((record) => this.createSubscriptionCard(record, categoryMap, paymentMap.get(record.id) ?? [], true))
      : [this.createSubscriptionEmpty('Henüz aktif abonelik yok.', 'Abonelik ekleyerek düzenli ödemelerini takip etmeye başla.')]));
    if (cancelledElement) cancelledElement.replaceChildren(...(cancelled.length
      ? cancelled.map((record) => this.createSubscriptionCard(record, categoryMap, paymentMap.get(record.id) ?? [], false))
      : [this.createSubscriptionEmpty('İptal edilmiş abonelik yok.', 'İptal ettiğin abonelikler burada görünür.')]));
  },

  renderUpcomingPayments(active, categoryMap) {
    const today = this.todayInputValue();
    const payments = active.map((record) => ({ record, days: daysBetweenDateKeys(today, record.nextPaymentDate) }))
      .filter((item) => item.days <= 30)
      .sort((a, b) => a.days - b.days || a.record.name.localeCompare(b.record.name, 'tr'));
    const overdue = payments.filter((item) => item.days < 0);
    const upcoming = payments.filter((item) => item.days >= 0);
    const overdueGroup = document.querySelector('#overdue-payments-group');
    const upcomingGroup = document.querySelector('#upcoming-payments-group');
    const overdueList = document.querySelector('#overdue-payments');
    const upcomingList = document.querySelector('#upcoming-payments');
    const empty = document.querySelector('#upcoming-empty');
    if (overdueGroup) overdueGroup.hidden = overdue.length === 0;
    if (upcomingGroup) upcomingGroup.hidden = upcoming.length === 0;
    if (empty) empty.hidden = payments.length > 0;
    if (overdueList) overdueList.replaceChildren(...overdue.map(({ record, days }) => this.createUpcomingPayment(record, days, categoryMap)));
    if (upcomingList) upcomingList.replaceChildren(...upcoming.map(({ record, days }) => this.createUpcomingPayment(record, days, categoryMap)));
  },

  createUpcomingPayment(record, days, categoryMap) {
    const card = document.createElement('article');
    card.className = `upcoming-payment-card${days < 0 ? ' is-overdue' : ''}`;
    const details = document.createElement('div');
    details.className = 'upcoming-payment-info';
    const name = document.createElement('strong');
    name.textContent = record.name;
    const category = document.createElement('span');
    category.textContent = categoryMap.get(record.categoryId)?.name ?? 'Gider kategorisi';
    const date = document.createElement('span');
    date.className = 'upcoming-payment-date';
    date.textContent = this.formatTransactionDate(record.nextPaymentDate);
    details.append(name, category, date);
    const due = document.createElement('div');
    due.className = 'upcoming-payment-due';
    const amount = document.createElement('strong');
    amount.textContent = formatKurus(record.amountKurus);
    const timing = document.createElement('span');
    timing.textContent = days < 0 ? `${Math.abs(days)} gün gecikti` : days === 0 ? 'Bugün' : `${days} gün kaldı`;
    due.append(amount, timing);
    const paid = document.createElement('button');
    paid.type = 'button';
    paid.className = 'button button-primary subscription-paid-button';
    paid.dataset.paySubscription = record.id;
    paid.textContent = 'Ödendi';
    paid.setAttribute('aria-label', `${record.name} ödemesini gider olarak kaydet`);
    card.append(details, due, paid);
    return card;
  },

  createSubscriptionCard(record, categoryMap, history, canManage) {
    const card = document.createElement('article');
    card.className = `card subscription-card${canManage ? '' : ' is-cancelled'}`;
    const heading = document.createElement('div');
    heading.className = 'subscription-card-heading';
    const name = document.createElement('h3');
    name.textContent = record.name;
    const status = document.createElement('span');
    status.className = `subscription-status${canManage ? ' is-active' : ' is-cancelled'}`;
    status.textContent = canManage ? 'Aktif' : 'İptal edildi';
    heading.append(name, status);
    const amount = document.createElement('strong');
    amount.className = 'subscription-card-amount';
    amount.textContent = formatKurus(record.amountKurus);
    const meta = document.createElement('div');
    meta.className = 'subscription-card-meta';
    meta.append(
      this.createSubscriptionMeta('Periyot', record.period === 'monthly' ? 'Aylık' : 'Yıllık'),
      this.createSubscriptionMeta('Sonraki ödeme', record.nextPaymentDate ? this.formatTransactionDate(record.nextPaymentDate) : '—'),
      this.createSubscriptionMeta('Kategori', categoryMap.get(record.categoryId)?.name ?? 'Gider kategorisi'),
    );
    card.append(heading, amount, meta);
    if (canManage) {
      const actions = document.createElement('div');
      actions.className = 'subscription-card-actions';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'button'; edit.dataset.editSubscription = record.id; edit.textContent = 'Düzenle';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'button subscription-cancel-button'; cancel.dataset.cancelSubscription = record.id; cancel.textContent = 'İptal et';
      actions.append(edit, cancel);
      card.append(actions);
    } else {
      const cancelledAt = document.createElement('p');
      cancelledAt.className = 'subscription-cancelled-date';
      cancelledAt.textContent = record.cancelledAt ? `İptal tarihi: ${this.formatTransactionDate(record.cancelledAt.slice(0, 10))}` : 'İptal edilmiş';
      card.append(cancelledAt);
    }
    card.append(this.createPaymentHistory(record.id, history));
    return card;
  },

  createSubscriptionMeta(label, value) {
    const item = document.createElement('div');
    item.className = 'subscription-meta-item';
    const term = document.createElement('span'); term.textContent = label;
    const description = document.createElement('strong'); description.textContent = value;
    item.append(term, description);
    return item;
  },

  createPaymentHistory(subscriptionId, history) {
    const details = document.createElement('details');
    details.className = 'subscription-history';
    const summary = document.createElement('summary');
    summary.textContent = `Ödeme geçmişi · ${history.length}`;
    details.append(summary);
    if (!history.length) {
      const empty = document.createElement('p'); empty.className = 'subscription-history-empty'; empty.textContent = 'Henüz ödeme kaydı yok.'; details.append(empty);
      return details;
    }
    const list = document.createElement('ul');
    for (const payment of history) {
      const item = document.createElement('li');
      const paymentDate = document.createElement('span');
      paymentDate.textContent = `${this.formatTransactionDate(payment.paidAt)} · ${payment.status === 'reversed' ? 'Gider geri alındı' : 'Ödendi'}`;
      const amount = document.createElement('strong'); amount.textContent = formatKurus(payment.amountKurus);
      item.append(paymentDate, amount); list.append(item);
    }
    details.append(list);
    return details;
  },

  createSubscriptionEmpty(title, description) {
    const empty = document.createElement('div');
    empty.className = 'subscription-empty-card';
    const heading = document.createElement('strong'); heading.textContent = title;
    const detail = document.createElement('span'); detail.textContent = description;
    empty.append(heading, detail);
    return empty;
  },

  bindSubscriptionsView() {
    const form = document.querySelector('#subscription-form');
    const dialog = document.querySelector('#subscription-dialog');
    const category = document.querySelector('#subscription-category');
    const feedback = document.querySelector('#subscription-form-feedback');
    const close = dialog?.querySelector('.dialog-close');
    document.querySelector('.subscription-add-button')?.addEventListener('click', () => this.openSubscriptionForm());
    close?.addEventListener('click', () => dialog.close());
    dialog?.addEventListener('close', () => this.setFormFeedback(feedback, ''));
    form?.addEventListener('submit', (event) => this.submitSubscriptionForm(event));
    category?.addEventListener('change', () => this.setFormFeedback(feedback, ''));
    document.querySelector('.subscription-list')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-subscription], [data-cancel-subscription]');
      if (!button) return;
      if (button.dataset.editSubscription) this.openSubscriptionForm(button.dataset.editSubscription);
      else this.confirmCancelSubscription(button.dataset.cancelSubscription);
    });
    document.querySelectorAll('.upcoming-list').forEach((list) => list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-pay-subscription]');
      if (button) this.confirmSubscriptionPayment(button.dataset.paySubscription);
    }));
  },

  async loadSubscriptionCategoryOptions(select, selectedId = 'expense-bills') {
    select.disabled = true;
    try {
      const allItems = await categories.list({ type: 'expense' });
      const items = allItems.filter((item) => !isLegacyOtherCategory(item));
      const retained = selectedId ? allItems.find((item) => item.id === selectedId && isLegacyOtherCategory(item)) : undefined;
      if (retained) items.push(retained);
      select.replaceChildren(new Option('Kategori seç', ''), ...items.map((item) => new Option(isLegacyOtherCategory(item) ? 'Mevcut eski kategori (korunuyor)' : item.name, item.id)));
      select.value = items.some((item) => item.id === selectedId) ? selectedId : '';
      select.disabled = items.length === 0;
      if (!items.length) throw new Error('Gider kategorisi bulunamadı. Önce bir gider kategorisi ekle.');
      return true;
    } catch (error) {
      select.replaceChildren(new Option('Kategoriler yüklenemedi', ''));
      select.disabled = true;
      throw error;
    }
  },

  async openSubscriptionForm(id) {
    const form = document.querySelector('#subscription-form');
    const dialog = document.querySelector('#subscription-dialog');
    const category = document.querySelector('#subscription-category');
    const feedback = document.querySelector('#subscription-form-feedback');
    form.reset();
    this.setFormFeedback(feedback, '');
    if (id) {
      try {
        const record = await subscriptions.get(id);
        if (!record) throw new Error('Abonelik artık bulunamıyor.');
        form.dataset.editId = id;
        document.querySelector('#subscription-dialog-title').textContent = 'Aboneliği düzenle';
        document.querySelector('#subscription-submit').textContent = 'Değişiklikleri kaydet';
        document.querySelector('#subscription-name').value = record.name;
        document.querySelector('#subscription-amount').value = formatKurus(record.amountKurus, { symbol: false });
        document.querySelector('#subscription-period').value = record.period;
        document.querySelector('#subscription-next-date').value = record.nextPaymentDate;
        await this.loadSubscriptionCategoryOptions(category, record.categoryId);
      } catch (error) {
        this.showNotice(error.message || 'Abonelik bilgileri yüklenemedi.');
        return;
      }
    } else {
      delete form.dataset.editId;
      document.querySelector('#subscription-dialog-title').textContent = 'Abonelik ekle';
      document.querySelector('#subscription-submit').textContent = 'Aboneliği kaydet';
      document.querySelector('#subscription-next-date').value = this.todayInputValue();
      try { await this.loadSubscriptionCategoryOptions(category); }
      catch (error) { this.setFormFeedback(feedback, error.message || 'Kategoriler yüklenemedi.', 'error'); }
    }
    dialog.showModal();
  },

  async submitSubscriptionForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#subscription-form-feedback');
    this.setFormFeedback(feedback, '');
    if (!form.reportValidity()) return;
    try {
      const amountKurus = tlToKurus(form.elements.amount.value);
      if (amountKurus <= 0) throw new TypeError('Tutar sıfırdan büyük olmalıdır.');
      const nextPaymentDate = form.elements.nextPaymentDate.value;
      if (!isValidDateInput(nextPaymentDate)) throw new TypeError('Geçerli bir sonraki ödeme tarihi seç.');
      const values = {
        name: form.elements.name.value.trim(),
        amountKurus,
        period: form.elements.period.value,
        nextPaymentDate,
        categoryId: form.elements.categoryId.value,
      };
      if (!values.name) throw new TypeError('Abonelik adı boş olamaz.');
      if (form.dataset.editId) await subscriptions.update(form.dataset.editId, values);
      else await subscriptions.add(values);
      document.querySelector('#subscription-dialog').close();
      await this.refreshSubscriptions();
      this.showNotice(form.dataset.editId ? 'Abonelik güncellendi.' : 'Abonelik eklendi.');
      delete form.dataset.editId;
    } catch (error) {
      this.setFormFeedback(feedback, this.subscriptionErrorMessage(error), 'error');
    }
  },

  async confirmSubscriptionPayment(id) {
    const record = await subscriptions.get(id);
    if (!record) return this.showNotice('Abonelik artık bulunamıyor.');
    const accepted = await this.askSubscriptionConfirmation(
      'Ödeme gider olarak kaydedilsin mi?',
      `${record.name} için ${formatKurus(record.amountKurus)} tutarında gider oluşturulacak. Bu dönemdeki ödeme bir kez kaydedilebilir.`,
      'Ödendi',
    );
    if (!accepted) return;
    try {
      await subscriptionPayments.record(id);
      await this.refreshSubscriptions();
      this.showNotice('Ödeme gider olarak kaydedildi.');
    } catch (error) {
      this.showNotice(this.subscriptionErrorMessage(error));
      await this.refreshSubscriptions();
    }
  },

  async confirmCancelSubscription(id) {
    const record = await subscriptions.get(id);
    if (!record) return this.showNotice('Abonelik artık bulunamıyor.');
    const accepted = await this.askSubscriptionConfirmation(
      'Abonelik iptal edilsin mi?',
      `${record.name} aktif aboneliklerden çıkarılacak. Geçmiş ödeme kayıtları korunur.`,
      'İptal et',
    );
    if (!accepted) return;
    try {
      await subscriptions.cancel(id);
      await this.refreshSubscriptions();
      this.showNotice('Abonelik iptal edildi.');
    } catch (error) {
      this.showNotice(error.message || 'Abonelik iptal edilemedi.');
    }
  },

  askSubscriptionConfirmation(title, message, actionLabel) {
    const dialog = document.querySelector('#subscription-confirm-dialog');
    document.querySelector('#subscription-confirm-title').textContent = title;
    document.querySelector('#subscription-confirm-message').textContent = message;
    document.querySelector('#subscription-confirm-action').textContent = actionLabel;
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  },

  subscriptionErrorMessage(error) {
    if (error?.name === 'ConstraintError') return 'Bu dönemin ödemesi zaten kaydedilmiş. Aynı ödeme ikinci kez eklenmedi.';
    return error?.message || 'İşlem tamamlanamadı. Lütfen tekrar dene.';
  },

  renderDashboard(data, categoryRecords) {
    const balance = document.querySelector('#dashboard-balance');
    const income = document.querySelector('#dashboard-income');
    const expense = document.querySelector('#dashboard-expense');
    if (balance) balance.textContent = formatKurus(data.balanceKurus);
    if (income) income.textContent = formatKurus(data.incomeKurus);
    if (expense) expense.textContent = formatKurus(data.expenseKurus);

    const categoryMap = new Map(categoryRecords.map((category) => [category.id, category]));
    this.renderWeeklyChart(data.weekly);
    this.renderRecentTransactions(data.recent, categoryMap);
  },

  renderWeeklyChart(weekly) {
    const svg = document.querySelector('.chart-svg');
    const axis = document.querySelector('.y-axis');
    const labels = document.querySelector('#dashboard-chart-labels');
    const chart = document.querySelector('#dashboard-chart');
    if (!svg || !axis || !labels || !chart) return;

    const largestValue = Math.max(0, ...weekly.flatMap((day) => [day.incomeKurus, day.expenseKurus]));
    const axisMaximum = chartAxisMaximumKurus(weekly);
    const axisValues = largestValue === 0
      ? [0, 0, 0, 0, 0]
      : [1, 0.75, 0.5, 0.25, 0].map((ratio) => Math.round(axisMaximum * ratio));
    axis.replaceChildren(...axisValues.map((value) => {
      const label = document.createElement('span');
      label.textContent = `${CURRENCY_SYMBOL} ${formatKurus(value, { symbol: false })}`;
      return label;
    }));

    labels.replaceChildren(...weekly.map((day) => {
      const label = document.createElement('span');
      label.textContent = day.label.replace('.', '');
      label.title = this.formatTransactionDate(day.date);
      return label;
    }));

    const width = 600;
    const top = 12;
    const bottom = 178;
    const height = bottom - top;
    const xAt = (index) => 8 + (584 * index) / Math.max(1, weekly.length - 1);
    const yAt = (amount) => bottom - (amount / axisMaximum) * height;
    const drawSeries = (field, lineClass, areaClass, pointClass) => {
      const points = weekly.map((day, index) => ({ x: xAt(index), y: yAt(day[field]) }));
      const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
      const areaPath = `${linePath} L${points.at(-1).x},${bottom} L${points[0].x},${bottom} Z`;
      const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      area.setAttribute('d', areaPath);
      area.setAttribute('class', areaClass);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', linePath);
      line.setAttribute('class', lineClass);
      svg.append(area, line);
      for (const point of points) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', point.x);
        circle.setAttribute('cy', point.y);
        circle.setAttribute('r', '3.5');
        circle.setAttribute('class', pointClass);
        svg.append(circle);
      }
    };

    svg.replaceChildren();
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#20c997" stop-opacity=".25"/><stop offset="100%" stop-color="#20c997" stop-opacity="0"/></linearGradient><linearGradient id="expense-area-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#ff6b75" stop-opacity=".2"/><stop offset="100%" stop-color="#ff6b75" stop-opacity="0"/></linearGradient>';
    svg.append(defs);
    drawSeries('incomeKurus', 'chart-line', 'chart-area-fill', 'chart-point');
    drawSeries('expenseKurus', 'chart-line chart-line-expense', 'chart-area-fill chart-area-fill-expense', 'chart-point chart-point-expense');

    const hasActivity = weekly.some((day) => day.incomeKurus || day.expenseKurus);
    chart.setAttribute('aria-label', hasActivity ? 'Son yedi gündeki günlük gelir ve gider grafiği' : 'Son yedi günde kayıt yok; gelir ve gider değerleri sıfır');
  },

  renderRecentTransactions(records, categoryMap) {
    const list = document.querySelector('#dashboard-transactions');
    if (!list) return;
    if (records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'transactions-empty';
      empty.innerHTML = '<span class="empty-icon" aria-hidden="true">⇄</span><strong>Henüz işlem yok</strong><span>Eklediğin işlemler burada görünecek.</span>';
      list.replaceChildren(empty);
      return;
    }

    const rows = records.map((record) => {
      const isIncome = record.type === 'income';
      const category = categoryMap.get(record.categoryId);
      const row = document.createElement('article');
      row.className = 'transaction-row';
      const icon = document.createElement('span');
      icon.className = `transaction-icon ${isIncome ? 'salary' : 'groceries'}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = isIncome ? '↙' : '↗';
      const info = document.createElement('span');
      info.className = 'transaction-info';
      const description = document.createElement('strong');
      description.textContent = record.description;
      const meta = document.createElement('small');
      meta.textContent = `${category?.name ?? 'Kategori'} · ${this.formatTransactionDate(record.date)}`;
      const kind = document.createElement('span');
      kind.className = `transaction-tag ${isIncome ? 'income-tag' : 'expense-tag'}`;
      kind.textContent = isIncome ? 'Gelir' : 'Gider';
      info.append(description, meta, kind);

      const amount = document.createElement('span');
      amount.className = `transaction-amount ${isIncome ? 'income-amount' : 'expense-amount'}`;
      amount.textContent = `${isIncome ? '+' : '−'} ${formatKurus(record.amountKurus)}`;
      row.append(icon, info, amount);
      return row;
    });
    list.replaceChildren(...rows);
  },

  bindViewNavigation() {
    const updateView = () => {
      const isTransactions = location.hash === '#transactions';
      const isSubscriptions = location.hash === '#subscriptions';
      const isBudgets = location.hash === '#budgets';
      const isReports = location.hash === '#reports';
      const isSettings = location.hash === '#settings';
      document.querySelectorAll('.dashboard > :not(#transactions-view):not(#subscriptions-view):not(#budgets-view):not(#reports-view):not(#settings-view)').forEach((section) => {
        section.hidden = isTransactions || isSubscriptions || isBudgets || isReports || isSettings;
      });
      const view = document.querySelector('#transactions-view');
      if (view) view.hidden = !isTransactions;
      const subscriptionsView = document.querySelector('#subscriptions-view');
      if (subscriptionsView) subscriptionsView.hidden = !isSubscriptions;
      const budgetsView = document.querySelector('#budgets-view');
      if (budgetsView) budgetsView.hidden = !isBudgets;
      const reportsView = document.querySelector('#reports-view');
      if (reportsView) reportsView.hidden = !isReports;
      const settingsView = document.querySelector('#settings-view');
      if (settingsView) settingsView.hidden = !isSettings;
      document.querySelectorAll('.desktop-nav a[href="#home"], .mobile-nav a[href="#home"]').forEach((link) => {
        if (isTransactions || isSubscriptions || isBudgets || isReports || isSettings) link.removeAttribute('aria-current'); else link.setAttribute('aria-current', 'page');
        link.classList.toggle('active', !isTransactions && !isSubscriptions && !isBudgets && !isReports && !isSettings && link.closest('.desktop-nav') !== null);
      });
      document.querySelectorAll('.desktop-nav a[href="#transactions"], .mobile-nav a[href="#transactions"]').forEach((link) => {
        if (isTransactions) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        link.classList.toggle('active', isTransactions && link.closest('.desktop-nav') !== null);
      });
      document.querySelectorAll('.desktop-nav a[href="#subscriptions"], .mobile-nav a[href="#subscriptions"]').forEach((link) => {
        if (isSubscriptions) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        link.classList.toggle('active', isSubscriptions && link.closest('.desktop-nav') !== null);
      });
      document.querySelectorAll('.desktop-nav a[href="#budgets"], .mobile-nav a[href="#budgets"]').forEach((link) => {
        if (isBudgets) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        link.classList.toggle('active', isBudgets && link.closest('.desktop-nav') !== null);
      });
      document.querySelectorAll('.desktop-nav a[href="#reports"], .mobile-nav a[href="#reports"]').forEach((link) => {
        if (isReports) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        link.classList.toggle('active', isReports && link.closest('.desktop-nav') !== null);
      });
      document.querySelectorAll('.desktop-nav a[href="#settings"], .mobile-nav a[href="#settings"], .topbar a[href="#settings"]').forEach((link) => {
        if (isSettings) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
        link.classList.toggle('active', isSettings && link.closest('.desktop-nav') !== null);
      });
      if (isTransactions) this.renderTransactionsView();
      if (isSubscriptions) this.refreshSubscriptions();
      if (isBudgets) this.refreshBudgets();
      if (isReports) this.refreshReports();
      if (isSettings) this.refreshSettingsOverview();
    };
    window.addEventListener('hashchange', updateView);
    updateView();
  },

  bindTransactionsView() {
    const type = document.querySelector('#transactions-type');
    const category = document.querySelector('#transactions-category');
    const search = document.querySelector('#transactions-search');
    const sort = document.querySelector('#transactions-sort');
    const list = document.querySelector('#all-transactions-list');
    const more = document.querySelector('#transactions-load-more');
    for (const control of [type, category, sort]) control?.addEventListener('change', () => {
      this.visibleCount = this.pageSize;
      if (control === type) this.populateTransactionsCategories();
      this.renderTransactionsView();
    });
    search?.addEventListener('input', () => {
      this.visibleCount = this.pageSize;
      this.renderTransactionsView();
    });
    more?.addEventListener('click', () => {
      this.visibleCount += this.pageSize;
      this.renderTransactionsView();
    });
    list?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-edit-transaction], [data-delete-transaction]');
      if (!button) return;
      const id = Number(button.dataset.editTransaction ?? button.dataset.deleteTransaction);
      if (button.hasAttribute('data-edit-transaction')) this.openEditTransaction(id);
      else this.confirmDeleteTransaction(id);
    });
    this.populateTransactionsCategories();
  },

  populateTransactionsCategories() {
    const select = document.querySelector('#transactions-category');
    if (!select) return;
    const current = select.value || 'all';
    const type = document.querySelector('#transactions-type')?.value ?? 'all';
    const items = (this.categoryRecords ?? []).filter((item) => (type === 'all' || item.type === type) && !isLegacyOtherCategory(item));
    select.replaceChildren(new Option('Tüm kategoriler', 'all'), ...items.map((item) => new Option(item.name, item.id)));
    select.value = items.some((item) => item.id === current) ? current : 'all';
  },

  renderTransactionsView() {
    const list = document.querySelector('#all-transactions-list');
    if (!list) return;
    const query = (document.querySelector('#transactions-search')?.value ?? '').trim().toLocaleLowerCase('tr-TR');
    const type = document.querySelector('#transactions-type')?.value ?? 'all';
    const categoryId = document.querySelector('#transactions-category')?.value ?? 'all';
    const direction = document.querySelector('#transactions-sort')?.value === 'asc' ? 1 : -1;
    const categoryMap = new Map((this.categoryRecords ?? []).map((item) => [item.id, item]));
    const filtered = (this.allTransactions ?? []).filter((record) => {
      const categoryName = categoryMap.get(record.categoryId)?.name ?? 'Kategori';
      return (type === 'all' || record.type === type)
        && (categoryId === 'all' || record.categoryId === categoryId)
        && (!query || `${record.description} ${categoryName}`.toLocaleLowerCase('tr-TR').includes(query));
    }).sort((a, b) => direction * (Date.parse(a.date) - Date.parse(b.date)
      || Date.parse(a.createdAt) - Date.parse(b.createdAt)
      || String(a.id).localeCompare(String(b.id), 'en', { numeric: true })));
    const visible = filtered.slice(0, this.visibleCount ?? 30);
    const count = document.querySelector('#transactions-count');
    if (count) count.textContent = `${filtered.length} işlem · ${visible.length} gösteriliyor`;
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'transactions-empty';
      empty.innerHTML = '<span class="empty-icon" aria-hidden="true">⇄</span><strong>İşlem bulunamadı</strong><span>Filtreleri değiştirebilir veya yeni işlem ekleyebilirsin.</span>';
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...visible.map((record) => this.createManageableTransactionRow(record, categoryMap)));
    }
    const more = document.querySelector('#transactions-load-more');
    if (more) more.hidden = visible.length >= filtered.length;
  },

  createManageableTransactionRow(record, categoryMap) {
    const isIncome = record.type === 'income';
    const row = document.createElement('article');
    row.className = `manage-transaction-row ${isIncome ? 'is-income' : 'is-expense'}`;
    const info = document.createElement('div');
    info.className = 'manage-transaction-info';
    const title = document.createElement('strong');
    title.textContent = record.description;
    const meta = document.createElement('span');
    meta.textContent = `${categoryMap.get(record.categoryId)?.name ?? 'Kategori'} · ${this.formatTransactionDate(record.date)}`;
    const amount = document.createElement('strong');
    amount.className = `transaction-amount ${isIncome ? 'income-amount' : 'expense-amount'}`;
    amount.textContent = `${isIncome ? '+' : '−'} ${formatKurus(record.amountKurus)}`;
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'manage-transaction-actions';
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'button transaction-action'; edit.dataset.editTransaction = record.id; edit.textContent = 'Düzenle';
    edit.setAttribute('aria-label', `${record.description} işlemini düzenle`);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'button transaction-action transaction-delete'; remove.dataset.deleteTransaction = record.id; remove.textContent = 'Sil';
    remove.setAttribute('aria-label', `${record.description} işlemini sil`);
    actions.append(edit, remove);
    row.append(info, amount, actions);
    return row;
  },

  async openEditTransaction(id) {
    const record = await transactions.get(id);
    if (!record) return this.showNotice('İşlem artık bulunamıyor.');
    const dialog = document.querySelector('.transaction-dialog');
    const form = document.querySelector('.dialog-form');
    const typeInput = document.querySelector('#transaction-type');
    const categoryInput = document.querySelector('#transaction-category');
    const feedback = document.querySelector('.form-feedback');
    const type = record.type;
    form.reset();
    form.dataset.editId = String(id);
    typeInput.value = type;
    document.querySelector('#dialog-title').textContent = 'İşlemi düzenle';
    document.querySelector('.dialog-icon').textContent = type === 'income' ? '+' : '−';
    document.querySelector('.dialog-icon').classList.toggle('dialog-icon-expense', type === 'expense');
    document.querySelector('#transaction-amount').value = formatKurus(record.amountKurus, { symbol: false });
    document.querySelector('#transaction-date').value = record.date.slice(0, 10);
    document.querySelector('#transaction-description').value = record.description;
    this.setFormFeedback(feedback, '');
    await this.refreshCategoryOptions(categoryInput, type, feedback, record.categoryId);
    categoryInput.value = record.categoryId;
    dialog.showModal();
  },

  async confirmDeleteTransaction(id) {
    const record = await transactions.get(id);
    if (!record) return this.showNotice('İşlem artık bulunamıyor.');
    const dialog = document.querySelector('#delete-confirm-dialog');
    dialog.querySelector('#delete-confirm-title').textContent = `“${record.description}” silinsin mi?`;
    dialog.showModal();
    const result = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (result !== 'confirm') return;
    try {
      await transactions.delete(id);
      this.showNotice('İşlem silindi.');
    } catch (error) {
      this.showNotice(error.message || 'İşlem silinemedi.');
    }
  },

  formatTransactionDate(value) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00`)
      : new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  },

  bindQuickActions() {
    const dialog = document.querySelector('.transaction-dialog');
    const title = document.querySelector('#dialog-title');
    const icon = document.querySelector('.dialog-icon');
    const form = document.querySelector('.dialog-form');
    const typeInput = document.querySelector('#transaction-type');
    const categoryInput = document.querySelector('#transaction-category');
    const dateInput = document.querySelector('#transaction-date');
    const feedback = document.querySelector('.form-feedback');
    const closeButton = document.querySelector('.dialog-close');
    if (!dialog || !title || !icon || !form || !typeInput || !categoryInput || !dateInput || !feedback) return;

    document.querySelectorAll('[data-transaction]').forEach((button) => {
      button.addEventListener('click', async () => {
        const type = button.dataset.transaction;
        const isIncome = type === 'income';
        form.reset();
        delete form.dataset.editId;
        typeInput.value = type;
        dateInput.value = this.todayInputValue();
        title.textContent = isIncome ? 'Gelir ekle' : 'Gider ekle';
        icon.textContent = isIncome ? '+' : '−';
        icon.classList.toggle('dialog-icon-expense', !isIncome);
        this.setFormFeedback(feedback, '');
        dialog.showModal();
        await this.refreshCategoryOptions(categoryInput, type, feedback);
      });
    });

    typeInput.addEventListener('change', () => {
      this.refreshCategoryOptions(categoryInput, typeInput.value, feedback);
    });
    closeButton?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => this.setFormFeedback(feedback, ''));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      this.setFormFeedback(feedback, '');
      if (!form.reportValidity()) return;

      try {
        const type = typeInput.value;
        const amountKurus = tlToKurus(form.elements.amount.value);
        if (amountKurus <= 0) throw new TypeError('Tutar sıfırdan büyük olmalıdır.');

        const categoryId = categoryInput.value;
        const category = await categories.get(categoryId);
        if (!category || category.type !== type) {
          throw new TypeError('Seçilen kategori, işlem türüyle eşleşmiyor.');
        }

        const transactionData = {
          type,
          amountKurus,
          categoryId,
          description: form.elements.description.value.trim(),
          date: dateInput.value,
        };
        const editId = form.dataset.editId;
        if (editId !== undefined) await transactions.update(Number(editId), transactionData);
        else await transactions.add(transactionData);

        form.reset();
        delete form.dataset.editId;
        typeInput.value = type;
        dateInput.value = this.todayInputValue();
        await this.refreshCategoryOptions(categoryInput, type, feedback);
        this.setFormFeedback(feedback, `${editId !== undefined ? 'İşlem güncellendi' : `${type === 'income' ? 'Gelir' : 'Gider'} başarıyla kaydedildi`}.`, 'success');
      } catch (error) {
        this.setFormFeedback(feedback, error.message || 'Kayıt sırasında bir hata oluştu.', 'error');
      }
    });
  },

  async refreshCategoryOptions(select, type, feedback, selectedId) {
    select.dataset.requestedType = type;
    select.disabled = true;
    try {
      const allItems = await categories.list({ type });
      if (select.dataset.requestedType !== type) return;
      const items = allItems.filter((category) => !isLegacyOtherCategory(category));
      const retained = selectedId ? allItems.find((category) => category.id === selectedId && isLegacyOtherCategory(category)) : undefined;
      if (retained) items.push(retained);
      select.replaceChildren(new Option('Kategori seç', ''));
      for (const category of items) select.add(new Option(isLegacyOtherCategory(category) ? 'Mevcut eski kategori (korunuyor)' : category.name, category.id));
      select.disabled = items.length === 0;
      if (items.length === 0) this.setFormFeedback(feedback, 'Bu işlem türü için henüz kategori bulunmuyor.', 'error');
    } catch (error) {
      if (select.dataset.requestedType !== type) return;
      select.replaceChildren(new Option('Kategoriler yüklenemedi', ''));
      select.disabled = true;
      this.setFormFeedback(feedback, error.message || 'Kategoriler yüklenemedi.', 'error');
    }
  },

  todayInputValue() {
    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
    return localDate.toISOString().slice(0, 10);
  },

  setFormFeedback(element, message, kind = '') {
    element.textContent = message;
    element.classList.toggle('is-success', kind === 'success');
    element.classList.toggle('is-error', kind === 'error');
  },

  showNotice(message) {
    let notice = document.querySelector('.app-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'app-notice';
      notice.setAttribute('role', 'status');
      document.body.append(notice);
    }
    notice.textContent = message;
    notice.classList.add('is-visible');
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => notice.classList.remove('is-visible'), 2600);
  },
};

document.addEventListener('DOMContentLoaded', () => app.init());

function safeKurusNumber(value) {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > maximum || value < -maximum) throw new RangeError('Abonelik toplamı güvenli kuruş aralığını aşıyor.');
  return Number(value);
}

function isValidDateInput(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetweenDateKeys(fromDate, toDate) {
  if (!isValidDateInput(fromDate) || !isValidDateInput(toDate)) return 0;
  const [fromYear, fromMonth, fromDay] = fromDate.split('-').map(Number);
  const [toYear, toMonth, toDay] = toDate.split('-').map(Number);
  const fromTime = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const toTime = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((toTime - fromTime) / 86_400_000);
}

function formatReportPercent(value, { signed = false } = {}) {
  return new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(value);
}

function addReportDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
