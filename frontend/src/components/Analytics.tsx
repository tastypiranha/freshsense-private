import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";
import { useEffect, useState } from "react";
import { DRAW_MS, useDrawOnce } from "../hooks/useDrawOnce";
import { API_BASE, CALIBRATION, LOCATIONS, TRUCKS, STAGES, number } from "../demo/config";
import type { World } from "../demo/types";
import { Icon } from "./Icon";
export function Analytics({ world }: { world: World }) {
  const data = useAnalytics(world.tick);
  const draw = useDrawOnce(!!data);
  const model = data?.model_card?.available ? data.model_card : null;
  const benchmark = data?.benchmark ?? null;
  const byTruck = (data?.hours_lost_by_truck ?? []).map((t: any) => ({
    name: t.truck_id,
    driver: t.driver,
    loss: Math.round(t.extra_loss_h * 10) / 10,
    excursions: t.excursions,
  }));
  const byStage = (data?.hours_lost_by_stage ?? [])
    .map((s: any) => ({ key: s.stage, label: STAGES[s.stage as keyof typeof STAGES] ?? s.label, loss: s.extra_loss_h }))
    .filter((s: any) => s.loss > 0);
  const worst = byTruck[0] ?? { name: "—", driver: "—", loss: 0, excursions: 0 },
    cause = byStage[0];
  const totalWeight = [...world.crates, ...world.archive].reduce((s, c) => s + c.weight_kg, 0);
  return (
    <div className="analytics-page">
      <div className="analytics-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Where is the cold chain breaking?</h2>
              <p>Extra shelf-life hours lost to heat in transit, by truck · since the last reset</p>
            </div>
            <span className="subtle-tag">Live</span>
          </div>
          <div className="analytics-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={byTruck}
                layout="vertical"
                margin={{ left: 0, right: 30, bottom: 12 }}
              >
                <CartesianGrid stroke="var(--border-subtle)" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: "var(--muted)" }}
                  axisLine={false}
                  tickLine={false}
                  unit="h"
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--text)" }}
                  axisLine={false}
                  tickLine={false}
                  width={45}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  formatter={(v) => [`${number(Number(v))}h`, "Extra life lost"]}
                />
                <Bar dataKey="loss" barSize={28} radius={[0, 5, 5, 0]} isAnimationActive={draw} animationDuration={DRAW_MS}>
                  {byTruck.map((t: any, i: number) => (
                    <Cell key={t.name} fill={i === 0 ? "var(--brand)" : "var(--border)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="analytics-insight">
            <Icon name="activity" size={18} />
            <span>
              {worst.loss > 0 ? (
                <>
                  <strong>{worst.name} needs attention.</strong> {worst.driver} · {number(worst.loss)}h
                  extra loss · {worst.excursions} excursions.
                </>
              ) : (
                "No heat damage in transit yet. Resume and trigger an incident."
              )}
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Loss across the journey</h2>
              <p>Every crate’s history: replayed real shipment temperatures</p>
            </div>
            <Icon name="route" size={18} />
          </div>
          <div className="stage-bars">
            {byStage.map((s: any) => (
              <div key={s.key}>
                <div>
                  <span>{s.label}</span>
                  <b>{number(s.loss)}h</b>
                </div>
                <span className="stage-bar">
                  <i style={{ width: `${(s.loss / (cause?.loss || 1)) * 100}%` }} />
                </span>
              </div>
            ))}
          </div>
          <div className="analytics-insight">
            <Icon name="clock" size={18} />
            <span>
              {cause ? (
                <>
                  <strong>{cause.label}</strong> accounts for the largest share of
                  temperature-related loss.
                </>
              ) : (
                "No significant temperature abuse recorded."
              )}
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>The impact, in perspective</h2>
              <p>Live counters from the backend since the last reset</p>
            </div>
            <Icon name="leaf" size={18} />
          </div>
          <div className="impact-grid">
            {[
              { label: "Volume redirected", value: `${number(world.impact.kg_saved, 0)} kg` },
              { label: "Donation decisions", value: world.impact.crates_donated },
              { label: "Deliveries completed", value: world.impact.deliveries_completed },
              { label: "Food discarded", value: `${number(world.impact.kg_wasted, 0)} kg` },
            ].map((m) => (
              <div key={m.label}>
                <strong>{m.value}</strong>
                <small>{m.label}</small>
              </div>
            ))}
          </div>
          <p className="analytics-note">
            {number(totalWeight, 0)} kg on hand · {TRUCKS.length} trucks (demo) · {LOCATIONS.length}{" "}
            locations (demo). Redirected volume counts redirect events, not verified consumption.
          </p>
        </section>
        <section className="panel model-card">
          <div className="panel-heading">
            <div>
              <h2>Freshness model, calibrated on real data</h2>
              <p>Errors on beef spoilage series never used for fitting</p>
            </div>
            <span className="subtle-tag">{model ? "Real lab data" : "Loading"}</span>
          </div>
          {model && (
            <div className="pending-model">
              <h3>Ratkowsky growth + e-nose gas model</h3>
              <p>
                Quality stages from labelled lab data: good ≥ {model.thresholds_log_cfu[0]}, acceptable ≥{" "}
                {model.thresholds_log_cfu[1]}, spoiled ≥ {model.thresholds_log_cfu[2]} log CFU/g · Tmin{" "}
                {model.tmin_c}°C (literature)
              </p>
              <div className="impact-grid">
                {[
                  { label: "Held-out TS5 error (log CFU/g)", value: number(model.holdout?.TS5?.fused_mae_log_cfu, 2) },
                  { label: "Gas model error, unseen series", value: number(model.gas_loso_mae, 2) },
                  { label: "Gas within one stage", value: `${number(model.gas_within_one_stage * 100, 0)}%` },
                  { label: "Fused error, unseen series", value: number(model.fusion?.fused_loso_mae_log_cfu, 2) },
                ].map((m) => (
                  <div key={m.label}>
                    <strong>{m.value}</strong>
                    <small>{m.label}</small>
                  </div>
                ))}
              </div>
              <div className="table-scroll">
                <table className="stage-table">
                  <thead>
                    <tr>
                      <th>PRODUCT</th>
                      <th>USDA FOODKEEPER (FRIDGE)</th>
                      <th>MODEL AT {model.reference_temp_c}°C</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(model.products as Record<string, any>).map(([k, p]) => (
                      <tr key={k}>
                        <td>
                          <b>{p.label}</b>
                        </td>
                        <td>
                          {p.foodkeeper_entry} · {p.foodkeeper_fridge_days.join("–")} d
                        </td>
                        <td>{number(p.model_shelf_life_days_at_ref)} d</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="model-images">
                {(model.images as string[]).map((src) => (
                  <a href={src} key={src} target="_blank" rel="noreferrer">
                    <img src={src} alt={`Model result: ${src.split("/").pop()?.replace(/_/g, " ")}`} loading="lazy" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
        <section className="panel benchmark-card">
          <div className="panel-heading">
            <div>
              <h2>FIFO vs FreshSense benchmark</h2>
              <p>10,000+ crates on real cold-chain shipment traces · distinct from the live dispatch comparison</p>
            </div>
            <span className="subtle-tag">{benchmark ? "Simulation results" : "Not supplied"}</span>
          </div>
          {benchmark ? (
            <>
              <div className="impact-grid">
                {[
                  { label: "Fewer rejections", value: `${number(benchmark.rejection_reduction_pct)}%` },
                  { label: "Less food wasted", value: `${number(benchmark.waste_reduction_pct)}%` },
                  { label: "FIFO wasted", value: `${number(benchmark.fifo.kg_wasted, 0)} kg` },
                  {
                    label: "FreshSense wasted",
                    value: `${number(benchmark.freshsense.kg_wasted, 0)} kg`,
                  },
                ].map((m) => (
                  <div key={m.label}>
                    <strong>{m.value}</strong>
                    <small>{m.label}</small>
                  </div>
                ))}
              </div>
              <p className="analytics-note">{benchmark.note}</p>
            </>
          ) : (
            <div className="empty-benchmark">
              <Icon name="chart" size={24} />
              <p>No benchmark result file yet. No reduction percentage is claimed.</p>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Data provenance</h2>
              <p>Clear about what is real, estimated, and simulated</p>
            </div>
            <Icon name="help" size={18} />
          </div>
          <div className="provenance-list">
            <p>
              <b>Freshness model</b>
              <span>Fitted to public beef e-nose spoilage curves (Mendeley); per-product scaling from USDA FoodKeeper.</span>
            </p>
            <p>
              <b>Temperatures & incidents</b>
              <span>Replayed real strawberry cold-chain shipments; door spike from a real fridge experiment (Zenodo).</span>
            </p>
            <p>
              <b>Locations, trucks, demand</b>
              <span>Demo assumptions (no public data); see backend/data/assumptions.json.</span>
            </p>
            <p>
              <b>Live tag</b>
              <span>Wokwi ESP32 over MQTT, or the slider fallback in the control dock.</span>
            </p>
            {CALIBRATION.generated_at && (
              <p>
                <b>Calibration</b>
                <span>Built {new Date(CALIBRATION.generated_at).toLocaleString("en-GB")}</span>
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function useAnalytics(tick: number) {
  const [data, setData] = useState<any>(null);
  const bucket = Math.floor(tick / 5);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/analytics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bucket]);
  return data;
}
