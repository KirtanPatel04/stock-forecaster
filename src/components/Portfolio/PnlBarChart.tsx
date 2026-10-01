import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Bucket } from '../../lib/tradeStats';

// Gain / loss are status colors (they mean good / bad), always paired with ▲/▼, the sign,
// and position above/below the zero line — never color alone.
export const GAIN = '#22c55e';
export const LOSS = '#ef4444';

const usd = (n: number, digits: number, prefix: string) =>
  `${n < 0 ? '-' : n > 0 ? '+' : ''}${prefix}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

interface ShapeProps { x?: number; y?: number; width?: number; height?: number; value?: number | number[] }

/** Bar with a 4px rounded data end; the baseline end stays square. Works for negative bars. */
function SignedBar({ x = 0, y = 0, width = 0, height = 0, value }: ShapeProps) {
  const v = Array.isArray(value) ? value[1] - value[0] : value ?? 0;
  const top = Math.min(y, y + height);
  const h = Math.abs(height);
  if (h < 0.5 || width <= 0) return null;
  const r = Math.min(4, width / 2, h);
  const fill = v >= 0 ? GAIN : LOSS;
  const d = v >= 0
    ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${top + h} Z`
    : `M${x},${top} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + width - r} Q${x + width},${top + h} ${x + width},${top + h - r} V${top} Z`;
  return <path d={d} fill={fill} />;
}

function Tip({ active, payload, prefix = '$' }: { active?: boolean; payload?: { payload: Bucket }[]; prefix?: string }) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  const up = b.pnl >= 0;
  return (
    <div className="bg-panel border border-border rounded px-2.5 py-1.5 text-[11px] shadow-lg">
      <div className="text-gray-300 font-semibold mb-0.5">{b.label}</div>
      <div className="font-mono text-white">{up ? '▲' : '▼'} {usd(b.pnl, 2, prefix)}</div>
      <div className="text-gray-400">{b.trades} trade{b.trades === 1 ? '' : 's'} · {Math.round((b.wins / b.trades) * 100)}% winners</div>
    </div>
  );
}

interface Props {
  title: string;
  subtitle: string;
  data: Bucket[];
  height?: number;
  onBarClick?: (b: Bucket) => void;   // e.g. drill into a day
  prefix?: string;                    // currency prefix, e.g. "C$"
  clickHint?: string;
}

export function PnlBarChart({ title, subtitle, data, height = 180, onBarClick, clickHint, prefix = '$' }: Props) {
  const [table, setTable] = useState(false);
  const best = data.length ? data.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worst = data.length ? data.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;

  return (
    <div className="bg-panel border border-border rounded-lg p-3 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div>
          <h4 className="text-sm font-semibold text-white">{title}</h4>
          <p className="text-[11px] text-gray-500">{subtitle}</p>
        </div>
        {data.length > 0 && (
          <button onClick={() => setTable((t) => !t)} className="text-[10px] text-gray-500 hover:text-gray-300 border border-border rounded px-1.5 py-0.5">
            {table ? 'Chart' : 'Table'}
          </button>
        )}
      </div>

      {data.length === 0 ? (
        <div className="flex items-center justify-center text-[11px] text-gray-600" style={{ height }}>No trades with this info yet</div>
      ) : table ? (
        <table className="w-full text-[11px] mt-1">
          <thead>
            <tr className="text-gray-500 text-left"><th className="font-normal py-0.5">Bucket</th><th className="font-normal text-right">P&L</th><th className="font-normal text-right">Trades</th><th className="font-normal text-right">Win %</th></tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.key} className="border-t border-border/60">
                <td className="py-1 text-gray-300">{b.label}</td>
                <td className={`text-right font-mono ${b.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{b.pnl >= 0 ? '▲' : '▼'} {usd(b.pnl, 0, prefix)}</td>
                <td className="text-right font-mono text-gray-300" style={{ fontVariantNumeric: 'tabular-nums' }}>{b.trades}</td>
                <td className="text-right font-mono text-gray-300" style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round((b.wins / b.trades) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}
                style={onBarClick ? { cursor: 'pointer' } : undefined}
                onClick={onBarClick ? (state: { activePayload?: { payload: Bucket }[] } | null) => {
                  const b = state?.activePayload?.[0]?.payload;
                  if (b) onBarClick(b);
                } : undefined}>
                <CartesianGrid vertical={false} stroke="#21262d" />
                <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#30363d' }} interval={0}
                  tickFormatter={(l: string) => (data.length > 5 && l.length > 9 ? `${l.slice(0, 8)}…` : l)} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} tickLine={false} axisLine={false} width={48}
                  tickFormatter={(v: number) => usd(v, 0, prefix)} />
                <ReferenceLine y={0} stroke="#4b5563" />
                <Tooltip content={<Tip prefix={prefix} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="pnl" shape={<SignedBar />} maxBarSize={36} isAnimationActive={false}>
                  {data.map((b) => <Cell key={b.key} fill={b.pnl >= 0 ? GAIN : LOSS} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Selective direct labels: just the best and worst slice */}
          {clickHint && <p className="text-[10px] text-gray-600 mt-0.5">{clickHint}</p>}
          <div className="flex justify-between text-[10px] mt-1">
            {best && best.pnl > 0 ? <span className="text-green-400">▲ Best: {best.label} {usd(best.pnl, 0, prefix)}</span> : <span />}
            {worst && worst.pnl < 0 ? <span className="text-red-400">▼ Worst: {worst.label} {usd(worst.pnl, 0, prefix)}</span> : <span />}
          </div>
        </>
      )}
    </div>
  );
}
