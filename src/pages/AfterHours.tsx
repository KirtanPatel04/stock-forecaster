import { useState } from 'react';
import { afterHoursApi } from '../api/client';
import type { AfterHoursReport } from '../types';

export function AfterHours() {
  const [ticker, setTicker] = useState('');
  const [report, setReport] = useState<AfterHoursReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = async () => {
    if (!ticker) return;
    setLoading(true);
    setError(null);
    try {
      const res = await afterHoursApi.getReport(ticker.toUpperCase());
      setReport(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch report');
    } finally {
      setLoading(false);
    }
  };

  const leanColor = {
    bullish: 'text-green-400',
    bearish: 'text-red-400',
    neutral: 'text-gray-400',
  }[report?.lean ?? 'neutral'];

  const leanBg = {
    bullish: 'bg-green-900/20 border-green-700/40',
    bearish: 'bg-red-900/20 border-red-700/40',
    neutral: 'bg-gray-800 border-gray-600/40',
  }[report?.lean ?? 'neutral'];

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <h1 className="text-xl font-bold text-white mb-4">After-Hours / Pre-Market Analysis</h1>

      <div className="flex gap-3 mb-6">
        <input
          className="bg-panel border border-border rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent"
          placeholder="Ticker (e.g. NVDA)"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && fetchReport()}
        />
        <button
          className="px-4 py-2 bg-accent text-black text-sm font-semibold rounded hover:bg-blue-400 disabled:opacity-50"
          onClick={fetchReport}
          disabled={loading || !ticker}
        >
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-700 rounded text-red-300 text-sm mb-4">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-3 text-gray-400">
          <div className="animate-spin w-5 h-5 border-2 border-accent border-t-transparent rounded-full" />
          <span className="text-sm">Analyzing news, earnings, filings, and macro events…</span>
        </div>
      )}

      {report && (
        <div className="space-y-4">
          {/* Lean card */}
          <div className={`p-4 border rounded-lg ${leanBg}`}>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs text-gray-400 uppercase">Lean</span>
                <div className={`text-3xl font-bold uppercase ${leanColor}`}>{report.lean}</div>
              </div>
              <div className="text-right">
                <span className="text-xs text-gray-400 uppercase">Probability of positive open</span>
                <div className="text-2xl font-mono font-bold text-white">
                  {(report.probability * 100).toFixed(0)}%
                </div>
              </div>
              <div className="text-right">
                <span className="text-xs text-gray-400 uppercase">Expected range</span>
                <div className="text-lg font-mono text-white">
                  ${report.expected_low.toFixed(2)} – ${report.expected_high.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* Key reasons */}
          <div className="bg-panel border border-border rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Key Reasons</h3>
            <ul className="space-y-2">
              {report.key_reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                  <span className="text-accent mt-0.5">›</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>

          {/* Summary */}
          {report.full_report.summary && (
            <div className="bg-panel border border-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Summary</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{report.full_report.summary}</p>
            </div>
          )}

          {/* Data sources */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-panel border border-border rounded-lg p-3">
              <h4 className="text-xs text-gray-400 uppercase mb-2">Price Context</h4>
              <p className="text-xs text-gray-300 font-mono">{report.full_report.price_context}</p>
            </div>
            <div className="bg-panel border border-border rounded-lg p-3">
              <h4 className="text-xs text-gray-400 uppercase mb-2">Data Used</h4>
              <div className="text-xs text-gray-400 space-y-1">
                <div>News items analyzed: <span className="text-white">{report.full_report.news_count}</span></div>
                <div>SEC 8-K filings: <span className="text-white">{report.full_report.sec_filings}</span></div>
                {report.full_report.upcoming_earnings && (
                  <div>Next earnings: <span className="text-yellow-400">{report.full_report.upcoming_earnings}</span></div>
                )}
              </div>
            </div>
          </div>

          {/* Upcoming macro */}
          {report.full_report.macro_events.length > 0 && (
            <div className="bg-panel border border-border rounded-lg p-3">
              <h4 className="text-xs text-gray-400 uppercase mb-2">Upcoming Macro Events</h4>
              <div className="flex flex-wrap gap-2">
                {report.full_report.macro_events.map((e, i) => (
                  <span key={i} className="text-xs bg-yellow-900/30 border border-yellow-700/40 text-yellow-300 px-2 py-0.5 rounded">
                    {e}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recent news */}
          {report.full_report.news_items.length > 0 && (
            <div className="bg-panel border border-border rounded-lg p-3">
              <h4 className="text-xs text-gray-400 uppercase mb-2">Recent News Headlines</h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {report.full_report.news_items.map((n, i) => (
                  <div key={i} className="text-xs">
                    <span className="text-gray-500">[{n.source}]</span>{' '}
                    <span className="text-gray-300">{n.headline}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
