interface Props {
  history: number[];
  lastPrice: number | null;
  targetPrice: number | null;
  width?: number;
  height?: number;
}

/** Recent price trend (solid) extending into a dashed "potential" move toward the target. */
export function PotentialSparkline({ history, lastPrice, targetPrice, width = 200, height = 40 }: Props) {
  const points = history.length >= 2 ? history : lastPrice != null ? [lastPrice] : [];
  if (points.length === 0) {
    return <div style={{ height }} className="flex items-center text-[9px] text-gray-600">No recent price data</div>;
  }

  const last = points[points.length - 1];
  const target = targetPrice ?? last;
  const min = Math.min(...points, target);
  const max = Math.max(...points, target);
  const range = max - min || 1;

  const padY = 4;
  const plotH = height - padY * 2;
  const histSpan = width * 0.68;

  const xAt = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * histSpan : histSpan);
  const yAt = (v: number) => padY + (1 - (v - min) / range) * plotH;

  const historyPath = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(' ');
  const lastX = xAt(points.length - 1);
  const lastY = yAt(last);
  const targetX = width - 3;
  const targetY = yAt(target);

  return (
    <svg width={width} height={height} className="block overflow-visible" role="img"
      aria-label={`Recent price $${last.toFixed(2)}, potential move to $${target.toFixed(2)}`}>
      <title>{`Recent: $${last.toFixed(2)} → Potential: $${target.toFixed(2)}`}</title>
      <path d={historyPath} fill="none" stroke="#9ca3af" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <line x1={lastX} y1={lastY} x2={targetX} y2={targetY}
        stroke="#22c55e" strokeWidth={2} strokeLinecap="round" strokeDasharray="3,3" />
      <circle cx={lastX} cy={lastY} r={2.5} fill="#e5e7eb" />
      <circle cx={targetX} cy={targetY} r={3} fill="#22c55e" />
    </svg>
  );
}
