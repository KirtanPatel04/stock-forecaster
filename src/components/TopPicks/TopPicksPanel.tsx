import type { TopPick } from '../../types';
import { PotentialSparkline } from './PotentialSparkline';

interface Props {
  picks: TopPick[];
  loading: boolean;
  error: string | null;
  generatedAt: string | null;
  onRefresh: () => void;
  onSelect: (ticker: string) => void;
}

export function TopPicksPanel({ picks, loading, error, generatedAt, onRefresh, onSelect }: Props) {
  return (
    <div className="bg-panel border border-border rounded-lg p-3 mx-4 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">🌙 Top Picks for Tomorrow's Open</h3>
            <span className="flex items-center gap-1 text-[9px] text-gray-500">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE
            </span>
            <span className="px-1.5 py-0.5 rounded bg-purple-900/40 border border-purple-500/40 text-purple-400 text-[9px] font-semibold tracking-wide">
              OVERNIGHT NEWS
            </span>
          </div>
          <p className="text-[10px] text-gray-500">
            Ranked by after-hours/pre-market news sentiment · gap-up candidates at tomorrow's open · <span className="text-gray-400">independent of today's intraday price action</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {generatedAt && !loading && (
            <span className="text-[10px] text-gray-600">
              scanned {new Date(generatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            className="px-3 py-1.5 bg-accent text-black text-xs font-semibold rounded hover:bg-blue-400 disabled:opacity-50"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-2 bg-red-900/30 border border-red-700 rounded text-red-300 text-xs">{error}</div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-gray-400 text-xs py-4">
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          Scanning liquid tickers for bullish news — this can take up to a minute…
        </div>
      )}

      {!loading && !error && picks.length === 0 && (
        <p className="text-xs text-gray-500 py-2">No strongly bullish after-hours setups found right now.</p>
      )}

      {!loading && picks.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {picks.map((p, i) => (
            <button
              key={p.ticker}
              onClick={() => onSelect(p.ticker)}
              className="flex-shrink-0 w-64 text-left bg-surface border border-border rounded-lg p-3 hover:border-green-500/50 transition-colors"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-gray-600 font-mono">#{i + 1}</span>
                  <span className="font-mono font-bold text-white">{p.ticker}</span>
                </div>
                {p.last_price != null && (
                  <span className="font-mono text-xs text-gray-300">${p.last_price.toFixed(2)}</span>
                )}
              </div>

              <div className="flex items-center gap-2 mb-1">
                <span className="px-1.5 py-0.5 rounded bg-green-900/40 border border-green-500/40 text-green-400 text-[10px] font-semibold">
                  +{p.expected_move_pct.toFixed(1)}% potential
                </span>
                <span className="text-[10px] text-gray-500">{p.news_count} news</span>
              </div>

              <div className="flex items-center justify-between mb-1">
                <PotentialSparkline
                  history={p.price_history}
                  lastPrice={p.last_price}
                  targetPrice={p.target_price}
                  width={155}
                  height={36}
                />
                {p.target_price != null && (
                  <span className="text-[10px] font-mono text-green-400 whitespace-nowrap">
                    → ${p.target_price.toFixed(2)}
                  </span>
                )}
              </div>

              <div className="h-1.5 bg-surface rounded-full overflow-hidden border border-border mb-2">
                <div
                  className="h-full bg-green-500 rounded-full"
                  style={{ width: `${Math.min(100, p.confidence * 100)}%` }}
                />
              </div>

              <p className="text-[10px] text-gray-400 line-clamp-2 leading-snug">{p.top_headline}</p>
              <p className="text-[9px] text-gray-600 mt-1">{p.top_source}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
