import { sentimentColor, sentimentLabel } from './chartUtils';
import type { NewsItem } from '../../types';

interface NewsMarkersProps {
  news: NewsItem[];
}

export function NewsList({ news }: NewsMarkersProps) {
  if (news.length === 0) return null;

  return (
    <div className="mt-3 space-y-1 max-h-48 overflow-y-auto pr-1">
      {news.slice(0, 20).map((n) => (
        <div
          key={n.id}
          className="flex items-start gap-2 p-2 rounded bg-panel border border-border hover:border-accent/30 transition-colors"
        >
          <div
            className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
            style={{ backgroundColor: sentimentColor(n.sentiment_score) }}
          />
          <div className="min-w-0">
            <p className="text-xs text-gray-200 leading-tight truncate">{n.headline}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-gray-500">{n.source}</span>
              <span className="text-[10px] text-gray-500">
                {new Date(n.published_at).toLocaleString('en-US', {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </span>
              {n.sentiment_score !== undefined && (
                <span
                  className="text-[10px] font-medium"
                  style={{ color: sentimentColor(n.sentiment_score) }}
                >
                  {sentimentLabel(n.sentiment_score)} ({n.sentiment_score > 0 ? '+' : ''}{n.sentiment_score?.toFixed(2)})
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
