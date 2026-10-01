import type { Action, Verdict } from '../../lib/rossRules';

const STYLE: Record<Action, { chip: string; box: string; label: string }> = {
  BUY: { chip: 'bg-green-500 text-black', box: 'border-green-500/50 bg-green-500/10', label: 'BUY' },
  READY: { chip: 'bg-accent text-black', box: 'border-accent/50 bg-accent/10', label: 'READY' },
  WAIT: { chip: 'bg-yellow-400 text-black', box: 'border-yellow-400/40 bg-yellow-400/5', label: 'WAIT' },
  PASS: { chip: 'bg-red-500/80 text-white', box: 'border-red-500/40 bg-red-500/5', label: 'PASS' },
};

export function VerdictChip({ action, size = 'sm' }: { action: Action; size?: 'sm' | 'md' }) {
  return (
    <span className={`font-bold rounded ${STYLE[action].chip} ${size === 'md' ? 'text-[11px] px-2 py-0.5' : 'text-[8px] px-1 py-px'}`}>
      {STYLE[action].label}
    </span>
  );
}

/** Should I buy it? The verdict, the one-line reason, and every factor for and against. */
export function VerdictBanner({ v }: { v: Verdict }) {
  return (
    <div className={`rounded border p-2 space-y-1.5 ${STYLE[v.action].box}`}>
      <div className="flex items-start gap-2">
        <VerdictChip action={v.action} size="md" />
        <span className="text-[11px] text-white leading-snug">{v.headline}</span>
      </div>
      {v.sizeNote && <p className="text-[10px] text-gray-300">{v.sizeNote}</p>}
      <ul className="space-y-0.5 text-[10px] leading-snug">
        {v.pros.map((r) => <li key={r} className="text-green-400/90">✓ {r}</li>)}
        {v.cons.map((r) => <li key={r} className="text-red-300/90">✗ {r}</li>)}
      </ul>
    </div>
  );
}
