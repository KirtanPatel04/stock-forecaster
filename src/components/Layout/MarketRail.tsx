import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { daytradeApi } from '../../api/client';
import type { MarketOverview, RailQuote } from '../../types/daytrade';
import { fmtPrice, fmtShares } from '../../lib/rossRules';
import { usePrefs } from '../../lib/prefs';

type Tab = 'small_caps' | 'gainers' | 'losers' | 'actives';
const TABS: { key: Tab; label: string }[] = [
  { key: 'small_caps', label: 'Small Cap' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
  { key: 'actives', label: 'Active' },
];

const pctClass = (v: number) => (v >= 0 ? 'text-green-400' : 'text-red-400');
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

/** Webull-style right rail — US indices and top movers, on every page. Click a row to open it in Day Trade. */
export function MarketRail() {
  const navigate = useNavigate();
  const [data, setData] = useState<MarketOverview | null>(null);
  const [p, setPrefs] = usePrefs();
  const tab: Tab = p.railTab;
  const setTab = (t: Tab) => setPrefs({ railTab: t });
  const collapsed = p.railCollapsed;
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await daytradeApi.getMarket();
      setData(res.data);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const toggle = () => setPrefs({ railCollapsed: !collapsed });

  if (collapsed) {
    return (
      <aside className="w-8 flex-shrink-0 bg-panel border-l border-border flex flex-col items-center pt-2 sticky top-0 h-[calc(100vh-48px)]">
        <button onClick={toggle} title="Show market rail" className="text-gray-400 hover:text-white text-xs">◀</button>
        <span className="mt-4 text-[10px] text-gray-500 [writing-mode:vertical-rl] tracking-widest">MARKETS</span>
      </aside>
    );
  }

  const rows: RailQuote[] = data?.[tab] ?? [];

  return (
    <aside className="w-64 flex-shrink-0 bg-panel border-l border-border flex flex-col sticky top-0 h-[calc(100vh-48px)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-[11px] font-semibold text-gray-300 tracking-wider">MARKETS</span>
        <button onClick={toggle} title="Hide" className="text-gray-500 hover:text-white text-xs">▶</button>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border border-b border-border">
        {(data?.indices ?? []).map((i) => (
          <button key={i.symbol} onClick={() => navigate(`/?symbol=${i.symbol}`)}
            className="bg-panel px-2 py-1.5 text-left hover:bg-surface">
            <div className="text-[10px] text-gray-500">{i.label}</div>
            <div className="flex items-baseline justify-between gap-1">
              <span className="text-xs font-mono text-white">{i.price.toFixed(2)}</span>
              <span className={`text-[10px] font-mono ${pctClass(i.change_pct)}`}>{pct(i.change_pct)}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="flex border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-1.5 text-[11px] font-medium ${tab === t.key ? 'text-white border-b-2 border-accent' : 'text-gray-500 hover:text-gray-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && !data && <p className="p-3 text-xs text-red-400">Market data unavailable — is the backend running?</p>}
        {!data && !error && <p className="p-3 text-xs text-gray-500">Loading…</p>}
        {rows.map((q) => (
          <button key={q.symbol} onClick={() => navigate(`/?symbol=${q.symbol}`)}
            className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-surface border-b border-border/50 text-left">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white font-mono">{q.symbol}</div>
              <div className="text-[10px] text-gray-500 truncate max-w-[110px]">{q.name}</div>
            </div>
            <div className="text-right">
              <div className="text-xs font-mono text-white">{fmtPrice(q.price)}</div>
              <div className="flex items-center gap-1.5 justify-end">
                <span className="text-[10px] text-gray-600">{fmtShares(q.volume)}</span>
                <span className={`text-[11px] font-mono font-semibold ${pctClass(q.change_pct)}`}>{pct(q.change_pct)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      {data && (
        <div className="px-3 py-1 text-[9px] text-gray-600 border-t border-border">
          Yahoo Finance · {new Date(data.generated_at).toLocaleTimeString()}
        </div>
      )}
    </aside>
  );
}
