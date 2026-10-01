import { useCallback, useMemo } from 'react';
import { journal, useJournal } from '../lib/journal';

export interface Holding {
  ticker: string;
  shares: number;
  avgBuyPrice: number;
  addedAt: string;
}

export interface Portfolio {
  cash: number;
  holdings: Holding[];
}

/**
 * Cash + open positions. Backed by the trade journal (src/lib/journal.ts) so every page —
 * Day Trade, Next Day, Chart, Portfolio — sees the same live numbers.
 */
export function usePortfolio() {
  const j = useJournal();

  const portfolio = useMemo<Portfolio>(() => ({
    cash: j.cash,
    holdings: j.open.map((p) => ({ ticker: p.symbol, shares: p.shares, avgBuyPrice: p.entry, addedAt: p.openedAt })),
  }), [j]);

  const setCash = useCallback((cash: number) => journal.setCash(cash), []);

  const addHolding = useCallback((h: Omit<Holding, 'addedAt'>) => {
    journal.openPosition({ symbol: h.ticker, shares: h.shares, entry: h.avgBuyPrice });
  }, []);

  return { portfolio, setCash, addHolding };
}
