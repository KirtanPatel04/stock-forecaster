import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Layout } from 'react-grid-layout';
import { WidgetGrid, type WidgetDef } from '../components/Layout/WidgetGrid';
import { Link, useSearchParams } from 'react-router-dom';
import { daytradeApi } from '../api/client';
import type { ChartBar, ChartLine } from '../components/DayTrade/DayTradeChart';
import { DayTradeChart } from '../components/DayTrade/DayTradeChart';
import type { WatchCandidate, WatchlistResponse, WatchTier, WatchKind } from '../types/daytrade';
import { fmtAcct, fmtPrice, fmtShares, fmtUsdFor, riskPlan } from '../lib/rossRules';
import { usePortfolio } from '../hooks/usePortfolio';
import { useDaySession } from '../hooks/useDaySession';
import { usePinnedWatchlist } from '../hooks/usePinnedWatchlist';
import { acctCost, useJournal } from '../lib/journal';
import { useFx } from '../lib/fx';
import { alerts } from '../lib/alerts';
import { prefs, usePrefs } from '../lib/prefs';

const prefs_alertTop = () => prefs.get().alertWatchlistTop;

const REFRESH_MS = 60_000;

// Default arrangement on the 24 × 40 grid: list | chart + checklist + catalyst | game plan + my watchlist
const WATCHLIST_LAYOUT: Layout[] = [
  { i: 'list', x: 0, y: 0, w: 6, h: 40 },
  { i: 'chart', x: 6, y: 0, w: 12, h: 28 },
  { i: 'checklist', x: 6, y: 28, w: 6, h: 12 },
  { i: 'catalyst', x: 12, y: 28, w: 6, h: 12 },
  { i: 'gameplan', x: 18, y: 0, w: 6, h: 24 },
  { i: 'mylist', x: 18, y: 24, w: 6, h: 16 },
];

const TIER_STYLE: Record<WatchTier, { label: string; cls: string }> = {
  A: { label: 'TOP', cls: 'bg-green-500 text-black' },
  B: { label: 'WATCH', cls: 'bg-accent text-black' },
  C: { label: 'LOW', cls: 'bg-gray-700 text-gray-300' },
  skip: { label: 'SKIP', cls: 'bg-red-500/80 text-white' },
};

const KIND_LABEL: Record<WatchKind, string> = {
  after_hours: 'After hours',
  premarket_gap: 'Pre-market gap',
  day_runner: 'Day runner',
};

const STATUS_ICON = { pass: ['✓', 'text-green-400'], warn: ['!', 'text-yellow-400'], fail: ['✗', 'text-red-400'] } as const;

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const pctCls = (v: number | null | undefined) => (v == null ? 'text-gray-500' : v >= 0 ? 'text-green-400' : 'text-red-400');

function CheckDots({ c }: { c: WatchCandidate }) {
  return (
    <div className="flex gap-0.5">
      {c.checks.filter((x) => x.core).map((x) => (
        <span key={x.key} title={x.label}
          className={`w-2 h-2 rounded-sm ${x.status === 'pass' ? 'bg-green-500/80' : x.status === 'warn' ? 'bg-yellow-400/70' : 'bg-red-500/40'}`} />
      ))}
    </div>
  );
}

/** Stays mounted in the background (see App.tsx); new TOP names raise an alert instead of switching the view. */
export function NextDay({ active = true }: { active?: boolean }) {
  const [params, setParams] = useSearchParams();
  const urlSymbol = active ? params.get('symbol')?.toUpperCase() ?? null : null;
  const [selected, setSelected] = useState<string | null>(urlSymbol);
  const [freshTop, setFreshTop] = useState<string[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const [data, setData] = useState<WatchlistResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'intraday' | 'daily'>('intraday');
  const [bars, setBars] = useState<ChartBar[]>([]);
  const [pf, setPrefs] = usePrefs();
  const showSkip = pf.watchlistShowSkipped;
  const setShowSkip = (v: boolean) => setPrefs({ watchlistShowSkipped: v });

  const { portfolio } = usePortfolio();
  const j = useJournal();
  const { usdcad } = useFx();
  const openCost = j.open.filter((p) => p.mode !== 'paper').reduce((sum, p) => sum + acctCost(p, usdcad), 0);
  const { settings } = useDaySession();
  const { pins, symbols: pinnedSymbols, toggle: togglePin, clear: clearPins, isPinned } = usePinnedWatchlist();
  const pinKey = pinnedSymbols.join(',');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await daytradeApi.getWatchlist(pinKey ? pinKey.split(',') : []);
      setData(res.data);
      setError(null);
    } catch {
      setError('Watchlist failed — is the backend running on :8000?');
    } finally {
      setLoading(false);
    }
  }, [pinKey]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (urlSymbol && urlSymbol !== selected) setSelected(urlSymbol);
  }, [urlSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected && data?.candidates.length) setSelected(data.candidates[0].symbol);
  }, [selected, data]);

  useEffect(() => {
    if (active && selected && urlSymbol !== selected) setParams({ symbol: selected }, { replace: true });
  }, [active, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (active) alerts.clear('watchlist'); }, [active]);

  // New TOP-tier names since the last refresh → alert
  useEffect(() => {
    if (!data) return;
    const top = data.candidates.filter((c) => c.tier === 'A').map((c) => c.symbol);
    if (seenRef.current === null) { seenRef.current = new Set(top); return; }
    const fresh = top.filter((sym) => !seenRef.current!.has(sym));
    seenRef.current = new Set(top);
    if (!fresh.length) return;
    setFreshTop((prev) => [...new Set([...fresh, ...prev])].slice(0, 4));
    if (!active && prefs_alertTop()) alerts.push('watchlist', fresh.map((symbol) => ({ symbol, label: 'TOP' })), "New name for tomorrow's watchlist");
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (sym: string) => { setSelected(sym); setFreshTop((prev) => prev.filter((x) => x !== sym)); };

  useEffect(() => {
    setBars([]);
    if (!selected) return;
    let live = true;
    const load = () => (view === 'daily' ? daytradeApi.getDaily(selected) : daytradeApi.getBars(selected))
      .then((r) => live && setBars(r.data as ChartBar[])).catch(() => {});
    load();
    const id = setInterval(load, view === 'daily' ? 600_000 : 30_000);
    return () => { live = false; clearInterval(id); };
  }, [selected, view]);

  const candidate = data?.candidates.find((c) => c.symbol === selected) ?? null;
  const rows = (data?.candidates ?? []).filter((c) => showSkip || c.tier !== 'skip' || c.pinned);
  const skipped = (data?.candidates.length ?? 0) - rows.length;
  const plan = useMemo(() => riskPlan(portfolio.cash, settings, null, openCost, usdcad), [portfolio.cash, settings, openCost, usdcad]);

  const lines = useMemo<ChartLine[]>(() => {
    if (!candidate) return [];
    const l = candidate.levels;
    const out: ChartLine[] = [];
    if (l.ext_high) out.push({ price: l.ext_high, color: '#58a6ff', title: candidate.kind === 'premarket_gap' ? 'PM high' : 'AH high' });
    if (l.day_high) out.push({ price: l.day_high, color: '#6b7280', title: 'HOD', dotted: true });
    if (l.regular_close) out.push({ price: l.regular_close, color: '#9ca3af', title: 'Close', dotted: true });
    if (l.prev_close) out.push({ price: l.prev_close, color: '#4b5563', title: 'Prev close', dotted: true });
    if (l.dma200) out.push({ price: l.dma200, color: '#f472b6', title: '200 MA' });
    return out;
  }, [candidate]);

  const phaseCls = { premarket: 'text-green-400', regular: 'text-gray-300', after_hours: 'text-accent', overnight: 'text-violet-400' };

  const pick = (node: ReactNode) => candidate ? node : <p className="p-3 text-xs text-gray-500">Select a stock from the list.</p>;
  const widgets: WidgetDef[] = [
    {
      id: 'list', title: 'Watchlist', minW: 4, minH: 8,
      render: () => (
        <div className="h-full flex flex-col">
        <div className="px-3 pt-2.5 pb-2 border-b border-border space-y-1.5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Next-Day Watchlist</h2>
              <p className="text-[10px] text-gray-500">After hours → pre-market · Ross Cameron's routine</p>
            </div>
            <button onClick={load} disabled={loading}
              className="text-[11px] px-2 py-1 rounded border border-border text-gray-300 hover:text-white disabled:opacity-50">
              {loading ? '…' : '↻'}
            </button>
          </div>
          {data && (
            <>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="px-1.5 py-0.5 rounded bg-surface text-white font-semibold whitespace-nowrap">For {data.phase.for_day}</span>
                <span className={phaseCls[data.phase.key]}>{data.phase.label}</span>
              </div>
              {data.notes.map((n) => <p key={n} className="text-[10px] text-yellow-400/90">⚑ {n}</p>)}
            </>
          )}
        </div>

        <div className="grid grid-cols-[1fr_52px_56px_56px_44px] gap-1 px-3 py-1 text-[9px] text-gray-500 uppercase tracking-wide border-b border-border">
          <span>Symbol</span><span className="text-right">Price</span><span className="text-right">Ext</span>
          <span className="text-right">Day</span><span className="text-right">Float</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <p className="p-3 text-xs text-red-400">{error}</p>}
          {!data && loading && <p className="p-3 text-xs text-gray-500">Scanning after-hours and pre-market movers…</p>}
          {data && rows.length === 0 && <p className="p-3 text-xs text-gray-400">No candidates yet. After-hours movers show up after 4 PM ET, pre-market gappers from 4 AM.</p>}
          {rows.map((c) => (
            <div key={c.symbol} onClick={() => select(c.symbol)}
              className={`px-3 py-1.5 border-b border-border/60 cursor-pointer hover:bg-surface ${selected === c.symbol ? 'bg-surface border-l-2 border-l-accent' : ''}`}>
              <div className="grid grid-cols-[1fr_52px_56px_56px_44px] gap-1 items-center">
                <div className="flex items-center gap-1.5 min-w-0">
                  <button onClick={(e) => { e.stopPropagation(); togglePin(c.symbol); }}
                    title={isPinned(c.symbol) ? 'Remove from my watchlist' : 'Add to my watchlist'}
                    className={isPinned(c.symbol) ? 'text-yellow-400' : 'text-gray-600 hover:text-yellow-400'}>★</button>
                  <span className={`text-[8px] font-bold px-1 rounded ${TIER_STYLE[c.tier].cls}`}>{TIER_STYLE[c.tier].label}</span>
                  <span className="text-xs font-semibold font-mono text-white">{c.symbol}</span>
                </div>
                <span className="text-[11px] font-mono text-right text-white">{fmtPrice(c.price)}</span>
                <span className={`text-[11px] font-mono text-right ${pctCls(c.ext_change_pct)}`}>{c.kind === 'day_runner' ? '—' : pct(c.ext_change_pct)}</span>
                <span className={`text-[11px] font-mono text-right ${pctCls(c.day_change_pct)}`}>{pct(c.day_change_pct)}</span>
                <span className={`text-[11px] font-mono text-right ${(c.float_shares ?? Infinity) < 20e6 ? 'text-white' : 'text-gray-500'}`}>{fmtShares(c.float_shares)}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <CheckDots c={c} />
                <span className="text-[9px] text-gray-500">{KIND_LABEL[c.kind]}</span>
                {c.has_fresh_news && <span className="text-[9px] text-green-400">news</span>}
                <span className="ml-auto text-[9px] text-gray-500 truncate max-w-[150px]">{c.verdict}</span>
              </div>
            </div>
          ))}
          {skipped > 0 && (
            <button onClick={() => setShowSkip(true)} className="px-3 py-2 text-[10px] text-gray-600 hover:text-gray-400">
              Show {skipped} skipped
            </button>
          )}
        </div>
        </div>
      ),
    },
    {
      id: 'chart', title: 'Chart', minW: 6, minH: 8,
      render: () => (
        <div className="h-full flex flex-col">
        <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-panel">
          {candidate ? (
            <>
              <span className={`text-[10px] font-bold px-1.5 rounded ${TIER_STYLE[candidate.tier].cls}`}>{TIER_STYLE[candidate.tier].label}</span>
              <span className="text-lg font-semibold font-mono text-white">{candidate.symbol}</span>
              <span className="text-xs text-gray-500 truncate max-w-[200px]">{candidate.name}</span>
              <span className="text-lg font-mono text-white">{fmtPrice(candidate.price)}</span>
              <span className="text-[11px] text-gray-400">
                {KIND_LABEL[candidate.kind]} <span className={`font-mono ${pctCls(candidate.move_pct)}`}>{pct(candidate.move_pct)}</span>
              </span>
            </>
          ) : (
            <span className="text-xs text-gray-500">{selected ? `Loading ${selected}…` : 'Waiting for watchlist…'}</span>
          )}
          <div className="ml-auto flex rounded border border-border overflow-hidden">
            {(['intraday', 'daily'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-2.5 py-1 text-[11px] ${view === v ? 'bg-accent/20 text-accent' : 'text-gray-500 hover:text-gray-300'}`}>
                {v === 'intraday' ? '1m + ext hours' : 'Daily 1Y'}
              </button>
            ))}
          </div>
        </div>

        {freshTop.length > 0 && (
          <div className="px-4 py-1.5 bg-green-500/10 border-b border-green-500/30 text-[11px] text-green-300 flex items-center gap-2 flex-wrap">
            <span className="font-semibold">New TOP name{freshTop.length > 1 ? 's' : ''}:</span>
            {freshTop.map((sym) => (
              <button key={sym} onClick={() => select(sym)} className="px-1.5 py-0.5 rounded bg-green-500/20 hover:bg-green-500/30 font-mono">{sym} →</button>
            ))}
            <button onClick={() => setFreshTop([])} className="ml-auto text-gray-500 hover:text-gray-300">Dismiss</button>
          </div>
        )}
        <div className="flex-1 min-h-0 relative">
          {selected && <DayTradeChart symbol={selected} bars={bars} daily={view === 'daily'} lines={lines} />}
          {selected && bars.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 pointer-events-none">Loading chart…</div>
          )}
          <div className="absolute top-2 left-3 flex gap-3 text-[10px] pointer-events-none">
            {view === 'intraday' ? (
              <><span className="text-gray-500">1m · ET · dimmed = pre/after hours</span><span className="text-amber-400">— VWAP</span><span className="text-violet-400">— 9 EMA</span></>
            ) : (
              <><span className="text-gray-500">Daily · spike-and-fade history, overhead resistance</span><span className="text-sky-400">— 20 MA</span><span className="text-pink-400">— 200 MA</span></>
            )}
          </div>
        </div>
        </div>
      ),
    },
    {
      id: 'checklist', title: "Ross's Checklist",
      render: () => pick(candidate && (
        <div className="h-full text-xs [&>div]:h-full">
            <div className="bg-panel p-3 overflow-y-auto">
              <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Ross's checklist · {candidate.core_score}/5 pillars
              </h4>
              <div className="space-y-1">
                {candidate.checks.map((x) => (
                  <div key={x.key} className="flex items-start gap-1.5">
                    <span className={`${STATUS_ICON[x.status][1]} w-3`}>{STATUS_ICON[x.status][0]}</span>
                    <span className={x.core ? 'text-gray-200' : 'text-gray-400'}>{x.label}</span>
                  </div>
                ))}
              </div>
            </div>
        </div>
      )),
    },
    {
      id: 'catalyst', title: 'Catalyst',
      render: () => pick(candidate && (
        <div className="h-full text-xs [&>div]:h-full">
            <div className="bg-panel p-3 overflow-y-auto">
              <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Catalyst</h4>
              {candidate.news.length === 0 && <p className="text-gray-500">No fresh headline since the last close.</p>}
              {candidate.news.map((n) => (
                <a key={n.title} href={n.url} target="_blank" rel="noreferrer" className="block mb-2 group">
                  <span className="text-[11px] text-white leading-snug group-hover:underline">{n.title}</span>
                  <span className="block text-[9px] text-gray-600">{n.publisher} · {new Date(n.published).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                </a>
              ))}
              <p className="text-[10px] text-gray-500 mt-2">
                {candidate.country ?? '—'} · {candidate.sector ?? '—'} · {candidate.exchange ?? ''} · RVol {candidate.rel_volume?.toFixed(1) ?? '—'}x
                {candidate.kind !== 'day_runner' && ` · ${fmtShares(candidate.ext_volume)} ext-hours shares`}
              </p>
            </div>
        </div>
      )),
    },
    {
      id: 'gameplan', title: 'Game Plan', minW: 4,
      render: () => (
        <div className="h-full overflow-y-auto text-xs">
        {candidate && (
          <section className="p-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Game plan · {candidate.symbol}</h3>
              <button onClick={() => togglePin(candidate.symbol)}
                className={`text-[10px] px-2 py-0.5 rounded border ${isPinned(candidate.symbol) ? 'border-yellow-400/50 text-yellow-400' : 'border-border text-gray-400 hover:text-white'}`}>
                {isPinned(candidate.symbol) ? '★ On my list' : '☆ Add to my list'}
              </button>
            </div>
            <div className={`rounded border p-2 ${candidate.tier === 'A' ? 'border-green-500/40 bg-green-500/10' : candidate.tier === 'skip' ? 'border-red-500/40 bg-red-500/5' : 'border-border bg-surface'}`}>
              <div className="font-semibold text-white text-[11px]">{candidate.verdict}</div>
              <p className="text-[11px] text-gray-300 mt-1 leading-snug">{candidate.plan}</p>
            </div>
            <div className="space-y-1">
              {[
                [candidate.kind === 'premarket_gap' ? 'Pre-market high' : 'After-hours high', candidate.levels.ext_high, 'text-accent'],
                ['High of day', candidate.levels.day_high, 'text-white'],
                ['Close', candidate.levels.regular_close, 'text-white'],
                ['Prev close', candidate.levels.prev_close, 'text-gray-400'],
                ['200-day MA', candidate.levels.dma200, 'text-pink-400'],
              ].filter(([, v]) => v != null).map(([label, v, cls]) => (
                <div key={label as string} className="flex justify-between">
                  <span className="text-gray-500">{label}</span>
                  <span className={`font-mono ${cls}`}>{fmtPrice(v as number)}</span>
                </div>
              ))}
            </div>
            {plan.cash > 0 ? (
              <div className="pt-2 border-t border-border space-y-1 text-[11px]">
                <div className="text-[10px] text-gray-500">With your {fmtAcct(plan, plan.cash)} ({settings.accountType}{plan.currency === 'CAD' ? ` · 1 USD = ${plan.fx.toFixed(4)} CAD` : ''})</div>
                <div className="flex justify-between"><span className="text-gray-500">Max shares by cash</span><span className="font-mono text-white">{Math.floor(plan.buyingPowerUsd / candidate.price).toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Each winner should pay</span><span className="font-mono text-green-400">+{fmtAcct(plan, plan.perTradeGoal, 2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Risk budget / trade</span><span className="font-mono text-white">{fmtAcct(plan, plan.maxRiskPerTrade)}</span></div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Stop must be within</span>
                  <span className="font-mono text-white" title="Your risk budget converted to USD, spread over the shares your cash buys">
                    {fmtUsdFor(plan, plan.maxRiskPerTrade / plan.fx / Math.max(1, Math.floor(plan.buyingPowerUsd / candidate.price)), 2)}/sh
                  </span>
                </div>
                <p className="text-[10px] text-gray-500">Your {fmtAcct(plan, plan.dailyGoal)} goal in {plan.tradesPerGoal} winners. Exact entry, stop and 2:1 target come from the live setup on the Day Trade page.</p>
              </div>
            ) : (
              <p className="text-[10px] text-yellow-400">Enter your cash on the <Link to="/" className="underline">Day Trade</Link> page to see sizing.</p>
            )}
          </section>
        )}
          {!candidate && <p className="p-3 text-gray-500">Select a stock from the list.</p>}
        </div>
      ),
    },
    {
      id: 'mylist', title: 'My Watchlist', minW: 4,
      render: () => (
        <div className="h-full overflow-y-auto text-xs">
        <section className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">★ My watchlist ({pins.length})</h3>
            {pins.length > 0 && <button onClick={clearPins} className="text-[10px] text-gray-600 hover:text-gray-400">Clear</button>}
          </div>
          {pins.length === 0 && <p className="text-[11px] text-gray-500">Star stocks tonight. They'll be pinned to the top of the Day Trade scanner tomorrow morning.</p>}
          {pins.map((p) => {
            const c = data?.candidates.find((x) => x.symbol === p.symbol);
            return (
              <div key={p.symbol} className="flex items-center justify-between">
                <button onClick={() => select(p.symbol)} className="font-mono text-white hover:text-accent">{p.symbol}</button>
                <span className="flex items-center gap-2">
                  {c && <span className={`font-mono text-[11px] ${pctCls(c.move_pct)}`}>{pct(c.move_pct)}</span>}
                  <Link to={`/?symbol=${p.symbol}`} className="text-[10px] text-accent hover:underline">Trade →</Link>
                  <button onClick={() => togglePin(p.symbol)} className="text-gray-600 hover:text-red-400">×</button>
                </span>
              </div>
            );
          })}
          <div className="pt-3 border-t border-border text-[10px] text-gray-500 space-y-1 leading-snug">
            <p className="text-gray-400 font-semibold">His morning routine</p>
            <p>6:45–7:00 AM ET: check the pre-market top gainers. For each, confirm float, price, relative volume, country and a catalyst, then the daily chart (200 MA overhead, history of spiking and fading).</p>
            <p>Only then drop to the 1-minute chart and wait for the first pullback. Don't chase the open.</p>
          </div>
        </section>
        </div>
      ),
    },
  ];

  return <WidgetGrid page="watchlist" widgets={widgets} defaultLayout={WATCHLIST_LAYOUT} />;
}
