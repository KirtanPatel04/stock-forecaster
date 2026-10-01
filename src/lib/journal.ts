/**
 * Trade journal — every position you open and close, with a snapshot of the stock and the setup
 * at entry (grade, float, price, catalyst, setup state, the app's verdict, time window…), so the
 * Portfolio page can show what you do well and badly. Every trade is marked real (placed with your
 * broker, at the fill price you tell us) or paper. Real trades move your cash — buying takes the
 * cost out, selling puts the proceeds back; paper trades never touch it.
 * Persisted in localStorage and synced across every open view.
 */
import { useSyncExternalStore } from 'react';

export type TradeMode = 'real' | 'paper';

export interface TradeContext {
  grade?: string;
  score?: number;
  changePct?: number;
  relVolume?: number | null;
  floatShares?: number | null;
  hasNews?: boolean;
  sector?: string | null;
  country?: string | null;
  exchange?: string | null;
  setupState?: string;
  verdict?: string;          // BUY / READY / WAIT / PASS at the moment you entered
  windowKey?: string;        // prime / late / off …
  temperature?: string;      // hot / warm / cold
  gainerRank?: number;
}

export interface Position {
  id: string;
  symbol: string;
  mode?: TradeMode;          // real money (with your broker) or paper; undefined = real (older entries)
  fxOpen?: number;           // account currency per 1 USD when bought (1 for a USD account)
  feePct?: number;           // FX fee per conversion leg, %, at the time of the trade
  shares: number;
  entry: number;
  stop?: number | null;
  target?: number | null;
  openedAt: string;
  context?: TradeContext;
}

export interface ClosedTrade extends Position {
  exit: number | null;       // null for a quick-logged P&L with no prices
  closedAt: string;
  pnl: number;               // USD (price move × shares)
  fxClose?: number;          // account currency per 1 USD when sold
  pnlAcct?: number;          // P&L in the account currency — includes the FX move and conversion fees
}

/** A trade's P&L in the account currency. Older trades without FX data are converted at `fallbackFx`. */
export function acctPnl(t: ClosedTrade, fallbackFx = 1): number {
  return t.pnlAcct ?? t.pnl * fallbackFx;
}

export interface LivePnl {
  pnlUsd: number;     // price move × shares
  pnlAcct: number;    // account currency if sold at `last` now: price move + FX move since the buy + both FX fees
  pct: number;        // pnlAcct ÷ what it cost
  valueAcct: number;  // market value in the account currency
}

/** Live P&L of an open position at `last` (USD), with `fxNow` = account currency per USD right now. */
export function livePnl(p: Position, last: number, fxNow: number): LivePnl {
  const fee = (p.feePct ?? 0) / 100;
  const fxIn = p.fxOpen ?? fxNow;
  const costAcct = p.shares * p.entry * fxIn * (1 + fee);
  const pnlAcct = p.shares * last * fxNow * (1 - fee) - costAcct;
  return { pnlUsd: (last - p.entry) * p.shares, pnlAcct, pct: costAcct ? (pnlAcct / costAcct) * 100 : 0, valueAcct: last * p.shares * fxNow };
}

/** What a position cost in the account currency (incl. the FX fee). */
export function acctCost(p: Position, fallbackFx = 1): number {
  return p.shares * p.entry * (p.fxOpen ?? fallbackFx) * (1 + (p.feePct ?? 0) / 100);
}

export interface JournalState {
  cash: number;
  open: Position[];
  closed: ClosedTrade[];
}

const KEY = 'sf_trade_journal';
const LEGACY_PORTFOLIO = 'sf_portfolio';
const LEGACY_SESSION = 'sf_daytrade_session';

const isReal = (p: { mode?: TradeMode }) => p.mode !== 'paper';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

function read(): JournalState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through to migration */ }
  return migrate();
}

/** One-time import of the old portfolio (cash + holdings) and today's session log. */
function migrate(): JournalState {
  const state: JournalState = { cash: 0, open: [], closed: [] };
  try {
    const pf = JSON.parse(localStorage.getItem(LEGACY_PORTFOLIO) || 'null');
    if (pf) {
      state.cash = Number(pf.cash) || 0;
      for (const h of pf.holdings ?? []) {
        state.open.push({ id: uid(), symbol: h.ticker, shares: h.shares, entry: h.avgBuyPrice, openedAt: h.addedAt ?? new Date().toISOString() });
      }
    }
    const sess = JSON.parse(localStorage.getItem(LEGACY_SESSION) || 'null');
    for (const t of sess?.trades ?? []) {
      state.closed.push({ id: t.id ?? uid(), symbol: t.symbol, shares: 0, entry: 0, exit: null, pnl: t.pnl, openedAt: t.time, closedAt: t.time });
    }
  } catch { /* ignore */ }
  write(state);
  return state;
}

function write(state: JournalState) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

let state: JournalState = read();
const listeners = new Set<() => void>();

function set(next: JournalState) {
  state = next;
  write(next);
  listeners.forEach((l) => l());
}

window.addEventListener('storage', (e) => {
  if (e.key === KEY) { state = read(); listeners.forEach((l) => l()); }
});

export const journal = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },

  setCash(cash: number) { set({ ...state, cash: Math.max(0, cash) }); },

  openPosition(p: Omit<Position, 'id' | 'openedAt'> & { openedAt?: string }) {
    const pos: Position = { ...p, id: uid(), openedAt: p.openedAt ?? new Date().toISOString() };
    set({ ...state, cash: isReal(pos) ? state.cash - acctCost(pos) : state.cash, open: [...state.open, pos] });
    return pos;
  },

  /** Sell `shares` (default: all) of a position at `exit`. Partial sells keep the rest open. */
  closePosition(id: string, exit: number, shares?: number, fxClose?: number) {
    const pos = state.open.find((p) => p.id === id);
    if (!pos) return;
    const qty = Math.min(pos.shares, shares ?? pos.shares);
    const fee = (pos.feePct ?? 0) / 100;
    const fxIn = pos.fxOpen ?? 1;
    const fxOut = fxClose ?? fxIn;
    const proceedsAcct = qty * exit * fxOut * (1 - fee);
    const costAcct = qty * pos.entry * fxIn * (1 + fee);
    const closed: ClosedTrade = {
      ...pos, id: uid(), shares: qty, exit, closedAt: new Date().toISOString(),
      pnl: (exit - pos.entry) * qty, fxClose: fxOut, pnlAcct: proceedsAcct - costAcct,
    };
    const open = qty >= pos.shares
      ? state.open.filter((p) => p.id !== id)
      : state.open.map((p) => (p.id === id ? { ...p, shares: p.shares - qty } : p));
    set({ ...state, cash: isReal(pos) ? state.cash + proceedsAcct : state.cash, open, closed: [...state.closed, closed] });
  },

  /** Quick-log a finished trade by its P&L only (no prices) — still carries the setup context. */
  /** `pnlAcct` is in the account currency; `fx` (account per USD) back-fills the USD figure. */
  logClosed(symbol: string, pnlAcct: number, mode: TradeMode, context?: TradeContext, fx = 1) {
    const now = new Date().toISOString();
    const t: ClosedTrade = {
      id: uid(), symbol, mode, shares: 0, entry: 0, exit: null, pnl: pnlAcct / fx, pnlAcct, fxOpen: fx, fxClose: fx,
      openedAt: now, closedAt: now, context,
    };
    set({ ...state, cash: mode === 'real' ? state.cash + pnlAcct : state.cash, closed: [...state.closed, t] });
  },

  removeClosed(id: string) {
    const t = state.closed.find((c) => c.id === id);
    if (!t) return;
    // Undo the cash effect of a real trade (a closed position returned cost + pnl; a quick log added pnl)
    set({ ...state, cash: isReal(t) ? state.cash - acctPnl(t) : state.cash, closed: state.closed.filter((c) => c.id !== id) });
  },

  /** Undo an open position (entered by mistake) — refunds its cost. */
  removeOpen(id: string) {
    const p = state.open.find((o) => o.id === id);
    if (!p) return;
    set({ ...state, cash: isReal(p) ? state.cash + acctCost(p) : state.cash, open: state.open.filter((o) => o.id !== id) });
  },
};

/** Replace the whole journal (restore from a backup). */
export function importJournal(next: JournalState) {
  if (typeof next?.cash !== 'number' || !Array.isArray(next.open) || !Array.isArray(next.closed)) {
    throw new Error('Not a trade-journal backup');
  }
  set({ cash: next.cash, open: next.open, closed: next.closed });
}

/** Wipe all positions and trade history (keeps cash). */
export function clearJournal() {
  set({ cash: state.cash, open: [], closed: [] });
}

export function useJournal(): JournalState {
  return useSyncExternalStore(journal.subscribe, journal.get);
}

export function todayET(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
