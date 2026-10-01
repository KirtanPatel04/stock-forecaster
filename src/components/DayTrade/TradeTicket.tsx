import { useEffect, useState } from 'react';
import type { DayTradeCandidate, Reach, TargetLevel } from '../../types/daytrade';
import {
  fmtAcct, fmtPrice, fmtUsd, fmtUsdFor, netAcct, positionSize, twoToOne, PDT_THRESHOLD, HOLD_MINUTES, type MoveProfile,
  type Levels, type RiskPlan, type RiskSettings, type SessionStatus, type SessionTrade, type Verdict, type TradeMode,
} from '../../lib/rossRules';
import { VerdictBanner } from './Verdict';
import { livePnl, type Position } from '../../lib/journal';

interface Props {
  candidate: DayTradeCandidate | null;
  levels: Levels | null;
  targets: TargetLevel[];
  profile: MoveProfile | null;
  verdict: Verdict | null;
  onLevelsChange: (l: Levels) => void;
  onUseLiveLevels: () => void;
  liveUpdatedAt: number | null;   // when the chart (and so the live levels) last refreshed
  cash: number;
  settings: RiskSettings;
  onEditPlan: () => void;
  plan: RiskPlan;
  status: SessionStatus;
  trades: SessionTrade[];
  onLogTrade: (symbol: string, pnl: number, mode: TradeMode) => void;
  positions: Position[];          // open positions in the selected stock
  lastPrice: number | null;
  onRequestBuy: (shares: number) => void;                  // opens the real/paper confirmation
  onRequestSell: (pos: Position, shares?: number) => void; // ditto
  onRemoveTrade: (id: string) => void;
  onResetSession: () => void;
  sections?: TicketSection[];     // render only these (as layout widgets); default all
}

export type TicketSection = 'account' | 'guard' | 'order' | 'holding' | 'trades';

const LEVEL_STYLE = {
  go: 'border-green-500/40 bg-green-500/10 text-green-400',
  caution: 'border-yellow-400/40 bg-yellow-400/10 text-yellow-400',
  stop: 'border-red-500/50 bg-red-500/15 text-red-400',
};

const REACH_STYLE: Record<Reach, string> = {
  likely: 'text-green-400 border-green-500/40',
  possible: 'text-yellow-400 border-yellow-400/40',
  stretch: 'text-red-400 border-red-500/40',
};

const fmtMove = (x: number) => (x < 1 ? `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}¢` : `$${x.toFixed(2)}`);

function Row({ label, value, cls = 'text-white' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className={`font-mono ${cls}`}>{value}</span>
    </div>
  );
}

function NumInput({ label, value, onChange, color }: { label: string; value: number; onChange: (n: number) => void; color: string }) {
  const [text, setText] = useState(fmtPrice(value));
  useEffect(() => setText(fmtPrice(value)), [value]);
  return (
    <label className="block">
      <span className={`text-[10px] ${color}`}>{label}</span>
      <input value={text} inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { const n = parseFloat(text); if (n > 0) onChange(n); else setText(fmtPrice(value)); }}
        className="w-full bg-surface border border-border rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-accent" />
    </label>
  );
}

/** Webull-style right panel: account & risk, the order ticket for the selected stock, and today's session guard. */
export function TradeTicket(p: Props) {
  const { candidate: c, levels, plan, status } = p;
  const show = (k: TicketSection) => !p.sections || p.sections.includes(k);
  const [pnlText, setPnlText] = useState('');
  const [logMode, setLogMode] = useState<TradeMode | null>(null);
  const [sharesText, setSharesText] = useState('');

  const size = levels ? positionSize(levels, plan, status.sizeMultiplier) : null;
  // Reset the share override whenever the suggested size changes (new stock / new levels)
  useEffect(() => setSharesText(''), [c?.symbol, size?.shares]);
  const buyShares = sharesText ? Math.max(0, Math.floor(Number(sharesText))) : size?.shares ?? 0;

  const buy = () => { if (buyShares >= 1) p.onRequestBuy(buyShares); };
  // What a 2:1 winner pays in the account currency, after converting back from USD (and FX fees)
  const winnerPays = levels ? netAcct(plan, buyShares, levels.entry, levels.target) : 0;
  // Whole shares round the reward down a little — within one share's worth counts as on-plan
  const onPlan = levels ? winnerPays + netAcct(plan, 1, levels.entry, levels.target) >= plan.perTradeGoal : false;
  const cad = plan.currency === 'CAD';
  const acct = (n: number, d = 0) => fmtAcct(plan, n, d);
  const rr = levels && levels.entry > levels.stop ? (levels.target - levels.entry) / (levels.entry - levels.stop) : null;

  const submitPnl = (sign: 1 | -1) => {
    const n = Math.abs(parseFloat(pnlText));
    if (!n || !c || !logMode) return;
    p.onLogTrade(c.symbol, sign * n, logMode);
    setPnlText('');
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto text-xs">
      {/* Account */}
      {show('account') && (<>
      <section className="p-3 border-b border-border space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Account</h3>
        <div className="bg-surface rounded p-2 space-y-1">
          <div className="flex justify-between"><span className="text-gray-500">Real cash</span><span className="font-mono text-white">{acct(p.cash, 2)}</span></div>
          {cad && (
            <div className="flex justify-between"><span className="text-gray-500">USD → CAD</span>
              <span className="font-mono text-gray-300">{plan.fx.toFixed(4)}{plan.fee > 0 ? ` · ${(plan.fee * 100).toFixed(2)}% fee` : ''}</span></div>
          )}
          <div className="flex justify-between">
            <span className="text-gray-500">Daily goal</span>
            <span className="font-mono text-green-400">{acct(plan.dailyGoal)}{!plan.goalIsSet && <span className="text-yellow-400"> (suggested)</span>}</span>
          </div>
          <div className="flex justify-between"><span className="text-gray-500">In {plan.tradesPerGoal} winners of</span><span className="font-mono text-green-400">+{acct(plan.perTradeGoal, 2)} each</span></div>
          <button onClick={p.onEditPlan} className="w-full mt-1 py-1 rounded border border-border text-[11px] text-gray-300 hover:text-white hover:border-accent">
            {plan.goalIsSet ? 'Edit cash & daily goal' : 'Set my cash & daily goal'}
          </button>
        </div>
        {plan.cash > 0 ? (
          <div className="space-y-1 pt-1">
            <Row label="Buying power" value={cad ? `${acct(plan.buyingPower)} ≈ ${fmtUsdFor(plan, plan.buyingPowerUsd)}` : acct(plan.buyingPower)} />
            <Row label="Max daily loss" value={acct(-plan.maxDailyLoss)} cls="text-red-400" />
            <Row label="Risk / trade (½ of each winner)" value={acct(plan.maxRiskPerTrade, 2)} />
            {plan.pdtLimited && (
              <p className="text-[10px] text-yellow-400">Margin under {fmtUsd(PDT_THRESHOLD)}: PDT rule limits you to 3 day trades per 5 days.</p>
            )}
            {p.settings.accountType === 'cash' && p.cash > 0 && (
              <p className="text-[10px] text-gray-500">Cash account: no PDT limit, but funds settle T+1 — you can't reuse today's sale proceeds until tomorrow.</p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-yellow-400">Set your cash and daily goal to size positions and filter the scanner.</p>
        )}
      </section>
      </>)}

      {/* Session guard */}
      {show('guard') && (<>
      <section className="p-3 border-b border-border space-y-2">
        <div className={`rounded border px-2 py-1.5 ${LEVEL_STYLE[status.level]}`}>
          <div className="font-semibold text-[11px]">{status.headline}</div>
          {status.reasons.map((r) => <div key={r} className="text-[10px] opacity-90 mt-0.5">{r}</div>)}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div><div className="text-[9px] text-gray-500">Day P&L</div><div className={`font-mono font-semibold ${status.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{acct(status.pnl)}</div></div>
          <div><div className="text-[9px] text-gray-500">W / L</div><div className="font-mono text-white">{status.wins} / {status.losses}</div></div>
          <div><div className="text-[9px] text-gray-500">To goal</div><div className="font-mono text-white">{Math.max(0, Math.round((status.pnl / Math.max(plan.dailyGoal, 1)) * 100))}%</div></div>
        </div>
        {plan.dailyGoal > 0 && (
          <div className="h-1.5 bg-surface rounded overflow-hidden">
            <div className={`h-full ${status.pnl >= 0 ? 'bg-green-500' : 'bg-red-500'}`}
              style={{ width: `${Math.min(100, (Math.abs(status.pnl) / plan.dailyGoal) * 100)}%` }} />
          </div>
        )}
      </section>
      </>)}

      {/* Order ticket */}
      {show('order') && (<>
      <section className="p-3 border-b border-border space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Trade Plan {c ? `· ${c.symbol}` : ''}</h3>
          {levels?.manual ? (
            <button onClick={p.onUseLiveLevels} className="text-[9px] text-yellow-400 hover:underline" title="Your typed levels are frozen — click to follow the chart again">
              ✎ manual · ↺ use live
            </button>
          ) : levels?.hypothetical ? (
            <span className="text-[9px] text-yellow-400">estimate — no live setup</span>
          ) : p.liveUpdatedAt ? (
            <span className="text-[9px] text-green-400 flex items-center gap-1" title="Entry, stop and 2:1 target recalculate from the chart every few seconds">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE · {Math.max(0, Math.round((Date.now() - p.liveUpdatedAt) / 1000))}s
            </span>
          ) : null}
        </div>
        {!c || !levels ? (
          <p className="text-gray-500">Select a stock from the scanner.</p>
        ) : (
          <>
            {p.verdict && <VerdictBanner v={p.verdict} />}
            <div className="grid grid-cols-3 gap-1.5">
              <NumInput label="Entry" value={levels.entry} color="text-accent"
                onChange={(entry) => p.onLevelsChange({ ...levels, entry, target: twoToOne(entry, levels.stop), hypothetical: true })} />
              <NumInput label="Stop" value={levels.stop} color="text-red-400"
                onChange={(stop) => p.onLevelsChange({ ...levels, stop, target: twoToOne(levels.entry, stop), hypothetical: true })} />
              <div>
                <span className="text-[10px] text-green-400">Target · 2:1</span>
                <div className="bg-surface border border-border rounded px-2 py-1 text-xs font-mono text-green-400">{fmtPrice(levels.target)}</div>
              </div>
            </div>
            {size && plan.cash > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 bg-surface rounded px-2 py-1.5">
                  <span className="text-gray-400">Shares</span>
                  <input value={sharesText || String(size.shares)} inputMode="numeric"
                    onChange={(e) => setSharesText(e.target.value.replace(/[^0-9]/g, ''))}
                    className="w-24 bg-transparent text-right text-lg font-mono font-semibold text-white focus:outline-none" />
                </div>
                <div className={`rounded px-2 py-1.5 text-[11px] ${onPlan ? 'bg-green-500/10 text-green-300' : 'bg-yellow-400/10 text-yellow-300'}`}>
                  At the 2:1 target this pays <span className="font-mono font-semibold">+{acct(winnerPays, 2)}</span>
                  {cad && <> (US${(buyShares * (levels.target - levels.entry)).toFixed(2)} at {plan.fx.toFixed(4)}{plan.fee > 0 ? ', after FX fees' : ''})</>}
                  {' '}— {Math.round((winnerPays / Math.max(plan.dailyGoal, 0.01)) * 100)}% of your {acct(plan.dailyGoal)} goal.
                  {!onPlan && winnerPays > 0 && (
                    <> {size.limitedBy === 'cash' ? 'Your cash caps the size' : 'Smaller than planned'} — you'd need ~{Math.ceil(plan.dailyGoal / winnerPays)} winners like this.</>
                  )}
                </div>
                <button onClick={buy} disabled={buyShares < 1}
                  className={`w-full py-1.5 rounded font-semibold text-[12px] disabled:opacity-40 ${status.level === 'stop' ? 'bg-red-500/20 text-red-300 border border-red-500/40' : 'bg-green-500 text-black hover:bg-green-400'}`}>
                  {`Buy ${buyShares.toLocaleString()} @ $${fmtPrice(levels.entry)}…${status.level === 'stop' ? ' (guard says stop)' : ''}`}
                </button>
                <p className="text-[9px] text-gray-500 text-center">Next you'll confirm: real order with your broker (and your actual fill) or paper trade.</p>
                {buyShares * levels.entry > plan.buyingPowerUsd + 0.01 && <p className="text-[10px] text-red-400">That's more than your buying power ({acct(plan.buyingPower)}).</p>}
                {status.sizeMultiplier === 0.25 && size.fullShares > 0 && (
                  <p className="text-[10px] text-gray-500">¼ of full size ({size.fullShares.toLocaleString()}) until you bank {acct(plan.dailyGoal * 0.25)} — Ross's cushion rule (turn off in your plan).</p>
                )}
                <Row label="Cost" value={cad ? `${fmtUsdFor(plan, size.costUsd, 2)} ≈ ${acct(size.cost, 2)}` : acct(size.cost, 2)} />
                <Row label="Risk" value={acct(-size.riskDollars, 2)} cls="text-red-400" />
                <Row label="Reward to target" value={acct(size.rewardDollars, 2)} cls="text-green-400" />
                {size.feesEatMove && <p className="text-[10px] text-red-400">FX fees are bigger than this 2:1 move — not tradeable in a CAD account.</p>}
                <Row label="Reward : Risk" value={rr != null ? `${rr.toFixed(2)} : 1` : '—'} cls={rr != null && rr >= 2 ? 'text-green-400' : rr != null && rr >= 1 ? 'text-yellow-400' : 'text-red-400'} />
                {p.targets.length > 0 && (
                  <div className="pt-1.5 mt-1 border-t border-border space-y-1">
                    <div className="text-[10px] text-gray-500">Targets · realistic within {HOLD_MINUTES} min?</div>
                    {p.targets.map((t) => (
                      <div key={t.label} className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-400">{t.label}</span>
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-white">{fmtPrice(t.price)}</span>
                          <span className="font-mono text-gray-500 w-12 text-right">+{acct(netAcct(plan, size.shares, levels.entry, t.price))}</span>
                          <span className="font-mono text-gray-500 w-12 text-right">{t.minutes == null ? '' : t.minutes > 90 ? '90m+' : `~${t.minutes}m`}</span>
                          <span className={`text-[8px] uppercase px-1 rounded border ${REACH_STYLE[t.reach]}`}>{t.reach}</span>
                        </span>
                      </div>
                    ))}
                    {p.profile && (
                      <p className="text-[10px] text-gray-400">
                        Typical 30-min run today: <span className="font-mono text-white">{fmtMove(p.profile.median)}</span> · good: <span className="font-mono text-white">{fmtMove(p.profile.p75)}</span> · avg 1-min candle <span className="font-mono">{fmtMove(p.profile.atr)}</span>
                      </p>
                    )}
                    <p className="text-[9px] text-gray-600 leading-snug">
                      Stop is sized so 2:1 fits inside how far this stock has actually run in 30-minute windows over the last ~2 hours — often just a few cents — but never tighter than half an average 1-min candle. Likely = a typical run gets there; possible = needs a good run or a new high; stretch = not a fast trade.
                    </p>
                  </div>
                )}
                <p className="text-[10px] text-gray-500">
                  Limited by {size.limitedBy === 'cash' ? 'your cash' : 'max risk per trade'} · {size.sharesByRisk.toLocaleString()} by risk / {size.sharesByCash.toLocaleString()} by cash
                </p>
                {status.level === 'stop' && <p className="text-[10px] text-red-400 font-semibold">Session guard says stop. No new trades today.</p>}
              </div>
            ) : (
              <p className="text-gray-500">{plan.cash > 0 ? 'Stop must be below entry.' : 'Enter cash above to size this trade.'}</p>
            )}
          </>
        )}
      </section>
      </>)}

      {/* Open positions in this stock */}
      {show('holding') && (<>
      {p.positions.length > 0 && (
        <section className="p-3 border-b border-border space-y-2">
          <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Open position · {c?.symbol}</h3>
          {p.positions.map((pos) => {
            const last = p.lastPrice ?? pos.entry;
            const pnl = livePnl(pos, last, plan.fx).pnlAcct;   // price move + FX move + fees, as if sold now
            return (
              <div key={pos.id} className="bg-surface rounded p-2 space-y-1">
                <div className="flex justify-between">
                  <span className="font-mono text-white">
                    <span className={`text-[8px] font-bold px-1 mr-1 rounded ${pos.mode === 'paper' ? 'bg-accent/20 text-accent' : 'bg-green-500/20 text-green-400'}`}>{pos.mode === 'paper' ? 'PAPER' : 'REAL'}</span>
                    {pos.shares.toLocaleString()} @ ${fmtPrice(pos.entry)}
                  </span>
                  <span className={`font-mono font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{pnl >= 0 ? '▲' : '▼'} {acct(pnl, 2)}</span>
                </div>
                <div className="flex justify-between text-[10px] text-gray-500">
                  <span>Last ${fmtPrice(last)}</span>
                  {pos.stop != null && <span className={last <= pos.stop ? 'text-red-400 font-semibold' : ''}>Stop ${fmtPrice(pos.stop)}{last <= pos.stop ? ' — HIT, get out' : ''}</span>}
                  {pos.target != null && <span className={last >= pos.target ? 'text-green-400 font-semibold' : ''}>Tgt ${fmtPrice(pos.target)}{last >= pos.target ? ' ✓' : ''}</span>}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => p.onRequestSell(pos, Math.floor(pos.shares / 2))} disabled={pos.shares < 2}
                    className="flex-1 py-1 rounded border border-border text-gray-300 hover:text-white disabled:opacity-40">Sell ½</button>
                  <button onClick={() => p.onRequestSell(pos)}
                    className="flex-1 py-1 rounded bg-red-500/80 text-white font-semibold hover:bg-red-500">Sell all…</button>
                </div>
              </div>
            );
          })}
        </section>
      )}
      </>)}

      {/* Log trades */}
      {show('trades') && (<>
      <section className="p-3 space-y-2">
        <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Today's trades · quick-log a P&L</h3>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-gray-500">Was it</span>
          {(['real', 'paper'] as const).map((m) => (
            <button key={m} onClick={() => setLogMode(m)}
              className={`px-2 py-0.5 rounded border ${logMode === m ? 'border-accent text-accent' : 'border-border text-gray-400'}`}>
              {m === 'real' ? '💵 real money' : '📝 paper'}
            </button>
          ))}
          <span className="text-gray-500">?</span>
        </div>
        <div className="flex gap-1">
          <input value={pnlText} onChange={(e) => setPnlText(e.target.value)} inputMode="decimal" placeholder={`P&L ${cad ? "C$" : "$"}`}
            className="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1 font-mono text-white focus:outline-none focus:border-accent" />
          <button disabled={!c || !logMode} onClick={() => submitPnl(1)} className="px-2 rounded bg-green-500/20 text-green-400 border border-green-500/40 disabled:opacity-40">Win</button>
          <button disabled={!c || !logMode} onClick={() => submitPnl(-1)} className="px-2 rounded bg-red-500/20 text-red-400 border border-red-500/40 disabled:opacity-40">Loss</button>
        </div>
        <div className="space-y-0.5">
          {p.trades.slice().reverse().map((t) => (
            <div key={t.id} className="flex items-center justify-between text-[11px] group">
              <span className="text-gray-400 font-mono">{new Date(t.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} {t.symbol}</span>
              <span className="flex items-center gap-2">
                <span className={`font-mono ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{acct(t.pnl, 2)}</span>
                <button onClick={() => p.onRemoveTrade(t.id)} className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100">×</button>
              </span>
            </div>
          ))}
        </div>
        {p.trades.length > 0 && (
          <button onClick={p.onResetSession} className="text-[10px] text-gray-600 hover:text-gray-400">Reset today's session</button>
        )}
        <p className="text-[9px] text-gray-600 pt-2 leading-snug">
          Educational tool based on Ross Cameron's public videos. Day trading is risky; his results aren't typical. Practice in a simulator first.
        </p>
      </section>
      </>)}

    </div>
  );
}
