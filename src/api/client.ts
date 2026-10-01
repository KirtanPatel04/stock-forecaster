import axios from 'axios';
import type {
  PriceBar,
  NewsItem,
  ForecastResponse,
  AfterHoursReport,
  TopPicksResponse,
  IntradayPicksResponse,
  BiggestMoversResponse,
} from '../types';
import type { DayTradeScan, DayTradeCandidate, IntradayBar, MarketOverview, WatchlistResponse, DailyBar, LiveQuote } from '../types/daytrade';

// VITE_API_URL points at a hosted backend (e.g. https://my-api.onrender.com); defaults to the dev proxy.
export const API_ORIGIN: string = import.meta.env.VITE_API_URL ?? '';
const api = axios.create({ baseURL: `${API_ORIGIN}/api` });

export interface SearchResult {
  symbol: string;
  description: string;
  exchange: string;
  currency: string;
}

export const stocksApi = {
  search: (q: string) => api.get<SearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}`),
  getBars: (ticker: string, timeframe = '1Min', limit = 300, daysBack = 5) =>
    api.get<PriceBar[]>(`/stocks/${ticker}/bars?timeframe=${timeframe}&limit=${limit}&days_back=${daysBack}&refresh=true`),
  // Reads from DB cache — use after analysis has already refreshed the cache
  getCachedBars: (ticker: string, timeframe = '1Min', limit = 390, daysBack = 2) =>
    api.get<PriceBar[]>(`/stocks/${ticker}/bars?timeframe=${timeframe}&limit=${limit}&days_back=${daysBack}`),
  getPrice: (ticker: string) => api.get<{ ticker: string; price: number; timestamp: string }>(`/stocks/${ticker}/price`),
  getForexRate: () => api.get<{ rate: number; timestamp: string }>('/stocks/forex/usdcad'),
};

export const newsApi = {
  getNews: (ticker: string, daysBack = 3) =>
    api.get<NewsItem[]>(`/news/${ticker}?days_back=${daysBack}&refresh=true&score=true`),
};

export const forecastApi = {
  train: (ticker: string, daysBack = 30) =>
    api.post(`/forecast/${ticker}/train?days_back=${daysBack}`),
  getForecast: (ticker: string) =>
    api.get<ForecastResponse>(`/forecast/${ticker}`),
  setBuyPrice: (ticker: string, price: number) =>
    api.post('/forecast/buy-price', { ticker, price }),
  clearBuyPrice: (ticker: string) =>
    api.delete(`/forecast/${ticker}/buy-price`),
};

export const afterHoursApi = {
  getReport: (ticker: string) =>
    api.get<AfterHoursReport>(`/afterhours/${ticker}`),
};

export const quickApi = {
  getAnalysis: (ticker: string, buyPrice?: number) =>
    api.get(`/quick/${ticker}/analysis${buyPrice ? `?buy_price=${buyPrice}` : ''}`),
  getSummary: (ticker: string) =>
    api.get(`/quick/${ticker}/summary`),
  getForecast: (ticker: string) =>
    api.get<ForecastResponse>(`/quick/${ticker}/forecast`),
};

export const moversApi = {
  getBiggestMovers: (limit = 10) =>
    api.get<BiggestMoversResponse>(`/movers/biggest?limit=${limit}`),
  getTopPicks: (limit = 8, tickers?: string[], maxPrice?: number) =>
    api.get<TopPicksResponse>(
      `/movers/top-picks?limit=${limit}${tickers?.length ? `&tickers=${encodeURIComponent(tickers.join(','))}` : ''}${maxPrice != null ? `&max_price=${maxPrice}` : ''}`
    ),
  getIntradayPicks: (limit = 8, tickers?: string[], maxPrice?: number) =>
    api.get<IntradayPicksResponse>(
      `/movers/intraday-picks?limit=${limit}${tickers?.length ? `&tickers=${encodeURIComponent(tickers.join(','))}` : ''}${maxPrice != null ? `&max_price=${maxPrice}` : ''}`
    ),
};

export const daytradeApi = {
  scan: (limit = 30) => api.get<DayTradeScan>(`/daytrade/scan?limit=${limit}`),
  getStock: (symbol: string) => api.get<DayTradeCandidate>(`/daytrade/stock/${encodeURIComponent(symbol)}`),
  getBars: (symbol: string) => api.get<IntradayBar[]>(`/daytrade/bars/${encodeURIComponent(symbol)}`),
  getMarket: () => api.get<MarketOverview>('/daytrade/market'),
  getWatchlist: (pinned: string[] = []) =>
    api.get<WatchlistResponse>(`/daytrade/watchlist${pinned.length ? `?tickers=${encodeURIComponent(pinned.join(','))}` : ''}`),
  getDaily: (symbol: string) => api.get<DailyBar[]>(`/daytrade/daily/${encodeURIComponent(symbol)}`),
  getLive: (symbols: string[]) =>
    api.get<Record<string, LiveQuote>>(`/daytrade/live?symbols=${encodeURIComponent(symbols.join(','))}`),
};

export default api;
