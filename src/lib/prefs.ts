/**
 * UI preferences — everything you can change that isn't your daily plan or your trades.
 * Edited on the Settings page; read by the pages that use them. Persisted in localStorage.
 */
import { useSyncExternalStore } from 'react';

export type GradeFilter = 'all' | 'AB' | 'A';
export type ScannerSort = 'verdict' | 'rank' | 'gain' | 'potential';
export type RailTab = 'small_caps' | 'gainers' | 'losers' | 'actives';
export type PortfolioRange = 'today' | 'week' | 'month' | '7d' | '30d' | '90d' | 'ytd' | 'all';
export type PortfolioMode = 'all' | 'real' | 'paper';

export interface Prefs {
  scannerGrade: GradeFilter;
  scannerFitsCash: boolean;
  scannerSort: ScannerSort;
  showGamePlan: boolean;
  alertNewSetups: boolean;
  alertWatchlistTop: boolean;
  alertMarketOpen: boolean;
  watchlistShowSkipped: boolean;
  railCollapsed: boolean;
  railTab: RailTab;
  portfolioRange: PortfolioRange;
  portfolioMode: PortfolioMode;
}

export const DEFAULT_PREFS: Prefs = {
  scannerGrade: 'AB',
  scannerFitsCash: true,
  scannerSort: 'verdict',
  showGamePlan: true,
  alertNewSetups: true,
  alertWatchlistTop: true,
  alertMarketOpen: true,
  watchlistShowSkipped: false,
  railCollapsed: false,
  railTab: 'small_caps',
  portfolioRange: 'all',
  portfolioMode: 'all',
};

const KEY = 'sf_prefs';

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // carry over the rail state saved before prefs existed
    if (saved.railCollapsed === undefined && localStorage.getItem('sf_rail_collapsed') === '1') saved.railCollapsed = true;
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    return DEFAULT_PREFS;
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

export const prefs = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  set(patch: Partial<Prefs>) {
    state = { ...state, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
    listeners.forEach((l) => l());
  },
  reset() { prefs.set(DEFAULT_PREFS); },
};

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  return [useSyncExternalStore(prefs.subscribe, prefs.get), prefs.set];
}
