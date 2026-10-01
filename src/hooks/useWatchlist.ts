import { useState, useEffect, useCallback, useRef } from 'react';
import { stocksApi } from '../api/client';

const STORAGE_KEY = 'sf_watchlist';
const LAST_TICKER_KEY = 'sf_last_ticker';

export interface WatchlistEntry {
  ticker: string;
  addedAt: number;
  price?: number;
  priceChange?: number; // vs previous poll
  prevPrice?: number;
}

export function useWatchlist() {
  const [entries, setEntries] = useState<WatchlistEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  });

  const pricesRef = useRef<Record<string, number>>({});

  const save = useCallback((next: WatchlistEntry[]) => {
    setEntries(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const add = useCallback((ticker: string) => {
    setEntries((prev) => {
      if (prev.some((e) => e.ticker === ticker)) return prev;
      const next = [{ ticker, addedAt: Date.now() }, ...prev];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const remove = useCallback((ticker: string) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.ticker !== ticker);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Poll prices for all watchlist tickers every 30s
  useEffect(() => {
    if (entries.length === 0) return;

    const poll = async () => {
      const updated = await Promise.all(
        entries.map(async (e) => {
          try {
            const res = await stocksApi.getPrice(e.ticker);
            const newPrice = res.data.price;
            const prev = pricesRef.current[e.ticker];
            pricesRef.current[e.ticker] = newPrice;
            return { ...e, price: newPrice, prevPrice: prev, priceChange: prev ? newPrice - prev : undefined };
          } catch {
            return e;
          }
        })
      );
      setEntries(updated);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    };

    poll();
    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  }, [entries.map((e) => e.ticker).join(',')]);

  const getLastTicker = () => localStorage.getItem(LAST_TICKER_KEY) || null;
  const setLastTicker = (ticker: string) => localStorage.setItem(LAST_TICKER_KEY, ticker);

  return { entries, add, remove, getLastTicker, setLastTicker };
}
