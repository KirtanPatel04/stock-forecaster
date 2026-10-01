import type { IntradayPick } from '../../types';

interface Props {
  picks: IntradayPick[];
  loading: boolean;
  error: string | null;
  generatedAt: string | null;
  marketOpen: boolean;
  onRefresh: () => void;
  onSelect: (ticker: string) => void;
}

function MiniSparkline({ history, pctFromOpen }: { history: number[]; pctFromOpen: number }) {
  if (history.length < 2) return null;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  const w = 80;
  const h = 28;
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  });
  const up = pctFromOpen >= 0;
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={up ? '#22c55e' : '#ef4444'}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ScoreBar({ prob }: { prob: number }) {
  const pct = Math.min(100, Math.max(0, (prob - 50) * 2)); // 50% prob = 0 width, 100% = 100 width
  return (
    <div className="h-1 bg-surface rounded-full overflow-hidden mt-1">
      <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function IntradayPicksPanel({ picks, loading, error, generatedAt, marketOpen, onRefresh, onSelect }: Props) {
  return (
    <div className="bg-panel border border-border rounded-lg p-3 mx-4 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-white">Top Picks Right Now</h3>
            <span className="flex items-center gap-1 text-[9px] text-gray-500">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE
            </span>
            <span className="px-1.5 py-0.5 rounded bg-green-900/40 border border-green-500/40 text-green-400 text-[9px] font-semibold tracking-wide">
              INTRADAY MOMENTUM
            </span>
          </div>
          <p className="text-[10px] text-gray-500 mt-0.5">
            Ranked by live price momentum · most likely to move up in the next 1-2 hours · auto-refreshes every 5 min
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {generatedAt && !loading && (
            <span className="text-[10px] text-gray-600 whitespace-nowrap">
              {new Date(generatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            className="px-3 py-1.5 bg-green-700 text-white text-xs font-semibold rounded hover:bg-green-600 disabled:opacity-50 whitespace-nowrap"
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
          <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          Scanning {25} tickers for live momentum — takes ~5 seconds…
        </div>
      )}

      {!loading && !error && picks.length === 0 && (
        <div className="py-3">
          {!marketOpen ? (
            <p className="text-xs text-gray-500">
              Market is closed (TSX: 9:30 AM – 4:00 PM ET, Mon–Fri). Intraday picks will appear once trading begins.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              No strong intraday momentum detected right now — market may be choppy. Rescans every 5 min.
            </p>
          )}
        </div>
      )}

      {!loading && picks.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {picks.map((p, i) => {
            const upFromOpen = p.pct_from_open >= 0;
            return (
              <button
                key={p.ticker}
                onClick={() => onSelect(p.ticker)}
                className="flex-shrink-0 w-52 text-left bg-surface border border-border rounded-lg p-3 hover:border-green-500/60 transition-colors"
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-gray-600 font-mono">#{i + 1}</span>
                    <span className="font-mono font-bold text-white text-sm">{p.ticker.replace(/\.TO$/i, '')}</span>
                    {p.accelerating && (
                      <span className="text-[9px] text-yellow-400 font-bold">▲</span>
                    )}
                  </div>
                  <span className="font-mono text-xs text-gray-300">C${p.current_price.toFixed(2)}</span>
                </div>

                {/* Prob up bar */}
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-[10px] text-green-400 font-semibold">{p.prob_up}% chance up</span>
                  <span className={`text-[10px] font-mono font-semibold ${upFromOpen ? 'text-green-400' : 'text-red-400'}`}>
                    {upFromOpen ? '+' : ''}{p.pct_from_open.toFixed(2)}% today
                  </span>
                </div>
                <ScoreBar prob={p.prob_up} />

                {/* Sparkline + target */}
                <div className="flex items-end justify-between mt-2 mb-1">
                  <MiniSparkline history={p.price_history} pctFromOpen={p.pct_from_open} />
                  <div className="text-right">
                    <div className="text-[9px] text-gray-500">1hr target</div>
                    <div className="text-[11px] font-mono text-green-400">C${p.target_price.toFixed(2)}</div>
                    <div className="text-[9px] text-gray-500">+{p.expected_move_pct.toFixed(1)}% est</div>
                  </div>
                </div>

                {/* Signals row */}
                <div className="flex items-center gap-1 flex-wrap mt-1">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${p.prob_up > 65 ? 'bg-green-900/50 border-green-500/50 text-green-400' : 'bg-green-900/20 border-green-500/20 text-green-500'}`}>
                    {p.momentum}
                  </span>
                  {p.accelerating && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-yellow-900/30 border border-yellow-500/30 text-yellow-400">
                      accelerating
                    </span>
                  )}
                  {p.vol_surge > 1.5 && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-900/30 border border-blue-500/30 text-blue-400">
                      {p.vol_surge.toFixed(1)}x vol
                    </span>
                  )}
                  {p.news_bonus > 0.05 && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-purple-900/30 border border-purple-500/30 text-purple-400">
                      +news
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Legend */}
      {!loading && picks.length > 0 && (
        <div className="flex items-center gap-4 mt-2 pt-2 border-t border-border">
          <span className="text-[9px] text-gray-600">▲ = momentum accelerating</span>
          <span className="text-[9px] text-gray-600">vol = volume surge vs avg</span>
          <span className="text-[9px] text-gray-600">+news = bullish news this session</span>
          <span className="text-[9px] text-gray-600">Click any pick to open its chart</span>
        </div>
      )}
    </div>
  );
}
