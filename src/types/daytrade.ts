export type Grade = 'A+' | 'A' | 'B' | 'C';
export type SetupState = 'extended' | 'pullback' | 'triggered' | 'broken' | 'stale' | 'none';
export type PillarKey = 'change' | 'rel_volume' | 'news' | 'price' | 'float';

export interface Pillar {
  pass: boolean | null;
  value: number | boolean | null;
  rule: string;
}

export interface SetupCheck {
  pass: boolean;
  label: string;
}

export interface Setup {
  state: SetupState;
  summary: string;
  checks: Record<string, SetupCheck>;
  hod?: number;
  squeeze_low?: number;
  vwap?: number;
  ema9?: number;
  last?: number;
  bars_since_hod?: number;
  retrace_pct?: number;
  pullback_low?: number;
  topping_tail?: boolean;
  entry?: number;
  stop?: number;
  target?: number;
  risk_per_share?: number;
  atr_1m?: number;
  up30_median?: number;   // typical run-up within 30 min of a bar (last ~2 hours)
  up30_p75?: number;      // a good 30-min run-up
  structural_stop?: number;
  stop_in_noise?: boolean;
  targets?: TargetLevel[];
  reach_2r?: Reach;
  minutes_2r?: number | null;
  hod_r?: number;
}

export type Reach = 'likely' | 'possible' | 'stretch';

export interface TargetLevel {
  label: string;
  price: number;
  r: number;
  reach: Reach;
  minutes?: number | null;
}

export interface NewsHeadline {
  title: string;
  published: string;
  url?: string;
  publisher?: string;
}

export interface DayTradeCandidate {
  symbol: string;
  name: string;
  exchange: string | null;
  sector: string | null;
  country: string | null;
  price: number;
  prev_close: number;
  change_pct: number;
  volume: number | null;
  avg_volume: number | null;
  rel_volume: number | null;
  float_shares: number | null;
  short_pct_float: number | null;
  day_high: number | null;
  market_state: string;
  news: NewsHeadline[];
  has_fresh_news: boolean;
  pillars: Record<PillarKey, Pillar>;
  score: number;
  grade: Grade;
  a_plus: Record<string, boolean>;
  big_volume: boolean;
  setup: Setup;
  flags: string[];
  gainer_rank?: number;
}

export interface TradingWindow {
  key: 'early' | 'prime' | 'late' | 'off' | 'closed';
  label: string;
  et_time: string;
}

export interface MarketTemperature {
  key: 'hot' | 'warm' | 'cold';
  runners_30: number;
  runners_50: number;
  runners_100: number;
  advice: string;
}

export interface DayTradeScan {
  generated_at: string;
  window: TradingWindow;
  temperature: MarketTemperature;
  candidates: DayTradeCandidate[];
}

export interface IntradayBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
  ema9: number;
}

export interface RailQuote {
  symbol: string;
  name: string;
  price: number;
  change_pct: number;
  volume: number | null;
}

export interface MarketOverview {
  generated_at: string;
  indices: { symbol: string; label: string; price: number; change_pct: number }[];
  gainers: RailQuote[];
  losers: RailQuote[];
  actives: RailQuote[];
  small_caps: RailQuote[];
}

// ── Next-day watchlist ───────────────────────────────────────────────────────
export type WatchKind = 'after_hours' | 'premarket_gap' | 'day_runner';
export type WatchTier = 'A' | 'B' | 'C' | 'skip';

export interface WatchCheck {
  key: string;
  status: 'pass' | 'warn' | 'fail';
  label: string;
  core: boolean;
}

export interface WatchCandidate {
  symbol: string;
  name: string;
  exchange: string | null;
  sector: string | null;
  country: string | null;
  kind: WatchKind;
  price: number;
  move_pct: number;
  day_change_pct: number | null;
  ext_change_pct: number;
  ext_volume: number;
  volume: number;
  rel_volume: number | null;
  float_shares: number | null;
  close_strength: number | null;
  news: NewsHeadline[];
  has_fresh_news: boolean;
  checks: WatchCheck[];
  core_score: number;
  tier: WatchTier;
  verdict: string;
  levels: {
    prev_close: number | null;
    regular_close: number | null;
    day_high: number | null;
    ext_high: number | null;
    dma200: number | null;
    key_level: number | null;
  };
  plan: string;
  pinned?: boolean;
}

export interface WatchlistResponse {
  generated_at: string;
  phase: { key: 'premarket' | 'regular' | 'after_hours' | 'overnight'; label: string; for_day: string; for_weekday: number };
  notes: string[];
  candidates: WatchCandidate[];
}

export interface DailyBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sma20: number | null;
  sma200: number | null;
}

/** Live price + first-pullback setup for one symbol (GET /api/daytrade/live). */
export interface LiveQuote {
  price: number;
  time: number;
  setup: Setup;
}
