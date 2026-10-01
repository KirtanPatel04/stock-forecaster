import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type RiskSettings, type SessionTrade, type TradeMode } from '../lib/rossRules';
import { acctPnl, journal, todayET, useJournal, type TradeContext } from '../lib/journal';
import { acctPerUsd, useFx } from '../lib/fx';

const SETTINGS_KEY = 'sf_daytrade_settings';

function loadSettings(): RiskSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    delete saved.goalPct;   // replaced by a $ goal the user sets
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Shared across every mounted page (Day Trade and Next Day both stay mounted)
let settingsState: RiskSettings = loadSettings();
const listeners = new Set<() => void>();
export const settingsStore = {
  get: () => settingsState,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  set(patch: Partial<RiskSettings>) {
    settingsState = { ...settingsState, ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsState)); } catch { /* ignore */ }
    listeners.forEach((l) => l());
  },
};

/** Today's closed trades (from the trade journal, ET day) + risk settings. */
export function useDaySession() {
  const j = useJournal();
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
  const { usdcad } = useFx();
  const fxNow = acctPerUsd(settings.currency ?? 'CAD', usdcad);

  const trades = useMemo<SessionTrade[]>(() => {
    const today = todayET();
    return j.closed
      .filter((t) => todayET(new Date(t.closedAt)) === today)
      .map((t) => ({ id: t.id, symbol: t.symbol, pnl: acctPnl(t, fxNow), time: t.closedAt }));   // account currency
  }, [j.closed, fxNow]);

  /** `pnl` is in the account currency (what the user typed). */
  const logTrade = useCallback(
    (symbol: string, pnl: number, mode: TradeMode, context?: TradeContext) => journal.logClosed(symbol, pnl, mode, context, fxNow), [fxNow]);
  const removeTrade = useCallback((id: string) => journal.removeClosed(id), []);
  const resetSession = useCallback(() => {
    if (!window.confirm("Delete today's logged trades from your journal?")) return;
    trades.forEach((t) => journal.removeClosed(t.id));
  }, [trades]);

  const setSettings = useCallback((patch: Partial<RiskSettings>) => settingsStore.set(patch), []);

  return { trades, logTrade, removeTrade, resetSession, settings, setSettings };
}
