/**
 * First-pullback analysis on live 1-minute bars, in the browser — so entry, stop and the 2:1 target
 * move with the chart instead of waiting for the next scan. A line-for-line port of
 * `analyze_setup` / `move_profile` / `fast_stop` / `realistic_targets` in
 * backend/app/services/daytrade_scanner.py — keep the two in sync.
 */
import type { IntradayBar, Setup, SetupCheck } from '../types/daytrade';
import { fastStop, realisticTargets, HOLD_MINUTES, type MoveProfile } from './rossRules';

const MAX_RETRACE = 0.5;
const SQUEEZE_LOOKBACK_BARS = 60;
const STALE_BARS = 30;
const PROFILE_LOOKBACK_BARS = 120;

const roundPx = (p: number) => (p < 1 ? Math.round(p * 1e4) / 1e4 : Math.round(p * 100) / 100);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** numpy.percentile with linear interpolation (numpy's default). */
function percentile(values: number[], q: number): number {
  const a = [...values].sort((x, y) => x - y);
  const pos = (a.length - 1) * (q / 100);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function moveProfile(h: number[], lo: number[], c: number[], minutes = HOLD_MINUTES, lookback = PROFILE_LOOKBACK_BARS): MoveProfile & { samples: number } {
  const n = c.length;
  const ranges = h.map((x, i) => x - lo[i]).slice(-14);
  const atr = n ? mean(ranges) : 0;
  const ups: number[] = [];
  for (let i = Math.max(0, n - lookback - minutes); i < n - minutes; i++) {
    ups.push(Math.max(0, Math.max(...h.slice(i + 1, i + 1 + minutes)) - c[i]));
  }
  let median: number, p75: number;
  if (ups.length >= 10) { median = percentile(ups, 50); p75 = percentile(ups, 75); }
  else { median = atr * Math.sqrt(minutes) * 0.6; p75 = atr * Math.sqrt(minutes); }
  return { atr, median, p75: Math.max(p75, median), samples: ups.length };
}

export function analyzeSetup(bars: IntradayBar[]): Setup | null {
  if (bars.length < 5) return null;
  const o = bars.map((b) => b.open), h = bars.map((b) => b.high), lo = bars.map((b) => b.low);
  const c = bars.map((b) => b.close), v = bars.map((b) => b.volume);

  // VWAP (from the session's first bar, incl. pre-market) and 9 EMA
  const vwap: number[] = [];
  let cumV = 0, cumTPV = 0;
  for (let i = 0; i < c.length; i++) {
    cumV += v[i]; cumTPV += ((h[i] + lo[i] + c[i]) / 3) * v[i];
    vwap.push(cumV > 0 ? cumTPV / cumV : c[i]);
  }
  const ema9: number[] = [];
  const k = 2 / 10;
  c.forEach((x, i) => ema9.push(i === 0 ? x : x * k + ema9[i - 1] * (1 - k)));

  const profile = moveProfile(h, lo, c);
  const hodVal = Math.max(...h);
  const hodIdx = h.lastIndexOf(hodVal);
  const start = Math.max(0, hodIdx - SQUEEZE_LOOKBACK_BARS);
  const base = Math.min(...lo.slice(start, hodIdx + 1));
  const move = hodVal - base;
  const last = c[c.length - 1];
  const lastVwap = vwap[vwap.length - 1], lastEma = ema9[ema9.length - 1];
  const barsSinceHod = c.length - 1 - hodIdx;

  const out: Setup = {
    state: 'none', summary: 'No meaningful squeeze yet today.', checks: {},
    hod: roundPx(hodVal), squeeze_low: roundPx(base), vwap: roundPx(lastVwap), ema9: roundPx(lastEma),
    last: roundPx(last), bars_since_hod: barsSinceHod,
    atr_1m: roundPx(profile.atr), up30_median: roundPx(profile.median), up30_p75: roundPx(profile.p75),
  };
  if (move <= 0 || move / base < 0.02) return out;

  const rng = h[hodIdx] - lo[hodIdx];
  const upperWick = h[hodIdx] - Math.max(o[hodIdx], c[hodIdx]);
  const toppingTail = rng > 0 && upperWick >= 0.5 * rng;

  const greenPush: number[] = [];
  for (let i = start; i <= hodIdx; i++) if (c[i] >= o[i]) greenPush.push(v[i]);
  const greenVol = mean(greenPush);

  if (barsSinceHod <= 1) {
    return { ...out, state: 'extended', summary: "Squeezing at the highs — don't chase. Wait for the first pullback.", topping_tail: toppingTail };
  }

  let pbIdx = hodIdx + 1;
  for (let i = hodIdx + 1; i < c.length; i++) if (lo[i] < lo[pbIdx]) pbIdx = i;
  const pullbackLow = lo[pbIdx];
  const retrace = (hodVal - pullbackLow) / move;
  const redAfter: number[] = [];
  for (let i = hodIdx + 1; i < c.length; i++) if (c[i] < o[i]) redAfter.push(v[i]);
  const lightRed = greenVol > 0 ? mean(redAfter) < greenVol : true;

  const checks: Record<string, SetupCheck> = {
    retrace_ok: { pass: retrace <= MAX_RETRACE, label: `Retrace ${(retrace * 100).toFixed(0)}% (≤ 50%)` },
    light_red_volume: { pass: lightRed, label: 'Lighter volume on red candles' },
    above_vwap: { pass: last >= lastVwap, label: `Holding VWAP $${roundPx(lastVwap)}` },
    above_ema9: { pass: last >= lastEma * 0.995, label: `Holding 9 EMA $${roundPx(lastEma)}` },
    no_topping_tail: { pass: !toppingTail, label: 'No topping tail at high of day' },
  };
  Object.assign(out, { checks, retrace_pct: Math.round(retrace * 1000) / 10, pullback_low: roundPx(pullbackLow), topping_tail: toppingTail });

  if (retrace > MAX_RETRACE || last < lastVwap) {
    const why = last < lastVwap ? 'lost VWAP' : `retraced ${(retrace * 100).toFixed(0)}% of the move`;
    return { ...out, state: 'broken', summary: `Pattern broken — ${why}. No trade until it rebuilds.` };
  }
  if (barsSinceHod > STALE_BARS) {
    return { ...out, state: 'stale', summary: `No new high in ${barsSinceHod} min — momentum fading.` };
  }

  // Crossing candle: the latest candle broke the prior candle's high after the pullback low printed
  const n = c.length;
  const triggered = pbIdx < n - 1 && h[n - 1] > h[n - 2];
  const entry = triggered ? Math.max(last, h[n - 2] + 0.01) : h[n - 1] + 0.01;
  const stop = fastStop(entry, pullbackLow, profile);
  const risk = entry - stop;
  const targets = realisticTargets(entry, stop, hodVal, base, profile);
  const two = targets.find((t) => t.label === '2:1 target');

  let summary = triggered
    ? 'First candle making a new high — entry trigger is live.'
    : `Pulling back ${(retrace * 100).toFixed(0)}% — buy the first candle that breaks $${roundPx(h[n - 1])}.`;
  if (two?.reach === 'stretch') summary += ` A 2:1 target ($${roundPx(two.price)}) is more than this stock usually moves in ${HOLD_MINUTES} min — not a fast trade.`;

  return {
    ...out,
    state: triggered ? 'triggered' : 'pullback',
    summary,
    entry: roundPx(entry),
    stop: roundPx(stop),
    structural_stop: roundPx(pullbackLow),
    risk_per_share: roundPx(risk),
    stop_in_noise: risk < 0.5 * profile.atr - 1e-9,
    target: two ? roundPx(two.price) : undefined,
    targets,
    reach_2r: two?.reach,
    minutes_2r: two?.minutes ?? null,
    hod_r: hodVal > entry ? Math.round(((hodVal - entry) / risk) * 100) / 100 : 0,
  };
}
