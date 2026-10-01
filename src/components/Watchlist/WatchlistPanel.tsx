import type { WatchlistEntry } from '../../hooks/useWatchlist';

interface WatchlistPanelProps {
  entries: WatchlistEntry[];
  activeTicker: string | null;
  onSelect: (ticker: string) => void;
  onRemove: (ticker: string) => void;
}

function displaySymbol(ticker: string) {
  return ticker.replace(/\.TO$/i, '');
}

export function WatchlistPanel({ entries, activeTicker, onSelect, onRemove }: WatchlistPanelProps) {
  if (entries.length === 0) {
    return (
      <div className="text-center text-gray-500 text-xs py-6 px-2">
        <div className="text-2xl mb-2">★</div>
        Search a ticker and click <span className="text-accent">+ Watch</span> to save it here
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((e) => {
        const isActive = e.ticker === activeTicker;
        const up = e.priceChange !== undefined && e.priceChange > 0;
        const down = e.priceChange !== undefined && e.priceChange < 0;
        const isCA = e.ticker.toUpperCase().endsWith('.TO');
        const sym = displaySymbol(e.ticker);
        const cSym = isCA ? 'C$' : '$';

        return (
          <div
            key={e.ticker}
            onClick={() => onSelect(e.ticker)}
            className={`group flex items-center justify-between px-3 py-2 rounded cursor-pointer transition-colors ${
              isActive
                ? 'bg-accent/10 border border-accent/30'
                : 'hover:bg-surface border border-transparent'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {/* Live pulse indicator when active */}
              {isActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
              )}
              <span className={`font-mono text-sm font-semibold ${isActive ? 'text-accent' : 'text-white'}`}>
                {sym}
              </span>
              <span className={`text-[9px] px-1 rounded font-semibold ${isCA ? 'bg-red-900/60 text-red-300' : 'bg-blue-900/60 text-blue-300'}`}>
                {isCA ? 'TSX' : 'US'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {e.price !== undefined && (
                <div className="text-right">
                  <div className={`text-xs font-mono font-semibold ${up ? 'text-green-400' : down ? 'text-red-400' : 'text-white'}`}>
                    {cSym}{e.price.toFixed(2)}
                  </div>
                  {e.priceChange !== undefined && e.prevPrice && (
                    <div className={`text-[10px] font-mono ${up ? 'text-green-400' : down ? 'text-red-400' : 'text-gray-500'}`}>
                      {up ? '+' : ''}{((e.priceChange / e.prevPrice) * 100).toFixed(2)}%
                    </div>
                  )}
                </div>
              )}
              <button
                onClick={(ev) => { ev.stopPropagation(); onRemove(e.ticker); }}
                className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all text-xs px-1"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
