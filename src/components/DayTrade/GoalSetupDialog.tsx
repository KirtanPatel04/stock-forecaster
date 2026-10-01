import { useEffect, useState } from 'react';
import { fmtAcct, suggestedGoal, type AccountType, type RiskSettings } from '../../lib/rossRules';
import { useFx, type Currency } from '../../lib/fx';

interface Props {
  open: boolean;
  cash: number;              // free cash
  openCost: number;          // money in open real positions
  settings: RiskSettings;
  canClose: boolean;         // false on first run — a goal is required
  onSave: (cash: number, patch: Partial<RiskSettings>) => void;
  onClose: () => void;
  inline?: boolean;          // render as a Settings section instead of a popup
}

/** Ask what the user wants to make per day, then split it across 2–3 winning trades at 2:1. */
export function GoalSetupDialog({ open, cash, openCost, settings, canClose, onSave, onClose, inline = false }: Props) {
  const [saved, setSaved] = useState(false);
  const [cashText, setCashText] = useState('');
  const [goalText, setGoalText] = useState('');
  const [trades, setTrades] = useState<2 | 3>(3);
  const [accountType, setAccountType] = useState<AccountType>('cash');
  const [currency, setCurrency] = useState<Currency>('CAD');
  const [feeText, setFeeText] = useState('0');
  const { usdcad, live } = useFx();
  const [quarter, setQuarter] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCashText(cash ? String(Math.round(cash * 100) / 100) : '');
    setGoalText(settings.dailyGoal != null ? String(settings.dailyGoal) : '');
    setTrades(settings.tradesPerGoal ?? 3);
    setAccountType(settings.accountType);
    setCurrency(settings.currency ?? 'CAD');
    setFeeText(String(settings.fxFeePct ?? 0));
    setQuarter(settings.quarterStart ?? false);
  }, [open, inline ? settings : null, inline ? cash : null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const m = (n: number, d = 0) => fmtAcct({ currency }, n, d);
  const fxFee = Math.max(0, parseFloat(feeText) || 0);
  const cashNum = parseFloat(cashText.replace(/[$,]/g, '')) || 0;
  const account = cashNum + openCost;
  const goal = parseFloat(goalText.replace(/[$,]/g, '')) || 0;
  const pct = account > 0 ? (goal / account) * 100 : 0;
  const perTrade = goal / trades;
  const riskPerTrade = perTrade / 2;
  const suggestions = [2, 3, 5].map((p) => ({ p, v: suggestedGoal(account * (p / 5)) }));
  const realism =
    goal <= 0 ? null :
    pct <= 5 ? { cls: 'text-green-400', text: `${pct.toFixed(1)}% of your account per day — in line with Ross's small-account pace.` } :
    pct <= 10 ? { cls: 'text-yellow-400', text: `${pct.toFixed(1)}% per day is aggressive. Expect bigger positions and bigger red days.` } :
    { cls: 'text-red-400', text: `${pct.toFixed(1)}% per day is very aggressive — your max daily loss would be the same ${m(goal)}. Consider a smaller goal.` };

  const valid = cashNum > 0 && goal > 0;

  const body = (
      <div className={inline ? 'bg-panel border border-border rounded-lg' : 'w-full max-w-md bg-panel border border-border rounded-lg shadow-2xl'} onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Your daily plan</h3>
          {canClose && !inline && <button onClick={onClose} className="text-gray-500 hover:text-white">×</button>}
        </div>

        <div className="p-4 space-y-4 text-xs">
          <label className="block">
            <span className="text-gray-300">How much <span className="text-white font-semibold">real cash</span> do you have available to trade{currency === 'CAD' ? ' (in CAD)' : ''}?</span>
            <input value={cashText} onChange={(e) => setCashText(e.target.value)} inputMode="decimal" placeholder="e.g. 2000"
              className="mt-1 w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-accent" />
            {openCost > 0 && <span className="text-[10px] text-gray-500">Plus {m(openCost, 2)} in open positions → account {m(account, 2)}</span>}
          </label>

          <div className="flex items-center gap-2">
            <span className="text-gray-400">Currency</span>
            <div className="flex rounded border border-border overflow-hidden">
              {(['CAD', 'USD'] as const).map((c) => (
                <button key={c} onClick={() => setCurrency(c)}
                  className={`px-3 py-1 ${currency === c ? 'bg-accent/20 text-accent' : 'text-gray-500'}`}>{c === 'CAD' ? '🇨🇦 CAD' : '🇺🇸 USD'}</button>
              ))}
            </div>
          </div>
          {currency === 'CAD' && (
            <div className="bg-surface rounded p-2 space-y-1.5">
              <p className="text-gray-400">
                US stocks trade in USD. Your cash, goal and P&L stay in CAD and every trade converts at the live rate:
                <span className="font-mono text-white"> 1 USD = {usdcad.toFixed(4)} CAD</span>{live ? '' : ' (last known)'}.
              </p>
              <label className="flex items-center gap-2 text-gray-400">
                Broker FX fee per conversion
                <input value={feeText} onChange={(e) => setFeeText(e.target.value)} inputMode="decimal"
                  className="w-16 bg-panel border border-border rounded px-1.5 py-0.5 font-mono text-white focus:outline-none focus:border-accent" />%
              </label>
              <p className="text-[10px] text-gray-500">0 if you hold USD (or use Norbert's gambit). Many Canadian brokers charge about 1.5% each way when converting CAD↔USD, which the sizing takes out of every trade.</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-gray-400">Account type</span>
            <div className="flex rounded border border-border overflow-hidden">
              {(['cash', 'margin'] as const).map((t) => (
                <button key={t} onClick={() => setAccountType(t)}
                  className={`px-3 py-1 capitalize ${accountType === t ? 'bg-accent/20 text-accent' : 'text-gray-500'}`}>{t}</button>
              ))}
            </div>
          </div>

          <div>
            <span className="text-gray-300">How much do you want to <span className="text-white font-semibold">make per day</span>{currency === 'CAD' ? ' (in CAD, after converting back)' : ''}?</span>
            <input value={goalText} onChange={(e) => setGoalText(e.target.value)} inputMode="decimal" placeholder="$ per day"
              className="mt-1 w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-accent" />
            {account > 0 && (
              <div className="flex gap-1 mt-1.5">
                {suggestions.map((s) => (
                  <button key={s.p} onClick={() => setGoalText(String(s.v))}
                    className="px-2 py-0.5 rounded border border-border text-gray-300 hover:border-accent hover:text-white">
                    {m(s.v)} <span className="text-gray-500">({s.p}%)</span>
                  </button>
                ))}
              </div>
            )}
            {realism && <p className={`mt-1.5 text-[11px] ${realism.cls}`}>{realism.text}</p>}
          </div>

          <div>
            <span className="text-gray-300">Reach it in how many winning trades?</span>
            <div className="flex gap-2 mt-1">
              {([2, 3] as const).map((n) => (
                <button key={n} onClick={() => setTrades(n)}
                  className={`flex-1 rounded border px-2 py-1.5 ${trades === n ? 'border-accent bg-accent/15 text-white' : 'border-border text-gray-400'}`}>
                  {n} trades{goal > 0 ? ` · ${m(goal / n)} each` : ''}
                </button>
              ))}
            </div>
          </div>

          {goal > 0 && (
            <div className="bg-surface rounded p-2.5 space-y-1">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Every trade is 2:1</div>
              <div className="flex justify-between"><span className="text-gray-400">Each winner makes</span><span className="font-mono text-green-400">+{m(perTrade, 2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Each loser costs (at the stop)</span><span className="font-mono text-red-400">-{m(riskPerTrade, 2)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Stop for the day at</span><span className="font-mono text-red-400">-{m(goal)}</span></div>
              <p className="text-[10px] text-gray-500 pt-1">
                Shares are sized so the 2:1 target pays {m(perTrade, 2)}. With a 5¢ stop that's about {Math.floor(riskPerTrade / 0.05).toLocaleString()} shares, capped by your cash.
              </p>
            </div>
          )}

          <label className="flex items-start gap-2 text-gray-400 cursor-pointer">
            <input type="checkbox" checked={quarter} onChange={(e) => setQuarter(e.target.checked)} className="mt-0.5" />
            <span>Use Ross's rule: trade ¼ size until I've made ¼ of my goal (slower start, protects red days)</span>
          </label>
        </div>

        <div className="px-4 py-3 border-t border-border flex gap-2">
          {canClose && !inline && <button onClick={onClose} className="flex-1 py-1.5 rounded border border-border text-gray-300 hover:text-white text-xs">Cancel</button>}
          <button disabled={!valid}
            onClick={() => {
              onSave(cashNum, { dailyGoal: goal, tradesPerGoal: trades, accountType, quarterStart: quarter, currency, fxFeePct: currency === 'CAD' ? fxFee : 0 });
              setSaved(true); setTimeout(() => setSaved(false), 2000);
            }}
            className="flex-1 py-1.5 rounded font-semibold text-xs bg-accent text-black hover:bg-blue-400 disabled:opacity-40">
            {saved && inline ? '✓ Saved' : 'Save my plan'}
          </button>
        </div>
      </div>
  );

  if (inline) return body;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => canClose && onClose()}>
      {body}
    </div>
  );
}
