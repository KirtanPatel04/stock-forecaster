import { useState, useCallback, useEffect, useRef } from 'react';
import { LiveChart } from '../components/Chart/LiveChart';
import { NewsList } from '../components/Chart/NewsMarkers';
import { WatchlistPanel } from '../components/Watchlist/WatchlistPanel';
import { TopPicksPanel } from '../components/TopPicks/TopPicksPanel';
import { IntradayPicksPanel } from '../components/TopPicks/IntradayPicksPanel';
import { BiggestMoversPanel } from '../components/TopPicks/BiggestMoversPanel';
import { stocksApi, newsApi, quickApi, moversApi } from '../api/client';
import type { SearchResult } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';
import { useWatchlist } from '../hooks/useWatchlist';
import { usePortfolio } from '../hooks/usePortfolio';
import type { PriceBar, NewsItem, WSMessage, ForecastResponse, TopPick, IntradayPick } from '../types';

interface QuickAnalysis {
  ticker: string;
  current_price: number;
  signal: 'BUY' | 'HOLD' | 'SELL';
  signal_score: number;
  prob_up: number;
  prob_down: number;
  momentum: string;
  news_sentiment: number | null;
  technicals: {
    rsi: number;
    rsi_signal: 'oversold' | 'neutral' | 'overbought';
    macd: { line: number; signal: number; histogram: number; direction: 'bullish' | 'bearish' | 'neutral' };
    ema9: number;
    ema21: number;
    ema_cross: 'bullish' | 'bearish' | 'neutral';
    bollinger: { upper: number; middle: number; lower: number; pct_b: number; width_pct: number };
    vwap: { vwap: number; distance_pct: number; position: 'above' | 'below' | 'at' } | null;
    support_resistance: { support: number[]; resistance: number[] };
  };
  ranges: {
    '1h': { low: number; high: number; expected_move_pct: number };
    eod: { low: number; high: number; expected_move_pct: number };
    '1d': { low: number; high: number; expected_move_pct: number };
  };
  buy_analysis: {
    buy_price: number;
    current_price: number;
    distance_pct: number;
    upside_1d: number;
    downside_1d: number;
    risk_reward: number | null;
    signal: 'BUY' | 'WAIT' | 'NEUTRAL';
    signal_color: string;
  } | null;
}

interface PeriodSummary {
  open: number; close: number; high: number; low: number;
  change_pct: number; volume: number;
}

interface StockSummary {
  ticker: string;
  current_price: number;
  periods: Record<string, PeriodSummary | null>;
}

const PERIODS = ['1D', '1W', '1M', '3M', '1Y'];

export function Home() {
  const [ticker, setTicker] = useState('');
  const [activeTicker, setActiveTicker] = useState<string | null>(null);
  const [liveBars, setLiveBars] = useState<PriceBar[]>([]);   // 1D WebSocket bars
  const [chartBars, setChartBars] = useState<PriceBar[]>([]); // bars for selected period
  const [chartTimeframe, setChartTimeframe] = useState('1Min');
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const [positionMode, setPositionMode] = useState<'buy' | 'own'>('buy');
  const [buyPriceInput, setBuyPriceInput] = useState('');
  const [sharesInput, setSharesInput] = useState('');
  const [committedBuyPrice, setCommittedBuyPrice] = useState<number | null>(null);
  const [committedShares, setCommittedShares] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<QuickAnalysis | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [lockedForecast, setLockedForecast] = useState<ForecastResponse | null>(null);
  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [activePeriod, setActivePeriod] = useState('1D');
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [polledPrice, setPolledPrice] = useState<number | null>(null);
  const priceTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [usdCadRate, setUsdCadRate] = useState<number | null>(null);
  const [stockCurrency, setStockCurrency] = useState<'CAD' | 'USD'>('CAD');

  const PERIOD_CONFIG: Record<string, { timeframe: string; limit: number; daysBack: number }> = {
    '1D': { timeframe: '1Min',  limit: 390,  daysBack: 2   },
    '1W': { timeframe: '15Min', limit: 500,  daysBack: 8   },
    '1M': { timeframe: '1Hour', limit: 200,  daysBack: 35  },
    '3M': { timeframe: '1Day',  limit: 90,   daysBack: 95  },
    '1Y': { timeframe: '1Day',  limit: 365,  daysBack: 370 },
  };

  const analysisIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const forecastIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const barRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { entries, add: addToWatchlist, remove: removeFromWatchlist, getLastTicker, setLastTicker } = useWatchlist();
  const isWatched = activeTicker ? entries.some((e) => e.ticker === activeTicker) : false;
  const { addHolding: addToPortfolio, portfolio: pf } = usePortfolio();
  const [buyConfirmed, setBuyConfirmed] = useState(false);

  const [topPicks, setTopPicks] = useState<TopPick[]>([]);
  const [topPicksLoading, setTopPicksLoading] = useState(false);
  const [topPicksError, setTopPicksError] = useState<string | null>(null);
  const [topPicksGeneratedAt, setTopPicksGeneratedAt] = useState<string | null>(null);

  const [intradayPicks, setIntradayPicks] = useState<IntradayPick[]>([]);
  const [intradayLoading, setIntradayLoading] = useState(false);
  const [intradayError, setIntradayError] = useState<string | null>(null);
  const [intradayGeneratedAt, setIntradayGeneratedAt] = useState<string | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const intradayIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scanTopPicks = useCallback(async () => {
    setTopPicksLoading(true);
    setTopPicksError(null);
    try {
      const watchlistTickers = entries.map((e) => e.ticker);
      const maxPrice = pf.cash > 0 ? pf.cash : undefined;
      const res = await moversApi.getTopPicks(8, watchlistTickers, maxPrice);
      setTopPicks(res.data.picks);
      setTopPicksGeneratedAt(res.data.generated_at);
    } catch (e: unknown) {
      setTopPicksError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setTopPicksLoading(false);
    }
  }, [entries, pf.cash]);

  const scanIntradayPicks = useCallback(async () => {
    setIntradayLoading(true);
    setIntradayError(null);
    try {
      const watchlistTickers = entries.map((e) => e.ticker);
      const maxPrice = pf.cash > 0 ? pf.cash : undefined;
      const res = await moversApi.getIntradayPicks(8, watchlistTickers, maxPrice);
      setIntradayPicks(res.data.picks);
      setIntradayGeneratedAt(res.data.generated_at);
      setMarketOpen(res.data.market_open);
    } catch (e: unknown) {
      setIntradayError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setIntradayLoading(false);
    }
  }, [entries]);

  useEffect(() => {
    scanTopPicks();
    scanIntradayPicks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Intraday picks refresh every 5 minutes — momentum changes fast
  useEffect(() => {
    if (intradayIntervalRef.current) clearInterval(intradayIntervalRef.current);
    intradayIntervalRef.current = setInterval(scanIntradayPicks, 5 * 60_000);
    return () => { if (intradayIntervalRef.current) clearInterval(intradayIntervalRef.current); };
  }, [scanIntradayPicks]);

  // Full rescan every 30 minutes — sentiment is cached in DB so more frequent rescans don't help much
  const topPicksRescanRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (topPicksRescanRef.current) clearInterval(topPicksRescanRef.current);
    topPicksRescanRef.current = setInterval(scanTopPicks, 30 * 60_000);
    return () => { if (topPicksRescanRef.current) clearInterval(topPicksRescanRef.current); };
  }, [scanTopPicks]);

  // Lightweight live price tick between rescans — keeps sparklines & prices current
  const topPicksTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (topPicksTickRef.current) clearInterval(topPicksTickRef.current);
    if (topPicks.length === 0) return;
    topPicksTickRef.current = setInterval(async () => {
      const updates = await Promise.all(
        topPicks.map(async (p) => {
          try {
            const res = await stocksApi.getPrice(p.ticker);
            return { ticker: p.ticker, price: res.data.price };
          } catch {
            return null;
          }
        })
      );
      setTopPicks((prev) => prev.map((p) => {
        const u = updates.find((x) => x && x.ticker === p.ticker);
        if (!u || u.price == null) return p;
        const movePct = p.expected_move_pct / 100;
        return {
          ...p,
          last_price: u.price,
          price_history: [...p.price_history.slice(-23), u.price],
          target_price: Math.round(u.price * (1 + movePct) * 100) / 100,
        };
      }));
    }, 30_000);
    return () => { if (topPicksTickRef.current) clearInterval(topPicksTickRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topPicks.map((p) => p.ticker).join(',')]);

  const handleWSMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'history') {
      setLiveBars(msg.data);
      setChartBars(msg.data);
    } else if (msg.type === 'bar') {
      const update = (prev: PriceBar[]) => {
        const exists = prev.some((b) => b.timestamp === msg.data.timestamp);
        if (exists) return prev.map((b) => b.timestamp === msg.data.timestamp ? msg.data : b);
        return [...prev.slice(-499), msg.data];
      };
      setLiveBars(update);
      // Only update chart if on 1D view
      setActivePeriod((ap) => { if (ap === '1D') setChartBars(update); return ap; });
    } else if (msg.type === 'news') {
      setNews((prev) => prev.some((n) => n.id === msg.data.id) ? prev : [msg.data, ...prev].slice(0, 50));
    }
  }, []);

  useWebSocket(activeTicker, handleWSMessage);

  const runAnalysis = useCallback(async (sym: string, buyPrice?: number) => {
    setAnalysisLoading(true);
    try {
      const res = await quickApi.getAnalysis(sym, buyPrice);
      setAnalysis(res.data);
      // Analysis already refreshed the bar cache on the backend — read it without an extra Alpaca call
      const barsRes = await stocksApi.getCachedBars(sym, '1Min', 390, 2);
      if (barsRes.data.length > 0) {
        setLiveBars(barsRes.data);
        setActivePeriod((ap) => { if (ap === '1D') setChartBars(barsRes.data); return ap; });
      }
    } catch {}
    finally { setAnalysisLoading(false); }
  }, []);

  const runForecast = useCallback(async (sym: string) => {
    try {
      const res = await quickApi.getForecast(sym);
      setForecast(res.data);
    } catch {}
  }, []);

  const switchPeriod = useCallback(async (sym: string, period: string) => {
    const cfg = PERIOD_CONFIG[period];
    if (!cfg) return;
    if (period === '1D') {
      // Use the live bars already loaded
      setChartBars(liveBars);
      setChartTimeframe('1Min');
      setActivePeriod('1D');
      return;
    }
    setPeriodLoading(true);
    try {
      const res = await stocksApi.getBars(sym, cfg.timeframe, cfg.limit, cfg.daysBack);
      setChartBars(res.data);
      setChartTimeframe(cfg.timeframe);
      setActivePeriod(period);
    } catch {}
    finally { setPeriodLoading(false); }
  }, [liveBars, PERIOD_CONFIG]);

  const loadTicker = useCallback(async (sym: string, currency?: 'CAD' | 'USD') => {
    if (!sym) return;
    setLoading(true);
    setError(null);
    setSearchResults([]);
    setLiveBars([]);
    setChartBars([]);
    setNews([]);
    setAnalysis(null);
    setForecast(null);
    setLockedForecast(null);
    setSummary(null);
    setPolledPrice(null);
    setActivePeriod('1D');
    setChartTimeframe('1Min');
    // Determine currency: explicit arg > .TO suffix > default CAD
    const detectedCurrency = currency ?? (sym.toUpperCase().endsWith('.TO') ? 'CAD' : 'USD');
    setStockCurrency(detectedCurrency);
    try {
      const [barsRes, newsRes, summaryRes] = await Promise.all([
        stocksApi.getBars(sym, '1Min', 390),
        newsApi.getNews(sym, 3),
        quickApi.getSummary(sym),
      ]);
      setLiveBars(barsRes.data);
      setChartBars(barsRes.data);
      setNews(newsRes.data);
      setSummary(summaryRes.data);
      setActiveTicker(sym);
      setLastTicker(sym);
      runAnalysis(sym, committedBuyPrice || undefined);
      runForecast(sym);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally { setLoading(false); }
  }, [committedBuyPrice, runAnalysis, runForecast, setLastTicker]);

  useEffect(() => {
    const last = getLastTicker();
    if (last) { setTicker(last); loadTicker(last); }
  }, []);

  // Analysis + bar sync every 60s (1 Alpaca REST call: analysis refreshes cache, bars read from cache)
  useEffect(() => {
    if (!activeTicker) return;
    if (analysisIntervalRef.current) clearInterval(analysisIntervalRef.current);
    analysisIntervalRef.current = setInterval(() => runAnalysis(activeTicker, committedBuyPrice || undefined), 60_000);
    return () => { if (analysisIntervalRef.current) clearInterval(analysisIntervalRef.current); };
  }, [activeTicker, committedBuyPrice, runAnalysis]);

  // Forecast every 60s (was 5 min) — synced with analysis so signal always reflects latest bars
  useEffect(() => {
    if (!activeTicker) return;
    if (forecastIntervalRef.current) clearInterval(forecastIntervalRef.current);
    forecastIntervalRef.current = setInterval(() => runForecast(activeTicker), 60_000);
    return () => { if (forecastIntervalRef.current) clearInterval(forecastIntervalRef.current); };
  }, [activeTicker, runForecast]);

  // Poll live price every 15s — cheap quote call, no bar API hit
  useEffect(() => {
    if (priceTickRef.current) clearInterval(priceTickRef.current);
    if (!activeTicker) { setPolledPrice(null); return; }
    const fetchPrice = async () => {
      try {
        const res = await stocksApi.getPrice(activeTicker);
        if (res.data.price) setPolledPrice(res.data.price);
      } catch {}
    };
    fetchPrice();
    priceTickRef.current = setInterval(fetchPrice, 15_000);
    return () => { if (priceTickRef.current) clearInterval(priceTickRef.current); };
  }, [activeTicker]);

  // Live candle tick — update the current minute bar with the polled price (no API call)
  useEffect(() => {
    if (!polledPrice || liveBars.length === 0) return;
    const nowMs = Date.now();
    const currentMinuteMs = Math.floor(nowMs / 60_000) * 60_000;
    const currentMinuteISO = new Date(currentMinuteMs).toISOString().replace('.000Z', 'Z');
    setLiveBars((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const lastMinuteMs = Math.floor(new Date(last.timestamp).getTime() / 60_000) * 60_000;
      if (lastMinuteMs === currentMinuteMs) {
        // Update the current in-progress bar
        const updated = { ...last, close: polledPrice, high: Math.max(last.high, polledPrice), low: Math.min(last.low, polledPrice) };
        return [...prev.slice(0, -1), updated];
      }
      // New minute not yet received via WS — append a synthetic bar so chart stays current
      if (currentMinuteMs > lastMinuteMs) {
        const synthetic = { ...last, timestamp: currentMinuteISO, open: last.close, high: polledPrice, low: polledPrice, close: polledPrice };
        return [...prev.slice(-499), synthetic];
      }
      return prev;
    });
    setActivePeriod((ap) => {
      if (ap === '1D') {
        setChartBars((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          const lastMinuteMs = Math.floor(new Date(last.timestamp).getTime() / 60_000) * 60_000;
          if (lastMinuteMs === currentMinuteMs) {
            const updated = { ...last, close: polledPrice, high: Math.max(last.high, polledPrice), low: Math.min(last.low, polledPrice) };
            return [...prev.slice(0, -1), updated];
          }
          if (currentMinuteMs > lastMinuteMs) {
            const synthetic = { ...last, timestamp: currentMinuteISO, open: last.close, high: polledPrice, low: polledPrice, close: polledPrice };
            return [...prev.slice(-499), synthetic];
          }
          return prev;
        });
      }
      return ap;
    });
  }, [polledPrice]);

  // Fetch live USD/CAD rate once on mount, refresh every minute
  useEffect(() => {
    const fetchRate = async () => {
      try { const res = await stocksApi.getForexRate(); setUsdCadRate(res.data.rate); } catch {}
    };
    fetchRate();
    const id = setInterval(fetchRate, 60_000);
    return () => clearInterval(id);
  }, []);

  const handleSearch = async (q: string) => {
    setTicker(q);
    if (q.length < 1) { setSearchResults([]); return; }
    try { const res = await stocksApi.search(q); setSearchResults(res.data.slice(0, 6)); } catch {}
  };

  const handleSetBuyPrice = () => {
    const p = parseFloat(buyPriceInput);
    if (!activeTicker || isNaN(p)) return;
    setCommittedBuyPrice(p);
    const shares = parseFloat(sharesInput);
    setCommittedShares(!isNaN(shares) && shares > 0 ? shares : null);
    // Lock the current forecast so buy panel targets don't drift on each 60s refresh
    setLockedForecast(forecast);
    runAnalysis(activeTicker, p);
  };

  const handleConfirmBuy = useCallback(() => {
    if (!activeTicker || !committedBuyPrice) return;
    const shares = committedShares ?? 1;
    addToPortfolio({ ticker: activeTicker, shares, avgBuyPrice: committedBuyPrice });   // journal deducts the cost from cash
    setBuyConfirmed(true);
    setTimeout(() => setBuyConfirmed(false), 3000);
  }, [activeTicker, committedBuyPrice, committedShares, addToPortfolio]);

  // Prefer the polled live quote price; fall back to last bar close, then analysis
  const currentPrice = polledPrice ?? (liveBars.length ? liveBars[liveBars.length - 1].close : analysis?.current_price);
  const pnl = committedBuyPrice && currentPrice ? (currentPrice - committedBuyPrice) / committedBuyPrice * 100 : null;

  const isCanadian = stockCurrency === 'CAD';
  const currencySymbol = isCanadian ? 'C$' : '$';
  // Display ticker without .TO suffix
  const displayTicker = activeTicker?.replace(/\.TO$/i, '') ?? '';

  const signalStyle: Record<string, string> = {
    BUY: 'bg-green-900/40 border-green-500/50 text-green-400',
    'ADD MORE': 'bg-green-900/40 border-green-500/50 text-green-400',
    SELL: 'bg-red-900/40 border-red-500/50 text-red-400',
    'SELL NOW': 'bg-red-900/40 border-red-500/50 text-red-400',
    'CUT LOSS': 'bg-red-900/60 border-red-400/70 text-red-300',
    WAIT: 'bg-red-900/40 border-red-500/50 text-red-400',
    HOLD: 'bg-yellow-900/30 border-yellow-500/40 text-yellow-400',
    NEUTRAL: 'bg-yellow-900/30 border-yellow-500/40 text-yellow-400',
  };

  // Live signal from backend composite score (RSI + MACD + VWAP + Bollinger + EMA + momentum + news)
  const liveSignal = (() => {
    if (!analysis || !forecast || !forecast.forecast_points?.length || !currentPrice) return null;
    const fc1h = forecast.forecast_points.find((fp) => fp.horizon_minutes === 60);
    const fc1hPct = fc1h ? (fc1h.predicted_price - currentPrice) / currentPrice * 100 : 0;

    const signal = analysis.signal;
    const score = analysis.signal_score;
    const tech = analysis.technicals;

    let color: string;
    let reason: string;

    if (signal === 'BUY') {
      color = 'text-green-400';
      const reasons: string[] = [];
      if (analysis.prob_up > 55) reasons.push(`${analysis.prob_up}% momentum up`);
      if (tech.rsi_signal === 'oversold') reasons.push(`RSI ${tech.rsi.toFixed(1)} oversold`);
      if (tech.macd.direction === 'bullish') reasons.push('MACD bullish');
      if (tech.vwap?.position === 'below') reasons.push(`${Math.abs(tech.vwap.distance_pct).toFixed(2)}% below VWAP`);
      if (tech.ema_cross === 'bullish') reasons.push('EMA uptrend');
      reason = `Bullish: ${reasons.slice(0, 3).join(' · ')}. Forecast ${fc1hPct >= 0 ? '+' : ''}${fc1hPct.toFixed(2)}% in 1hr.`;
    } else if (signal === 'SELL') {
      color = 'text-red-400';
      const reasons: string[] = [];
      if (analysis.prob_up < 45) reasons.push(`only ${analysis.prob_up}% momentum up`);
      if (tech.rsi_signal === 'overbought') reasons.push(`RSI ${tech.rsi.toFixed(1)} overbought`);
      if (tech.macd.direction === 'bearish') reasons.push('MACD bearish');
      if (tech.vwap?.position === 'above') reasons.push(`${Math.abs(tech.vwap.distance_pct).toFixed(2)}% above VWAP`);
      if (tech.ema_cross === 'bearish') reasons.push('EMA downtrend');
      reason = `Bearish: ${reasons.slice(0, 3).join(' · ')}. Forecast ${fc1hPct >= 0 ? '+' : ''}${fc1hPct.toFixed(2)}% in 1hr.`;
    } else {
      color = 'text-yellow-400';
      reason = `Mixed signals — score ${score.toFixed(2)}, RSI ${tech.rsi.toFixed(1)}, ${analysis.prob_up}% up. Forecast ${fc1hPct >= 0 ? '+' : ''}${fc1hPct.toFixed(2)}% in 1hr. Wait for a clearer setup.`;
    }

    const howItWorks = `Composite score (${score.toFixed(2)}) from 7 factors: momentum ${analysis.prob_up}% up (weight 60%), RSI ${tech.rsi.toFixed(1)} (${tech.rsi_signal}), MACD ${tech.macd.direction}, VWAP ${tech.vwap ? tech.vwap.position + ' ' + Math.abs(tech.vwap.distance_pct).toFixed(2) + '%' : 'n/a'}, Bollinger %B ${(tech.bollinger.pct_b * 100).toFixed(0)}%, EMA cross ${tech.ema_cross}, news ${analysis.news_sentiment != null ? (analysis.news_sentiment > 0 ? '+' : '') + analysis.news_sentiment.toFixed(2) : 'n/a'}. BUY ≥ 0.25, SELL ≤ −0.25.`;

    return { signal, color, reason, howItWorks, fc1h, fc1hPct };
  })();

  // Position advice — for "I Own This" mode
  const positionAdvice = (() => {
    if (!committedBuyPrice || !currentPrice || !forecast || !forecast.forecast_points?.length) return null;

    const pnl = currentPrice - committedBuyPrice;
    const pnlPct = (pnl / committedBuyPrice) * 100;
    const totalPnl = committedShares ? pnl * committedShares : null;

    // Find the peak and trough forecast points
    const pts = [...forecast.forecast_points].sort((a, b) => a.horizon_minutes - b.horizon_minutes);
    const peakPt = pts.reduce((best, p) => p.predicted_price > best.predicted_price ? p : best, pts[0]);
    const eodPt = pts[pts.length - 1];
    const peakAboveCurrent = peakPt.predicted_price > currentPrice * 1.001;
    const eodDeclining = eodPt.predicted_price < currentPrice * 0.999;
    const forecastReachesEntry = peakPt.predicted_price >= committedBuyPrice;

    const horizonLabel = (m: number) => m < 60 ? `${m} min` : m === 60 ? '1 hr' : m === 120 ? '2 hr' : 'end of day';

    let action: 'HOLD' | 'SELL NOW' | 'CUT LOSS' | 'ADD MORE';
    let actionColor: string;
    let advice: string;
    let sellTarget: number | null = null;
    let sellWindow: string | null = null;

    if (pnl >= 0) {
      // Profitable position
      if (eodDeclining && !peakAboveCurrent) {
        action = 'SELL NOW';
        actionColor = 'text-red-400';
        advice = `You're up ${pnlPct.toFixed(2)}% but forecast shows declining momentum through end of day. Lock in your profit now.`;
        sellTarget = currentPrice;
        sellWindow = 'Now';
      } else if (peakAboveCurrent) {
        action = 'HOLD';
        actionColor = 'text-green-400';
        advice = `Forecast peaks at $${peakPt.predicted_price.toFixed(2)} in ~${horizonLabel(peakPt.horizon_minutes)}. Hold and sell near that level for maximum gain.`;
        sellTarget = peakPt.predicted_price;
        sellWindow = `~${horizonLabel(peakPt.horizon_minutes)}`;
      } else {
        action = 'HOLD';
        actionColor = 'text-yellow-400';
        advice = `Up ${pnlPct.toFixed(2)}% — forecast is flat. Hold if comfortable; take profit if you need the capital.`;
        sellTarget = eodPt.predicted_price;
        sellWindow = 'End of day';
      }
    } else {
      // Losing position
      if (forecastReachesEntry && peakAboveCurrent) {
        action = 'HOLD';
        actionColor = 'text-yellow-400';
        advice = `Down ${Math.abs(pnlPct).toFixed(2)}% from entry. Forecast projects recovery to $${peakPt.predicted_price.toFixed(2)} in ~${horizonLabel(peakPt.horizon_minutes)} — above your $${committedBuyPrice.toFixed(2)} entry. Hold for the bounce.`;
        sellTarget = committedBuyPrice;
        sellWindow = `~${horizonLabel(peakPt.horizon_minutes)}`;
      } else if (eodDeclining || analysis?.momentum === 'bearish') {
        action = 'CUT LOSS';
        actionColor = 'text-red-400';
        advice = `Down ${Math.abs(pnlPct).toFixed(2)}% and forecast shows continued weakness. Cutting the loss now protects your capital from further downside.`;
        sellTarget = currentPrice;
        sellWindow = 'Now';
      } else {
        action = 'HOLD';
        actionColor = 'text-yellow-400';
        advice = `Down ${Math.abs(pnlPct).toFixed(2)}%. Forecast doesn't show a strong recovery to your entry of $${committedBuyPrice.toFixed(2)} — reassess your thesis.`;
        sellTarget = null;
        sellWindow = null;
      }
    }

    // Add more signal: dip below entry + forecast recovering strongly
    if (pnl < 0 && peakPt.predicted_price >= committedBuyPrice && analysis?.prob_up && analysis.prob_up > 58) {
      action = 'ADD MORE';
      actionColor = 'text-green-400';
      advice = `Price dipped ${Math.abs(pnlPct).toFixed(2)}% below your entry but momentum is ${analysis.momentum} (${analysis.prob_up}% prob up). Forecast recovers to $${peakPt.predicted_price.toFixed(2)}. Adding here lowers your average.`;
    }

    return { action, actionColor, advice, pnl, pnlPct, totalPnl, sellTarget, sellWindow, peakPt, eodPt, pts };
  })();

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Watchlist sidebar */}
      <div className="w-48 flex-shrink-0 bg-panel border-r border-border flex flex-col">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Watchlist</span>
        </div>
        <div className="flex-1 overflow-y-auto py-1 px-1">
          <WatchlistPanel entries={entries} activeTicker={activeTicker}
            onSelect={(t) => { setTicker(t.replace(/\.TO$/i, '')); loadTicker(t); }} onRemove={removeFromWatchlist} />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {/* Top bar */}
        <div className="sticky top-0 z-10 bg-surface border-b border-border px-4 py-2 flex items-center gap-2">
          <div className="relative">
            <input
              className="w-36 bg-panel border border-border rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent"
              placeholder="Ticker"
              value={ticker}
              onChange={(e) => handleSearch(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') { loadTicker(ticker); setSearchResults([]); } }}
            />
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 w-72 mt-1 bg-panel border border-border rounded shadow-xl z-20">
                {searchResults.map((r) => (
                  <button key={r.symbol} className="w-full text-left px-3 py-2 text-sm hover:bg-border flex items-center gap-2"
                    onClick={() => {
                      const display = r.symbol.replace(/\.TO$/i, '');
                      setTicker(display);
                      loadTicker(r.symbol, r.currency as 'CAD' | 'USD');
                      setSearchResults([]);
                    }}>
                    <span className="text-accent font-mono font-semibold">{r.symbol.replace(/\.TO$/i, '')}</span>
                    <span className={`text-[9px] px-1 py-0.5 rounded font-semibold flex-shrink-0 ${r.exchange === 'TSX' ? 'bg-red-900/60 text-red-300' : 'bg-blue-900/60 text-blue-300'}`}>
                      {r.exchange}
                    </span>
                    <span className="text-gray-400 text-xs truncate">{r.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="px-3 py-1.5 bg-accent text-black text-sm font-semibold rounded hover:bg-blue-400 disabled:opacity-50"
            onClick={() => loadTicker(ticker)} disabled={loading || !ticker}>
            {loading ? '…' : 'Load'}
          </button>

          {activeTicker && (
            <button
              className={`px-3 py-1.5 text-sm font-semibold rounded border transition-colors ${isWatched
                ? 'bg-yellow-600/20 border-yellow-600/50 text-yellow-400'
                : 'bg-panel border-border text-gray-400 hover:border-yellow-500 hover:text-yellow-400'}`}
              onClick={() => isWatched ? removeFromWatchlist(activeTicker) : addToWatchlist(activeTicker)}>
              {isWatched ? '★ Watching' : '☆ Watch'}
            </button>
          )}

          {activeTicker && currentPrice && (
            <div className="ml-2 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-white text-lg">{displayTicker}</span>
                <span className={`text-[9px] px-1 py-0.5 rounded font-semibold ${isCanadian ? 'bg-red-900/60 text-red-300' : 'bg-blue-900/60 text-blue-300'}`}>
                  {isCanadian ? 'TSX' : 'US'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-white text-lg">{currencySymbol}{currentPrice.toFixed(2)}</span>
                {!isCanadian && usdCadRate && (
                  <span className="text-xs text-gray-400">= C${(currentPrice * usdCadRate).toFixed(2)}</span>
                )}
              </div>
              {pnl !== null && (
                <span className={`font-mono text-sm font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}% P&L
                </span>
              )}
              <span className="flex items-center gap-1 text-[10px] text-gray-500 ml-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE
              </span>
            </div>
          )}
        </div>

        <BiggestMoversPanel onSelect={(sym) => { setTicker(sym.replace(/\.TO$/i, '')); loadTicker(sym); }} />

        <IntradayPicksPanel
          picks={intradayPicks}
          loading={intradayLoading}
          error={intradayError}
          generatedAt={intradayGeneratedAt}
          marketOpen={marketOpen}
          onRefresh={scanIntradayPicks}
          onSelect={(sym) => { setTicker(sym.replace(/\.TO$/i, '')); loadTicker(sym); }}
        />

        <TopPicksPanel
          picks={topPicks}
          loading={topPicksLoading}
          error={topPicksError}
          generatedAt={topPicksGeneratedAt}
          onRefresh={scanTopPicks}
          onSelect={(sym) => { setTicker(sym.replace(/\.TO$/i, '')); loadTicker(sym); }}
        />

        {error && <div className="mx-4 mt-3 p-3 bg-red-900/30 border border-red-700 rounded text-red-300 text-sm">{error}</div>}

        {activeTicker ? (
          <div className="p-4 grid grid-cols-1 xl:grid-cols-3 gap-4">

            {/* LEFT: Chart + period summary */}
            <div className="xl:col-span-2 space-y-3">

              {/* Period tabs */}
              {summary && (
                <div className="bg-panel border border-border rounded-lg p-3">
                  <div className="flex gap-1 mb-3">
                    {PERIODS.map((p) => (
                      <button key={p}
                        onClick={() => activeTicker && switchPeriod(activeTicker, p)}
                        className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${activePeriod === p ? 'bg-accent text-black' : 'text-gray-400 hover:text-white'} ${periodLoading && activePeriod !== p ? 'opacity-50' : ''}`}>
                        {p}
                      </button>
                    ))}
                  </div>
                  {summary.periods[activePeriod] ? (() => {
                    const p = summary.periods[activePeriod]!;
                    const up = p.change_pct >= 0;
                    return (
                      <div className="grid grid-cols-4 gap-3">
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">Change</div>
                          <div className={`text-xl font-mono font-bold ${up ? 'text-green-400' : 'text-red-400'}`}>
                            {up ? '+' : ''}{p.change_pct.toFixed(2)}%
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">High</div>
                          <div className="text-sm font-mono text-white">{currencySymbol}{p.high.toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">Low</div>
                          <div className="text-sm font-mono text-white">{currencySymbol}{p.low.toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase">Open ({activePeriod})</div>
                          <div className="text-sm font-mono text-white">{currencySymbol}{p.open.toFixed(2)}</div>
                        </div>
                      </div>
                    );
                  })() : <div className="text-xs text-gray-500">No data for this period</div>}
                </div>
              )}

              {/* Chart */}
              {periodLoading ? (
                <div className="h-[460px] flex items-center justify-center bg-panel rounded-lg border border-border">
                  <div className="flex items-center gap-2 text-gray-400 text-sm">
                    <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    Loading {activePeriod} chart…
                  </div>
                </div>
              ) : (
                <LiveChart ticker={activeTicker} bars={chartBars} forecast={activePeriod === '1D' ? forecast : null} news={activePeriod === '1D' ? news : []} buyPrice={committedBuyPrice} currentPrice={activePeriod === '1D' ? currentPrice : null} timeframe={chartTimeframe} />
              )}

              {/* News */}
              <div className="bg-panel border border-border rounded-lg p-3">
                <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Recent News ({news.length})</h3>
                <NewsList news={news} />
              </div>
            </div>

            {/* RIGHT: Buy analysis */}
            <div className="space-y-3">

              {/* Buy price input */}
              {/* Position panel — Buy analysis OR Own-it tracker */}
              <div className="bg-panel border border-border rounded-lg overflow-hidden">
                {/* Mode toggle */}
                <div className="flex border-b border-border">
                  <button
                    className={`flex-1 py-2 text-xs font-semibold tracking-wide transition-colors ${positionMode === 'buy' ? 'bg-yellow-600/20 text-yellow-400 border-b-2 border-yellow-500' : 'text-gray-500 hover:text-gray-300'}`}
                    onClick={() => { setPositionMode('buy'); setCommittedBuyPrice(null); setCommittedShares(null); setBuyPriceInput(''); setSharesInput(''); setLockedForecast(null); runAnalysis(activeTicker!); }}
                  >
                    Looking to Buy
                  </button>
                  <button
                    className={`flex-1 py-2 text-xs font-semibold tracking-wide transition-colors ${positionMode === 'own' ? 'bg-blue-600/20 text-blue-400 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-300'}`}
                    onClick={() => { setPositionMode('own'); setCommittedBuyPrice(null); setCommittedShares(null); setBuyPriceInput(''); setSharesInput(''); setLockedForecast(null); runAnalysis(activeTicker!); }}
                  >
                    I Own This
                  </button>
                </div>

                <div className="p-4">
                  {positionMode === 'buy' ? (
                    <>
                      <p className="text-[10px] text-gray-500 mb-2">
                        Enter a price and shares you're considering — we'll show the forecast target and expected profit.
                        {!isCanadian && usdCadRate && <span className="text-blue-400"> USD stock · rate: 1 USD = C${usdCadRate.toFixed(4)}</span>}
                      </p>
                      <div className="flex gap-2 mb-2">
                        <input
                          className="flex-1 bg-surface border border-border rounded px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-yellow-500 placeholder-gray-600"
                          placeholder={`Buy price ${currencySymbol}`}
                          value={buyPriceInput}
                          onChange={(e) => setBuyPriceInput(e.target.value)}
                          type="number" step="0.01"
                          onKeyDown={(e) => e.key === 'Enter' && handleSetBuyPrice()}
                        />
                        <input
                          className="w-20 bg-surface border border-border rounded px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-yellow-500 placeholder-gray-600"
                          placeholder="Shares"
                          value={sharesInput}
                          onChange={(e) => setSharesInput(e.target.value)}
                          type="number" step="1"
                          onKeyDown={(e) => e.key === 'Enter' && handleSetBuyPrice()}
                        />
                        <button className="px-3 py-2 bg-yellow-600 text-black text-sm font-bold rounded hover:bg-yellow-500"
                          onClick={handleSetBuyPrice}>
                          Analyze
                        </button>
                      </div>
                      {committedBuyPrice && (lockedForecast ?? forecast)?.forecast_points?.length && currentPrice && (() => {
                        const activeForecast = lockedForecast ?? forecast!;
                        const fc1h = activeForecast.forecast_points.find((fp) => fp.horizon_minutes === 60);
                        const pts = [...activeForecast.forecast_points].sort((a, b) => a.horizon_minutes - b.horizon_minutes);
                        const eodPt = pts[pts.length - 1];
                        const peakPt = pts.reduce((best, p) => p.predicted_price > best.predicted_price ? p : best, pts[0]);
                        const shares = committedShares ?? null;
                        const totalCost = shares ? shares * committedBuyPrice : null;
                        const fc1hProfit = fc1h && shares ? (fc1h.predicted_price - committedBuyPrice) * shares : null;
                        const eodProfit = eodPt && shares ? (eodPt.predicted_price - committedBuyPrice) * shares : null;
                        const fc1hPct = fc1h ? (fc1h.predicted_price - committedBuyPrice) / committedBuyPrice * 100 : null;
                        const eodPct = eodPt ? (eodPt.predicted_price - committedBuyPrice) / committedBuyPrice * 100 : null;
                        return (
                          <div className="mt-2 bg-surface border border-yellow-500/20 rounded-lg p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-gray-500">Entry</span>
                              <div className="flex items-center gap-2 flex-wrap justify-end">
                                <span className="font-mono text-yellow-400 text-xs">{currencySymbol}{committedBuyPrice.toFixed(2)}</span>
                                {shares && <span className="text-[10px] text-gray-500">× {shares} shares</span>}
                                {totalCost && <span className="font-mono text-white text-xs">{currencySymbol}{totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                                {!isCanadian && usdCadRate && totalCost && (
                                  <span className="text-[10px] text-blue-300 font-mono">≈ C${(totalCost * usdCadRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                )}
                              </div>
                            </div>
                            {fc1h && (
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-gray-500">1hr target</span>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-white text-xs">${fc1h.predicted_price.toFixed(2)}</span>
                                  {fc1hPct !== null && (
                                    <span className={`text-[10px] font-semibold font-mono ${fc1hPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      {fc1hPct >= 0 ? '+' : ''}{fc1hPct.toFixed(2)}%
                                    </span>
                                  )}
                                  {fc1hProfit !== null && (
                                    <span className={`text-[10px] font-mono ${fc1hProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      ({fc1hProfit >= 0 ? '+' : ''}${fc1hProfit.toFixed(2)})
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                            {eodPt && (
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-gray-500">EOD target</span>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-white text-xs">${eodPt.predicted_price.toFixed(2)}</span>
                                  {eodPct !== null && (
                                    <span className={`text-[10px] font-semibold font-mono ${eodPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      {eodPct >= 0 ? '+' : ''}{eodPct.toFixed(2)}%
                                    </span>
                                  )}
                                  {eodProfit !== null && (
                                    <span className={`text-[10px] font-mono ${eodProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      ({eodProfit >= 0 ? '+' : ''}${eodProfit.toFixed(2)})
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                            {peakPt && peakPt.horizon_minutes !== (eodPt?.horizon_minutes) && (() => {
                              const peakPct = (peakPt.predicted_price - committedBuyPrice) / committedBuyPrice * 100;
                              const peakProfit = shares ? (peakPt.predicted_price - committedBuyPrice) * shares : null;
                              const peakLabel = peakPt.horizon_minutes === 15 ? '15 min' : peakPt.horizon_minutes === 60 ? '1 hr' : peakPt.horizon_minutes === 120 ? '2 hr' : 'EOD';
                              return (
                                <div className="flex items-center justify-between border-t border-border pt-2">
                                  <span className="text-[10px] text-yellow-400/70">Peak (~{peakLabel})</span>
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-white text-xs">${peakPt.predicted_price.toFixed(2)}</span>
                                    <span className={`text-[10px] font-semibold font-mono ${peakPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      {peakPct >= 0 ? '+' : ''}{peakPct.toFixed(2)}%
                                    </span>
                                    {peakProfit !== null && (
                                      <span className={`text-[10px] font-mono ${peakProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        ({peakProfit >= 0 ? '+' : ''}${peakProfit.toFixed(2)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })()}
                            <div className="flex items-center justify-between pt-1 border-t border-border mt-1">
                              <button className="text-[10px] text-gray-600 hover:text-red-400" onClick={() => { setCommittedBuyPrice(null); setCommittedShares(null); setBuyPriceInput(''); setSharesInput(''); setBuyConfirmed(false); setLockedForecast(null); runAnalysis(activeTicker!); }}>✕ clear</button>
                              {buyConfirmed ? (
                                <span className="text-[11px] text-green-400 font-semibold">✓ Added to portfolio!</span>
                              ) : (
                                <button
                                  className="px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs font-bold rounded transition-colors"
                                  onClick={handleConfirmBuy}
                                >
                                  ✓ Confirm Buy → Add to Portfolio
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </>
                  ) : (
                    <>
                      <p className="text-[10px] text-gray-500 mb-2">Enter what you paid — we'll track your P&L live and tell you when the forecast says to hold, sell, or add more.</p>
                      <div className="flex gap-2 mb-2">
                        <input
                          className="flex-1 bg-surface border border-border rounded px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500 placeholder-gray-600"
                          placeholder="I bought at $"
                          value={buyPriceInput}
                          onChange={(e) => setBuyPriceInput(e.target.value)}
                          type="number" step="0.01"
                          onKeyDown={(e) => e.key === 'Enter' && handleSetBuyPrice()}
                        />
                        <input
                          className="w-20 bg-surface border border-border rounded px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500 placeholder-gray-600"
                          placeholder="Shares"
                          value={sharesInput}
                          onChange={(e) => setSharesInput(e.target.value)}
                          type="number" step="1"
                          onKeyDown={(e) => e.key === 'Enter' && handleSetBuyPrice()}
                        />
                        <button className="px-3 py-2 bg-blue-600 text-white text-sm font-bold rounded hover:bg-blue-500"
                          onClick={handleSetBuyPrice}>
                          Track
                        </button>
                      </div>
                      {committedBuyPrice && currentPrice && (
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className="text-gray-500">
                            Entry <span className="text-white font-mono">${committedBuyPrice.toFixed(2)}</span>
                            {committedShares && <span className="text-gray-500"> · {committedShares} shares</span>}
                          </span>
                          <button className="text-gray-600 hover:text-red-400" onClick={() => { setCommittedBuyPrice(null); setCommittedShares(null); setBuyPriceInput(''); setSharesInput(''); setLockedForecast(null); runAnalysis(activeTicker!); }}>✕ clear</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Position tracker — live P&L + forecast-based advice (I Own This mode) */}
              {positionMode === 'own' && positionAdvice && currentPrice && (
                <div className="bg-panel border border-border rounded-lg overflow-hidden">
                  {/* P&L header */}
                  <div className={`px-4 py-3 border-b border-border ${positionAdvice.pnl >= 0 ? 'bg-green-900/20' : 'bg-red-900/20'}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Your Position</div>
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-mono text-white text-lg">{currencySymbol}{currentPrice.toFixed(2)}</span>
                          {!isCanadian && usdCadRate && (
                            <span className="text-xs text-blue-300 font-mono">C${(currentPrice * usdCadRate).toFixed(2)}</span>
                          )}
                          <span className={`font-mono text-sm font-semibold ${positionAdvice.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {positionAdvice.pnl >= 0 ? '+' : ''}{positionAdvice.pnlPct.toFixed(2)}%
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        {positionAdvice.totalPnl !== null ? (
                          <>
                            <div className="text-[10px] text-gray-500 mb-0.5">Total P&L</div>
                            <div className={`font-mono font-bold text-base ${positionAdvice.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {positionAdvice.totalPnl >= 0 ? '+' : ''}${positionAdvice.totalPnl.toFixed(2)}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-[10px] text-gray-500 mb-0.5">Per share</div>
                            <div className={`font-mono font-bold text-base ${positionAdvice.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {positionAdvice.pnl >= 0 ? '+' : ''}${positionAdvice.pnl.toFixed(2)}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Recommendation */}
                  <div className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Forecast Recommendation</div>
                        <div className={`text-xl font-bold ${positionAdvice.actionColor}`}>{positionAdvice.action}</div>
                      </div>
                      {positionAdvice.sellTarget && (
                        <div className="text-right">
                          <div className="text-[10px] text-gray-500 mb-0.5">
                            {positionAdvice.action === 'CUT LOSS' || positionAdvice.action === 'SELL NOW' ? 'Exit at' : 'Target sell'}
                          </div>
                          <div className="font-mono text-white text-sm">${positionAdvice.sellTarget.toFixed(2)}</div>
                          {positionAdvice.sellWindow && (
                            <div className="text-[10px] text-gray-500">{positionAdvice.sellWindow}</div>
                          )}
                        </div>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-300 leading-snug mb-3">{positionAdvice.advice}</p>

                    {/* Forecast path relative to entry */}
                    <div className="space-y-1.5">
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider">Forecast vs Your Entry</div>
                      {positionAdvice.pts.filter((fp) => [15, 60, 120, 390].includes(fp.horizon_minutes)).map((fp) => {
                        const vsEntry = fp.predicted_price - committedBuyPrice!;
                        const vsEntryPct = vsEntry / committedBuyPrice! * 100;
                        const label = fp.horizon_minutes === 15 ? '15 min' : fp.horizon_minutes === 60 ? '1 hr' : fp.horizon_minutes === 120 ? '2 hr' : 'EOD';
                        const isPeak = fp.horizon_minutes === positionAdvice.peakPt.horizon_minutes;
                        return (
                          <div key={fp.horizon_minutes} className={`flex items-center justify-between text-xs rounded px-2 py-1 ${isPeak ? 'bg-white/5 border border-white/10' : ''}`}>
                            <span className="text-gray-500 w-12">{label}</span>
                            <span className="font-mono text-white">${fp.predicted_price.toFixed(2)}</span>
                            <span className={`font-mono font-semibold w-20 text-right ${vsEntry >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {vsEntry >= 0 ? '+' : ''}{vsEntryPct.toFixed(2)}% from entry
                            </span>
                            {isPeak && <span className="text-[9px] text-yellow-400 ml-1">peak</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Live Signal — always visible, updates every 60s */}
              {analysisLoading && !liveSignal && (
                <div className="bg-panel border border-border rounded-lg p-4 flex items-center gap-2 text-gray-400 text-sm">
                  <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                  Analyzing live data…
                </div>
              )}

              {liveSignal && (
                <div className={`border rounded-lg p-4 ${signalStyle[liveSignal.signal]}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="text-[10px] uppercase tracking-wider opacity-60">Live Signal</span>
                      <div className={`text-2xl font-bold ${liveSignal.color}`}>{liveSignal.signal}</div>
                    </div>
                    {liveSignal.fc1h && currentPrice && (
                      <div className="text-right">
                        <div className="text-[10px] text-gray-500 mb-0.5">1hr target</div>
                        <div className="font-mono text-sm text-white">${liveSignal.fc1h.predicted_price.toFixed(2)}</div>
                        <div className={`font-mono text-xs font-semibold ${liveSignal.fc1hPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {liveSignal.fc1hPct >= 0 ? '+' : ''}{liveSignal.fc1hPct.toFixed(2)}%
                        </div>
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] opacity-80 leading-snug mb-2">{liveSignal.reason}</p>
                  <details className="group">
                    <summary className="text-[10px] opacity-50 cursor-pointer hover:opacity-80 select-none">How this is calculated ▸</summary>
                    <p className="text-[10px] opacity-60 leading-snug mt-1">{liveSignal.howItWorks}</p>
                  </details>
                </div>
              )}

              {/* Buy price entry signal (when user enters a price) */}
              {analysis && !analysisLoading && analysis.buy_analysis && (
                <div className={`border rounded-lg p-4 ${signalStyle[analysis.buy_analysis.signal]}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase tracking-wider opacity-70">Entry Analysis</span>
                    <span className="text-2xl font-bold">{analysis.buy_analysis.signal}</span>
                  </div>
                  <div className="text-xs space-y-1 opacity-80">
                    <div className="flex justify-between">
                      <span>Risk/Reward</span>
                      <span className="font-mono">
                        {analysis.buy_analysis.risk_reward == null ? '—' : `${analysis.buy_analysis.risk_reward.toFixed(2)}x`}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Upside (1d)</span>
                      <span className="font-mono text-green-400">+${analysis.buy_analysis.upside_1d.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Downside (1d)</span>
                      {analysis.buy_analysis.downside_1d <= 0
                        ? <span className="font-mono text-green-400">Below expected floor</span>
                        : <span className="font-mono text-red-400">-${analysis.buy_analysis.downside_1d.toFixed(2)}</span>
                      }
                    </div>
                  </div>
                </div>
              )}

              {analysis && !analysisLoading && (() => {
                const isTopPick = topPicks.some((p) => p.ticker === activeTicker);
                const intradayBearish = analysis.momentum === 'bearish' || analysis.prob_down > 55;
                return isTopPick && intradayBearish ? (
                  <div className="bg-purple-900/20 border border-purple-500/40 rounded-lg p-3">
                    <div className="flex items-start gap-2">
                      <div>
                        <p className="text-[11px] text-purple-300 font-semibold mb-0.5">Two different signals, two different time horizons</p>
                        <p className="text-[10px] text-purple-400/80 leading-snug">
                          The <span className="text-blue-400">intraday forecast below</span> reflects today's price momentum — it's bearish right now.
                          The <span className="text-purple-300">Top Picks rank</span> is based on overnight news sentiment and targets tomorrow's open gap.
                          A stock can dip today and still gap up tomorrow on bullish news.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null;
              })()}

              {analysis && !analysisLoading && (
                <>

                  {/* Probability */}
                  <div className="bg-panel border border-border rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="text-xs text-gray-400 uppercase">Price Direction Probability</div>
                      <span className="px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-500/40 text-blue-400 text-[9px] font-semibold tracking-wide">INTRADAY</span>
                    </div>
                    <p className="text-[10px] text-gray-600 mb-3">Based on the last 30 bars of price momentum · today's session only</p>
                    <div className="flex items-end gap-2 mb-2">
                      <div className="flex-1">
                        <div className="text-[10px] text-green-400 mb-1">UP {analysis.prob_up}%</div>
                        <div className="h-3 bg-surface rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${analysis.prob_up}%` }} />
                        </div>
                      </div>
                      <div className="flex-1">
                        <div className="text-[10px] text-red-400 mb-1">DOWN {analysis.prob_down}%</div>
                        <div className="h-3 bg-surface rounded-full overflow-hidden">
                          <div className="h-full bg-red-500 rounded-full transition-all" style={{ width: `${analysis.prob_down}%` }} />
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between text-[10px] text-gray-500 mt-2">
                      <span>Momentum: <span className={analysis.momentum === 'bullish' ? 'text-green-400' : analysis.momentum === 'bearish' ? 'text-red-400' : 'text-gray-400'}>{analysis.momentum}</span></span>
                      {analysis.news_sentiment !== null && (
                        <span>News: <span className={analysis.news_sentiment > 0 ? 'text-green-400' : analysis.news_sentiment < 0 ? 'text-red-400' : 'text-gray-400'}>{analysis.news_sentiment > 0 ? '+' : ''}{analysis.news_sentiment?.toFixed(2)}</span></span>
                      )}
                    </div>
                  </div>

                  {/* Technical Indicators */}
                  {analysis.technicals && (() => {
                    const tech = analysis.technicals;
                    const rsiColor = tech.rsi_signal === 'oversold' ? 'text-green-400' : tech.rsi_signal === 'overbought' ? 'text-red-400' : 'text-gray-300';
                    const macdColor = tech.macd.direction === 'bullish' ? 'text-green-400' : tech.macd.direction === 'bearish' ? 'text-red-400' : 'text-gray-400';
                    const emaColor = tech.ema_cross === 'bullish' ? 'text-green-400' : tech.ema_cross === 'bearish' ? 'text-red-400' : 'text-gray-400';
                    const vwapColor = !tech.vwap ? 'text-gray-500' : tech.vwap.position === 'above' ? 'text-red-400' : tech.vwap.position === 'below' ? 'text-green-400' : 'text-gray-400';
                    const bbColor = tech.bollinger.pct_b <= 0.1 ? 'text-green-400' : tech.bollinger.pct_b >= 0.9 ? 'text-red-400' : 'text-gray-300';

                    return (
                      <div className="bg-panel border border-border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <div className="text-xs text-gray-400 uppercase">Technical Indicators</div>
                          <span className="px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-500/40 text-blue-400 text-[9px] font-semibold tracking-wide">LIVE</span>
                        </div>

                        <div className="space-y-3">
                          {/* RSI */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] text-gray-500">RSI (14)</span>
                              <span className={`text-xs font-mono font-semibold ${rsiColor}`}>
                                {tech.rsi.toFixed(1)} <span className="text-[9px] opacity-70">{tech.rsi_signal}</span>
                              </span>
                            </div>
                            <div className="relative h-2 bg-surface rounded-full overflow-hidden">
                              {/* Overbought/oversold zones */}
                              <div className="absolute inset-y-0 left-0 bg-green-500/15 rounded-l-full" style={{ width: '30%' }} />
                              <div className="absolute inset-y-0 right-0 bg-red-500/15 rounded-r-full" style={{ width: '30%' }} />
                              {/* RSI value marker */}
                              <div className={`absolute top-0 bottom-0 w-1 rounded-full ${tech.rsi_signal === 'oversold' ? 'bg-green-400' : tech.rsi_signal === 'overbought' ? 'bg-red-400' : 'bg-blue-400'}`}
                                style={{ left: `calc(${Math.min(99, Math.max(1, tech.rsi))}% - 2px)` }} />
                            </div>
                            <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
                              <span>0 — oversold</span>
                              <span>30</span>
                              <span>70</span>
                              <span>overbought — 100</span>
                            </div>
                          </div>

                          {/* MACD + EMA row */}
                          <div className="grid grid-cols-2 gap-2">
                            <div className="bg-surface rounded p-2">
                              <div className="text-[9px] text-gray-500 mb-1">MACD</div>
                              <div className={`text-xs font-semibold ${macdColor}`}>{tech.macd.direction}</div>
                              <div className="text-[9px] text-gray-600 font-mono mt-0.5">
                                hist {tech.macd.histogram >= 0 ? '+' : ''}{tech.macd.histogram.toFixed(4)}
                              </div>
                            </div>
                            <div className="bg-surface rounded p-2">
                              <div className="text-[9px] text-gray-500 mb-1">EMA 9 / 21</div>
                              <div className={`text-xs font-semibold ${emaColor}`}>{tech.ema_cross}</div>
                              <div className="text-[9px] text-gray-600 font-mono mt-0.5">
                                {tech.ema9.toFixed(2)} / {tech.ema21.toFixed(2)}
                              </div>
                            </div>
                          </div>

                          {/* VWAP */}
                          {tech.vwap && (
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="text-[10px] text-gray-500">VWAP </span>
                                <span className="text-[10px] font-mono text-gray-400">${tech.vwap.vwap.toFixed(2)}</span>
                              </div>
                              <div className="text-right">
                                <span className={`text-xs font-semibold ${vwapColor}`}>
                                  {tech.vwap.position === 'above' ? '▲' : tech.vwap.position === 'below' ? '▼' : '≈'}{' '}
                                  {tech.vwap.position} VWAP
                                </span>
                                <span className={`text-[10px] font-mono ml-1 ${vwapColor}`}>
                                  {tech.vwap.distance_pct >= 0 ? '+' : ''}{tech.vwap.distance_pct.toFixed(2)}%
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Bollinger %B */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] text-gray-500">Bollinger %B</span>
                              <span className={`text-xs font-mono font-semibold ${bbColor}`}>
                                {(tech.bollinger.pct_b * 100).toFixed(0)}%
                                <span className="text-[9px] text-gray-600 ml-1">band width {tech.bollinger.width_pct.toFixed(1)}%</span>
                              </span>
                            </div>
                            <div className="relative h-1.5 bg-surface rounded-full overflow-hidden">
                              <div className={`absolute top-0 bottom-0 w-1.5 rounded-full ${tech.bollinger.pct_b <= 0.1 ? 'bg-green-400' : tech.bollinger.pct_b >= 0.9 ? 'bg-red-400' : 'bg-blue-400'}`}
                                style={{ left: `calc(${Math.min(99, Math.max(1, tech.bollinger.pct_b * 100))}% - 3px)` }} />
                            </div>
                            <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
                              <span>lower band</span>
                              <span>mid</span>
                              <span>upper band</span>
                            </div>
                          </div>

                          {/* Support / Resistance */}
                          {(tech.support_resistance.resistance.length > 0 || tech.support_resistance.support.length > 0) && (
                            <div className="border-t border-border pt-2">
                              <div className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wider">Key Levels</div>
                              <div className="flex gap-4">
                                {tech.support_resistance.resistance.length > 0 && (
                                  <div>
                                    <div className="text-[9px] text-red-400/70 mb-1">Resistance</div>
                                    {tech.support_resistance.resistance.map((lv) => (
                                      <div key={lv} className="font-mono text-xs text-red-400">${lv.toFixed(2)}</div>
                                    ))}
                                  </div>
                                )}
                                {tech.support_resistance.support.length > 0 && (
                                  <div>
                                    <div className="text-[9px] text-green-400/70 mb-1">Support</div>
                                    {tech.support_resistance.support.map((lv) => (
                                      <div key={lv} className="font-mono text-xs text-green-400">${lv.toFixed(2)}</div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Expected ranges */}
                  <div className="bg-panel border border-border rounded-lg p-4">
                    <div className="text-xs text-gray-400 uppercase mb-3">Expected Price Range</div>
                    <div className="space-y-2">
                      {[
                        { label: 'Next 1 Hour', range: analysis.ranges['1h'] },
                        { label: 'End of Day', range: analysis.ranges['eod'] },
                        { label: 'Tomorrow', range: analysis.ranges['1d'] },
                      ].map(({ label, range }) => (
                        <div key={label} className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 w-20">{label}</span>
                          <div className="flex-1 flex items-center gap-1">
                            <span className="text-xs font-mono text-red-400">${range.low.toFixed(2)}</span>
                            <div className="flex-1 h-1.5 bg-surface rounded-full relative">
                              {currentPrice && (
                                <div className="absolute top-0 bottom-0 w-0.5 bg-white rounded"
                                  style={{ left: `${Math.min(100, Math.max(0, (currentPrice - range.low) / (range.high - range.low) * 100))}%` }} />
                              )}
                            </div>
                            <span className="text-xs font-mono text-green-400">${range.high.toFixed(2)}</span>
                          </div>
                          <span className="text-[10px] text-gray-500 w-12 text-right">±{range.expected_move_pct.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-gray-600 mt-2">Based on recent realized volatility. White bar = current price.</p>
                  </div>
                </>
              )}

              {/* Price Forecast card — updates every 60s from live price + momentum */}
              {forecast && forecast.forecast_points?.length > 0 && currentPrice && (
                <div className="bg-panel border border-border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-gray-400 uppercase">Price Forecast</div>
                      <span className="px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-500/40 text-blue-400 text-[9px] font-semibold tracking-wide">INTRADAY</span>
                    </div>
                    <div className="text-[10px] text-gray-600">live · updates every 60s</div>
                  </div>
                  <p className="text-[10px] text-gray-600 mb-3">From <span className="text-white font-mono">${currentPrice.toFixed(2)}</span> now — projected path based on momentum drift</p>
                  <div className="space-y-2">
                    {forecast.forecast_points
                      .filter((fp) => [15, 60, 120, 390].includes(fp.horizon_minutes))
                      .map((fp) => {
                        const diff = fp.predicted_price - currentPrice;
                        const diffPct = diff / currentPrice * 100;
                        const label = fp.horizon_minutes === 15 ? '15 Min' : fp.horizon_minutes === 60 ? '1 Hour' : fp.horizon_minutes === 120 ? '2 Hours' : 'End of Day';
                        const up = diff >= 0;
                        return (
                          <div key={fp.horizon_minutes} className="flex items-center justify-between">
                            <span className="text-[10px] text-gray-500 w-20">{label}</span>
                            <div className="flex-1 mx-2">
                              <div className="h-1 bg-surface rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${up ? 'bg-green-500/40' : 'bg-red-500/40'}`}
                                  style={{ width: `${Math.min(100, Math.abs(diffPct) * 20)}%`, marginLeft: up ? '50%' : `${50 - Math.min(50, Math.abs(diffPct) * 20)}%` }} />
                              </div>
                            </div>
                            <span className="font-mono text-sm text-white w-20 text-right">${fp.predicted_price.toFixed(2)}</span>
                            <span className={`font-mono text-xs font-semibold w-16 text-right ${up ? 'text-green-400' : 'text-red-400'}`}>
                              {up ? '+' : ''}{diffPct.toFixed(2)}%
                            </span>
                          </div>
                        );
                      })}
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-[10px] text-gray-600">Dashed blue line on chart · 80% confidence band shown</p>
                    {liveSignal && (
                      <span className={`text-[10px] font-semibold ${liveSignal.color}`}>{liveSignal.signal}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-80 text-gray-500">
            <div className="text-5xl mb-4">📈</div>
            <p className="text-lg">Search a ticker or pick one from your watchlist</p>
            <p className="text-sm mt-2">Enter a buy price on the right to get an instant analysis</p>
          </div>
        )}
      </div>
    </div>
  );
}
