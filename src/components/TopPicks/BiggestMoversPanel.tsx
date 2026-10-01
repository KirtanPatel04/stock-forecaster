import { useCallback, useEffect, useState } from 'react';
import { moversApi } from '../../api/client';
import type { Mover } from '../../types';

interface Props {
  onSelect: (ticker: string) => void;
}

type Tab = 'gainers' | 'losers';

const REFRESH_MS = 60_000;

export function BiggestMoversPanel({ onSelect }: Props) {
  const [tab, setTab] = useState<Tab>('gainers');
  const [movers, setMovers] = useState<Record<Tab, Mover[]>>({ gainers: [], losers: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await moversApi.getBiggestMovers(12);
      setMovers({ gainers: res.data.gainers, losers: res.data.losers });
      setGeneratedAt(res.data.generated_at);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load movers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const list = movers[tab];

  return (
    <div className="bg-panel border border-border rounded-lg p-3 mx-4 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-white">Biggest Movers Today</h3>
            <span className="flex items-center gap-1 text-[9px] text-gray-500">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE
            </span>
          </div>
          <p className="text-[10px] text-gray-500 mt-0.5">
            Top % gainers and losers on the TSX · stocks under C$1 and warrants hidden · refreshes every minute
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {generatedAt && (
            <span className="text-[10px] text-gray-600 whitespace-nowrap">
              {new Date(generatedAt).toLocaleTimeString()}
            </span>
          )}
          <div className="flex rounded border border-border overflow-hidden">
            {(['gainers', 'losers'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs font-semibold capitalize ${
                  tab === t
                    ? t === 'gainers' ? 'bg-green-700 text-white' : 'bg-red-700 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-2 bg-red-900/30 border border-red-700 rounded text-red-300 text-xs">{error}</div>
      )}

      {loading && list.length === 0 && (
        <div className="flex items-center gap-2 text-gray-400 text-xs py-4">
          <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          Loading today's movers…
        </div>
      )}

      {!loading && !error && list.length === 0 && (
        <p className="text-xs text-gray-500 py-3">No movers reported yet today.</p>
      )}

      {list.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {list.map((m, i) => {
            const up = m.percent_change >= 0;
            return (
              <button
                key={m.symbol}
                onClick={() => onSelect(m.symbol)}
                className={`flex-shrink-0 w-32 text-left bg-surface border border-border rounded-lg p-2.5 transition-colors ${
                  up ? 'hover:border-green-500/60' : 'hover:border-red-500/60'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] text-gray-600 font-mono">#{i + 1}</span>
                  <span className="font-mono font-bold text-white text-sm">{m.symbol.replace(/\.TO$/i, '')}</span>
                </div>
                <div className="font-mono text-xs text-gray-300">C${m.price.toFixed(2)}</div>
                <div className={`font-mono text-sm font-semibold ${up ? 'text-green-400' : 'text-red-400'}`}>
                  {up ? '+' : ''}{m.percent_change.toFixed(2)}%
                </div>
                <div className={`font-mono text-[10px] ${up ? 'text-green-500/70' : 'text-red-500/70'}`}>
                  {up ? '+' : ''}{m.change.toFixed(2)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
