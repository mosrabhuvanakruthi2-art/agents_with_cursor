import { useState } from 'react';

/**
 * SVG donut chart with external labels + leader lines (no chart library).
 * data: [{ key?, label, value, color }]
 * Hovering a slice highlights it; clicking calls onSelect(key) (toggles).
 */
export default function DonutChart({ data = [], centerLabel, selectedKey = null, onSelect }) {
  const [hover, setHover] = useState(null);
  const total = data.reduce((s, d) => s + (d.value || 0), 0);

  const W = 520, H = 300, cx = W / 2, cy = H / 2;
  const outerR = 92, thickness = 22, midR = outerR - thickness / 2;

  // point on a circle for a given fraction (0..1), clockwise starting at top
  const pt = (frac, radius) => {
    const a = frac * 2 * Math.PI;
    return { x: cx + radius * Math.sin(a), y: cy - radius * Math.cos(a) };
  };

  // geometry per slice (functional — no mutation during render)
  const visible = data.filter((d) => d.value > 0);
  const fracs = visible.map((d) => (total > 0 ? d.value / total : 0));
  const baseSegs = visible.map((d, i) => {
    const startFrac = fracs.slice(0, i).reduce((a, b) => a + b, 0);
    const frac = fracs[i];
    const midFrac = startFrac + frac / 2;
    const mid = pt(midFrac, outerR);
    return { ...d, frac, startFrac, endFrac: startFrac + frac, midFrac, mid, side: mid.x >= cx ? 1 : -1, key: d.key ?? d.label };
  });

  // push apart labels that land too close, per side
  const GAP = 24;
  const labelYByKey = {};
  [1, -1].forEach((side) => {
    baseSegs.filter((s) => s.side === side).sort((a, b) => a.mid.y - b.mid.y)
      .reduce((prevY, s) => {
        const y = s.mid.y < prevY + GAP ? prevY + GAP : s.mid.y;
        labelYByKey[s.key] = y;
        return y;
      }, -Infinity);
  });
  const segs = baseSegs.map((s) => ({ ...s, labelY: labelYByKey[s.key] }));

  const arcPath = (s) => {
    if (s.frac >= 0.999) {
      const a = pt(0, midR), b = pt(0.5, midR);
      return `M ${a.x} ${a.y} A ${midR} ${midR} 0 1 1 ${b.x} ${b.y} A ${midR} ${midR} 0 1 1 ${a.x} ${a.y}`;
    }
    const start = pt(s.startFrac, midR), end = pt(s.endFrac, midR);
    return `M ${start.x} ${start.y} A ${midR} ${midR} 0 ${s.frac > 0.5 ? 1 : 0} 1 ${end.x} ${end.y}`;
  };

  const active = hover ?? selectedKey;
  const clickable = typeof onSelect === 'function';
  const handleClick = (key) => clickable && onSelect(selectedKey === key ? null : key);

  return (
    <div className="relative mx-auto" style={{ width: W, maxWidth: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <circle cx={cx} cy={cy} r={midR} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />

        {/* slices */}
        {segs.map((s) => {
          const isActive = active === s.key;
          const dim = active != null && !isActive;
          return (
            <path key={s.key} d={arcPath(s)} fill="none" stroke={s.color}
              strokeWidth={isActive ? thickness + 6 : thickness}
              opacity={dim ? 0.3 : 1}
              style={{ cursor: clickable ? 'pointer' : 'default', transition: 'stroke-width .15s, opacity .15s' }}
              onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}
              onClick={() => handleClick(s.key)} />
          );
        })}

        {/* leader lines + labels */}
        {segs.map((s) => {
          const isActive = active === s.key;
          const startP = pt(s.midFrac, outerR + 1);
          const kneeX = cx + s.side * (outerR + 22);
          const labelX = cx + s.side * (outerR + 30);
          return (
            <g key={s.key} opacity={active != null && !isActive ? 0.45 : 1}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}
              onClick={() => handleClick(s.key)}>
              <polyline points={`${startP.x},${startP.y} ${kneeX},${s.labelY} ${labelX},${s.labelY}`}
                fill="none" stroke="#cbd5e1" strokeWidth={1} />
              <circle cx={startP.x} cy={startP.y} r={2.5} fill={s.color} />
              <text x={labelX + s.side * 4} y={s.labelY} dy="0.32em"
                textAnchor={s.side === 1 ? 'start' : 'end'}
                fontSize="12.5" fontWeight={isActive ? 700 : 500} fill={isActive ? '#0f172a' : '#475569'}>
                {s.label}: {s.value}
              </text>
            </g>
          );
        })}

        {/* center total */}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="28" fontWeight="700" fill="#0f172a">{total}</text>
        {centerLabel && (
          <text x={cx} y={cy + 18} textAnchor="middle" fontSize="10.5" fill="#94a3b8"
            style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>{centerLabel}</text>
        )}
      </svg>
    </div>
  );
}
