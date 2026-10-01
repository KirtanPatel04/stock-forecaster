import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Layout } from 'react-grid-layout';
import { WidgetGrid, type WidgetDef } from '../components/Layout/WidgetGrid';
import { Link, useSearchParams } from 'react-router-dom';
import { daytradeApi } from '../api/client';
import type { DayTradeCandidate, DayTradeScan, IntradayBar, LiveQuote } from '../types/daytrade';
import { contextFor, fmtAcct, gamePlan, levelsFor, profileFor, riskPlan, sessionStatus, targetsFor, verdict, fmtPrice, fmtShares, type Levels } from '../lib/rossRules';
import { VerdictChip } from '../components/DayTrade/Verdict';
import { usePortfolio } from '../hooks/usePortfolio';
import { useDaySession } from '../hooks/useDaySession';
import { usePinnedWatchlist } from '../hooks/usePinnedWatchlist';
import { acctCost, acctPnl, journal, livePnl, todayET, useJournal, type Position, type TradeMode } from '../lib/journal';
import { PositionsBar } from '../components/DayTrade/PositionsBar';
import type { ChartLine } from '../components/DayTrade/DayTradeChart';
import { useFx } from '../lib/fx';
import { analyzeSetup } from '../lib/liveSetup';
import { alerts } from '../lib/alerts';
import { prefs } from '../lib/prefs';
import { ScannerList, GRADE_STYLE, PillarDots } from '../components/DayTrade/ScannerList';
import { SetupPanel } from '../components/DayTrade/SetupPanel';
import { TradeTicket } from '../components/DayTrade/TradeTicket';
import { OrderDialog, type OrderRequest, type OrderResult } from '../components/DayTrade/OrderDialog';
import { GoalSetupDialog } from '../components/DayTrade/GoalSetupDialog';
import { DayTradeChart } from '../components/DayTrade/DayTradeChart';

const SCAN_MS = 30_000;

// Default Webull-style arrangement on a 24 × 40 grid: scanner | chart + positions + setup | account & ticket
const DAYTRADE_LAYOUT: Layout[] = [
  { i: 'scanner', x: 0, y: 0, w: 6, h: 40 },
  { i: 'chart', x: 6, y: 0, w: 12, h: 23 },
  { i: 'positions', x: 6, y: 23, w: 12, h: 6 },
  { i: 'pillars', x: 6, y: 29, w: 4, h: 11 },
  { i: 'pullback', x: 10, y: 29, w: 4, h: 11 },
  { i: 'catalyst', x: 14, y: 29, w: 4, h: 11 },
  { i: 'account', x: 18, y: 0, w: 6, h: 9 },
  { i: 'guard', x: 18, y: 9, w: 6, h: 6 },
  { i: 'order', x: 18, y: 15, w: 6, h: 17 },
  { i: 'trades', x: 18, y: 32, w: 6, h: 8 },
];
const BARS_MS = 5_000;          // chart + live levels while you're looking at it
const BARS_HIDDEN_MS = 30_000;  // slower in the background
const LIVE_MS = 5_000;          // every scanner row's price, levels and share size

/**
 * Stays mounted while you visit other pages (see App.tsx) so the scan, chart and your selection keep
 * running. `active` = this page is on screen. The selected stock only changes when you pick one —
 * new BUY/READY setups raise an alert instead of switching the view.
 */
export function DayTrade({ active = true }: { active?: boolean }) {
  const [params, setParams] = useSearchParams();
  const urlSymbol = active ? params.get('symbol')?.toUpperCase() ?? null : null;
  const [selected, setSelected] = useState<string | null>(urlSymbol);
  const [freshSetups, setFreshSetups] = useState<{ symbol: string; label: string }[]>([]);
  const seenRef = useRef<Set<string> | null>(null);

  const [rawScan, setScan] = useState<DayTradeScan | null>(null);
  const [liveMap, setLiveMap] = useState<Record<string, LiveQuote>>({});
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<DayTradeCandidate | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [bars, setBars] = useState<IntradayBar[]>([]);
  const [barsAt, setBarsAt] = useState<number | null>(null);
  const [override, setOverride] = useState<{ symbol: string; levels: Levels } | null>(null);
  const [search, setSearch] = useState('');

  const { portfolio, setCash } = usePortfolio();
  const j = useJournal();
  const { usdcad } = useFx();
  const openCost = useMemo(() => j.open.filter((p) => p.mode !== 'paper').reduce((sum, p) => sum + acctCost(p, usdcad), 0), [j.open, usdcad]);
  const { trades, logTrade, removeTrade, resetSession, settings, setSettings } = useDaySession();
  const { symbols: pinnedSymbols } = usePinnedWatchlist();
  const [pinnedExtra, setPinnedExtra] = useState<DayTradeCandidate[]>([]);
  const [order, setOrder] = useState<(OrderRequest & { positionId?: string }) | null>(null);
  const [planOpen, setPlanOpen] = useState(false);

  // Every scanner stock re-priced every 5s: live price, change %, and entry / stop / 2:1 target —
  // so the suggested share size on each row follows the live price between full scans.
  const liveSymbols = useMemo(
    () => [...new Set([...pinnedSymbols, ...(rawScan?.candidates.map((c) => c.symbol) ?? [])])].slice(0, 40).join(','),
    [rawScan, pinnedSymbols],
  );
  useEffect(() => {
    if (!liveSymbols) return;
    let live = true;
    const load = () => daytradeApi.getLive(liveSymbols.split(',')).then((r) => live && setLiveMap((m) => ({ ...m, ...r.data }))).catch(() => {});
    load();
    const id = setInterval(load, active ? LIVE_MS : BARS_HIDDEN_MS);
    return () => { live = false; clearInterval(id); };
  }, [liveSymbols, active]);
  const withLive = useCallback((c: DayTradeCandidate): DayTradeCandidate => {
    const q = liveMap[c.symbol];
    if (!q) return c;
    return { ...c, price: q.price, change_pct: c.prev_close ? (q.price / c.prev_close - 1) * 100 : c.change_pct, setup: q.setup };
  }, [liveMap]);
  const scan = useMemo<DayTradeScan | null>(
    () => rawScan && { ...rawScan, candidates: rawScan.candidates.map(withLive) },
    [rawScan, withLive],
  );

  const loadScan = useCallback(async () => {
    setScanLoading(true);
    try {
      const res = await daytradeApi.scan(30);
      setScan(res.data);
      setScanError(null);
    } catch {
      setScanError('Scan failed — is the backend running on :8000?');
    } finally {
      setScanLoading(false);
    }
  }, []);

  // Refresh every 15s in Ross's 7–10 AM window, 30s otherwise
  const scanEvery = scan?.window.key === 'prime' ? 15_000 : SCAN_MS;
  useEffect(() => {
    loadScan();
    const id = setInterval(loadScan, scanEvery);
    return () => clearInterval(id);
  }, [loadScan, scanEvery]);

  // A symbol in the URL (market rail, portfolio link) selects it
  useEffect(() => {
    if (urlSymbol && urlSymbol !== selected) { setOverride(null); setSelected(urlSymbol); }
  }, [urlSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // First load: start on the most obvious stock
  useEffect(() => {
    if (!selected && scan?.candidates.length) setSelected(scan.candidates[0].symbol);
  }, [selected, scan]);

  // Keep the URL in step with the selection while this page is on screen
  useEffect(() => {
    if (active && selected && urlSymbol !== selected) setParams({ symbol: selected }, { replace: true });
  }, [active, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (active) alerts.clear('daytrade'); }, [active]);

  const fromScan = scan?.candidates.find((c) => c.symbol === selected) ?? null;

  // Starred names from last night's watchlist that aren't on the live scanner — evaluate them individually
  const missingPins = pinnedSymbols.filter((sym) => !scan?.candidates.some((c) => c.symbol === sym)).join(',');
  useEffect(() => {
    if (!missingPins) { setPinnedExtra([]); return; }
    let live = true;
    const load = () => Promise.all(missingPins.split(',').map((sym) => daytradeApi.getStock(sym).then((r) => r.data).catch(() => null)))
      .then((res) => live && setPinnedExtra(res.filter((c): c is DayTradeCandidate => c !== null)));
    load();
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, [missingPins]);
  const pinned = useMemo(
    () => pinnedSymbols
      .map((sym) => scan?.candidates.find((c) => c.symbol === sym) ?? (() => { const x = pinnedExtra.find((c) => c.symbol === sym); return x && withLive(x); })())
      .filter((c): c is DayTradeCandidate => !!c),
    [pinnedSymbols, scan, pinnedExtra, withLive],
  );

  // Stocks not on the scanner (rail clicks, search) are evaluated on their own
  useEffect(() => {
    setLookup(null);
    setLookupError(null);
    if (!selected || fromScan) return;
    let live = true;
    const load = () => daytradeApi.getStock(selected)
      .then((r) => live && setLookup(r.data))
      .catch(() => live && setLookupError(`No US equity data for ${selected}`));
    load();
    const id = setInterval(load, SCAN_MS);
    return () => { live = false; clearInterval(id); };
  }, [selected, !!fromScan]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBars([]);
    if (!selected) return;
    let live = true;
    const load = () => daytradeApi.getBars(selected).then((r) => { if (live) { setBars(r.data); setBarsAt(Date.now()); } }).catch(() => {});
    load();
    const id = setInterval(load, active ? BARS_MS : BARS_HIDDEN_MS);
    return () => { live = false; clearInterval(id); };
  }, [selected, active]);

  const scanned = fromScan ?? pinnedExtra.find((c) => c.symbol === selected) ?? lookup;
  // Re-run the first-pullback analysis on every chart update so entry / stop / 2:1 target move with price
  const liveSetup = useMemo(() => analyzeSetup(bars), [bars]);
  const candidate = useMemo(
    () => (scanned && liveSetup && scanned.symbol === selected
      ? { ...scanned, price: bars[bars.length - 1].close, setup: liveSetup }
      : scanned),
    [scanned, liveSetup, selected], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const plan = useMemo(() => riskPlan(portfolio.cash, settings, scan?.temperature, openCost, usdcad), [portfolio.cash, settings, scan?.temperature, openCost, usdcad]);
  const status = useMemo(() => sessionStatus(trades, plan, scan?.window), [trades, plan, scan?.window]);
  const autoLevels = useMemo(() => (candidate ? levelsFor(candidate) : null), [candidate]);
  const levels = override?.symbol === selected ? override.levels : autoLevels;
  const targets = useMemo(() => (candidate && levels ? targetsFor(candidate, levels) : []), [candidate, levels]);
  const v = useMemo(
    () => (candidate ? verdict(candidate, levels, plan, status, scan?.window, scan?.temperature) : null),
    [candidate, levels, plan, status, scan?.window, scan?.temperature],
  );

  // New BUY / READY setups since the last scan → alert (banner here, navbar badge + desktop notification elsewhere)
  useEffect(() => {
    if (!scan) return;
    const actionable = scan.candidates
      .map((c) => ({ symbol: c.symbol, label: verdict(c, levelsFor(c), plan, status, scan.window, scan.temperature).action }))
      .filter((a) => a.label === 'BUY' || a.label === 'READY');
    if (seenRef.current === null) { seenRef.current = new Set(actionable.map((a) => a.symbol)); return; }
    const fresh = actionable.filter((a) => !seenRef.current!.has(a.symbol));
    seenRef.current = new Set(actionable.map((a) => a.symbol));   // a name that drops off and comes back alerts again
    if (!fresh.length) return;
    setFreshSetups((prev) => [...fresh, ...prev.filter((p) => !fresh.some((f) => f.symbol === p.symbol))].slice(0, 4));
    if (!active && prefs.get().alertNewSetups) alerts.push('daytrade', fresh, 'New day-trade setup');
  }, [scan]); // eslint-disable-line react-hooks/exhaustive-deps

  // Today's game plan: the best stocks for your goal, from the live scan + your starred names
  const game = useMemo(() => {
    if (!scan) return null;
    const pool = [...pinned, ...scan.candidates.filter((c) => !pinned.some((p) => p.symbol === c.symbol))];
    return gamePlan(pool, plan, status, scan.window, scan.temperature);
  }, [scan, pinned, plan, status]);

  // When the prime window opens (7:00 pre-market) and at the 9:30 open, push today's picks
  const phaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scan || !game) return;
    const phase = scan.window.key === 'prime' ? scan.window.label : scan.window.key;
    const prev = phaseRef.current;
    phaseRef.current = phase;
    if (prev === null || prev === phase || scan.window.key !== 'prime') return;
    if (!prefs.get().alertMarketOpen || !game.picks.length) return;
    const picks = game.picks.slice(0, plan.tradesPerGoal).map((p) => ({ symbol: p.c.symbol, label: `${p.v.action} · +$${Math.round(p.pays)}` }));
    const title = phase.includes('open') ? 'Market open — your picks to hit today\'s goal' : 'Prime window open — your picks for today';
    setFreshSetups((prev2) => [...picks, ...prev2.filter((x) => !picks.some((p) => p.symbol === x.symbol))].slice(0, 4));
    alerts.push('daytrade', picks, title);
  }, [scan]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastPrice = bars.length ? bars[bars.length - 1].close : candidate?.price ?? null;

  const requestSell = (pos: Position, shares?: number, price?: number) => setOrder({
    side: 'sell', symbol: pos.symbol, price: price ?? (pos.symbol === selected ? lastPrice : null) ?? pos.entry, shares: shares ?? pos.shares, maxShares: pos.shares,
    mode: pos.mode ?? 'real', entry: pos.entry, positionId: pos.id, fxOpen: pos.fxOpen, feePct: pos.feePct,
  });

  // Your position in the stock on the chart, marked to the live price
  const heldHere = j.open.filter((p) => p.symbol === selected);
  const heldShares = heldHere.reduce((s, p) => s + p.shares, 0);
  const heldPnl = lastPrice != null ? heldHere.reduce((s, p) => s + livePnl(p, lastPrice, plan.fx).pnlAcct, 0) : 0;
  const positionLines = useMemo<ChartLine[]>(() => heldHere.map((p) => ({
    price: p.entry,
    color: '#e5e7eb',
    title: `Avg ${p.shares}${lastPrice != null ? ` ${livePnl(p, lastPrice, plan.fx).pnlAcct >= 0 ? '+' : ''}${fmtAcct(plan, livePnl(p, lastPrice, plan.fx).pnlAcct, 0)}` : ''}`,
  })), [heldHere.map((p) => p.id + p.shares).join(), lastPrice, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const realizedTodayReal = useMemo(() => {
    const today = todayET();
    return j.closed.filter((t) => t.mode !== 'paper' && todayET(new Date(t.closedAt)) === today).reduce((s, t) => s + acctPnl(t, plan.fx), 0);
  }, [j.closed, plan.fx]);

  const confirmOrder = (r: OrderResult) => {
    if (!order) return;
    if (order.side === 'buy' && candidate) {
      journal.openPosition({
        symbol: order.symbol, mode: r.mode, shares: r.shares, entry: r.price, stop: r.stop, target: r.target,
        fxOpen: r.fx, feePct: plan.fee * 100,
        context: contextFor(candidate, v, scan?.window, scan?.temperature),
      });
    } else if (order.side === 'sell' && order.positionId) {
      journal.closePosition(order.positionId, r.price, r.shares, r.fx);
    }
    setOrder(null);
  };

  const select = (sym: string) => {
    setOverride(null);
    setSelected(sym);
    setFreshSetups((prev) => prev.filter((p) => p.symbol !== sym));
  };

  const ticketProps = {
    candidate, levels, targets, verdict: v, plan, status, trades, settings,
    profile: candidate ? profileFor(candidate) : null,
    onLevelsChange: (l: Levels) => { if (selected) setOverride({ symbol: selected, levels: { ...l, manual: true } }); },
    onUseLiveLevels: () => setOverride(null),
    liveUpdatedAt: liveSetup ? barsAt : null,
    cash: portfolio.cash,
    onEditPlan: () => setPlanOpen(true),
    onLogTrade: (sym: string, pnl: number, mode: TradeMode) => logTrade(sym, pnl, mode, candidate ? contextFor(candidate, v, scan?.window, scan?.temperature) : undefined),
    positions: j.open.filter((pos) => pos.symbol === selected),
    lastPrice,
    onRequestBuy: (shares: number) => { if (candidate && levels) setOrder({ side: 'buy', symbol: candidate.symbol, price: levels.entry, shares, stop: levels.stop }); },
    onRequestSell: requestSell,
    onRemoveTrade: removeTrade,
    onResetSession: resetSession,
  };
  const needStock = (node: ReactNode) => candidate ? node : <p className="p-3 text-xs text-gray-500">Select a stock from the scanner.</p>;

  const widgets: WidgetDef[] = [
    {
      id: 'scanner', title: 'Scanner', minW: 4, minH: 8,
      render: () => (
        <ScannerList scan={scan} loading={scanLoading} error={scanError} plan={plan} status={status}
          selected={selected} pinned={pinned} game={game} onSelect={select} onRefresh={loadScan} />
      ),
    },
    {
      id: 'chart', title: 'Chart', minW: 6, minH: 8,
      render: () => (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-panel flex-wrap">
            <form onSubmit={(e) => { e.preventDefault(); if (search.trim()) { select(search.trim().toUpperCase()); setSearch(''); } }}>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Symbol…"
                className="w-24 bg-surface border border-border rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-accent" />
            </form>
            {candidate ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className={`text-[10px] font-bold px-1 rounded ${GRADE_STYLE[candidate.grade]}`}>{candidate.grade}</span>
                  <span className="text-lg font-semibold font-mono text-white">{candidate.symbol}</span>
                  <span className="text-xs text-gray-500 truncate max-w-[180px]">{candidate.name}</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-mono text-white">{fmtPrice(candidate.price)}</span>
                  <span className={`text-sm font-mono font-semibold ${candidate.change_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {candidate.change_pct >= 0 ? '+' : ''}{candidate.change_pct.toFixed(2)}%
                  </span>
                </div>
                {heldShares > 0 && (
                  <span className={`text-[11px] font-mono px-2 py-0.5 rounded border whitespace-nowrap flex-shrink-0 ${heldPnl >= 0 ? 'border-green-500/40 text-green-400 bg-green-500/10' : 'border-red-500/40 text-red-400 bg-red-500/10'}`}
                    title="Your position in this stock, marked to the live price">
                    Long {heldShares.toLocaleString()} · {heldPnl >= 0 ? '▲ +' : '▼ '}{fmtAcct(plan, heldPnl, 2)}
                  </span>
                )}
                {v && <span title={v.headline}><VerdictChip action={v.action} size="md" /></span>}
                <PillarDots c={candidate} />
                <div className="hidden 2xl:flex gap-4 text-[10px] text-gray-500 ml-auto">
                  <span>Vol <span className="text-gray-300 font-mono">{fmtShares(candidate.volume)}</span></span>
                  <span>RVol <span className="text-gray-300 font-mono">{candidate.rel_volume?.toFixed(1) ?? '—'}x</span></span>
                  <span>Float <span className="text-gray-300 font-mono">{fmtShares(candidate.float_shares)}</span></span>
                </div>
              </>
            ) : (
              <span className="text-xs text-gray-500">{lookupError ?? (selected ? `Loading ${selected}…` : 'Waiting for scan…')}</span>
            )}
          </div>
          {freshSetups.length > 0 && (
            <div className="px-4 py-1.5 bg-green-500/10 border-b border-green-500/30 text-[11px] text-green-300 flex items-center gap-2 flex-wrap">
              <span className="font-semibold">New setup{freshSetups.length > 1 ? 's' : ''}:</span>
              {freshSetups.map((f) => (
                <button key={f.symbol} onClick={() => select(f.symbol)}
                  className="px-1.5 py-0.5 rounded bg-green-500/20 hover:bg-green-500/30 font-mono">
                  {f.symbol} · {f.label} →
                </button>
              ))}
              <button onClick={() => setFreshSetups([])} className="ml-auto text-gray-500 hover:text-gray-300">Dismiss</button>
            </div>
          )}
          {scan && (scan.window.key === 'off' || scan.window.key === 'closed') && (
            <div className="px-4 py-1.5 bg-violet-500/10 border-b border-violet-500/30 text-[11px] text-violet-300 flex items-center gap-2">
              <span>{scan.window.label}.</span>
              <Link to="/watchlist" className="underline font-semibold">Build tomorrow's watchlist from after-hours movers →</Link>
            </div>
          )}
          <div className="flex-1 min-h-0 relative">
            {selected && <DayTradeChart symbol={selected} bars={bars} levels={levels} hod={candidate?.setup.hod} lines={positionLines} />}
            {selected && bars.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 pointer-events-none">Loading 1-minute chart…</div>
            )}
            <div className="absolute top-2 left-3 flex gap-3 text-[10px] pointer-events-none">
              <span className="text-gray-500">1m · ET · incl. pre-market</span>
              <span className="text-amber-400">— VWAP</span>
              <span className="text-violet-400">— 9 EMA</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'positions', title: 'Positions', minW: 6, minH: 3,
      render: () => j.open.length
        ? <PositionsBar fill positions={j.open} plan={plan} selected={selected} selectedLast={lastPrice}
            realizedToday={realizedTodayReal} onSelect={select} onSell={(pos, last, shares) => requestSell(pos, shares, last)} />
        : <p className="px-4 py-2 text-xs text-gray-500">No open positions — buy from the Order ticket and they'll show here, marked to the live price.</p>,
    },
    { id: 'pillars', title: 'Five Pillars', render: () => needStock(candidate && <SetupPanel c={candidate} only="pillars" />) },
    { id: 'pullback', title: 'First Pullback', render: () => needStock(candidate && <SetupPanel c={candidate} only="pullback" />) },
    { id: 'catalyst', title: 'Catalyst & Flags', render: () => needStock(candidate && <SetupPanel c={candidate} only="catalyst" />) },
    { id: 'account', title: 'Account', minW: 4, render: () => <TradeTicket {...ticketProps} sections={['account']} /> },
    { id: 'guard', title: 'Session Guard', minW: 4, minH: 3, render: () => <TradeTicket {...ticketProps} sections={['guard']} /> },
    { id: 'order', title: 'Order Ticket', minW: 4, minH: 8, render: () => <TradeTicket {...ticketProps} sections={['order', 'holding']} /> },
    { id: 'trades', title: "Today's Trades", minW: 4, render: () => <TradeTicket {...ticketProps} sections={['trades']} /> },
  ];

  return (
    <>
      <WidgetGrid page="daytrade" widgets={widgets} defaultLayout={DAYTRADE_LAYOUT} />

      <OrderDialog order={active ? order : null} plan={plan} onConfirm={confirmOrder} onCancel={() => setOrder(null)} />
      <GoalSetupDialog
        open={active && (planOpen || !settings.dailyGoal)}
        cash={portfolio.cash}
        openCost={openCost}
        settings={settings}
        canClose={!!settings.dailyGoal}
        onClose={() => setPlanOpen(false)}
        onSave={(cash, patch) => { setCash(cash); setSettings(patch); setPlanOpen(false); }}
      />
    </>
  );
}
