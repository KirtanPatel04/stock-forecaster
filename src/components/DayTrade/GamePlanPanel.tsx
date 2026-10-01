import type { GamePlan, RiskPlan } from '../../lib/rossRules';
import { fmtAcct, fmtPrice } from '../../lib/rossRules';
import { usePrefs } from '../../lib/prefs';
import { VerdictChip } from './Verdict';

interface Props {
  game: GamePlan;
  plan: RiskPlan;
  selected: string | null;
  onSelect: (symbol: string) => void;
}

/** "Today's game plan" — the stocks most likely to get you to your daily goal, per the skill. */
export function GamePlanPanel({ game, plan, selected, onSelect }: Props) {
  const [pf, setPrefs] = usePrefs();
  const open = pf.showGamePlan;

  return (
    <div className="border-b border-border bg-accent/5">
      <button onClick={() => setPrefs({ showGamePlan: !open })} className="w-full flex items-center justify-between px-3 py-1.5 text-left">
        <span className="text-[11px] font-semibold text-white">
          🎯 Game plan · {fmtAcct(plan, plan.dailyGoal)} in {plan.tradesPerGoal} trades
        </span>
        <span className="text-[10px] text-gray-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-1">
          <p className="text-[10px] text-gray-300">{game.headline}</p>
          {game.picks.map((p, i) => {
            const needed = i < plan.tradesPerGoal;
            return (
              <button key={p.c.symbol} onClick={() => onSelect(p.c.symbol)}
                className={`w-full text-left rounded px-2 py-1 border ${selected === p.c.symbol ? 'border-accent bg-accent/10' : 'border-border hover:border-gray-500'} ${needed ? '' : 'opacity-70'}`}>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-gray-500 w-3">{i + 1}</span>
                  <VerdictChip action={p.v.action} />
                  <span className="text-xs font-mono font-semibold text-white">{p.c.symbol}</span>
                  <span className="text-[9px] text-gray-500">{p.c.grade}</span>
                  <span className="ml-auto text-[10px] font-mono text-green-400">+{fmtAcct(plan, p.pays)}</span>
                  <span className="text-[9px] text-gray-500 w-14 text-right">{needed ? `trade ${i + 1}` : 'backup'}</span>
                </div>
                <div className="text-[9px] text-gray-400 pl-4 mt-0.5">
                  {p.size.shares.toLocaleString()} sh · {p.v.action === 'READY' ? 'buy on break of' : p.v.action === 'BUY' ? 'buy near' : 'wait —'} ${fmtPrice(p.levels.entry)} · stop ${fmtPrice(p.levels.stop)} · 2:1 ${fmtPrice(p.levels.target)}
                  {p.minutes != null && p.minutes <= 90 ? ` · ~${p.minutes}m` : ''}
                </div>
              </button>
            );
          })}
          {game.notes.map((n) => <p key={n} className="text-[10px] text-yellow-400/90">⚑ {n}</p>)}
        </div>
      )}
    </div>
  );
}
