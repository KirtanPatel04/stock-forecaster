export interface PriceBar {
  ticker: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  timeframe: string;
}

export interface NewsItem {
  id: number;
  ticker?: string;
  source: string;
  headline: string;
  summary?: string;
  published_at: string;
  sentiment_score?: number;
  relevance_score?: number;
  surprise_level?: number;
  expected_impact?: number;
}

export interface ForecastPoint {
  horizon_minutes: number;
  target_time: string;
  predicted_price: number;
  lower_50: number;
  upper_50: number;
  lower_80: number;
  upper_80: number;
}

export interface ForecastResponse {
  ticker: string;
  current_price: number;
  forecast_points: ForecastPoint[];
  exit_window_start?: string;
  exit_window_end?: string;
  model_weights: Record<string, string | number>;
  computed_at: string;
  buy_price?: number;
  live_pnl?: number;
}

export interface AfterHoursReport {
  ticker: string;
  lean: 'bullish' | 'bearish' | 'neutral';
  probability: number;
  expected_low: number;
  expected_high: number;
  key_reasons: string[];
  full_report: {
    price_context: string;
    news_count: number;
    recent_earnings?: Record<string, unknown>;
    upcoming_earnings?: string;
    analyst_ratings: Record<string, unknown>[];
    sec_filings: number;
    macro_events: string[];
    iv_data: Record<string, unknown>;
    summary: string;
    news_items: { source: string; headline: string; summary: string }[];
  };
}

export interface TopPick {
  ticker: string;
  composite_score: number;
  sentiment: number;
  confidence: number;
  expected_move_pct: number;
  news_count: number;
  top_headline: string;
  top_source: string;
  reasons: string[];
  last_price: number | null;
  price_history: number[];
  target_price: number | null;
}

export interface TopPicksResponse {
  picks: TopPick[];
  generated_at: string;
}

export interface IntradayPickHorizon {
  expected_move_pct: number;
  target_price: number;
}

export interface IntradayPick {
  ticker: string;
  score: number;
  prob_up: number;
  momentum: string;
  accelerating: boolean;
  current_price: number;
  pct_from_open: number;
  vol_surge: number;
  expected_move_pct: number; // backwards compat (= 1hr)
  target_price: number;      // backwards compat (= 1hr)
  horizons?: {
    '15min': IntradayPickHorizon;
    '1hr': IntradayPickHorizon;
    '1day': IntradayPickHorizon;
  };
  price_history: number[];
  news_bonus: number;
  bars_today: number;
}

export interface Mover {
  symbol: string;
  price: number;
  change: number;
  percent_change: number;
}

export interface BiggestMoversResponse {
  gainers: Mover[];
  losers: Mover[];
  generated_at: string;
}

export interface IntradayPicksResponse {
  picks: IntradayPick[];
  generated_at: string;
  market_open: boolean;
}

export type WSMessage =
  | { type: 'history'; data: PriceBar[] }
  | { type: 'bar'; data: PriceBar }
  | { type: 'forecast'; data: ForecastResponse }
  | { type: 'news'; data: NewsItem }
  | { type: 'ping' };
