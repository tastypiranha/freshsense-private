import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DRAW_MS } from "../hooks/useDrawOnce";

/** Minimum shelf life each outlet type needs on arrival (backend network.json). */
const CUTOFFS = [
  { h: 24, label: "restaurant 24h" },
  { h: 8, label: "dark store 8h" },
  { h: 2, label: "food bank 2h" },
];

const hm = (m: number) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;

/** Hours of shelf life left over the trip: FreshSense (measured) vs the printed label's countdown, with the
 *  outlet cut-offs. `projected` (live view) draws a dotted line from now to the projected arrival. */
export function ShelfLifeChart({
  rows,
  labelHours,
  total,
  projected,
  animate = false,
}: {
  rows: any[];
  labelHours: number; // hours on the label at dispatch
  total: number; // trip length, minutes
  projected?: { minute: number; hours: number } | null;
  animate?: boolean;
}) {
  const last = rows[rows.length - 1];
  const labelLine = [
    { minute: 0, label: labelHours },
    { minute: total, label: Math.max(0, labelHours - total / 60) },
  ];
  const proj = projected && last.minute < projected.minute
    ? [{ minute: last.minute, proj: last.hours_left }, { minute: projected.minute, proj: projected.hours }]
    : null;
  const top = Math.max(labelHours, ...rows.map((r) => r.hours_left), 26);
  const anim = animate ? { isAnimationActive: true, animationDuration: DRAW_MS, animationEasing: "linear" as const } : { isAnimationActive: false };

  return (
    <div className="shelf-chart">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
          <XAxis dataKey="minute" type="number" domain={[0, total]} allowDuplicatedCategory={false} tickFormatter={(m) => `${Math.round(m / 60)}h`} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
          <YAxis domain={[0, Math.ceil(top * 1.05)]} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}h`} />
          <Tooltip
            labelFormatter={(m) => hm(Number(m))}
            formatter={(v, name) => [`${Number(v).toFixed(1)} h`, name]}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }}
          />
          {CUTOFFS.filter((c) => c.h < top).map((c) => (
            <ReferenceLine key={c.h} y={c.h} stroke="var(--muted)" strokeDasharray="2 4" strokeOpacity={0.7} label={{ value: c.label, fontSize: 9, fill: "var(--muted)", position: "insideTopLeft" }} />
          ))}
          <Line data={labelLine} dataKey="label" name="Label countdown" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="6 4" dot={false} {...anim} />
          <Line data={rows} dataKey="hours_left" name="FreshSense" stroke="var(--brand)" strokeWidth={2.2} dot={false} type="monotone" {...anim} />
          {proj && <Line data={proj} dataKey="proj" name="Projected" stroke="var(--brand)" strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} />}
          {projected && (
            <ReferenceDot x={projected.minute} y={projected.hours} r={5} fill="var(--brand)" stroke="#fff" strokeWidth={1.5} label={{ value: `${Math.round(projected.hours)}h on arrival`, fontSize: 10, fill: "var(--brand)", position: "left" }} />
          )}
        </LineChart>
      </ResponsiveContainer>
      <div className="shelf-legend">
        <span><i className="sw brand" />FreshSense</span>
        <span><i className="sw label" />Label countdown</span>
        {projected && <span><i className="sw proj" />Projected</span>}
        <span><i className="sw cut" />Outlet minimums</span>
      </div>
    </div>
  );
}
