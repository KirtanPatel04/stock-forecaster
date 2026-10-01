import { useEffect, useState } from 'react';
import { fmtAcct, fmtPrice, fmtUsdFor, twoToOne, type RiskPlan, type TradeMode } from '../../lib/rossRules';

export interface OrderRequest {
  side: 'buy' | 'sell';
  symbol: string;
  price: number;             // suggested fill (planned entry, or the live price for a sell)
  shares: number;            // suggested shares
  maxShares?: number;        // sell: shares held
  stop?: number | null;      // buy: planned stop
  mode?: TradeMode;          // sell: the position's mode (fixed)
  entry?: number;            // sell: the position's entry, for the P&L preview
  fxOpen?: number;           // sell: the rate the position was bought at
  feePct?: number;           // sell: the position's FX fee
}

export interface OrderResult {
  mode: TradeMode;
  price: number;
  shares: number;
  fx: number;                // account currency per 1 USD used for this fill
  stop?: number;
  target?: number;
}

interface Props {
  order: OrderRequest | null;
  plan: RiskPlan;
  onConfirm: (r: OrderResult) => void;
  onCancel: () => void;
}

const num = (s: string) => {
  const n = parseFloat(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * The app never places orders. Before anything is recorded we ask: was this a real order with your
 * broker (and what did you actually get filled at), or a paper trade? Buys keep the target at 2:1
 * from the actual fill and the stop.
 */
export function OrderDialog({ order, plan, onConfirm, onCancel }: Props) {
  const [mode, setMode] = useState<TradeMode | null>(null);
  const [priceText, setPriceText] = useState('');
  const [sharesText, setSharesText] = useState('');
  const [stopText, setStopText] = useState('');
  const [fxText, setFxText] = useState('');

  useEffect(() => {
    if (!order) return;
    setMode(order.side === 'sell' ? order.mode ?? 'real' : null);   // buys must be answered explicitly
    setPriceText(fmtPrice(order.price));
    setSharesText(String(order.shares));
    setStopText(order.stop != null ? fmtPrice(order.stop) : '');
    setFxText(plan.fx.toFixed(4));
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!order) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, onCancel]);

  if (!order) return null;
  const isBuy = order.side === 'buy';
  const price = num(priceText);
  const shares = Math.floor(num(sharesText));
  const stop = num(stopText);
  const target = isBuy && price > stop ? twoToOne(price, stop) : NaN;
  const risk = isBuy && price > stop ? (price - stop) * shares : NaN;
  const reward = risk * 2;
  const cad = plan.currency === 'CAD';
  const rate = cad ? num(fxText) : 1;
  const fee = isBuy ? plan.fee : (order.feePct ?? plan.fee * 100) / 100;
  // Account-currency amounts: both legs converted, fees on each leg
  const costAcct = price * shares * rate * (1 + fee);
  const riskAcct = isBuy && price > stop ? shares * (price * (1 + fee) - stop * (1 - fee)) * rate : NaN;
  const rewardAcct = isBuy && price > stop ? shares * (target * (1 - fee) - price * (1 + fee)) * rate : NaN;
  const pnl = !isBuy && order.entry != null
    ? shares * (price * rate * (1 - fee) - order.entry * (order.fxOpen ?? rate) * (1 + fee))
    : NaN;
  const pnlUsd = !isBuy && order.entry != null ? (price - order.entry) * shares : NaN;
  const maxShares = !isBuy ? order.maxShares ?? order.shares : Infinity;

  const valid = mode != null && price > 0 && shares > 0 && shares <= maxShares && rate > 0 && (!isBuy || (stop > 0 && stop < price));

  const confirm = () => {
    if (!valid || !mode) return;
    onConfirm(isBuy ? { mode, price, shares, stop, target, fx: rate } : { mode, price, shares, fx: rate });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="w-full max-w-sm bg-panel border border-border rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">{isBuy ? 'Record a buy' : 'Record a sell'} · <span className="font-mono">{order.symbol}</span></h3>
          <button onClick={onCancel} className="text-gray-500 hover:text-white">×</button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          {isBuy ? (
            <div className="space-y-1.5">
              <p className="text-gray-300">This app doesn't place orders. <span className="text-white font-semibold">Did you actually buy this with your broker?</span></p>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setMode('real')}
                  className={`rounded border px-2 py-2 text-left ${mode === 'real' ? 'border-green-500 bg-green-500/15' : 'border-border hover:border-gray-500'}`}>
                  <div className="font-semibold text-white">💵 Yes — real money</div>
                  <div className="text-[10px] text-gray-400">I'll enter my actual fill. Moves my cash.</div>
                </button>
                <button onClick={() => setMode('paper')}
                  className={`rounded border px-2 py-2 text-left ${mode === 'paper' ? 'border-accent bg-accent/15' : 'border-border hover:border-gray-500'}`}>
                  <div className="font-semibold text-white">📝 Paper trade</div>
                  <div className="text-[10px] text-gray-400">Practice only. Cash untouched.</div>
                </button>
              </div>
            </div>
          ) : (
            <p className="text-gray-300">
              {mode === 'paper'
                ? <>📝 <span className="text-white font-semibold">Paper position</span> — closes at the price below.</>
                : <>💵 <span className="text-white font-semibold">Real position</span> — enter the price your broker actually sold at.</>}
            </p>
          )}

          {mode && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[10px] text-gray-400">
                    {mode === 'real' ? (isBuy ? 'Your actual fill price' : 'Your actual sell price') : (isBuy ? 'Paper fill price' : 'Paper exit price')}{cad ? ' (US$)' : ''}
                  </span>
                  <input value={priceText} onChange={(e) => setPriceText(e.target.value)} inputMode="decimal" autoFocus
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="text-[10px] text-gray-400">{isBuy ? 'Shares' : `Shares (you hold ${maxShares})`}</span>
                  <input value={sharesText} onChange={(e) => setSharesText(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric"
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-accent" />
                </label>
              </div>

              {cad && (
                <label className="block">
                  <span className="text-[10px] text-gray-400">
                    {mode === 'real' ? 'USD→CAD rate your broker used' : 'USD→CAD rate (live)'}{plan.fee > 0 || (order.feePct ?? 0) > 0 ? ` · ${((isBuy ? plan.fee : (order.feePct ?? 0) / 100) * 100).toFixed(2)}% FX fee per conversion` : ''}
                  </span>
                  <input value={fxText} onChange={(e) => setFxText(e.target.value)} inputMode="decimal" disabled={mode !== 'real'}
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-accent disabled:opacity-60" />
                  <span className="text-[10px] text-gray-500">
                    {isBuy ? 'Costs' : 'Proceeds'} {fmtUsdFor(plan, price * shares, 2)} ≈ <span className="text-gray-300">{fmtAcct(plan, isBuy ? costAcct : price * shares * rate * (1 - fee), 2)}</span>
                  </span>
                </label>
              )}

              {isBuy && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-[10px] text-red-400">Stop</span>
                      <input value={stopText} onChange={(e) => setStopText(e.target.value)} inputMode="decimal"
                        className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-red-400" />
                    </label>
                    <div>
                      <span className="text-[10px] text-green-400">Target (2:1 from your fill)</span>
                      <div className="bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-green-400">{Number.isFinite(target) ? fmtPrice(target) : '—'}</div>
                    </div>
                  </div>
                  {Number.isFinite(risk) && (
                    <div className="bg-surface rounded px-2 py-1.5 space-y-0.5">
                      <div className="flex justify-between"><span className="text-gray-500">Risk if stopped</span>
                        <span className="font-mono text-red-400">-{fmtAcct(plan, riskAcct, 2)}{cad && <span className="text-gray-500"> (US${risk.toFixed(2)})</span>}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Reward at 2:1 target</span>
                        <span className="font-mono text-green-400">+{fmtAcct(plan, rewardAcct, 2)}{cad && <span className="text-gray-500"> (US${reward.toFixed(2)})</span>}</span></div>
                      {plan.dailyGoal > 0 && (
                        <div className="flex justify-between"><span className="text-gray-500">Share of today's goal</span>
                          <span className="font-mono text-white">{Math.round((rewardAcct / plan.dailyGoal) * 100)}% of {fmtAcct(plan, plan.dailyGoal)}</span></div>
                      )}
                      {mode === 'real' && costAcct > plan.buyingPower + 0.01 && (
                        <p className="text-[10px] text-red-400">Costs {fmtAcct(plan, costAcct, 2)} — more than your buying power ({fmtAcct(plan, plan.buyingPower, 2)}).</p>
                      )}
                    </div>
                  )}
                  {stop >= price && <p className="text-[10px] text-red-400">Stop must be below your fill price.</p>}
                </div>
              )}

              {!isBuy && Number.isFinite(pnl) && (
                <div className="bg-surface rounded px-2 py-1.5 flex justify-between">
                  <span className="text-gray-500">P&L on {shares || 0} shares</span>
                  <span className={`font-mono font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {pnl >= 0 ? '▲ +' : '▼ '}{fmtAcct(plan, pnl, 2)}
                    {cad && <span className="text-gray-500 font-normal"> (US${pnlUsd.toFixed(2)} + FX)</span>}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border flex gap-2">
          <button onClick={onCancel} className="flex-1 py-1.5 rounded border border-border text-gray-300 hover:text-white text-xs">Cancel</button>
          <button onClick={confirm} disabled={!valid}
            className={`flex-1 py-1.5 rounded font-semibold text-xs disabled:opacity-40 ${isBuy ? 'bg-green-500 text-black hover:bg-green-400' : 'bg-red-500 text-white hover:bg-red-400'}`}>
            {mode == null ? 'Choose real or paper' : `Record ${mode} ${isBuy ? 'buy' : 'sell'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
