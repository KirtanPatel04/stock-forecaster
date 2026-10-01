/**
 * Live USD→CAD rate (CAD per 1 USD), shared by every page. US stocks trade in USD; a Canadian
 * account's cash, goal and P&L are in CAD, so every trade is converted at this rate.
 * Polled every 60s; the last good rate is kept in localStorage so the app still works offline.
 */
import { useSyncExternalStore } from 'react';
import { stocksApi } from '../api/client';

export type Currency = 'CAD' | 'USD';

interface FxState {
  usdcad: number;
  updatedAt: string | null;
  live: boolean;          // false = last saved rate (fetch failing)
}

const KEY = 'sf_fx_usdcad';
const FALLBACK = 1.37;
const POLL_MS = 60_000;

function load(): FxState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s?.usdcad > 0) return { ...s, live: false };
  } catch { /* ignore */ }
  return { usdcad: FALLBACK, updatedAt: null, live: false };
}

let state: FxState = load();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    const r = await stocksApi.getForexRate();
    if (r.data.rate > 0) {
      state = { usdcad: r.data.rate, updatedAt: r.data.timestamp, live: true };
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
      listeners.forEach((l) => l());
    }
  } catch {
    if (state.live) { state = { ...state, live: false }; listeners.forEach((l) => l()); }
  }
}

export const fx = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    if (!timer) { refresh(); timer = setInterval(refresh, POLL_MS); }
    return () => { listeners.delete(l); };
  },
};

export function useFx(): FxState {
  return useSyncExternalStore(fx.subscribe, fx.get);
}

/** Account-currency units per 1 USD. */
export function acctPerUsd(currency: Currency, usdcad: number): number {
  return currency === 'CAD' ? usdcad : 1;
}

/** "C$1,234" / "US$56.78" / "$56.78" (USD account). */
export function fmtMoney(n: number, currency: Currency | 'USD-in-CAD-account', digits = 0): string {
  const prefix = currency === 'CAD' ? 'C$' : currency === 'USD-in-CAD-account' ? 'US$' : '$';
  const sign = n < 0 ? '-' : '';
  return `${sign}${prefix}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
