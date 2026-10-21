/** 搜索的 token 预算：单次上限 + 每日累计上限，按本地日期重置。 */
import { kvGet, kvSet } from '../memory/store.js';

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getDailyUsed() {
  return Number(kvGet(`search:used:${todayKey()}`, 0)) || 0;
}

export function addDailyUsed(tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (!n) return getDailyUsed();
  const used = getDailyUsed() + n;
  kvSet(`search:used:${todayKey()}`, used);
  return used;
}

/**
 * @returns {{ok:boolean, reason?:'per-query'|'per-day', used:number, limit:number}}
 */
export function checkBudget({ estimatedTokens, maxPerQuery, maxPerDay }) {
  const used = getDailyUsed();
  const est = Math.max(0, Number(estimatedTokens) || 0);

  if (est > maxPerQuery) {
    return { ok: false, reason: 'per-query', used, limit: maxPerQuery };
  }
  if (used + est > maxPerDay) {
    return { ok: false, reason: 'per-day', used, limit: maxPerDay };
  }
  return { ok: true, used, limit: maxPerDay };
}
