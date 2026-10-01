import { useEffect, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LineStyle,
  Time,
} from 'lightweight-charts';
import type { Levels } from '../../lib/rossRules';

export interface ChartBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number | null;
  ema9?: number | null;
  sma20?: number | null;
  sma200?: number | null;
}

export interface ChartLine {
  price: number;
  color: string;
  title: string;
  dotted?: boolean;
}

interface Props {
  symbol: string;
  bars: ChartBar[];
  daily?: boolean;
  levels?: Levels | null;
  hod?: number | null;
  lines?: ChartLine[];
}

const etTime = (t: Time) =>
  new Date(Number(t) * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const dayLabel = (t: Time) =>
  new Date(Number(t) * 1000).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** Pre-market (before 9:30) and after-hours (16:00+) bars, in ET. */
function isExtended(t: number): boolean {
  const [h, m] = new Date(t * 1000)
    .toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
    .split(':').map(Number);
  const mins = h * 60 + m;
  return mins < 9 * 60 + 30 || mins >= 16 * 60;
}

const OVERLAYS = [
  { key: 'vwap', color: '#f59e0b', width: 2, title: 'VWAP' },
  { key: 'ema9', color: '#a78bfa', width: 1, title: '9 EMA' },
  { key: 'sma20', color: '#38bdf8', width: 1, title: '20 MA' },
  { key: 'sma200', color: '#f472b6', width: 2, title: '200 MA' },
] as const;

/**
 * Intraday: 1-minute candles with VWAP + 9 EMA (Ross's two indicators); extended-hours candles are dimmed.
 * Daily: candles with the 20 and 200-day moving averages.
 */
export function DayTradeChart({ symbol, bars, daily = false, levels, hod, lines }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayRefs = useRef<Record<string, ISeriesApi<'Line'>>>({});
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const fittedRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { color: '#0f1117' }, textColor: '#9ca3af', fontSize: 11 },
      grid: { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#21262d', scaleMargins: { top: 0.08, bottom: 0.25 } },
      timeScale: {
        borderColor: '#21262d', timeVisible: !daily, secondsVisible: false, rightOffset: 8,
        tickMarkFormatter: daily ? dayLabel : etTime,
      },
      localization: { timeFormatter: daily ? dayLabel : etTime },
    });
    candleRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    });
    volRef.current = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    overlayRefs.current = {};
    for (const o of OVERLAYS) {
      overlayRefs.current[o.key] = chart.addLineSeries({
        color: o.color, lineWidth: o.width, title: o.title, priceLineVisible: false, lastValueVisible: false,
      });
    }
    chartRef.current = chart;
    priceLinesRef.current = [];
    fittedRef.current = false;

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [daily]);

  // New symbol → re-fit on its first data load
  useEffect(() => { fittedRef.current = false; }, [symbol]);

  useEffect(() => {
    if (!candleRef.current) return;
    const t = (b: ChartBar) => b.time as Time;
    candleRef.current.setData(bars.map((b) => {
      const up = b.close >= b.open;
      const dim = !daily && isExtended(b.time) ? (up ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)') : null;
      return { time: t(b), open: b.open, high: b.high, low: b.low, close: b.close, ...(dim ? { color: dim, wickColor: dim } : {}) };
    }));
    volRef.current?.setData(bars.map((b) => ({
      time: t(b), value: b.volume, color: b.close >= b.open ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)',
    })));
    for (const o of OVERLAYS) {
      overlayRefs.current[o.key]?.setData(
        bars.filter((b) => b[o.key] != null).map((b) => ({ time: t(b), value: b[o.key] as number })),
      );
    }
    if (bars.length && !fittedRef.current) {
      // Intraday: last ~2 hours so the current squeeze / pullback is readable. Daily: ~4 months.
      const span = daily ? 90 : 120;
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - span), to: bars.length + 5 });
      fittedRef.current = true;
    }
  }, [bars, daily]);

  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    priceLinesRef.current.forEach((l) => series.removePriceLine(l));
    priceLinesRef.current = [];
    const add = (l: ChartLine) => priceLinesRef.current.push(series.createPriceLine({
      price: l.price, color: l.color, title: l.title, lineWidth: 1,
      lineStyle: l.dotted ? LineStyle.Dotted : LineStyle.Dashed, axisLabelVisible: true,
    }));
    if (hod) add({ price: hod, color: '#6b7280', title: 'HOD', dotted: true });
    if (levels) {
      const risk = levels.entry - levels.stop;
      add({ price: levels.entry, color: '#58a6ff', title: levels.hypothetical ? 'Entry?' : 'Entry' });
      add({ price: levels.stop, color: '#ef4444', title: 'Stop' });
      add({ price: levels.target, color: '#22c55e', title: Math.abs(levels.target - (levels.entry + 2 * risk)) < 0.005 ? '2:1' : 'Target' });
      add({ price: levels.entry + 3 * risk, color: 'rgba(34,197,94,0.45)', title: '3:1', dotted: true });
    }
    lines?.forEach(add);
  }, [levels, hod, lines, daily]);

  return <div ref={containerRef} className="w-full h-full" />;
}
