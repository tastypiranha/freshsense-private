import { useEffect, useRef, useState } from "react";
import { DRAW_MS, useDrawOnce } from "../hooks/useDrawOnce";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import {
  API_BASE,
  CONFIG,
  PRODUCT_ICONS,
  STAGES,
  number,
  statusInfo,
  timeLabel,
  getLocation,
} from "../demo/config";
import type { World } from "../demo/types";
import { Icon } from "./Icon";

export function JourneyDrawer({
  world,
  id,
  onClose,
}: {
  world: World;
  id: string;
  onClose: () => void;
}) {
  const [metric, setMetric] = useState<"environment" | "freshness" | "tvc">("environment");
  const panel = useRef<HTMLElement>(null);
  const journey = useJourney(id, world.tick);
  const draw = useDrawOnce(!!journey, `${id}-${metric}`);
  useEffect(() => {
    const last = document.activeElement as HTMLElement | null,
      oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const elements = [
          ...panel.current!.querySelectorAll<HTMLElement>('button,select,input,[tabindex="0"]'),
        ].filter((e) => !e.hasAttribute("disabled"));
        const first = elements[0],
          last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", key);
      last?.focus();
    };
  }, [onClose]);
  if (!journey) return null;
  const { crate, product, readings, stages, summary, blame } = journey;
  const thresholds: number[] = journey.thresholds_log_cfu ?? [];
  const exportReport = () => {
    const rows = [
      ["timestamp", "stage", "temperature_c", "humidity_pct", "bacteria_log_cfu_g", "freshness_score"],
      ...readings.map((r: any) => [r.ts, r.stage, r.temp_c, r.humidity, r.tvc, r.freshness_score]),
    ];
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `${id}-journey.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const excursions: { start: string; end: string }[] = [];
  for (const row of readings) {
    if (row.temp_c > product.max_safe_c) {
      const last = excursions[excursions.length - 1];
      if (last && last.end === readings[Math.max(0, readings.indexOf(row) - 1)].ts)
        last.end = row.ts;
      else excursions.push({ start: row.ts, end: row.ts });
    }
  }
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        ref={panel}
        className="journey-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${id} Journey report`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <div>
            <div className="eyebrow">FROM ORIGIN TO ARRIVAL</div>
            <h2>
              Journey report <span className="subtle-tag">Live from backend</span>
            </h2>
          </div>
          <button className="icon-button" aria-label="Close journey report" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="journey-crate">
            <span className="product-icon">
              <Icon name={PRODUCT_ICONS[crate.product]} size={24} />
            </span>
            <div>
              <h3>
                {crate.id} <span>{product.label}</span>
              </h3>
              <p>
                {crate.delivered
                  ? "Delivered"
                  : crate.discarded
                    ? "Removed from dispatch"
                    : crate.truck_id
                      ? `${crate.truck_id} (demo) · In transit`
                      : `${getLocation(crate.warehouse_id)?.area} cold room (demo) · Stationary live tag`}
              </p>
            </div>
            <span
              className={`status status-${crate.status}`}
              style={{ "--status-color": statusInfo(crate.status).color } as React.CSSProperties}
            >
              <i />
              {statusInfo(crate.status).label}
            </span>
          </div>
          <div className="journey-metrics">
            {[
              { label: "Freshness", value: `${number(crate.freshness_score)}%` },
              { label: "Shelf life left", value: `${number(crate.hours_left)}h` },
              { label: "Bacterial load", value: `${number(summary.tvc, 2)} log` },
              { label: "Extra life lost", value: `${number(summary.extra_loss_h)}h` },
            ].map((m) => (
              <div key={m.label}>
                <small>{m.label}</small>
                <strong>{m.value}</strong>
              </div>
            ))}
          </div>
          <div className="journey-stage-strip">
            {stages.map((s: any, i: number) => (
              <div key={`${s.stage}-${i}`}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <b>{s.label}</b>
                <small>{number(s.duration_min / 60)}h</small>
              </div>
            ))}
          </div>
          <section className="journey-chart-panel">
            <div className="report-section-heading">
              <div>
                <h3>Full cold-chain history</h3>
                <p>
                  {new Date(summary.picked_up_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                  })}{" "}
                  → {timeLabel(world.sim_time)} · {readings.length} displayed readings
                </p>
              </div>
              <button className="text-button" onClick={exportReport}>
                <Icon name="download" size={14} />
                CSV
              </button>
            </div>
            <div className="report-tabs">
              {(
                [
                  ["environment", "Temperature & humidity"],
                  ["freshness", "Freshness"],
                  ["tvc", "Bacterial load"],
                ] as const
              ).map(([key, label]) => (
                <button
                  className={metric === key ? "selected" : ""}
                  key={key}
                  onClick={() => setMetric(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="journey-chart">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={readings} margin={{ top: 12, right: 12, left: -16, bottom: 6 }}>
                  <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(ts) => timeLabel(ts)}
                    minTickGap={65}
                    tick={{ fontSize: 9, fill: "var(--muted)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    yAxisId="primary"
                    tick={{ fontSize: 9, fill: "var(--muted)" }}
                    tickLine={false}
                    axisLine={false}
                    domain={
                      metric === "environment"
                        ? ["auto", "auto"]
                        : metric === "freshness"
                          ? [0, 100]
                          : [1.5, (max: number) => Math.max(5.6, Math.ceil(max * 2) / 2)]
                    }
                  />
                  {metric === "environment" && (
                    <YAxis
                      yAxisId="humidity"
                      orientation="right"
                      domain={[0, 100]}
                      tick={{ fontSize: 9, fill: "var(--muted)" }}
                      tickLine={false}
                      axisLine={false}
                      width={32}
                    />
                  )}
                  <Tooltip
                    labelFormatter={(ts) => new Date(String(ts)).toLocaleString("en-GB")}
                    contentStyle={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                  />
                  {metric === "environment" && (
                    <>
                      <ReferenceArea
                        yAxisId="primary"
                        y1={CONFIG.temp_min}
                        y2={product.max_safe_c}
                        fill="var(--surface-subtle)"
                        fillOpacity={0.6}
                      />
                      <ReferenceLine
                        yAxisId="primary"
                        y={product.max_safe_c}
                        stroke="var(--muted)"
                        strokeDasharray="4 4"
                        label={{
                          value: `Safe ≤ ${product.max_safe_c}°C`,
                          fill: "var(--muted)",
                          fontSize: 9,
                          position: "insideTopLeft",
                        }}
                      />
                      {excursions.map((e) => (
                        <ReferenceArea
                          key={e.start}
                          yAxisId="primary"
                          x1={e.start}
                          x2={e.end}
                          fill="var(--brand)"
                          fillOpacity={0.08}
                        />
                      ))}
                      <Line
                        yAxisId="primary"
                        name="Temperature (°C)"
                        type="monotone"
                        dataKey="temp_c"
                        stroke="var(--brand)"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={draw}
                        animationDuration={DRAW_MS}
                        animationEasing="linear"
                      />
                      <Line
                        yAxisId="humidity"
                        name="Humidity (%)"
                        dataKey="humidity"
                        stroke="var(--muted)"
                        strokeDasharray="4 3"
                        dot={false}
                        isAnimationActive={draw}
                        animationDuration={DRAW_MS}
                        animationEasing="linear"
                      />
                    </>
                  )}
                  {metric === "tvc" &&
                    thresholds.map((t, i) => (
                      <ReferenceLine
                        key={t}
                        yAxisId="primary"
                        y={t}
                        stroke="var(--muted)"
                        strokeDasharray="4 4"
                        label={{
                          value: ["good", "acceptable", "spoiled"][i],
                          fill: "var(--muted)",
                          fontSize: 9,
                          position: "insideTopLeft",
                        }}
                      />
                    ))}
                  {metric !== "environment" && (
                    <Line
                      yAxisId="primary"
                      name={metric === "freshness" ? "Freshness (%)" : "Bacteria (log CFU/g)"}
                      dataKey={metric === "freshness" ? "freshness_score" : "tvc"}
                      stroke="var(--brand)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={draw}
                        animationDuration={DRAW_MS}
                        animationEasing="linear"
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="chart-legend">
              <span>
                <i className="chart-key" />
                {metric === "environment"
                  ? "Temperature"
                  : metric === "freshness"
                    ? "Freshness"
                    : "Bacterial load (log CFU/g) · dashed: quality stages from lab data"}
              </span>
              {metric === "environment" && (
                <>
                  <span>
                    <i className="chart-key muted-key" />
                    Humidity
                  </span>
                  <span>Shaded regions: temperature excursion</span>
                </>
              )}
            </div>
          </section>
          <div className="blame-callout">
            <Icon name="activity" size={21} />
            <div>
              <strong>Where freshness was lost</strong>
              <p>{blame.text}</p>
            </div>
          </div>
          <div className="report-section-heading">
            <div>
              <h3>Stage-by-stage breakdown</h3>
              <p>From this crate’s readings: replayed real cold-chain temperatures and the calibrated growth model.</p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="stage-table">
              <thead>
                <tr>
                  <th>STAGE</th>
                  <th>DURATION</th>
                  <th>AVG / PEAK</th>
                  <th>ABOVE LIMIT</th>
                  <th>EXTRA LOSS</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((s: any, i: number) => (
                  <tr key={`${s.stage}-${i}`}>
                    <td>
                      <b>{STAGES[s.stage as keyof typeof STAGES] ?? s.label}</b>
                      <small className="stage-location">{s.location_name}</small>
                    </td>
                    <td>{number(s.duration_min / 60)}h</td>
                    <td>
                      {number(s.avg_temp_c)} / {number(s.max_temp_c)}°C
                    </td>
                    <td>{number(s.minutes_above_limit, 0)}m</td>
                    <td>{number(s.extra_loss_h)}h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {crate.redirect_reason && (
            <div className="info-callout">
              <Icon name="route" />
              <div>
                <strong>Dispatch decision</strong>
                <p>{crate.redirect_reason}</p>
              </div>
            </div>
          )}
          <p className="report-disclaimer">
            Ratkowsky growth model calibrated on public beef spoilage data and USDA FoodKeeper ·
            stage thresholds from labelled lab data · not a food-safety certification. Chart and CSV
            show up to {CONFIG.history_max_points} downsampled readings.
          </p>
        </div>
      </aside>
    </div>
  );
}

/** Fetch the crate's journey report from the backend; refresh every few ticks while open. */
function useJourney(id: string, tick: number) {
  const [data, setData] = useState<any>(null);
  const bucket = Math.floor(tick / 5);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/crates/${id}/journey`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && j && setData(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, bucket]);
  return data && data.crate.id === id ? data : null;
}
