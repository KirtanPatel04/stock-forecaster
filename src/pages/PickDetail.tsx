import { useEffect, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { quickApi, newsApi } from '../api/client';
import type { IntradayPick, NewsItem } from '../types';

interface QuickAnalysis {
  ticker: string;
  current_price: number;
  signal: string;
  signal_score: number;
  prob_up: number;
  prob_down: number;
  momentum: string;
  news_sentiment: number | null;
  technicals: {
    rsi: number;
    rsi_signal: string;
    macd: { line: number; signal: number; histogram: number; direction: string };
    ema9: number;
    ema21: number;
    ema_cross: string;
    bollinger: { upper: number; middle: number; lower: number; pct_b: number; width_pct: number };
    vwap: { vwap: number; distance_pct: number; position: string } | null;
    support_resistance: { support: number[]; resistance: number[] };
  } | null;
  ranges: {
    '15min': { low: number; high: number; expected_move_pct: number };
    '1hr': { low: number; high: number; expected_move_pct: number };
    '1d': { low: number; high: number; expected_move_pct: number };
  } | null;
}

function fmt(n: number, d = 2) {
  return n.toFixed(d);
}

function RsiBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const color = value < 30 ? 'bg-blue-400' : value > 70 ? 'bg-red-400' : 'bg-green-400';
  const label = value < 30 ? 'Oversold — bounce likely' : value > 70 ? 'Overbought — caution' : 'Neutral zone';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-gray-400">RSI ({fmt(value, 0)})</span>
        <span className={value < 30 ? 'text-blue-400' : value > 70 ? 'text-red-400' : 'text-green-400'}>{label}</span>
      </div>
      <div className="h-2 bg-surface rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
        <span>0</span><span>30</span><span>70</span><span>100</span>
      </div>
    </div>
  );
}

function ProbBar({ probUp }: { probUp: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-gray-400">Momentum probability</span>
        <span className="text-green-400 font-semibold">{fmt(probUp, 0)}% up</span>
      </div>
      <div className="h-3 bg-red-900/40 rounded-full overflow-hidden">
        <div className="h-full bg-green-500/70 rounded-full transition-all" style={{ width: `${probUp}%` }} />
      </div>
      <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
        <span>Bear</span><span>50%</span><span>Bull</span>
      </div>
    </div>
  );
}

function ReasonPill({ text, color = 'green' }: { text: string; color?: 'green' | 'blue' | 'yellow' }) {
  const cls = color === 'green'
    ? 'bg-green-900/30 border-green-500/30 text-green-300'
    : color === 'blue'
    ? 'bg-blue-900/30 border-blue-500/30 text-blue-300'
    : 'bg-yellow-900/30 border-yellow-500/30 text-yellow-300';
  return (
    <div className={`text-xs rounded-lg border px-3 py-2 ${cls}`}>
      {text}
    </div>
  );
}

export function PickDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  // Pick data passed via navigation state
  const pick = location.state?.pick as (IntradayPick & {
    price: number;
    maxShares: number;
    dollarMovePerShare: number;
    expectedProfit: number;
    sharesPerK: number;
    profitPerK: number;
    hz: { expected_move_pct: number; target_price: number };
    activeHorizon: '15min' | '1hr' | '1day';
    cash: number;
    profitGoal: number;
  }) | null;

  const [analysis, setAnalysis] = useState<QuickAnalysis | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    Promise.allSettled([
      quickApi.getAnalysis(ticker),
      newsApi.getNews(ticker, 2),
    ]).then(([aRes, nRes]) => {
      if (aRes.status === 'fulfilled') setAnalysis(aRes.value.data);
      if (nRes.status === 'fulfilled') setNews(nRes.value.data.slice(0, 6));
    }).finally(() => setLoading(false));
  }, [ticker]);

  const horizonLabel = pick?.activeHorizon === '15min' ? '15 minutes'
    : pick?.activeHorizon === '1hr' ? '1 hour' : '1 day';

  // Build the "why" reasons list
  const reasons: { text: string; color: 'green' | 'blue' | 'yellow' }[] = [];
  if (pick) {
    if (pick.prob_up >= 65)
      reasons.push({ text: `${pick.prob_up}% of recent 5-min bars closed higher — strong upward pressure`, color: 'green' });
    else if (pick.prob_up >= 55)
      reasons.push({ text: `${pick.prob_up}% of recent bars closed higher — mild bullish lean`, color: 'green' });

    if (pick.accelerating)
      reasons.push({ text: 'Momentum is accelerating — recent bars moving up faster than the prior 10', color: 'green' });

    if (pick.vol_surge > 1.5)
      reasons.push({ text: `Volume surge ×${fmt(pick.vol_surge, 1)} — unusual buying activity right now`, color: 'blue' });

    if (pick.news_bonus > 0.03)
      reasons.push({ text: `Recent news is net positive (sentiment +${fmt(pick.news_bonus * 100 / 0.15, 0)}%) — boosting the score`, color: 'blue' });

    if (pick.pct_from_open < 1)
      reasons.push({ text: `Only ${fmt(pick.pct_from_open, 2)}% above today's open — still early in the move, room to run`, color: 'green' });
  }

  if (analysis?.technicals) {
    const t = analysis.technicals;
    if (t.rsi_signal === 'oversold')
      reasons.push({ text: `RSI ${fmt(t.rsi, 0)} — oversold territory, historically a strong bounce signal`, color: 'blue' });
    if (t.macd.direction === 'bullish')
      reasons.push({ text: 'MACD crossed above signal line — trend turning bullish', color: 'green' });
    if (t.ema_cross === 'bullish')
      reasons.push({ text: 'EMA 9 crossed above EMA 21 — short-term momentum is bullish', color: 'green' });
    if (t.vwap?.position === 'above')
      reasons.push({ text: `Price is ${fmt(t.vwap.distance_pct, 2)}% above VWAP — institutional buyers dominating`, color: 'green' });
  }

  const sentimentNews = news.filter((n) => (n.sentiment_score ?? 0) > 0.3);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">

      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
      >
        ← Back to Portfolio
      </button>

      {/* Hero header */}
      <div className="bg-panel border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="font-mono text-3xl font-bold text-white">{ticker}</span>
              {pick && (
                <span className="text-sm px-2.5 py-1 rounded-full bg-green-900/40 border border-green-500/40 text-green-400 font-semibold">
                  {pick.prob_up}% bullish
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500">
              Why this pick is expected to move up in the next {horizonLabel}
            </p>
          </div>
          {pick && (
            <div className="text-right">
              <div className="text-[10px] text-gray-500 mb-0.5">Current price</div>
              <div className="font-mono text-xl text-white">${fmt(pick.price)}</div>
              <div className="text-[10px] text-green-400">{pick.momentum}</div>
            </div>
          )}
        </div>
      </div>

      {/* Profit breakdown */}
      {pick && (
        <div className="bg-panel border border-green-500/30 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Profit calculation — with your ${fmt(pick.cash)} cash</h3>

          {/* Main calc */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-surface rounded-lg p-3 text-center">
              <div className="text-[10px] text-gray-500 mb-1">Shares you can buy</div>
              <div className="font-mono text-xl text-white">{pick.maxShares}</div>
              <div className="text-[10px] text-gray-500">${fmt(pick.price)}/share</div>
            </div>
            <div className="bg-surface rounded-lg p-3 text-center">
              <div className="text-[10px] text-gray-500 mb-1">Expected move ({pick.activeHorizon})</div>
              <div className="font-mono text-xl text-green-400">+{fmt(pick.hz.expected_move_pct)}%</div>
              <div className="text-[10px] text-green-500">+${fmt(pick.dollarMovePerShare)}/share</div>
            </div>
            <div className="bg-surface rounded-lg p-3 text-center border border-green-500/20 bg-green-900/10">
              <div className="text-[10px] text-gray-500 mb-1">Expected profit</div>
              <div className="font-mono text-xl text-green-400 font-bold">+${fmt(pick.expectedProfit)}</div>
              <div className="text-[10px] text-green-500">→ ${fmt(pick.hz.target_price)}/share</div>
            </div>
          </div>

          {/* Math walkthrough */}
          <div className="bg-surface/60 rounded-lg p-4 text-xs space-y-1.5 border border-border">
            <p className="text-gray-400 font-semibold mb-2">How we calculated this:</p>
            <div className="flex justify-between">
              <span className="text-gray-500">Your cash balance</span>
              <span className="font-mono text-white">${fmt(pick.cash)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">÷ Share price</span>
              <span className="font-mono text-white">÷ ${fmt(pick.price)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <span className="text-gray-400">= Shares you can buy</span>
              <span className="font-mono text-white">{pick.maxShares} shares</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">× Expected move per share</span>
              <span className="font-mono text-green-400">× +${fmt(pick.dollarMovePerShare)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <span className="text-gray-400 font-semibold">= Estimated profit</span>
              <span className="font-mono text-green-400 font-bold">+${fmt(pick.expectedProfit)}</span>
            </div>
          </div>

          {/* Horizons comparison */}
          {pick.horizons && (
            <div className="mt-4">
              <p className="text-[10px] text-gray-500 mb-2">Expected profit at each time horizon (with {pick.maxShares} shares):</p>
              <div className="grid grid-cols-3 gap-2">
                {(['15min', '1hr', '1day'] as const).map((h) => {
                  const hData = pick.horizons?.[h];
                  if (!hData) return null;
                  const move = pick.price * (hData.expected_move_pct / 100);
                  const profit = pick.maxShares * move;
                  const isActive = h === pick.activeHorizon;
                  return (
                    <div key={h} className={`rounded-lg p-3 border text-center ${isActive ? 'border-green-500/40 bg-green-900/15' : 'border-border bg-surface/50'}`}>
                      <div className="text-[10px] text-gray-500 mb-1">
                        {h === '15min' ? '15 minutes' : h === '1hr' ? '1 hour' : '1 day'}
                      </div>
                      <div className={`font-mono text-sm font-bold ${isActive ? 'text-green-400' : 'text-gray-300'}`}>
                        +${fmt(profit)}
                      </div>
                      <div className="text-[9px] text-gray-500">+{fmt(hData.expected_move_pct)}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-[10px] text-yellow-500/80 mt-3">
            This is a statistical estimate based on recent price momentum — not a guarantee. Always set a stop-loss.
          </p>
        </div>
      )}

      {/* Why it will move */}
      {loading ? (
        <div className="bg-panel border border-border rounded-xl p-5">
          <p className="text-sm text-gray-500 animate-pulse">Loading analysis...</p>
        </div>
      ) : (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Why we expect it to move up</h3>
          {reasons.length > 0 ? (
            <div className="space-y-2">
              {reasons.map((r, i) => <ReasonPill key={i} text={r.text} color={r.color} />)}
            </div>
          ) : (
            <p className="text-xs text-gray-500">Analysis loading — try refreshing in a moment.</p>
          )}
        </div>
      )}

      {/* Technical signals */}
      {analysis?.technicals && (
        <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
          <h3 className="text-sm font-semibold text-white">Technical signals</h3>

          <ProbBar probUp={pick?.prob_up ?? analysis.prob_up} />
          <RsiBar value={analysis.technicals.rsi} />

          {/* MACD + EMA row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface rounded-lg p-3">
              <div className="text-[10px] text-gray-500 mb-1.5">MACD</div>
              <div className={`text-sm font-semibold ${analysis.technicals.macd.direction === 'bullish' ? 'text-green-400' : analysis.technicals.macd.direction === 'bearish' ? 'text-red-400' : 'text-gray-400'}`}>
                {analysis.technicals.macd.direction === 'bullish' ? '▲ Bullish crossover' : analysis.technicals.macd.direction === 'bearish' ? '▼ Bearish' : '— Neutral'}
              </div>
              <div className="text-[10px] text-gray-500 mt-1">
                Hist: {analysis.technicals.macd.histogram > 0 ? '+' : ''}{fmt(analysis.technicals.macd.histogram, 4)}
              </div>
            </div>
            <div className="bg-surface rounded-lg p-3">
              <div className="text-[10px] text-gray-500 mb-1.5">EMA 9 / 21</div>
              <div className={`text-sm font-semibold ${analysis.technicals.ema_cross === 'bullish' ? 'text-green-400' : analysis.technicals.ema_cross === 'bearish' ? 'text-red-400' : 'text-gray-400'}`}>
                {analysis.technicals.ema_cross === 'bullish' ? '▲ Golden cross' : analysis.technicals.ema_cross === 'bearish' ? '▼ Death cross' : '— Neutral'}
              </div>
              <div className="text-[10px] text-gray-500 mt-1">
                EMA9 {fmt(analysis.technicals.ema9, 2)} / EMA21 {fmt(analysis.technicals.ema21, 2)}
              </div>
            </div>
          </div>

          {/* VWAP */}
          {analysis.technicals.vwap && (
            <div className="bg-surface rounded-lg p-3">
              <div className="text-[10px] text-gray-500 mb-1">VWAP (session anchor)</div>
              <div className="flex items-center justify-between">
                <div>
                  <span className={`text-sm font-semibold ${analysis.technicals.vwap.position === 'above' ? 'text-green-400' : analysis.technicals.vwap.position === 'below' ? 'text-red-400' : 'text-gray-400'}`}>
                    {analysis.technicals.vwap.position === 'above' ? `▲ Price is above VWAP` : analysis.technicals.vwap.position === 'below' ? '▼ Price is below VWAP' : '= At VWAP'}
                  </span>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    VWAP: ${fmt(analysis.technicals.vwap.vwap)} · distance: {analysis.technicals.vwap.distance_pct > 0 ? '+' : ''}{fmt(analysis.technicals.vwap.distance_pct, 2)}%
                  </div>
                </div>
                <div className="text-[10px] text-gray-500 text-right max-w-[140px]">
                  {analysis.technicals.vwap.position === 'above'
                    ? 'Buyers in control — institutional money supporting the price'
                    : 'Sellers in control — may need to reclaim VWAP for sustained move'}
                </div>
              </div>
            </div>
          )}

          {/* Support / resistance */}
          {(analysis.technicals.support_resistance.resistance.length > 0 ||
            analysis.technicals.support_resistance.support.length > 0) && (
            <div className="bg-surface rounded-lg p-3">
              <div className="text-[10px] text-gray-500 mb-2">Key price levels</div>
              <div className="flex gap-6 flex-wrap">
                {analysis.technicals.support_resistance.resistance.length > 0 && (
                  <div>
                    <div className="text-[9px] text-red-400 mb-1 uppercase tracking-wider">Resistance (sell pressure)</div>
                    {analysis.technicals.support_resistance.resistance.slice(0, 2).map((r) => (
                      <div key={r} className="font-mono text-xs text-red-300">${fmt(r)}</div>
                    ))}
                  </div>
                )}
                {analysis.technicals.support_resistance.support.length > 0 && (
                  <div>
                    <div className="text-[9px] text-green-400 mb-1 uppercase tracking-wider">Support (buy pressure)</div>
                    {analysis.technicals.support_resistance.support.slice(0, 2).map((s) => (
                      <div key={s} className="font-mono text-xs text-green-300">${fmt(s)}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Bullish news */}
      {sentimentNews.length > 0 && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Positive news driving the move</h3>
          <div className="space-y-3">
            {sentimentNews.map((n) => (
              <div key={n.id} className="bg-surface rounded-lg p-3 border border-border">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white leading-relaxed">{n.headline}</p>
                    {n.summary && n.summary !== n.headline && (
                      <p className="text-[10px] text-gray-500 mt-1 leading-relaxed line-clamp-2">{n.summary}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[9px] text-gray-600">{n.source}</span>
                      {n.sentiment_score != null && (
                        <span className="text-[9px] text-green-400">
                          sentiment +{fmt(n.sentiment_score * 100, 0)}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All recent news */}
      {news.length > sentimentNews.length && (
        <div className="bg-panel border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-3">All recent news</h3>
          <div className="space-y-2">
            {news.map((n) => {
              const sent = n.sentiment_score ?? 0;
              const sentColor = sent > 0.2 ? 'text-green-400' : sent < -0.2 ? 'text-red-400' : 'text-gray-500';
              return (
                <div key={n.id} className="flex items-start gap-2 py-2 border-b border-border last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-300 leading-relaxed">{n.headline}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[9px] text-gray-600">{n.source}</span>
                      {n.sentiment_score != null && (
                        <span className={`text-[9px] ${sentColor}`}>
                          {sent > 0 ? '+' : ''}{fmt(sent * 100, 0)}% sentiment
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Risk disclaimer */}
      <div className="bg-yellow-900/10 border border-yellow-500/20 rounded-xl p-4">
        <p className="text-[10px] text-yellow-400/80 leading-relaxed">
          <span className="font-semibold">Risk reminder:</span> These projections are based on statistical momentum patterns and sentiment signals — they are estimates, not predictions. Stocks can move in any direction at any time. Never invest more than you can afford to lose, and always use stop-losses to protect your capital.
        </p>
      </div>

    </div>
  );
}
