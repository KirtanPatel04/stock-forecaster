import { useCallback, useEffect, useState } from 'react';

const KEY = 'sf_nextday_pins';
const EVENT = 'sf-pins-changed';

export interface Pin {
  symbol: string;
  addedAt: string;
}

function load(): Pin[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

/** Symbols starred for the next session — shared by the Next Day and Day Trade pages. */
export function usePinnedWatchlist() {
  const [pins, setPins] = useState<Pin[]>(load);

  useEffect(() => {
    const sync = () => setPins(load());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);

  const save = (next: Pin[]) => {
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setPins(next);
    window.dispatchEvent(new Event(EVENT));
  };

  const toggle = useCallback((symbol: string) => {
    const cur = load();
    save(cur.some((p) => p.symbol === symbol)
      ? cur.filter((p) => p.symbol !== symbol)
      : [...cur, { symbol, addedAt: new Date().toISOString() }]);
  }, []);

  const clear = useCallback(() => save([]), []);
  const isPinned = useCallback((symbol: string) => pins.some((p) => p.symbol === symbol), [pins]);

  return { pins, symbols: pins.map((p) => p.symbol), toggle, clear, isPinned };
}
