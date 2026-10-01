import type { Time } from 'lightweight-charts';

export function toChartTime(isoString: string): number {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

export function formatTime(ts: Time): string {
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function sentimentColor(score: number | undefined): string {
  if (score === undefined) return '#9ca3af';
  if (score > 0.3) return '#22c55e';
  if (score > 0.0) return '#86efac';
  if (score < -0.3) return '#ef4444';
  if (score < 0.0) return '#fca5a5';
  return '#9ca3af';
}

export function sentimentLabel(score: number | undefined): string {
  if (score === undefined) return 'Unscored';
  if (score > 0.5) return 'Very Bullish';
  if (score > 0.2) return 'Bullish';
  if (score > -0.2) return 'Neutral';
  if (score > -0.5) return 'Bearish';
  return 'Very Bearish';
}

export function formatPct(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(2)}%`;
}
