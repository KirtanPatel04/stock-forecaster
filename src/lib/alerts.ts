/**
 * New-opportunity alerts from the pages that keep running in the background
 * (Day Trade scanner, Next-Day watchlist). Shown as navbar badges while you're elsewhere,
 * plus a desktop notification if you've allowed them.
 */
import { useSyncExternalStore } from 'react';

export type AlertPage = 'daytrade' | 'watchlist';

export interface OpportunityAlert {
  symbol: string;
  label: string;   // e.g. "READY" / "BUY" / "TOP"
}

type State = Record<AlertPage, OpportunityAlert[]>;

let state: State = { daytrade: [], watchlist: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const alerts = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },

  push(page: AlertPage, items: OpportunityAlert[], notifyTitle?: string) {
    if (!items.length) return;
    const merged = [...items, ...state[page].filter((a) => !items.some((i) => i.symbol === a.symbol))].slice(0, 9);
    state = { ...state, [page]: merged };
    emit();
    if (notifyTitle && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(notifyTitle, { body: items.map((i) => `${i.symbol} — ${i.label}`).join('\n'), tag: `sf-${page}` });
      } catch { /* ignore */ }
    }
  },

  clear(page: AlertPage) {
    if (!state[page].length) return;
    state = { ...state, [page]: [] };
    emit();
  },
};

export function useAlerts(): State {
  return useSyncExternalStore(alerts.subscribe, alerts.get);
}
