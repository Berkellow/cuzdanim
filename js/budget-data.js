const MAX_SAFE_KURUS = BigInt(Number.MAX_SAFE_INTEGER);

/** Calculate current-month expense totals and per-budget usage using integer kuruş. */
export function summarizeBudgets(budgets, transactions, referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const firstDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const nextMonth = new Date(year, month + 1, 1);
  const lastDate = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
  const expenses = transactions.filter((item) => item.type === 'expense'
    && typeof item.date === 'string'
    && item.date.slice(0, 10) >= firstDate
    && item.date.slice(0, 10) < lastDate);
  const spentByCategory = new Map();
  let totalSpent = 0n;
  for (const item of expenses) {
    if (!Number.isSafeInteger(item.amountKurus) || item.amountKurus < 0) continue;
    const amount = BigInt(item.amountKurus);
    totalSpent += amount;
    spentByCategory.set(item.categoryId, (spentByCategory.get(item.categoryId) ?? 0n) + amount);
  }
  const totalBudget = budgets.reduce((sum, item) => sum + BigInt(item.amountKurus), 0n);
  const items = budgets.map((budget) => {
    const spentKurus = spentByCategory.get(budget.categoryId) ?? 0n;
    const budgetKurus = BigInt(budget.amountKurus);
    const remainingKurus = budgetKurus - spentKurus;
    const percentage = Number((spentKurus * 10000n) / budgetKurus) / 100;
    const level = spentKurus > budgetKurus ? 'exceeded'
      : spentKurus * 100n >= budgetKurus * 90n ? 'critical'
        : spentKurus * 100n >= budgetKurus * 70n ? 'warning' : 'normal';
    return {
      budget,
      spentKurus: safeNumber(spentKurus),
      remainingKurus: safeNumber(remainingKurus),
      percentage,
      level,
    };
  });
  return {
    totalBudgetKurus: safeNumber(totalBudget),
    totalSpentKurus: safeNumber(totalSpent),
    remainingKurus: safeNumber(totalBudget - totalSpent),
    items,
  };
}

function safeNumber(value) {
  if (value > MAX_SAFE_KURUS || value < -MAX_SAFE_KURUS) throw new RangeError('Bütçe toplamı güvenli kuruş aralığını aşıyor.');
  return Number(value);
}
