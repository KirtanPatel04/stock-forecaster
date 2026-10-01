/**
 * Ross Cameron small-account risk rules — sizing and "walk away" guard.
 * Mirrors .claude/skills/ross-cameron-day-trading/SKILL.md (Risk & position sizing).
 */
import type { TradeContext } from './journal';
import type { Currency } from './fx';
import type { DayTradeCandidate, MarketTemperature, Reach, TargetLevel, TradingWindow } from '../types/daytrade';

export type AccountType = 'cash' | 'margin';

export type { TradeMode } from './journal';

export interface RiskSettings {
  accountType: AccountType;
  currency: Currency;           // the account's currency — cash, goal and P&L are in this
  fxFeePct: number;             // broker's USD↔CAD conversion fee per leg, % (0 for a USD account / Norbert's gambit)
  dailyGoal: number | null;     // $ the user wants to make per day — null until they've set it
  tradesPerGoal: 2 | 3;         // reach the goal in this many winning trades
  quarterStart: boolean;        // Ross's "¼ size until you've banked ¼ of the goal" rule (opt-in)
}

export const DEFAULT_SETTINGS: RiskSettings = { accountType: 'cash', currency: 'CAD', fxFeePct: 0, dailyGoal: null, tradesPerGoal: 3, quarterStart: false };

/** A sensible starting goal: ~5% of the account, as in Ross's $2k small-account challenge (~$100/day). */
export function suggestedGoal(account: number): number {
  return Math.max(5, Math.round((account * 0.05) / 5) * 5);
}

export interface RiskPlan {
  // All money amounts are in the account currency unless named *Usd
  currency: Currency;
  fx: number;                 // account currency per 1 USD (1 for a USD account)
  fee: number;                // FX fee per conversion leg, as a fraction
  cash: number;               // account value (free cash + money in open positions)
  buyingPower: number;
  buyingPowerUsd: number;     // what that buys in USD after the conversion fee
  dailyGoal: number;
  goalIsSet: boolean;
  tradesPerGoal: number;
  perTradeGoal: number;       // what each 2:1 winner should pay
  maxDailyLoss: number;
  maxRiskPerTrade: number;    // ½ of the per-trade goal, so every trade is 2:1
  quarterStart: boolean;
  coldMarket: boolean;
  pdtLimited: boolean;
}

export interface SessionTrade {
  id: string;
  symbol: string;
  pnl: number;
  time: string;
}

export interface SessionStatus {
  pnl: number;
  peak: number;
  wins: number;
  losses: number;
  consecutiveLosers: number;
  hasCushion: boolean;
  sizeMultiplier: number; // 0 = stop, 0.25 = quarter size, 1 = full
  level: 'go' | 'caution' | 'stop';
  headline: string;
  reasons: string[];
}

export interface PositionSize {
  shares: number;
  fullShares: number;
  sharesByRisk: number;
  sharesByCash: number;
  costUsd: number;
  cost: number;           // account currency, incl. FX fee
  riskUsd: number;
  riskDollars: number;    // account currency lost at the stop, incl. FX fees
  rewardUsd: number;
  rewardDollars: number;  // account currency made at the target, net of FX fees
  feesEatMove: boolean;   // FX fees are bigger than the 2:1 move — untradeable in this account
  limitedBy: 'risk' | 'cash';
}

/** Net account-currency P&L of `shares` bought at `entry` and sold at `exit`, both legs converted at plan.fx with fees. */
export function netAcct(plan: RiskPlan, shares: number, entry: number, exit: number): number {
  return shares * (exit * (1 - plan.fee) - entry * (1 + plan.fee)) * plan.fx;
}

export interface Levels {
  entry: number;
  stop: number;
  target: number;
  hypothetical: boolean; // true when there's no live pullback setup — levels are an estimate
  manual?: boolean;      // typed in by the user — frozen until they switch back to live levels
}

export const PDT_THRESHOLD = 25_000;

/**
 * `cash` is free cash and `openCost` money tied up in open positions — both in the account currency.
 * `usdcad` is the live rate; for a CAD account every USD trade is converted at it.
 */
export function riskPlan(cash: number, settings: RiskSettings, temperature?: MarketTemperature | null, openCost = 0, usdcad = 1): RiskPlan {
  const coldMarket = temperature?.key === 'cold';
  const currency: Currency = settings.currency ?? 'CAD';
  const fx = currency === 'CAD' ? usdcad : 1;
  const fee = currency === 'CAD' ? Math.max(0, settings.fxFeePct ?? 0) / 100 : 0;
  const margin = settings.accountType === 'margin';
  const account = cash + openCost;
  const buyingPower = Math.max(0, margin ? account * (account >= PDT_THRESHOLD ? 4 : 2) - openCost : cash);
  const dailyGoal = settings.dailyGoal ?? suggestedGoal(account);
  const tradesPerGoal = settings.tradesPerGoal ?? 3;
  const perTradeGoal = dailyGoal / tradesPerGoal;
  return {
    currency,
    fx,
    fee,
    cash: account,
    buyingPower,
    buyingPowerUsd: buyingPower / fx / (1 + fee),
    dailyGoal,
    goalIsSet: settings.dailyGoal != null,
    tradesPerGoal,
    perTradeGoal,
    maxDailyLoss: dailyGoal,              // Ross: max loss = your daily goal
    maxRiskPerTrade: perTradeGoal / 2,    // every trade is 2:1 → a winner pays perTradeGoal (account currency)
    quarterStart: settings.quarterStart ?? false,
    coldMarket,
    pdtLimited: margin && currency === 'USD' && account < PDT_THRESHOLD,   // PDT is a US (FINRA) rule — Canadian brokers don't apply it
  };
}

export function sessionStatus(trades: SessionTrade[], plan: RiskPlan, window?: TradingWindow | null): SessionStatus {
  let pnl = 0;
  let peak = 0;
  let consecutiveLosers = 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    pnl += t.pnl;
    peak = Math.max(peak, pnl);
    if (t.pnl < 0) { losses++; consecutiveLosers++; } else { wins++; consecutiveLosers = 0; }
  }

  const stops: string[] = [];
  const cautions: string[] = [];
  if (plan.dailyGoal > 0 && pnl <= -plan.maxDailyLoss) stops.push(`Max daily loss hit (${fmtAcct(plan, -plan.maxDailyLoss)}). Accept it — try again tomorrow.`);
  if (consecutiveLosers >= 3) stops.push('3 losers in a row — done for the day.');
  if (peak >= plan.dailyGoal * 0.25 && peak > 0 && pnl <= peak / 2) stops.push(`Gave back half the day's peak (${fmtAcct(plan, peak)}). You're emotionally compromised — walk away.`);
  if (window && (window.key === 'off' || window.key === 'closed')) cautions.push('Outside the 7–10 AM ET window — his edge falls off after the open.');
  if (window?.key === 'late') cautions.push('Past 10 AM — A+ setups only.');
  if (plan.dailyGoal > 0 && pnl >= plan.dailyGoal) cautions.push('Daily goal hit — protect it. Walk away if you give back half.');
  if (plan.coldMarket) cautions.push('Cold market — Ross lowers his goal and trades less on days like this.');
  const level: SessionStatus['level'] = stops.length ? 'stop' : cautions.length ? 'caution' : 'go';
  const reasons = [...stops, ...cautions];

  const hasCushion = plan.dailyGoal > 0 && pnl >= plan.dailyGoal * 0.25;
  const sizeMultiplier = level === 'stop' ? 0 : !plan.quarterStart || hasCushion ? 1 : 0.25;

  const tradesLeft = plan.perTradeGoal > 0 ? Math.max(0, Math.ceil((plan.dailyGoal - pnl) / plan.perTradeGoal)) : 0;
  const headline =
    level === 'stop' ? 'STOP — walk away' :
    pnl >= plan.dailyGoal ? 'Goal reached — consider stopping' :
    sizeMultiplier === 0.25 ? 'Quarter size until you build a cushion' :
    `${tradesLeft} winning trade${tradesLeft === 1 ? '' : 's'} to your goal`;

  return { pnl, peak, wins, losses, consecutiveLosers, hasCushion, sizeMultiplier, level, headline, reasons };
}

// ── Fast-trade targets (≤ 30 min) ────────────────────────────────────────────
// Keep in sync with move_profile / fast_stop / realistic_targets in backend/app/services/daytrade_scanner.py.
export const HOLD_MINUTES = 30;
const NOISE_FRACTION = 0.5;

export interface MoveProfile {
  atr: number;       // average 1-min candle range
  median: number;    // typical 30-min run-up today
  p75: number;       // a good 30-min run-up
}

export function profileFor(c: DayTradeCandidate): MoveProfile {
  const s = c.setup;
  const atr = s.atr_1m ?? c.price * 0.005;
  const median = s.up30_median ?? atr * Math.sqrt(HOLD_MINUTES) * 0.6;
  return { atr, median, p75: Math.max(s.up30_p75 ?? atr * Math.sqrt(HOLD_MINUTES), median) };
}

const tickFor = (price: number) => (price < 1 ? 0.0001 : 0.01);
const roundTick = (x: number, tick: number) => Math.round(x / tick) * tick;

/**
 * Tightest sensible stop for a ≤30-minute trade: risk = the tighter of half a typical 30-min run
 * (so 2R fits inside it) and the structural support — but never inside the noise floor
 * (½ an average 1-min candle, min one tick).
 */
export function fastStop(entry: number, structural: number | null | undefined, p: MoveProfile): number {
  const tick = tickFor(entry);
  const noise = Math.max(tick, NOISE_FRACTION * p.atr);
  let risk = p.median / 2;
  if (structural != null && structural < entry) risk = Math.min(risk, entry - structural);
  risk = Math.max(risk, noise);
  const stop = Math.floor((entry - risk) / tick + 1e-9) * tick;
  return roundTick(Math.min(stop, entry - tick), tick);
}

/** Rough minutes to travel `distance`, scaling the typical 30-min run by √time. */
export function estimateMinutes(distance: number, p: MoveProfile): number | null {
  if (p.median <= 0) return null;
  return Math.max(1, Math.round(HOLD_MINUTES * (distance / p.median) ** 2));
}

/**
 * Targets in R, rated by how realistic they are within ~30 minutes.
 * Time: likely if a typical 30-min run covers it, possible if a good run does, else stretch.
 * Structure: above the high of day needs a breakout (at best possible; stretch past half the first leg).
 */
export function realisticTargets(entry: number, stop: number, hod: number, squeezeLow: number, p: MoveProfile): TargetLevel[] {
  const risk = entry - stop;
  if (risk <= 0) return [];
  const move = Math.max(0, hod - squeezeLow);
  const order: Reach[] = ['likely', 'possible', 'stretch'];
  const reach = (price: number): Reach => {
    const d = price - entry - 1e-9;
    const byTime: Reach = d <= p.median ? 'likely' : d <= p.p75 ? 'possible' : 'stretch';
    const byStructure: Reach = price <= Math.max(hod, entry) ? 'likely' : price <= hod + 0.5 * move ? 'possible' : 'stretch';
    return order[Math.max(order.indexOf(byTime), order.indexOf(byStructure))];
  };
  const mk = (label: string, price: number): TargetLevel =>
    ({ label, price, r: (price - entry) / risk, reach: reach(price), minutes: estimateMinutes(price - entry, p) });
  const out = [mk('2:1 target', entry + 2 * risk), mk('3:1 runner', entry + 3 * risk)];
  if (hod > entry) out.push(mk('HOD retest', hod));
  return out.sort((a, b) => a.price - b.price);
}

/** Target defaults to 2:1 — Ross's minimum worthwhile reward for the risk. */
export function twoToOne(entry: number, stop: number): number {
  return roundTick(entry + 2 * (entry - stop), tickFor(entry));
}

/** Entry / stop / target — the live pullback plan if there is one, otherwise an estimate from the current price. */
export function levelsFor(c: DayTradeCandidate): Levels | null {
  const s = c.setup;
  if (s.entry != null && s.stop != null && s.entry > s.stop) {
    return { entry: s.entry, stop: s.stop, target: twoToOne(s.entry, s.stop), hypothetical: false };
  }
  const entry = c.price;
  const support = [s.pullback_low, s.vwap, s.ema9].filter((x): x is number => x != null && x < entry);
  const stop = fastStop(entry, support.length ? Math.max(...support) : null, profileFor(c));
  if (entry - stop <= 0) return null;
  return { entry, stop, target: twoToOne(entry, stop), hypothetical: true };
}

export function targetsFor(c: DayTradeCandidate, levels: Levels): TargetLevel[] {
  const hod = c.setup.hod ?? c.day_high ?? levels.entry;
  const low = c.setup.squeeze_low ?? c.prev_close;
  return realisticTargets(levels.entry, levels.stop, hod, low, profileFor(c));
}

/**
 * Shares so that the 2:1 target pays the per-trade goal *in the account currency, after FX*.
 * For a CAD account the goal is converted to USD at the live rate; conversion fees on both legs
 * are taken out of the reward, so a fee-heavy account needs a few more shares (or a bigger move).
 */
export function positionSize(levels: Levels, plan: RiskPlan, sizeMultiplier: number): PositionSize | null {
  const riskPerShare = levels.entry - levels.stop;
  if (riskPerShare <= 0 || levels.entry <= 0) return null;
  const netRewardPerShare = netAcct(plan, 1, levels.entry, levels.target);   // account currency
  const feesEatMove = netRewardPerShare <= 0;
  const sharesByRisk = feesEatMove ? 0 : Math.floor(plan.perTradeGoal / netRewardPerShare + 1e-9);
  const sharesByCash = Math.floor(plan.buyingPowerUsd / levels.entry);
  const fullShares = Math.max(0, Math.min(sharesByRisk, sharesByCash));
  const shares = Math.floor(fullShares * sizeMultiplier);
  return {
    shares,
    fullShares,
    sharesByRisk,
    sharesByCash,
    costUsd: shares * levels.entry,
    cost: shares * levels.entry * (1 + plan.fee) * plan.fx,
    riskUsd: shares * riskPerShare,
    riskDollars: -netAcct(plan, shares, levels.entry, levels.stop),
    rewardUsd: shares * Math.max(0, levels.target - levels.entry),
    rewardDollars: Math.max(0, netAcct(plan, shares, levels.entry, levels.target)),
    feesEatMove,
    limitedBy: sharesByCash < sharesByRisk ? 'cash' : 'risk',
  };
}

export type CashFit = 'full' | 'partial' | 'poor';

/** How well the user's cash lets them take a proper Ross-sized position on this stock. */
/**
 * How well the user's cash lets them take a proper position, plus the suggested size at the current
 * (live) levels: `shares` to buy, what they pay at the 2:1 target and lose at the stop (account currency).
 */
export function cashFit(c: DayTradeCandidate, plan: RiskPlan, sizeMultiplier = 1): { fit: CashFit; potential: number; shares: number; risk: number; entry: number | null } {
  const lv = levelsFor(c);
  const none = { fit: 'poor' as CashFit, potential: 0, shares: 0, risk: 0, entry: lv?.entry ?? null };
  if (!lv || plan.cash <= 0) return none;
  const size = positionSize(lv, plan, sizeMultiplier);
  if (!size || size.fullShares < 1) return none;
  const fit: CashFit = size.sharesByCash >= size.sharesByRisk ? 'full' : size.sharesByCash >= size.sharesByRisk * 0.25 ? 'partial' : 'poor';
  return { fit, potential: size.rewardDollars, shares: size.shares, risk: size.riskDollars, entry: lv.entry };
}

/** Format an account-currency amount for this plan (C$ for a CAD account, $ for USD). */
export function fmtAcct(plan: Pick<RiskPlan, 'currency'>, n: number, digits = 0): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}${plan.currency === 'CAD' ? 'C$' : '$'}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Format a USD amount — "US$" when the account is in CAD so the two never get confused. */
export function fmtUsdFor(plan: Pick<RiskPlan, 'currency'>, n: number, digits = 0): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}${plan.currency === 'CAD' ? 'US$' : '$'}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtUsd(n: number, digits = 0): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null) return '—';
  return n < 1 ? n.toFixed(4) : n.toFixed(2);
}

export function fmtShares(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

// ── Buy / don't-buy verdict ──────────────────────────────────────────────────
export type Action = 'BUY' | 'READY' | 'WAIT' | 'PASS';

export interface Verdict {
  action: Action;
  headline: string;
  pros: string[];
  cons: string[];
  sizeNote: string | null;
}

export const ACTION_ORDER: Record<Action, number> = { BUY: 0, READY: 1, WAIT: 2, PASS: 3 };

/**
 * Should I buy it? Combines every factor from the skill:
 * pillars/grade, time window, market temperature, pullback state, 2:1 realism, cash fit, session guard.
 *   BUY   — setup triggered and everything lines up
 *   READY — everything lines up; buy only if it breaks the entry price
 *   WAIT  — good stock, wrong moment (extended, too early, market closed, no cash entered)
 *   PASS  — breaks a rule; don't trade it
 */
export function verdict(
  c: DayTradeCandidate,
  levels: Levels | null,
  plan: RiskPlan,
  status: SessionStatus,
  window?: TradingWindow | null,
  temperature?: MarketTemperature | null,
): Verdict {
  const pros: string[] = [];
  const cons: string[] = [];
  const blockers: string[] = [];
  const waits: string[] = [];
  const s = c.setup;

  // Stock quality
  if (c.score === 5) pros.push(`All 5 pillars${c.grade === 'A+' ? ' + A+ extras' : ''}`);
  if (c.grade === 'C') blockers.push(`Only ${c.score}/5 pillars — not his kind of stock`);
  if (c.grade === 'B') {
    if (temperature?.key === 'cold') blockers.push('4/5 pillars in a cold market — he only takes 5/5 when it\'s cold');
    else cons.push('4/5 pillars — trade it smaller');
  }
  if (c.gainer_rank && c.gainer_rank <= 3) pros.push(`#${c.gainer_rank} leading gainer — obvious stock`);
  if (c.has_fresh_news) pros.push('Fresh news catalyst');
  if ((c.rel_volume ?? 0) >= 5) pros.push(`${c.rel_volume?.toFixed(0)}x relative volume`);
  if (temperature?.key === 'hot') pros.push('Hot market — runners are following through');
  if (temperature?.key === 'cold') cons.push('Cold market — smaller goal, walk away early');

  // Time of day
  if (window?.key === 'early') waits.push('Before 7 AM ET — let volume build');
  if (window?.key === 'late' && c.grade !== 'A+') blockers.push('Past 10 AM — only A+ setups now');
  if (window?.key === 'off') blockers.push('Outside his 7–10 AM window — edge is gone for today');
  if (window?.key === 'closed') waits.push('Market closed — put it on tomorrow\'s watchlist');
  if (window?.key === 'prime') pros.push('Inside the 7–10 AM window');

  // Pattern
  if (s.state === 'extended') waits.push('Extended — wait for the first pullback, don\'t chase');
  if (s.state === 'none') waits.push('No setup has formed yet');
  if (s.state === 'broken' || s.state === 'stale') blockers.push(s.summary);
  if (s.state === 'triggered') pros.push('Entry trigger is live (first candle to make a new high)');
  if (s.state === 'pullback') pros.push(`Clean pullback (${s.retrace_pct?.toFixed(0)}% retrace, holding VWAP)`);
  if (s.topping_tail) cons.push('Topping tail at the high — sellers showed up');
  if (s.stop_in_noise) cons.push(`Stop is inside normal 1-min noise (~$${fmtPrice(s.atr_1m)}/bar) — easy to get shaken out`);
  c.flags.filter((f) => f.startsWith('NYSE') || f.startsWith('200-day')).forEach((f) => cons.push(f));

  // Reward vs risk — is 2:1 realistic?
  if (levels) {
    const risk = levels.entry - levels.stop;
    const rr = risk > 0 ? (levels.target - levels.entry) / risk : 0;
    const t2 = targetsFor(c, levels).find((t) => t.label === '2:1 target');
    const prof = profileFor(c);
    const eta = t2?.minutes != null ? (t2.minutes > 90 ? '90+ min' : `~${t2.minutes} min`) : '';
    const cents = (x: number) => (x < 1 ? `${(x * 100).toFixed(0)}¢` : `$${x.toFixed(2)}`);
    if (rr < 1) blockers.push('Target pays less than the risk — he won\'t take these');
    else if (t2?.reach === 'stretch') blockers.push(`2:1 target $${fmtPrice(t2.price)} is more than it usually moves in ${HOLD_MINUTES} min (typical run ${cents(prof.median)}) — not a fast trade`);
    else if (t2?.reach === 'possible') cons.push(`2:1 target $${fmtPrice(t2.price)} needs a better-than-typical run (${eta})`);
    else if (t2?.reach === 'likely') pros.push(`2:1 target $${fmtPrice(t2.price)} (+${cents(t2.price - levels.entry)}) fits a typical 30-min run (${eta})`);
    // In a CAD account the conversion fees come out of every winner and add to every loser
    if (plan.fee > 0 && risk > 0) {
      const netWin = netAcct(plan, 1, levels.entry, levels.target);
      const netLoss = -netAcct(plan, 1, levels.entry, levels.stop);
      const netRR = netLoss > 0 ? netWin / netLoss : 0;
      if (netRR < 1) blockers.push(`After ${(plan.fee * 100).toFixed(1)}% FX fees each way this 2:1 is only ${netRR.toFixed(2)}:1 in ${plan.currency} — the fees eat the edge`);
      else if (netRR < 1.8) cons.push(`FX fees cut this to ${netRR.toFixed(2)}:1 in ${plan.currency}`);
    }
    if (risk / levels.entry > 0.05) cons.push(`Wide stop (${((risk / levels.entry) * 100).toFixed(1)}% of price) — slow to pay 2:1`);
  }

  // Cash & session
  if (plan.cash <= 0) waits.push('Enter your cash to size it');
  else if (levels) {
    const size = positionSize(levels, plan, 1);
    if (!size || size.fullShares < 1) blockers.push('Your cash can\'t buy a meaningful position');
    else if (size.sharesByCash < size.sharesByRisk * 0.25) blockers.push('Too expensive for your cash — the position would be too small to matter');
    else if (size.limitedBy === 'cash') cons.push('Position limited by your cash, not by risk');
    else pros.push('Your cash covers a full-risk position');
  }
  if (status.level === 'stop') blockers.unshift(`Session guard: ${status.reasons[0] ?? 'stop trading today'}`);

  let action: Action;
  let headline: string;
  if (blockers.length) {
    action = 'PASS';
    headline = blockers[0];
  } else if (waits.length) {
    action = 'WAIT';
    headline = waits[0];
  } else if (s.state === 'pullback' && levels) {
    action = 'READY';
    headline = `Buy only if it breaks $${fmtPrice(levels.entry)} — stop $${fmtPrice(levels.stop)}, target $${fmtPrice(levels.target)}`;
  } else if (s.state === 'triggered' && levels) {
    action = 'BUY';
    headline = `Buy near $${fmtPrice(levels.entry)} — stop $${fmtPrice(levels.stop)}, 2:1 target $${fmtPrice(levels.target)}`;
  } else {
    action = 'WAIT';
    headline = 'No live entry yet';
  }

  const notes: string[] = [];
  if (c.grade === 'B') notes.push('reduced size (4/5 pillars)');
  if (status.sizeMultiplier === 0.25) notes.push('¼ size until you build a cushion');
  const sizeNote = action === 'BUY' || action === 'READY' ? (notes.length ? `Size: ${notes.join(', ')}` : 'Size: full') : null;

  return { action, headline, pros, cons: [...blockers.slice(action === 'PASS' ? 1 : 0), ...waits.slice(action === 'WAIT' ? 1 : 0), ...cons], sizeNote };
}

/** Snapshot of the stock and setup at entry — what the Portfolio insights slice by. */
export function contextFor(c: DayTradeCandidate, v: Verdict | null, window?: TradingWindow | null, temperature?: MarketTemperature | null): TradeContext {
  return {
    grade: c.grade, score: c.score, changePct: c.change_pct, relVolume: c.rel_volume, floatShares: c.float_shares,
    hasNews: c.has_fresh_news, sector: c.sector, country: c.country, exchange: c.exchange,
    setupState: c.setup.state, verdict: v?.action, windowKey: window?.key, temperature: temperature?.key,
    gainerRank: c.gainer_rank,
  };
}

// ── Today's game plan: the stocks most likely to get you to your goal ────────
export interface GoalPick {
  c: DayTradeCandidate;
  v: Verdict;
  levels: Levels;
  size: PositionSize;
  reach: Reach | null;
  minutes: number | null;
  pays: number;          // $ at the 2:1 target with the planned size
  coverage: number;      // pays ÷ per-trade goal (capped at 1)
  score: number;
}

export interface GamePlan {
  picks: GoalPick[];
  plannedTotal: number;  // what the top `tradesPerGoal` picks pay if they all hit 2:1
  headline: string;
  notes: string[];
}

const ACTION_WEIGHT: Record<Action, number> = { BUY: 3, READY: 2.5, WAIT: 1, PASS: 0 };
const GRADE_WEIGHT: Record<string, number> = { 'A+': 2, A: 1.5, B: 0.8, C: 0 };

/**
 * Rank the scanner by how well each stock serves *your* plan, using the skill's rules:
 * never a PASS (broken pattern, bad pillars, unrealistic 2:1, can't size it, session stopped),
 * prefer live setups (BUY > READY > WAIT), higher grades, 2:1 reachable within ~30 min,
 * a position your cash can size to pay the per-trade goal, the obvious leading gainers, fresh news.
 */
export function gamePlan(
  candidates: DayTradeCandidate[],
  plan: RiskPlan,
  status: SessionStatus,
  window?: TradingWindow | null,
  temperature?: MarketTemperature | null,
): GamePlan {
  const picks: GoalPick[] = [];
  for (const c of candidates) {
    const levels = levelsFor(c);
    if (!levels) continue;
    const v = verdict(c, levels, plan, status, window, temperature);
    if (v.action === 'PASS') continue;
    const size = positionSize(levels, plan, status.sizeMultiplier);
    if (!size || size.shares < 1) continue;
    const t2 = targetsFor(c, levels).find((t) => t.label === '2:1 target') ?? null;
    if (t2?.reach === 'stretch') continue;
    const pays = size.rewardDollars;
    const coverage = plan.perTradeGoal > 0 ? Math.min(1, pays / plan.perTradeGoal) : 0;
    const score =
      ACTION_WEIGHT[v.action] +
      (GRADE_WEIGHT[c.grade] ?? 0) +
      (t2?.reach === 'likely' ? 1 : t2?.reach === 'possible' ? 0.4 : 0) +
      coverage * 1.5 +
      (c.gainer_rank && c.gainer_rank <= 3 ? 0.5 : 0) +
      (c.has_fresh_news ? 0.3 : 0);
    picks.push({ c, v, levels, size, reach: t2?.reach ?? null, minutes: t2?.minutes ?? null, pays, coverage, score });
  }
  picks.sort((a, b) => b.score - a.score);
  const top = picks.slice(0, plan.tradesPerGoal + 2);   // the trades you need + a couple of backups
  const plannedTotal = top.slice(0, plan.tradesPerGoal).reduce((s, p) => s + p.pays, 0);

  const notes: string[] = [];
  const remaining = Math.max(0, plan.dailyGoal - status.pnl);
  let headline: string;
  if (status.level === 'stop') {
    headline = 'Session guard says stop — no new trades today';
  } else if (status.pnl >= plan.dailyGoal) {
    headline = `Goal reached (${fmtAcct(plan, status.pnl)}) — protect it`;
  } else if (!top.length) {
    headline = 'Nothing fits your plan right now — waiting is a position';
    if (window?.key === 'early') notes.push('Before 7 AM ET — the list fills in as pre-market volume builds.');
    if (window?.key === 'off' || window?.key === 'closed') notes.push("Outside his 7–10 AM window. Build tomorrow's list on the Next-Day Watchlist.");
  } else {
    const live = top.filter((p) => p.v.action === 'BUY' || p.v.action === 'READY').length;
    headline = live
      ? `${live} live setup${live === 1 ? '' : 's'} toward your ${fmtAcct(plan, remaining)} still to make`
      : `Watching ${top.length} — waiting for a first pullback`;
    if (plannedTotal + 0.01 < remaining && top.length >= plan.tradesPerGoal) {
      notes.push(`Your cash caps the top ${plan.tradesPerGoal} at ${fmtAcct(plan, plannedTotal)} — you may need ${Math.ceil(remaining / Math.max(plannedTotal / plan.tradesPerGoal, 1))} winners today.`);
    }
    if (top.length < plan.tradesPerGoal) notes.push(`Only ${top.length} stock${top.length === 1 ? '' : 's'} fit${top.length === 1 ? 's' : ''} right now — don't force the rest.`);
  }
  if (temperature?.key === 'cold') notes.push('Cold market — Ross trades less and walks away sooner on days like this.');
  return { picks: top, plannedTotal, headline, notes };
}
