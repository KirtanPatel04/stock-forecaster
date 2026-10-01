import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { stocksApi } from '../api/client';
import { acctPnl, livePnl, journal, todayET, useJournal, type ClosedTrade, type Position, type TradeMode } from '../lib/journal';
import { OrderDialog, type OrderRequest, type OrderResult } from '../components/DayTrade/OrderDialog';
import { DIMENSIONS, bucketize, insights, pnlByPeriod, summarize, weekStart, type Bucket } from '../lib/tradeStats';
import { usePrefs, type PortfolioRange } from '../lib/prefs';
import { useFx } from '../lib/fx';
import { useDaySession } from '../hooks/useDaySession';
import { fmtAcct, riskPlan } from '../lib/rossRules';
import { PnlBarChart } from '../components/Portfolio/PnlBarChart';
import { fmtPrice } from '../lib/rossRules';

const PRICE_MS = 10_000;
type Range = PortfolioRange | 'custom';
const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'Day' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' },
  { key: '7d', label: '7D' }, { key: '30d', label: '30D' }, { key: '90d', label: '90D' },
  { key: 'ytd', label: 'YTD' }, { key: 'all', label: 'All' }, { key: 'custom', label: 'Custom' },
];
const STEPPABLE: Range[] = ['today', 'week', 'month'];

// ET calendar-date helpers (YYYY-MM-DD strings compare correctly as text)
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtDay = (day: string, opts: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

/** [from, to] ET dates (inclusive) for a range; `offset` steps Day/Week/Month back in time. */
function rangeBounds(range: Range, offset: number, custom: { from: string; to: string }): { from: string | null; to: string | null; label: string } {
  const now = todayET();
  switch (range) {
    case 'today': {
      // step back through trading days (skip Sat/Sun)
      let d = now, n = offset;
      while (n > 0) { d = addDays(d, -1); const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) n--; }
      return { from: d, to: d, label: offset === 0 ? 'Today' : fmtDay(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) };
    }
    case 'week': {
      const mon = addDays(weekStart(now), -7 * offset);
      return { from: mon, to: addDays(mon, 6), label: offset === 0 ? 'This week' : `Week of ${fmtDay(mon, { month: 'short', day: 'numeric', year: 'numeric' })}` };
    }
    case 'month': {
      const d = new Date(`${now.slice(0, 7)}-01T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - offset);
      const first = d.toISOString().slice(0, 10);
      const next = new Date(d); next.setUTCMonth(next.getUTCMonth() + 1);
      return { from: first, to: addDays(next.toISOString().slice(0, 10), -1), label: fmtDay(first, { month: 'long', year: 'numeric' }) };
    }
    case '7d': return { from: addDays(now, -6), to: now, label: 'Last 7 days' };
    case '30d': return { from: addDays(now, -29), to: now, label: 'Last 30 days' };
    case '90d': return { from: addDays(now, -89), to: now, label: 'Last 90 days' };
    case 'ytd': return { from: `${now.slice(0, 4)}-01-01`, to: now, label: 'Year to date' };
    case 'custom': return {
      from: custom.from || null, to: custom.to || null,
      label: custom.from === custom.to && custom.from ? fmtDay(custom.from, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
        : `${custom.from ? fmtDay(custom.from, { month: 'short', day: 'numeric', year: 'numeric' }) : '…'} → ${custom.to ? fmtDay(custom.to, { month: 'short', day: 'numeric', year: 'numeric' }) : '…'}`,
    };
    default: return { from: null, to: null, label: 'All time' };
  }
}

type ModeFilter = 'all' | TradeMode;
const modeOf = (p: { mode?: TradeMode }): TradeMode => p.mode ?? 'real';

function ModeBadge({ mode }: { mode?: TradeMode }) {
  return mode === 'paper'
    ? <span className="text-[8px] font-bold px-1 rounded bg-accent/20 text-accent">PAPER</span>
    : <span className="text-[8px] font-bold px-1 rounded bg-green-500/20 text-green-400">REAL</span>;
}

const tone = (n: number) => (n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-gray-300');
const arrow = (n: number) => (n > 0 ? '▲ ' : n < 0 ? '▼ ' : '');

function held(fromIso: string, toIso?: string): string {
  const m = Math.max(0, Math.round(((toIso ? new Date(toIso) : new Date()).getTime() - new Date(fromIso).getTime()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
}

function Tile({ label, value, cls = 'text-white', sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="bg-panel border border-border rounded-lg px-3 py-2">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500">{sub}</div>}
    </div>
  );
}

export function Portfolio() {
  const j = useJournal();
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [pf, setPrefs] = usePrefs();
  const { settings } = useDaySession();
  const { usdcad, live: fxLive } = useFx();
  const plan = useMemo(() => riskPlan(j.cash, settings, null, 0, usdcad), [j.cash, settings, usdcad]);
  const fxNow = plan.fx;
  const signed = (n: number, d = 2) => `${n > 0 ? '+' : ''}${fmtAcct(plan, n, d)}`;
  const cur = (n: number, d = 2) => fmtAcct(plan, n, d);
  const prefix = plan.currency === 'CAD' ? 'C$' : '$';
  const [range, setRangeState] = useState<Range>(pf.portfolioRange);
  const [offset, setOffset] = useState(0);
  const [custom, setCustom] = useState({ from: addDays(todayET(), -29), to: todayET() });
  const modeFilter: ModeFilter = pf.portfolioMode;
  const setModeFilter = (m: ModeFilter) => setPrefs({ portfolioMode: m });
  const setRange = (r: Range) => { setRangeState(r); setOffset(0); };
  const bounds = rangeBounds(range, offset, custom);
  const [order, setOrder] = useState<(OrderRequest & { positionId: string }) | null>(null);
  const [, tick] = useState(0);

  const symbols = useMemo(() => [...new Set(j.open.map((p) => p.symbol))].sort().join(','), [j.open]);

  // Live quotes for everything you hold
  useEffect(() => {
    if (!symbols) return;
    let live = true;
    const load = () => Promise.all(symbols.split(',').map((s) =>
      stocksApi.getPrice(s).then((r) => [s, r.data.price] as const).catch(() => null)))
      .then((res) => {
        if (!live) return;
        setPrices((prev) => ({ ...prev, ...Object.fromEntries(res.filter((x): x is readonly [string, number] => !!x && x[1] > 0)) }));
        tick((t) => t + 1);
      });
    load();
    const id = setInterval(load, PRICE_MS);
    return () => { live = false; clearInterval(id); };
  }, [symbols]);

  const inMode = (p: { mode?: TradeMode }) => modeFilter === 'all' || modeOf(p) === modeFilter;
  const requestSell = (p: Position, last: number | null, shares?: number) => setOrder({
    side: 'sell', symbol: p.symbol, price: last ?? p.entry, shares: shares ?? p.shares, maxShares: p.shares,
    mode: modeOf(p), entry: p.entry, positionId: p.id, fxOpen: p.fxOpen, feePct: p.feePct,
  });
  const confirmSell = (r: OrderResult) => { if (order) journal.closePosition(order.positionId, r.price, r.shares, r.fx); setOrder(null); };

  // Live P&L in the account currency, as if sold now: price move + FX move since you bought, both conversion fees
  const openRows = j.open.filter(inMode).map((p) => {
    const last = prices[p.symbol] ?? null;
    const live = last != null ? livePnl(p, last, fxNow) : null;
    const pnlUsd = live?.pnlUsd ?? 0;
    const pnl = live?.pnlAcct ?? 0;
    return { p, last, pnl, pnlUsd, value: (last ?? p.entry) * p.shares * fxNow };
  });
  const openPnl = openRows.reduce((s, r) => s + r.pnl, 0);

  // Every chart and stat works in the account currency (each trade's own FX in and out)
  const filtered = useMemo<ClosedTrade[]>(() => j.closed.filter((c) => {
    if (modeFilter !== 'all' && modeOf(c) !== modeFilter) return false;
    const day = todayET(new Date(c.closedAt));
    return (!bounds.from || day >= bounds.from) && (!bounds.to || day <= bounds.to);
  }).map((c) => ({ ...c, pnlUsd: c.pnl, pnl: acctPnl(c, fxNow) })), [j.closed, modeFilter, bounds.from, bounds.to, fxNow]);

  // Oldest trade → how far back the arrows can go
  const firstDay = useMemo(() => j.closed.reduce<string | null>((m, c) => {
    const d = todayET(new Date(c.closedAt));
    return !m || d < m ? d : m;
  }, null), [j.closed]);
  const canStepBack = STEPPABLE.includes(range) && !!firstDay && !!bounds.from && bounds.from > firstDay;

  const today = todayET();
  const realizedToday = j.closed.filter((c) => inMode(c) && todayET(new Date(c.closedAt)) === today).reduce((s, c) => s + acctPnl(c, fxNow), 0);
  const realOpenValue = openRows.filter((r) => modeOf(r.p) === 'real').reduce((s, r) => s + r.value, 0);
  const s = summarize(filtered);
  const ins = useMemo(() => insights(filtered, 2, prefix), [filtered, prefix]);
  const spanDays = bounds.from && bounds.to
    ? (new Date(`${bounds.to}T12:00:00Z`).getTime() - new Date(`${bounds.from}T12:00:00Z`).getTime()) / 86_400_000
    : firstDay ? (Date.now() - new Date(`${firstDay}T12:00:00Z`).getTime()) / 86_400_000 : 0;
  const period: 'day' | 'week' = spanDays > 70 ? 'week' : 'day';
  const periodData = useMemo(() => pnlByPeriod(filtered, period), [filtered, period]);
  const drill = (b: Bucket) => {
    setCustom({ from: b.key, to: period === 'week' ? addDays(b.key, 6) : b.key });
    setRangeState('custom');
  };
  const charts = useMemo(() => DIMENSIONS.map((d) => ({ d, data: bucketize(filtered, d) })), [filtered]);

  return (
    <div className="p-4 space-y-4 max-w-[1400px]">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">Portfolio</h1>
          <p className="text-[11px] text-gray-500">Live positions and what your trade history says you do well and badly. Buy and sell from the Day Trade ticket.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">Show</span>
          <div className="flex rounded border border-border overflow-hidden">
            {([['all', 'All'], ['real', '💵 Real money'], ['paper', '📝 Paper']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setModeFilter(k)}
                className={`px-3 py-1 text-[11px] ${modeFilter === k ? 'bg-accent/20 text-accent' : 'text-gray-400 hover:text-gray-200'}`}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Account tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Tile label="Real account value" value={cur(j.cash + (modeFilter === 'paper' ? 0 : realOpenValue))} sub="real cash + real positions at market" />
        <Tile label="Real cash" value={cur(j.cash)}
          sub={plan.currency === 'CAD' ? `1 USD = ${fxNow.toFixed(4)} CAD${fxLive ? ' · live' : ' · last known'}` : 'paper trades never touch this'} />
        <Tile label="Open P&L" value={`${arrow(openPnl)}${signed(openPnl)}`} cls={tone(openPnl)} sub={`${j.open.length} position${j.open.length === 1 ? '' : 's'} · live`} />
        <Tile label="Realized today" value={`${arrow(realizedToday)}${signed(realizedToday)}`} cls={tone(realizedToday)} />
        <Tile label={`Realized · ${bounds.label}`} value={`${arrow(s.total)}${signed(s.total)}`} cls={tone(s.total)} sub={`${s.trades} trades`} />
        <Tile label="Win rate" value={s.trades ? `${Math.round(s.winRate * 100)}%` : '—'} cls={s.trades ? (s.winRate >= 0.5 ? 'text-green-400' : 'text-red-400') : 'text-white'} sub={`${s.wins}W / ${s.losses}L`} />
        <Tile label="Avg win / avg loss" value={s.trades ? `${cur(s.avgWin, 0)} / ${cur(s.avgLoss, 0)}` : '—'}
          cls={s.wins && s.losses ? (s.avgWin >= s.avgLoss ? 'text-green-400' : 'text-red-400') : 'text-white'}
          sub={s.profitFactor != null ? `profit factor ${s.profitFactor.toFixed(2)}` : undefined} />
      </div>

      {/* Live positions */}
      <div className="bg-panel border border-border rounded-lg">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            Open positions
            <span className="flex items-center gap-1 text-[9px] text-gray-500 font-normal"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE · {PRICE_MS / 1000}s</span>
          </h3>
        </div>
        {j.open.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-500">{modeFilter === 'paper' ? 'No open paper positions.' : "You're flat — no open positions."} Open one from the <Link to="/" className="text-accent hover:underline">Day Trade</Link> ticket.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wide text-left">
                {['Symbol', 'Shares', 'Entry', 'Last', 'P&L', 'P&L %', 'Stop', 'Target', 'Held', ''].map((h, i) => (
                  <th key={h + i} className={`font-normal px-3 py-1.5 ${i > 0 && i < 9 ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody style={{ fontVariantNumeric: 'tabular-nums' }}>
              {openRows.map(({ p, last, pnl, pnlUsd }) => {
                const pct = last != null ? ((last - p.entry) / p.entry) * 100 : 0;
                const stopHit = last != null && p.stop != null && last <= p.stop;
                const tgtHit = last != null && p.target != null && last >= p.target;
                return (
                  <tr key={p.id} className="border-t border-border/60">
                    <td className="px-3 py-2 whitespace-nowrap"><ModeBadge mode={p.mode} /> <Link to={`/?symbol=${p.symbol}`} className="font-mono font-semibold text-white hover:text-accent">{p.symbol}</Link></td>
                    <td className="px-3 text-right font-mono text-gray-300">{p.shares.toLocaleString()}</td>
                    <td className="px-3 text-right font-mono text-gray-300">{fmtPrice(p.entry)}</td>
                    <td className="px-3 text-right font-mono text-white">{last != null ? fmtPrice(last) : '…'}</td>
                    <td className={`px-3 text-right font-mono font-semibold ${tone(pnl)}`} title={plan.currency === 'CAD' ? `US$${pnlUsd.toFixed(2)} price move; the rest is FX and fees` : undefined}>
                      {arrow(pnl)}{signed(pnl)}
                      {plan.currency === 'CAD' && <div className="text-[9px] font-normal text-gray-500">US${pnlUsd.toFixed(2)}</div>}
                    </td>
                    <td className={`px-3 text-right font-mono ${tone(pct)}`}>{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</td>
                    <td className={`px-3 text-right font-mono ${stopHit ? 'text-red-400 font-semibold' : 'text-gray-400'}`}>{p.stop != null ? fmtPrice(p.stop) : '—'}{stopHit ? ' HIT' : ''}</td>
                    <td className={`px-3 text-right font-mono ${tgtHit ? 'text-green-400 font-semibold' : 'text-gray-400'}`}>{p.target != null ? fmtPrice(p.target) : '—'}{tgtHit ? ' ✓' : ''}</td>
                    <td className="px-3 text-right text-gray-400">{held(p.openedAt)}</td>
                    <td className="px-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button disabled={p.shares < 2} onClick={() => requestSell(p, last, Math.floor(p.shares / 2))}
                          className="px-2 py-0.5 rounded border border-border text-gray-300 hover:text-white disabled:opacity-40">Sell ½…</button>
                        <button onClick={() => requestSell(p, last)}
                          className="px-2 py-0.5 rounded bg-red-500/80 text-white font-semibold hover:bg-red-500">Sell…</button>
                        <button title="Remove (entered by mistake) — refunds the cost" onClick={() => window.confirm(`Remove ${p.symbol} without recording a trade?`) && journal.removeOpen(p.id)}
                          className="text-gray-600 hover:text-red-400 px-1">×</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* History range — one row, scopes everything below */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-gray-500">History</span>
        <div className="flex rounded border border-border overflow-hidden">
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setRange(r.key)}
              className={`px-2.5 py-1 text-[11px] ${range === r.key ? 'bg-accent/20 text-accent' : 'text-gray-400 hover:text-gray-200'}`}>{r.label}</button>
          ))}
        </div>
        {STEPPABLE.includes(range) && (
          <div className="flex items-center gap-1">
            <button onClick={() => setOffset((o) => o + 1)} disabled={!canStepBack} title="Earlier"
              className="px-2 py-0.5 rounded border border-border text-gray-300 hover:text-white disabled:opacity-30">←</button>
            <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0} title="Later"
              className="px-2 py-0.5 rounded border border-border text-gray-300 hover:text-white disabled:opacity-30">→</button>
            {offset > 0 && <button onClick={() => setOffset(0)} className="text-[10px] text-accent hover:underline">Back to now</button>}
          </div>
        )}
        {range === 'custom' && (
          <div className="flex items-center gap-1 text-[11px]">
            <input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              className="bg-surface border border-border rounded px-1.5 py-0.5 text-gray-200 [color-scheme:dark]" />
            <span className="text-gray-500">→</span>
            <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              className="bg-surface border border-border rounded px-1.5 py-0.5 text-gray-200 [color-scheme:dark]" />
          </div>
        )}
        <span className="text-[11px] text-white font-semibold">{bounds.label}</span>
        <span className="text-[10px] text-gray-600">
          {filtered.length} closed trade{filtered.length === 1 ? '' : 's'}{firstDay ? ` · history since ${fmtDay(firstDay, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-panel border border-border rounded-lg p-6 text-center text-sm text-gray-400">
          No closed trades in this range yet. Every trade you buy and sell from the Day Trade ticket is recorded with the setup at entry, so these charts can show when and how you make and lose money.
        </div>
      ) : (
        <>
          {/* Doing well / costing you */}
          <div className="grid md:grid-cols-2 gap-3">
            <div className="bg-panel border border-green-500/30 rounded-lg p-3">
              <h3 className="text-sm font-semibold text-green-400 mb-2">▲ What you're doing well</h3>
              {ins.good.length === 0 ? <p className="text-[11px] text-gray-500">Not enough winning patterns yet (needs 2+ trades in a slice).</p> : (
                <ul className="space-y-1.5">{ins.good.map((i) => <li key={i.text} className="text-[12px] text-gray-200"><span className="text-green-400">▲</span> {i.text}</li>)}</ul>
              )}
            </div>
            <div className="bg-panel border border-red-500/30 rounded-lg p-3">
              <h3 className="text-sm font-semibold text-red-400 mb-2">▼ What's costing you</h3>
              {ins.bad.length === 0 ? <p className="text-[11px] text-gray-500">No losing patterns yet — keep it that way.</p> : (
                <ul className="space-y-1.5">{ins.bad.map((i) => <li key={i.text} className="text-[12px] text-gray-200"><span className="text-red-400">▼</span> {i.text}</li>)}</ul>
              )}
            </div>
          </div>

          <PnlBarChart prefix={prefix} title={period === 'week' ? 'Weekly P&L' : 'Daily P&L'}
            subtitle={`Realized profit and loss per ${period} · ${bounds.label}`} data={periodData} height={170}
            onBarClick={drill} clickHint={`Click a bar to see just that ${period}.`} />

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {charts.map(({ d, data }) => <PnlBarChart key={d.id} prefix={prefix} title={d.title} subtitle={d.subtitle} data={data} />)}
          </div>

          {/* Trade history */}
          <div className="bg-panel border border-border rounded-lg">
            <h3 className="px-3 py-2 text-sm font-semibold text-white border-b border-border">Trade history</h3>
            <div className="max-h-[360px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-panel">
                  <tr className="text-[10px] text-gray-500 uppercase tracking-wide text-left">
                    {['Closed', 'Symbol', 'Shares', 'Entry', 'Exit', 'Held', 'Grade', 'Verdict', 'Setup', 'P&L', ''].map((h, i) => (
                      <th key={h + i} className={`font-normal px-3 py-1.5 ${[2, 3, 4, 9].includes(i) ? 'text-right' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {[...filtered].sort((a, b) => b.closedAt.localeCompare(a.closedAt)).map((t) => (
                    <tr key={t.id} className="border-t border-border/60 group">
                      <td className="px-3 py-1.5 text-gray-400">{new Date(t.closedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                      <td className="px-3 font-mono text-white whitespace-nowrap"><ModeBadge mode={t.mode} /> {t.symbol}</td>
                      <td className="px-3 text-right font-mono text-gray-300">{t.shares || '—'}</td>
                      <td className="px-3 text-right font-mono text-gray-300">{t.entry ? fmtPrice(t.entry) : '—'}</td>
                      <td className="px-3 text-right font-mono text-gray-300">{t.exit != null ? fmtPrice(t.exit) : '—'}</td>
                      <td className="px-3 text-gray-400">{t.exit != null ? held(t.openedAt, t.closedAt) : '—'}</td>
                      <td className="px-3 text-gray-300">{t.context?.grade ?? '—'}</td>
                      <td className="px-3 text-gray-300">{t.context?.verdict ?? '—'}</td>
                      <td className="px-3 text-gray-400">{t.context?.setupState ?? '—'}</td>
                      <td className={`px-3 text-right font-mono font-semibold ${tone(t.pnl)}`}>{arrow(t.pnl)}{signed(t.pnl)}</td>
                      <td className="px-3 text-right">
                        <button onClick={() => window.confirm('Delete this trade from your journal?') && journal.removeClosed(t.id)}
                          className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      <OrderDialog order={order} plan={plan} onConfirm={confirmSell} onCancel={() => setOrder(null)} />
    </div>
  );
}
