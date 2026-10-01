import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  LineData,
  Time,
  SeriesMarker,
  CrosshairMode,
  LineStyle,
  TickMarkType,
} from 'lightweight-charts';
import type { PriceBar, ForecastResponse, NewsItem } from '../../types';
import { toChartTime } from './chartUtils';

interface LiveChartProps {
  ticker: string;
  bars: PriceBar[];
  forecast: ForecastResponse | null;
  news: NewsItem[];
  buyPrice: number | null;
  currentPrice?: number | null;
  timeframe?: string; // '1Min' | '15Min' | '1Hour' | '1Day'
}

function tickFormatter(time: Time, type: TickMarkType): string {
  const d = new Date(Number(time) * 1000);

  if (type === TickMarkType.Year) {
    return d.getFullYear().toString();
  }
  if (type === TickMarkType.Month) {
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  }
  if (type === TickMarkType.DayOfMonth) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  // Time ticks — show 12-hour local time
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m === '00' ? `${h12}${ampm}` : `${h12}:${m}${ampm}`;
}

export function LiveChart({ ticker, bars, forecast, news, buyPrice, currentPrice, timeframe = '1Min' }: LiveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const forecastRef = useRef<ISeriesApi<'Line'> | null>(null);
  const upper80Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const lower80Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const upper50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const lower50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const buyLineRef = useRef<ISeriesApi<'Line'> | null>(null);

  const isIntraday = ['1Min', '5Min', '15Min', '30Min', '1Hour'].includes(timeframe);

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 460,
      layout: {
        background: { color: '#0f1117' },
        textColor: '#9ca3af',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4b5563', labelBackgroundColor: '#1f2937' },
        horzLine: { color: '#4b5563', labelBackgroundColor: '#1f2937' },
      },
      timeScale: {
        timeVisible: isIntraday,
        secondsVisible: false,
        borderColor: '#21262d',
        rightOffset: 12,
        tickMarkFormatter: tickFormatter,
      },
      rightPriceScale: { borderColor: '#21262d' },
      localization: {
        timeFormatter: (t: number) => {
          const d = new Date(t * 1000);
          if (isIntraday) {
            const h = d.getHours();
            const m = d.getMinutes().toString().padStart(2, '0');
            const ampm = h >= 12 ? 'pm' : 'am';
            return `${h % 12 || 12}:${m} ${ampm}  ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
          }
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        },
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444',
      borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    });

    const upper80 = chart.addLineSeries({ color: 'rgba(88,166,255,0.2)', lineWidth: 1, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false });
    const lower80 = chart.addLineSeries({ color: 'rgba(88,166,255,0.2)', lineWidth: 1, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false });
    const upper50 = chart.addLineSeries({ color: 'rgba(88,166,255,0.5)', lineWidth: 1, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false });
    const lower50 = chart.addLineSeries({ color: 'rgba(88,166,255,0.5)', lineWidth: 1, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false });
    const forecastLine = chart.addLineSeries({ color: '#58a6ff', lineWidth: 2, lineStyle: LineStyle.Dashed, lastValueVisible: true, priceLineVisible: false, title: 'Forecast' });
    const buyLine = chart.addLineSeries({ color: '#facc15', lineWidth: 1, lineStyle: LineStyle.SparseDotted, lastValueVisible: true, priceLineVisible: false, title: 'Entry' });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    forecastRef.current = forecastLine;
    upper80Ref.current = upper80;
    lower80Ref.current = lower80;
    upper50Ref.current = upper50;
    lower50Ref.current = lower50;
    buyLineRef.current = buyLine;

    const handleResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); chart.remove(); chartRef.current = null; };
  }, []);

  // Reconfigure timeScale when timeframe changes (without recreating chart)
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      timeScale: {
        timeVisible: isIntraday,
        secondsVisible: false,
        tickMarkFormatter: tickFormatter,
      },
    });
  }, [timeframe, isIntraday]);

  // Candlestick data
  useEffect(() => {
    if (!candleRef.current || bars.length === 0) return;
    // De-duplicate by timestamp (last-write-wins) then sort ascending.
    // lightweight-charts throws on duplicate/unsorted timestamps — catch silently breaks the chart.
    const seen = new Map<number, CandlestickData>();
    for (const b of bars) {
      const t = toChartTime(b.timestamp);
      seen.set(t, { time: t as Time, open: b.open, high: b.high, low: b.low, close: b.close });
    }
    const data = Array.from(seen.values()).sort((a, b) => (a.time as number) - (b.time as number));
    try { candleRef.current.setData(data); } catch {}
  }, [bars]);

  // News markers
  useEffect(() => {
    if (!candleRef.current || bars.length === 0 || news.length === 0) return;
    const firstTs = toChartTime(bars[0].timestamp);
    const lastTs = toChartTime(bars[bars.length - 1].timestamp);
    const markers: SeriesMarker<Time>[] = news
      .filter((n) => { const t = toChartTime(n.published_at); return t >= firstTs && t <= lastTs; })
      .map((n) => {
        const score = n.sentiment_score ?? 0;
        return {
          time: toChartTime(n.published_at) as Time,
          position: 'aboveBar' as const,
          color: score > 0.1 ? '#22c55e' : score < -0.1 ? '#ef4444' : '#9ca3af',
          shape: 'circle' as const,
          text: score > 0.2 ? '↑' : score < -0.2 ? '↓' : '·',
          id: String(n.id),
        };
      })
      .sort((a, b) => Number(a.time) - Number(b.time));
    try { candleRef.current.setMarkers(markers); } catch {}
  }, [news, bars]);

  // Forecast lines
  useEffect(() => {
    const refs = [forecastRef, upper80Ref, lower80Ref, upper50Ref, lower50Ref];
    if (refs.some((r) => !r.current)) return;
    if (!forecast || !forecast.forecast_points?.length || bars.length === 0) {
      refs.forEach((r) => { try { r.current?.setData([]); } catch {} });
      return;
    }
    const lastBar = bars[bars.length - 1];
    // Sanity-check the live price: if it's more than 25% away from the last bar close
    // (e.g. stale 0.01 quote after hours) fall back to the bar close so the chart
    // doesn't stretch its Y-axis from $0 to $229 and loop the forecast lines.
    const barClose = lastBar.close;
    const priceOk = currentPrice != null && barClose > 0 && Math.abs(currentPrice - barClose) / barClose < 0.10;
    const anchorPrice = priceOk ? currentPrice! : barClose;
    const anchor = { time: toChartTime(lastBar.timestamp) as Time, value: anchorPrice };
    const pts = forecast.forecast_points.sort((a, b) => a.horizon_minutes - b.horizon_minutes);
    // Drop forecast points whose price is >50% away from anchor — means the forecast
    // was computed from a bad base price (e.g. $0.01 quote) and would loop the chart.
    const sanePts = pts.filter((fp) => Math.abs(fp.predicted_price - anchorPrice) / anchorPrice < 0.08);
    if (sanePts.length === 0) {
      refs.forEach((r) => { try { r.current?.setData([]); } catch {} });
      return;
    }
    const toLine = (key: keyof typeof sanePts[0]): LineData[] => [
      anchor,
      ...sanePts.map((fp) => ({ time: toChartTime(fp.target_time) as Time, value: fp[key] as number })),
    ];
    try {
      forecastRef.current!.setData(toLine('predicted_price'));
      upper80Ref.current!.setData(toLine('upper_80'));
      lower80Ref.current!.setData(toLine('lower_80'));
      upper50Ref.current!.setData(toLine('upper_50'));
      lower50Ref.current!.setData(toLine('lower_50'));
    } catch {}
  }, [forecast, bars]);

  // Buy price line
  useEffect(() => {
    if (!buyLineRef.current || bars.length === 0) return;
    if (!buyPrice) { try { buyLineRef.current.setData([]); } catch {}; return; }
    try {
      buyLineRef.current.setData([
        { time: toChartTime(bars[0].timestamp) as Time, value: buyPrice },
        { time: toChartTime(bars[bars.length - 1].timestamp) as Time, value: buyPrice },
      ]);
    } catch {}
  }, [buyPrice, bars]);

  return (
    <div className="w-full space-y-2">
      <div ref={containerRef} className="w-full rounded-lg overflow-hidden" />

      {/* Legend — always shown when forecast is active */}
      {forecast && forecast.forecast_points?.length > 0 && (
        <div className="bg-[#0f1117] border border-[#21262d] rounded-lg px-4 py-3">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">Chart Legend</div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">

            {/* Candles */}
            <div className="flex items-center gap-2">
              <div className="flex gap-0.5">
                <div className="w-3 h-4 bg-green-500 rounded-sm" />
                <div className="w-3 h-4 bg-red-500 rounded-sm" />
              </div>
              <div>
                <div className="text-xs text-white font-medium">Candles</div>
                <div className="text-[10px] text-gray-500">Green = price closed up · Red = price closed down</div>
              </div>
            </div>

            {/* Forecast path */}
            <div className="flex items-center gap-2">
              <svg width="32" height="14" className="flex-shrink-0">
                <line x1="0" y1="7" x2="32" y2="7" stroke="#58a6ff" strokeWidth="2" strokeDasharray="6,3" />
              </svg>
              <div>
                <div className="text-xs text-blue-400 font-medium">Forecast line</div>
                <div className="text-[10px] text-gray-500">Model's best guess at where price is heading</div>
              </div>
            </div>

            {/* 50% band */}
            <div className="flex items-center gap-2">
              <svg width="32" height="14" className="flex-shrink-0">
                <line x1="0" y1="3" x2="32" y2="3" stroke="rgba(88,166,255,0.55)" strokeWidth="1.5" strokeDasharray="3,2" />
                <line x1="0" y1="11" x2="32" y2="11" stroke="rgba(88,166,255,0.55)" strokeWidth="1.5" strokeDasharray="3,2" />
              </svg>
              <div>
                <div className="text-xs text-blue-300/70 font-medium">50% band</div>
                <div className="text-[10px] text-gray-500">Price stays inside here 1 out of 2 times</div>
              </div>
            </div>

            {/* 80% band */}
            <div className="flex items-center gap-2">
              <svg width="32" height="14" className="flex-shrink-0">
                <line x1="0" y1="3" x2="32" y2="3" stroke="rgba(88,166,255,0.2)" strokeWidth="1.5" strokeDasharray="3,2" />
                <line x1="0" y1="11" x2="32" y2="11" stroke="rgba(88,166,255,0.2)" strokeWidth="1.5" strokeDasharray="3,2" />
              </svg>
              <div>
                <div className="text-xs text-blue-200/40 font-medium">80% band</div>
                <div className="text-[10px] text-gray-500">Price stays inside here 4 out of 5 times</div>
              </div>
            </div>

            {/* Entry price */}
            {buyPrice && (
              <div className="flex items-center gap-2">
                <svg width="32" height="14" className="flex-shrink-0">
                  <line x1="0" y1="7" x2="32" y2="7" stroke="#facc15" strokeWidth="1.5" strokeDasharray="2,4" />
                </svg>
                <div>
                  <div className="text-xs text-yellow-400 font-medium">Your entry price</div>
                  <div className="text-[10px] text-gray-500">The price you entered to buy at</div>
                </div>
              </div>
            )}

            {/* News markers */}
            <div className="flex items-center gap-2">
              <div className="flex gap-1 flex-shrink-0">
                <div className="w-2 h-2 rounded-full bg-green-400 mt-1" />
                <div className="w-2 h-2 rounded-full bg-red-400 mt-1" />
                <div className="w-2 h-2 rounded-full bg-gray-400 mt-1" />
              </div>
              <div>
                <div className="text-xs text-gray-300 font-medium">News dots</div>
                <div className="text-[10px] text-gray-500">Green = bullish news · Red = bearish · Gray = neutral</div>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
