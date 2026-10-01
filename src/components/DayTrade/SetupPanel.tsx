import type { DayTradeCandidate, PillarKey } from '../../types/daytrade';
import { fmtPrice, fmtShares } from '../../lib/rossRules';
import { STATE_STYLE } from './ScannerList';

const PILLAR_LABEL: Record<PillarKey, string> = {
  change: '% Change', rel_volume: 'Rel. Volume', news: 'Catalyst', price: 'Price', float: 'Float',
};

function pillarValue(key: PillarKey, c: DayTradeCandidate): string {
  switch (key) {
    case 'change': return `+${c.change_pct.toFixed(1)}%`;
    case 'rel_volume': return c.rel_volume != null ? `${c.rel_volume.toFixed(1)}x` : 'n/a';
    case 'news': return c.has_fresh_news ? 'Fresh news' : 'None today';
    case 'price': return `$${fmtPrice(c.price)}`;
    case 'float': return fmtShares(c.float_shares);
  }
}

const EXIT_INDICATORS = [
  'Big seller on Level 2',
  'Hidden seller — buying but price won\'t move',
  'Burst of red on the tape',
  'Pop then sharp reversal (false breakout)',
  'Buying slowing on time & sales',
  'Topping tail / doji / first red candle at the high',
];

export type SetupSection = 'pillars' | 'pullback' | 'catalyst';

/** The three setup panels; `only` renders one of them on its own (as a layout widget). */
export function SetupPanel({ c, only }: { c: DayTradeCandidate; only?: SetupSection }) {
  const s = c.setup;
  const st = STATE_STYLE[s.state];
  const timeAgo = (iso: string) => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };

  const sections: Record<SetupSection, JSX.Element> = {
    pillars: (
      <div className="bg-panel p-3">
        <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Five Pillars · {c.score}/5</h4>
        <div className="space-y-1">
          {(Object.keys(PILLAR_LABEL) as PillarKey[]).map((k) => {
            const p = c.pillars[k];
            return (
              <div key={k} className="flex items-center justify-between" title={p.rule}>
                <span className="flex items-center gap-1.5">
                  <span className={p.pass ? 'text-green-400' : p.pass === null ? 'text-gray-500' : 'text-red-400'}>
                    {p.pass ? '✓' : p.pass === null ? '?' : '✗'}
                  </span>
                  <span className="text-gray-300">{PILLAR_LABEL[k]}</span>
                </span>
                <span className="font-mono text-gray-400">{pillarValue(k, c)}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-2 pt-2 border-t border-border space-y-0.5 text-[10px]">
          <p className={c.a_plus.change_30 ? 'text-green-400' : 'text-gray-600'}>A+ · up ≥ 30%</p>
          <p className={c.a_plus.price_5_10 ? 'text-green-400' : 'text-gray-600'}>A+ · $5–$10 sweet spot</p>
          <p className={c.a_plus.float_10m ? 'text-green-400' : 'text-gray-600'}>A+ · float &lt; 10M</p>
          <p className={c.a_plus.prime_window ? 'text-green-400' : 'text-gray-600'}>A+ · 7–10 AM ET</p>
        </div>
      </div>

    ),
    pullback: (
      <div className="bg-panel p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">First Pullback</h4>
          <span className={`text-[9px] font-semibold px-1.5 py-px rounded border ${st.cls}`}>{st.label}</span>
        </div>
        <p className="text-gray-200 mb-2 leading-snug">{s.summary}</p>
        <div className="space-y-1">
          {Object.values(s.checks).map((ch) => (
            <div key={ch.label} className="flex items-center gap-1.5">
              <span className={ch.pass ? 'text-green-400' : 'text-red-400'}>{ch.pass ? '✓' : '✗'}</span>
              <span className="text-gray-300">{ch.label}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1 mt-2 pt-2 border-t border-border text-[10px] font-mono">
          <div><div className="text-gray-500">HOD</div><div className="text-white">{fmtPrice(s.hod)}</div></div>
          <div><div className="text-gray-500">VWAP</div><div className="text-amber-400">{fmtPrice(s.vwap)}</div></div>
          <div><div className="text-gray-500">9 EMA</div><div className="text-violet-400">{fmtPrice(s.ema9)}</div></div>
        </div>
      </div>

    ),
    catalyst: (
      <div className="bg-panel p-3 overflow-y-auto">
        <h4 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Catalyst & Flags</h4>
        {c.news.length === 0 && <p className="text-gray-500 mb-2">No headlines found.</p>}
        {c.news.map((n) => (
          <a key={n.title} href={n.url} target="_blank" rel="noreferrer" className="block mb-1.5 group">
            <span className={`text-[11px] leading-snug group-hover:underline ${c.has_fresh_news ? 'text-white' : 'text-gray-500'}`}>{n.title}</span>
            <span className="block text-[9px] text-gray-600">{n.publisher} · {timeAgo(n.published)}</span>
          </a>
        ))}
        {c.flags.map((f) => <p key={f} className="text-[10px] text-yellow-400/90 mt-1">⚑ {f}</p>)}
        <details className="mt-2">
          <summary className="text-[10px] text-gray-400 cursor-pointer">Exit indicators</summary>
          <ul className="mt-1 space-y-0.5 text-[10px] text-gray-400 list-disc pl-4">
            {EXIT_INDICATORS.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </details>
      </div>
    ),
  };

  if (only) return <div className="h-full text-xs [&>div]:h-full">{sections[only]}</div>;
  return (
    <div className="grid grid-cols-3 gap-px bg-border border-t border-border text-xs">
      {sections.pillars}
      {sections.pullback}
      {sections.catalyst}
    </div>
  );
}
