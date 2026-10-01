import { useEffect, useMemo, useRef, useState } from 'react';
import { stocksApi } from '../../api/client';
import { livePnl, type Position } from '../../lib/journal';
import { fmtAcct, fmtPrice, type RiskPlan } from '../../lib/rossRules';

const PRICE_MS = 5_000;

interface Props {
  positions: Position[];
  plan: RiskPlan;
  selected: string | null;
  selectedLast: number | null;     // the chart's latest close for the selected stock (already live)
  realizedToday: number;           // account currency
  onSelect: (symbol: string) => void;
  onSell: (pos: Position, last: number, shares?: number) => void;
  fill?: boolean;                  // fill its container (as a layout widget) instead of a fixed-height strip
}

function held(fromIso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(fromIso).getTime()) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Where the price sits between stop (0%) and target (100%), with the entry marked. */
function StopTargetBar({ stop, entry, target, last }: { stop: number; entry: number; target: number; last: number }) {
  const span = target - stop;
  if (span <= 0) return null;
  const at = Math.min(1, Math.max(0, (last - stop) / span));
  const entryAt = Math.min(1, Math.max(0, (entry - stop) / span));
  const up = last >= entry;
  return (
    <div className="w-20" title={`Stop ${fmtPrice(stop)} · entry ${fmtPrice(entry)} · target ${fmtPrice(target)}`}>
      <div className="relative h-1.5 rounded bg-surface overflow-hidden">
        <div className={`absolute top-0 h-full ${up ? 'bg-green-500/70' : 'bg-red-500/70'}`}
          style={{ left: `${Math.min(entryAt, at) * 100}%`, width: `${Math.abs(at - entryAt) * 100}%` }} />
        <div className="absolute top-0 h-full w-px bg-gray-300" style={{ left: `${entryAt * 100}%` }} />
      </div>
      <div className="flex justify-between text-[8px] text-gray-500 font-mono mt-0.5">
        <span className="text-red-400/80">{fmtPrice(stop)}</span><span className="text-green-400/80">{fmtPrice(target)}</span>
      </div>
    </div>
  );
}

/** Webull-style positions strip under the chart — every open position, marked to the live price. */
export function PositionsBar({ positions, plan, selected, selectedLast, realizedToday, onSelect, onSell, fill = false }: Props) {
  const [quotes, setQuotes] = useState<Record<string, number>>({});
  const prevRef = useRef<Record<string, number>>({});
  const [ticks, setTicks] = useState<Record<string, 1 | -1 | 0>>({});
  const [open, setOpen] = useState(true);

  // Live quotes for held stocks other than the one on the chart (that one comes from the chart's bars)
  const others = useMemo(
    () => [...new Set(positions.map((p) => p.symbol))].filter((s) => s !== selected).sort().join(','),
    [positions, selected],
  );
  useEffect(() => {
    if (!others) return;
    let live = true;
    const load = () => Promise.all(others.split(',').map((s) =>
      stocksApi.getPrice(s).then((r) => [s, r.data.price] as const).catch(() => null)))
      .then((res) => {
        if (!live) return;
        setQuotes((q) => ({ ...q, ...Object.fromEntries(res.filter((x): x is readonly [string, number] => !!x && x[1] > 0)) }));
      });
    load();
    const id = setInterval(load, PRICE_MS);
    return () => { live = false; clearInterval(id); };
  }, [others]);

  const priceOf = (sym: string) => (sym === selected && selectedLast != null ? selectedLast : quotes[sym] ?? null);

  // ▲/▼ tick versus the previous price
  const priceKey = positions.map((p) => `${p.symbol}:${priceOf(p.symbol)}`).join('|');
  useEffect(() => {
    const next: Record<string, 1 | -1 | 0> = {};
    for (const p of positions) {
      const now = priceOf(p.symbol);
      const prev = prevRef.current[p.symbol];
      if (now != null) {
        next[p.symbol] = prev == null || now === prev ? (ticks[p.symbol] ?? 0) : now > prev ? 1 : -1;
        prevRef.current[p.symbol] = now;
      }
    }
    setTicks(next);
  }, [priceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = positions.map((p) => {
    const last = priceOf(p.symbol);
    return { p, last, live: last != null ? livePnl(p, last, plan.fx) : null };
  });
  const openPnl = rows.reduce((s, r) => s + (r.live?.pnlAcct ?? 0), 0);
  const dayPnl = realizedToday + rows.filter((r) => r.p.mode !== 'paper').reduce((s, r) => s + (r.live?.pnlAcct ?? 0), 0);
  const cad = plan.currency === 'CAD';
  const money = (n: number, d = 2) => `${n > 0 ? '+' : ''}${fmtAcct(plan, n, d)}`;
  const tone = (n: number) => (n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-gray-300');
  const arrow = (n: number) => (n > 0 ? '▲ ' : n < 0 ? '▼ ' : '');

  return (
    <div className={fill ? 'h-full flex flex-col bg-panel' : 'border-t border-border bg-panel flex-shrink-0'}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-4 px-4 py-1.5 text-left">
        <span className="text-[11px] font-semibold text-white">Positions ({positions.length})</span>
        <span className="flex items-center gap-1 text-[9px] text-gray-500"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE</span>
        <span className="text-[11px] text-gray-400">Open P&L <span className={`font-mono font-semibold ${tone(openPnl)}`}>{arrow(openPnl)}{money(openPnl)}</span></span>
        <span className="text-[11px] text-gray-400" title="Realized today + open real positions marked to market">
          Day P&L <span className={`font-mono font-semibold ${tone(dayPnl)}`}>{arrow(dayPnl)}{money(dayPnl)}</span>
        </span>
        <span className="ml-auto text-[10px] text-gray-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className={`${fill ? 'flex-1 min-h-0' : 'max-h-[150px]'} overflow-y-auto overflow-x-auto`}>
          <table className="w-full text-[11px] whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr className="text-[9px] text-gray-500 uppercase tracking-wide text-left">
                {['Symbol', 'Qty', 'Avg', 'Last', `P&L${cad ? ' (C$)' : ''}`, '%', 'Stop → Target', 'Held', ''].map((h, i) => (
                  <th key={h} className={`font-normal px-2 py-1 ${i >= 1 && i <= 5 ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, last, live }) => {
                const tick = ticks[p.symbol] ?? 0;
                const stopHit = last != null && p.stop != null && last <= p.stop;
                const tgtHit = last != null && p.target != null && last >= p.target;
                return (
                  <tr key={p.id} className={`border-t border-border/60 ${p.symbol === selected ? 'bg-surface' : ''}`}>
                    <td className="px-2 py-1">
                      <span className={`text-[8px] font-bold px-1 mr-1 rounded ${p.mode === 'paper' ? 'bg-accent/20 text-accent' : 'bg-green-500/20 text-green-400'}`}>{p.mode === 'paper' ? 'PAPER' : 'REAL'}</span>
                      <button onClick={() => onSelect(p.symbol)} className="font-mono font-semibold text-white hover:text-accent">{p.symbol}</button>
                    </td>
                    <td className="px-2 text-right font-mono text-gray-300">{p.shares.toLocaleString()}</td>
                    <td className="px-2 text-right font-mono text-gray-300">{fmtPrice(p.entry)}</td>
                    <td className={`px-2 text-right font-mono ${tick > 0 ? 'text-green-400' : tick < 0 ? 'text-red-400' : 'text-white'}`}>
                      {last != null ? <>{tick > 0 ? '▲' : tick < 0 ? '▼' : ''}{fmtPrice(last)}</> : '…'}
                    </td>
                    <td className={`px-2 text-right font-mono font-semibold ${tone(live?.pnlAcct ?? 0)}`}>
                      {live ? <><span>{arrow(live.pnlAcct)}{money(live.pnlAcct)}</span>{cad && <span className="block text-[9px] font-normal text-gray-500">US${live.pnlUsd >= 0 ? '+' : ''}{live.pnlUsd.toFixed(2)}</span>}</> : '…'}
                    </td>
                    <td className={`px-2 text-right font-mono ${tone(live?.pct ?? 0)}`}>{live ? `${live.pct > 0 ? '+' : ''}${live.pct.toFixed(2)}%` : ''}</td>
                    <td className="px-2">
                      {last != null && p.stop != null && p.target != null
                        ? <div className="flex items-center gap-2">
                            <StopTargetBar stop={p.stop} entry={p.entry} target={p.target} last={last} />
                            {stopHit && <span className="text-[9px] font-bold text-red-400" title="Price is at or below your stop — get out">STOP HIT</span>}
                            {tgtHit && <span className="text-[9px] font-bold text-green-400" title="2:1 target reached — sell into strength">TARGET ✓</span>}
                          </div>
                        : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-2 text-gray-400">{held(p.openedAt)}</td>
                    <td className="px-2">
                      <div className="flex gap-1 justify-end">
                        <button title="Sell half" disabled={last == null || p.shares < 2} onClick={() => last != null && onSell(p, last, Math.floor(p.shares / 2))}
                          className="px-1.5 py-0.5 rounded border border-border text-gray-300 hover:text-white disabled:opacity-40">½</button>
                        <button disabled={last == null} onClick={() => last != null && onSell(p, last)}
                          className="px-1.5 py-0.5 rounded bg-red-500/80 text-white font-semibold hover:bg-red-500 disabled:opacity-40">Sell</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
