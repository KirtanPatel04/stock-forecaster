import { useMemo, useState } from 'react';
import type { DayTradeCandidate, DayTradeScan, Grade, PillarKey, SetupState } from '../../types/daytrade';
import { ACTION_ORDER, cashFit, fmtAcct, fmtPrice, fmtShares, levelsFor, verdict, type RiskPlan, type SessionStatus } from '../../lib/rossRules';
import { VerdictChip } from './Verdict';
import { GamePlanPanel } from './GamePlanPanel';
import type { GamePlan } from '../../lib/rossRules';

interface Props {
  scan: DayTradeScan | null;
  loading: boolean;
  error: string | null;
  plan: RiskPlan;
  status: SessionStatus;
  selected: string | null;
  pinned: DayTradeCandidate[];
  game: GamePlan | null;
  onSelect: (symbol: string) => void;
  onRefresh: () => void;
}

import { usePrefs, type GradeFilter, type ScannerSort as Sort } from '../../lib/prefs';

export const GRADE_STYLE: Record<Grade, string> = {
  'A+': 'bg-green-500 text-black',
  A: 'bg-green-400/80 text-black',
  B: 'bg-yellow-400/80 text-black',
  C: 'bg-gray-700 text-gray-300',
};

export const STATE_STYLE: Record<SetupState, { label: string; cls: string }> = {
  triggered: { label: 'TRIGGER', cls: 'bg-green-500/20 text-green-400 border-green-500/40' },
  pullback: { label: 'PULLBACK', cls: 'bg-accent/15 text-accent border-accent/40' },
  extended: { label: 'EXTENDED', cls: 'bg-yellow-400/10 text-yellow-400 border-yellow-400/30' },
  stale: { label: 'STALE', cls: 'bg-gray-700/40 text-gray-400 border-gray-600' },
  broken: { label: 'BROKEN', cls: 'bg-red-500/10 text-red-400 border-red-500/30' },
  none: { label: '—', cls: 'text-gray-600 border-transparent' },
};

const PILLAR_ORDER: { key: PillarKey; short: string }[] = [
  { key: 'change', short: '%' },
  { key: 'rel_volume', short: 'V' },
  { key: 'news', short: 'N' },
  { key: 'price', short: '$' },
  { key: 'float', short: 'F' },
];

const TEMP_STYLE = { hot: 'text-red-400 bg-red-500/10', warm: 'text-yellow-400 bg-yellow-400/10', cold: 'text-sky-400 bg-sky-400/10' };
const WINDOW_STYLE = { prime: 'text-green-400', early: 'text-gray-300', late: 'text-yellow-400', off: 'text-red-400', closed: 'text-gray-500' };
const FIT_STYLE = { full: 'bg-green-400', partial: 'bg-yellow-400', poor: 'bg-red-400' };
const GRADE_RANK: Record<Grade, number> = { 'A+': 0, A: 1, B: 2, C: 3 };

export function PillarDots({ c }: { c: DayTradeCandidate }) {
  return (
    <div className="flex gap-0.5">
      {PILLAR_ORDER.map(({ key, short }) => {
        const p = c.pillars[key];
        const cls = p.pass ? 'bg-green-500/80 text-black' : p.pass === null ? 'bg-gray-700 text-gray-400' : 'bg-red-500/25 text-red-300';
        return (
          <span key={key} title={`${p.rule}: ${p.pass ? 'pass' : p.pass === null ? 'unknown' : 'fail'}`}
            className={`w-3.5 h-3.5 rounded-sm text-[8px] font-bold flex items-center justify-center ${cls}`}>{short}</span>
        );
      })}
    </div>
  );
}

export function ScannerList({ scan, loading, error, plan, status, selected, pinned, game, onSelect, onRefresh }: Props) {
  const [pf, setPrefs] = usePrefs();
  const gradeFilter = pf.scannerGrade;
  const fitsCash = pf.scannerFitsCash;
  const sort = pf.scannerSort;
  const setGradeFilter = (g: GradeFilter) => setPrefs({ scannerGrade: g });
  const setFitsCash = (f: (v: boolean) => boolean) => setPrefs({ scannerFitsCash: f(fitsCash) });
  const setSort = (s: Sort) => setPrefs({ scannerSort: s });

  const rows = useMemo(() => {
    const list = (scan?.candidates ?? []).map((c) => ({
      c, ...cashFit(c, plan, status.sizeMultiplier || 1), v: verdict(c, levelsFor(c), plan, status, scan?.window, scan?.temperature),
    }));
    const pinnedSet = new Set(pinned.map((p) => p.symbol));
    const filtered = list.filter(({ c, fit }) => {
      if (pinnedSet.has(c.symbol)) return false;
      if (gradeFilter === 'A' && GRADE_RANK[c.grade] > 1) return false;
      if (gradeFilter === 'AB' && GRADE_RANK[c.grade] > 2) return false;
      if (fitsCash && plan.cash > 0 && fit === 'poor') return false;
      return true;
    });
    if (sort === 'verdict') filtered.sort((a, b) => ACTION_ORDER[a.v.action] - ACTION_ORDER[b.v.action]);
    if (sort === 'gain') filtered.sort((a, b) => b.c.change_pct - a.c.change_pct);
    if (sort === 'potential') filtered.sort((a, b) => b.potential - a.potential);
    return filtered;
  }, [scan, plan, status, pinned, gradeFilter, fitsCash, sort]);

  const pinnedRows = pinned.map((c) => ({
    c, ...cashFit(c, plan, status.sizeMultiplier || 1), v: verdict(c, levelsFor(c), plan, status, scan?.window, scan?.temperature),
  }));
  const pinnedInScan = pinned.filter((p) => scan?.candidates.some((c) => c.symbol === p.symbol)).length;
  const hidden = (scan?.candidates.length ?? 0) - pinnedInScan - rows.length;

  type Row = (typeof rows)[number];
  const renderRow = ({ c, fit, potential, shares, risk, entry, v }: Row, star = false) => {
    const st = STATE_STYLE[c.setup.state];
    return (
            <button key={c.symbol} onClick={() => onSelect(c.symbol)}
              className={`w-full text-left px-3 py-1.5 border-b border-border/60 hover:bg-surface ${selected === c.symbol ? 'bg-surface border-l-2 border-l-accent' : ''}`}>
              <div className="grid grid-cols-[1fr_52px_56px_44px_44px] gap-1 items-center">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-[9px] font-bold px-1 rounded ${GRADE_STYLE[c.grade]}`}>{c.grade}</span>
                  {star && <span className="text-yellow-400 text-[10px]">★</span>}
                  <span className="text-xs font-semibold font-mono text-white">{c.symbol}</span>
                  {plan.cash > 0 && <span className={`w-1.5 h-1.5 rounded-full ${FIT_STYLE[fit]}`} title={`Cash fit: ${fit}`} />}
                </div>
                <span className="text-[11px] font-mono text-right text-white">{fmtPrice(c.price)}</span>
                <span className="text-[11px] font-mono text-right font-semibold text-green-400">+{c.change_pct.toFixed(0)}%</span>
                <span className={`text-[11px] font-mono text-right ${(c.rel_volume ?? 0) >= 5 ? 'text-white' : 'text-gray-500'}`}>
                  {c.rel_volume != null ? `${c.rel_volume >= 100 ? c.rel_volume.toFixed(0) : c.rel_volume.toFixed(1)}x` : '—'}
                </span>
                <span className={`text-[11px] font-mono text-right ${(c.float_shares ?? Infinity) < 20e6 ? 'text-white' : 'text-gray-500'}`}>
                  {fmtShares(c.float_shares)}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <VerdictChip action={v.action} />
                <PillarDots c={c} />
                <span className={`text-[8px] font-semibold px-1 py-px rounded border ${st.cls}`}>{st.label}</span>
                {c.gainer_rank && c.gainer_rank <= 3 && <span className="text-[9px] text-yellow-400">#{c.gainer_rank} gainer</span>}
                {plan.cash > 0 && shares > 0 && entry != null && (
                  <span className="ml-auto text-[9px] font-mono whitespace-nowrap"
                    title={`Suggested size at the live entry $${fmtPrice(entry)}: ${shares} shares → ${fmtAcct(plan, potential, 2)} at the 2:1 target, −${fmtAcct(plan, risk, 2)} at the stop`}>
                    <span className="text-white">{shares.toLocaleString()} sh</span>
                    <span className="text-green-400"> +{fmtAcct(plan, potential)}</span>
                    <span className="text-red-400/80"> −{fmtAcct(plan, risk)}</span>
                  </span>
                )}
              </div>
            </button>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-2.5 pb-2 border-b border-border space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Day Trade Scanner</h2>
            <p className="text-[10px] text-gray-500">Ross Cameron · Five Pillars · US small caps</p>
          </div>
          <button onClick={onRefresh} disabled={loading}
            className="text-[11px] px-2 py-1 rounded border border-border text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-50">
            {loading ? '…' : '↻'}
          </button>
        </div>

        {scan && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px]">
              <span className={`font-mono ${WINDOW_STYLE[scan.window.key]}`}>● {scan.window.et_time}</span>
              <span className={`px-1.5 py-0.5 rounded font-semibold uppercase ${TEMP_STYLE[scan.temperature.key]}`}>
                {scan.temperature.key} market
              </span>
            </div>
            <p className={`text-[10px] ${WINDOW_STYLE[scan.window.key]}`}>{scan.window.label}</p>
            <p className="text-[10px] text-gray-500">{scan.temperature.advice}</p>
          </div>
        )}

        <div className="flex items-center gap-1 flex-wrap">
          {(['A', 'AB', 'all'] as GradeFilter[]).map((g) => (
            <button key={g} onClick={() => setGradeFilter(g)}
              className={`text-[10px] px-2 py-0.5 rounded border ${gradeFilter === g ? 'border-accent text-accent' : 'border-border text-gray-500 hover:text-gray-300'}`}>
              {g === 'A' ? 'A only' : g === 'AB' ? 'A + B' : 'All'}
            </button>
          ))}
          <button onClick={() => setFitsCash((v) => !v)}
            className={`text-[10px] px-2 py-0.5 rounded border ${fitsCash ? 'border-accent text-accent' : 'border-border text-gray-500'}`}
            title="Hide stocks your cash can't size properly">
            Fits my cash
          </button>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
            className="ml-auto bg-surface border border-border rounded text-[10px] text-gray-300 px-1 py-0.5">
            <option value="verdict">Sort: Buy first</option>
            <option value="rank">Sort: Grade</option>
            <option value="gain">Sort: % Gain</option>
            <option value="potential">Sort: $ to target</option>
          </select>
        </div>
      </div>

      {game && plan.cash > 0 && <GamePlanPanel game={game} plan={plan} selected={selected} onSelect={onSelect} />}

      <div className="grid grid-cols-[1fr_52px_56px_44px_44px] gap-1 px-3 py-1 text-[9px] text-gray-500 uppercase tracking-wide border-b border-border">
        <span>Symbol</span><span className="text-right">Price</span><span className="text-right">Chg</span>
        <span className="text-right">RVol</span><span className="text-right">Float</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && <p className="p-3 text-xs text-red-400">{error}</p>}
        {!scan && loading && <p className="p-3 text-xs text-gray-500">Scanning the market…</p>}
        {scan && rows.length === 0 && (
          <div className="p-4 text-xs text-gray-400 space-y-1">
            <p className="font-semibold text-gray-300">Nothing worth trading right now.</p>
            <p>"No trade" is a valid trade. Loosen the filters to see B/C names, or come back in the 7–10 AM ET window.</p>
          </div>
        )}
        {pinnedRows.length > 0 && (
          <>
            <div className="px-3 py-1 text-[9px] uppercase tracking-wide text-yellow-400/80 bg-yellow-400/5 border-b border-border">★ My watchlist</div>
            {pinnedRows.map((r) => renderRow(r, true))}
            <div className="px-3 py-1 text-[9px] uppercase tracking-wide text-gray-500 border-b border-border">Scanner</div>
          </>
        )}
        {rows.map((r) => renderRow(r))}
        {hidden > 0 && <p className="px-3 py-2 text-[10px] text-gray-600">{hidden} more hidden by filters</p>}
      </div>
    </div>
  );
}
