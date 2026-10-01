/** Trade-journal analytics — where you make money and where you lose it. */
import type { ClosedTrade } from './journal';

export interface Bucket {
  key: string;
  label: string;
  pnl: number;
  trades: number;
  wins: number;
}

export interface Dimension {
  id: string;
  title: string;        // chart title — the question it answers
  subtitle: string;
  noun: string;         // used in insight sentences, e.g. "Entries 9:30–10"
  order?: string[];     // fixed category order (ordinal dims)
  get: (t: ClosedTrade) => string | null;
}

const etParts = (iso: string) => {
  const d = new Date(iso);
  const [h, m] = d.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  const wd = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return { mins: h * 60 + m, wd };
};

const hasPrices = (t: ClosedTrade) => t.exit != null && t.entry > 0;

export const DIMENSIONS: Dimension[] = [
  {
    id: 'time', title: 'When do you make money?', subtitle: 'P&L by entry time (ET)', noun: 'Entries at',
    order: ['Pre 4–7', '7–8', '8–9', '9–9:30', '9:30–10', '10–11', '11–12', '12–4', 'After 4'],
    get: (t) => {
      const { mins } = etParts(t.openedAt);
      if (mins < 7 * 60) return 'Pre 4–7';
      if (mins < 8 * 60) return '7–8';
      if (mins < 9 * 60) return '8–9';
      if (mins < 9 * 60 + 30) return '9–9:30';
      if (mins < 10 * 60) return '9:30–10';
      if (mins < 11 * 60) return '10–11';
      if (mins < 12 * 60) return '11–12';
      if (mins < 16 * 60) return '12–4';
      return 'After 4';
    },
  },
  {
    id: 'weekday', title: 'Best and worst days', subtitle: 'P&L by day of week', noun: 'Trading on',
    order: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    get: (t) => etParts(t.openedAt).wd,
  },
  {
    id: 'hold', title: 'How long you hold', subtitle: 'P&L by time in the trade', noun: 'Holding',
    order: ['< 5 min', '5–15 min', '15–30 min', '30–60 min', '60+ min'],
    get: (t) => {
      if (!hasPrices(t)) return null;
      const m = (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 60000;
      return m < 5 ? '< 5 min' : m < 15 ? '5–15 min' : m < 30 ? '15–30 min' : m < 60 ? '30–60 min' : '60+ min';
    },
  },
  {
    id: 'verdict', title: 'Following the signal', subtitle: "P&L by the app's verdict when you entered", noun: 'Trades the app marked',
    order: ['BUY', 'READY', 'WAIT', 'PASS'],
    get: (t) => t.context?.verdict ?? null,
  },
  {
    id: 'grade', title: 'Stock quality', subtitle: 'P&L by Five-Pillars grade', noun: 'Grade',
    order: ['A+', 'A', 'B', 'C'],
    get: (t) => t.context?.grade ?? null,
  },
  {
    id: 'setup', title: 'Entry timing', subtitle: 'P&L by chart pattern at entry', noun: 'Buying when the setup was',
    order: ['triggered', 'pullback', 'extended', 'stale', 'broken', 'none'],
    get: (t) => t.context?.setupState ?? null,
  },
  {
    id: 'price', title: 'Price range', subtitle: 'P&L by share price at entry', noun: 'Stocks priced',
    order: ['< $2', '$2–5', '$5–10', '$10–20', '$20+'],
    get: (t) => {
      const p = t.entry > 0 ? t.entry : null;
      if (p == null) return null;
      return p < 2 ? '< $2' : p < 5 ? '$2–5' : p < 10 ? '$5–10' : p < 20 ? '$10–20' : '$20+';
    },
  },
  {
    id: 'float', title: 'Float size', subtitle: 'P&L by shares available to trade', noun: 'Float',
    order: ['< 5M', '5–10M', '10–20M', '20M+'],
    get: (t) => {
      const f = t.context?.floatShares;
      if (f == null) return null;
      return f < 5e6 ? '< 5M' : f < 10e6 ? '5–10M' : f < 20e6 ? '10–20M' : '20M+';
    },
  },
  {
    id: 'news', title: 'Catalyst', subtitle: 'P&L with vs without fresh news', noun: 'Stocks with',
    order: ['Fresh news', 'No news'],
    get: (t) => (t.context?.hasNews == null ? null : t.context.hasNews ? 'Fresh news' : 'No news'),
  },
  {
    id: 'market', title: 'Market temperature', subtitle: 'P&L in hot / warm / cold markets', noun: 'Trading in a',
    order: ['hot', 'warm', 'cold'],
    get: (t) => t.context?.temperature ?? null,
  },
  {
    id: 'sector', title: 'Which kinds of stocks', subtitle: 'P&L by sector', noun: 'Sector:',
    get: (t) => t.context?.sector ?? (t.context ? 'Unknown' : null),
  },
  {
    id: 'symbol', title: 'Your tickers', subtitle: 'P&L by stock', noun: 'Trading',
    get: (t) => t.symbol,
  },
];

export function bucketize(trades: ClosedTrade[], dim: Dimension, maxNominal = 8): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const t of trades) {
    const key = dim.get(t);
    if (key == null) continue;
    const b = map.get(key) ?? { key, label: key, pnl: 0, trades: 0, wins: 0 };
    b.pnl += t.pnl;
    b.trades += 1;
    if (t.pnl > 0) b.wins += 1;
    map.set(key, b);
  }
  let out = [...map.values()];
  if (dim.order) {
    out.sort((a, b) => dim.order!.indexOf(a.key) - dim.order!.indexOf(b.key));
  } else {
    // Nominal: biggest impact first, fold the tail into "Other"
    out.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    if (out.length > maxNominal) {
      const tail = out.slice(maxNominal - 1);
      out = [...out.slice(0, maxNominal - 1), tail.reduce((o, b) => ({ ...o, pnl: o.pnl + b.pnl, trades: o.trades + b.trades, wins: o.wins + b.wins }),
        { key: 'Other', label: 'Other', pnl: 0, trades: 0, wins: 0 })];
    }
  }
  return out;
}

const etDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Monday (YYYY-MM-DD) of the week containing an ET date string. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Realized P&L per day (or per week for long ranges), oldest → newest, over every period that
 * had trades. Bucket keys are ET dates (the week's Monday for weekly buckets), so a click can
 * drill into exactly that day or week.
 */
export function pnlByPeriod(trades: ClosedTrade[], period: 'day' | 'week'): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const t of trades) {
    const day = etDay(t.closedAt);
    const key = period === 'day' ? day : weekStart(day);
    const b = map.get(key) ?? {
      key, pnl: 0, trades: 0, wins: 0,
      label: (period === 'week' ? 'Wk ' : '') + new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
    };
    b.pnl += t.pnl;
    b.trades += 1;
    if (t.pnl > 0) b.wins += 1;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface Summary {
  total: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;       // positive number
  profitFactor: number | null;
  best: number;
  worst: number;
}

export function summarize(trades: ClosedTrade[]): Summary {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  return {
    total: grossWin - grossLoss,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    best: trades.length ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worst: trades.length ? Math.min(...trades.map((t) => t.pnl)) : 0,
  };
}

export interface Insight {
  tone: 'good' | 'bad';
  text: string;
  pnl: number;
}

const money = (n: number, prefix: string) => `${n < 0 ? '-' : '+'}${prefix}${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Plain-English strengths and leaks, strongest first. Needs ≥ `minTrades` in a slice to call it a pattern. */
export function insights(trades: ClosedTrade[], minTrades = 2, prefix = '$'): { good: Insight[]; bad: Insight[] } {
  const usd = (n: number) => money(n, prefix);
  const good: Insight[] = [];
  const bad: Insight[] = [];
  for (const dim of DIMENSIONS.filter((d) => d.id !== 'symbol')) {
    for (const b of bucketize(trades, dim)) {
      if (b.trades < minTrades || b.key === 'Other') continue;
      const wr = Math.round((b.wins / b.trades) * 100);
      const text = `${dim.noun} ${b.label}: ${usd(b.pnl)} over ${b.trades} trades (${wr}% winners)`;
      if (b.pnl > 0 && wr >= 50) good.push({ tone: 'good', text, pnl: b.pnl });
      else if (b.pnl < 0) bad.push({ tone: 'bad', text, pnl: b.pnl });
    }
  }

  const s = summarize(trades);
  if (s.wins >= 2 && s.losses >= 2) {
    if (s.avgLoss > s.avgWin) {
      bad.push({ tone: 'bad', pnl: -(s.avgLoss - s.avgWin) * s.losses,
        text: `Average loss (${prefix}${s.avgLoss.toFixed(0)}) is bigger than average win (${prefix}${s.avgWin.toFixed(0)}) — cut losers at the stop; aim for 2:1` });
    } else if (s.avgWin >= 2 * s.avgLoss) {
      good.push({ tone: 'good', pnl: (s.avgWin - s.avgLoss) * s.wins,
        text: `Winners average ${(s.avgWin / Math.max(s.avgLoss, 0.01)).toFixed(1)}× your losers — that's the 2:1 discipline Ross preaches` });
    }
  }
  const byDay = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const k = new Date(t.closedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    byDay.set(k, [...(byDay.get(k) ?? []), t]);
  }
  let overtrade = 0;
  for (const day of byDay.values()) {
    const sorted = [...day].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
    let peak = 0, run = 0, lateLoss = 0;
    for (const t of sorted) {
      run += t.pnl;
      if (peak > 0 && run < peak / 2 && t.pnl < 0) lateLoss += t.pnl;
      peak = Math.max(peak, run);
    }
    overtrade += lateLoss;
  }
  if (overtrade < 0) {
    bad.push({ tone: 'bad', pnl: overtrade,
      text: `${usd(overtrade)} lost after giving back half the day's profit — that's his walk-away signal` });
  }

  good.sort((a, b) => b.pnl - a.pnl);
  bad.sort((a, b) => a.pnl - b.pnl);
  return { good: good.slice(0, 6), bad: bad.slice(0, 6) };
}
