import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { DRAW_MS } from "../hooks/useDrawOnce";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { API_BASE, PRODUCT_ICONS, number, statusInfo } from "../demo/config";
import { Icon } from "./Icon";
import { LiveTrip } from "./LiveTrip";
import { ShelfLifeChart } from "./ShelfLifeChart";
import type { IconName } from "./Icon";

type Incident = { type: string; at_h: number; minutes: number; on: boolean };
const NETWORK_LABEL: Record<string, string> = {
  restaurant: "Zomato restaurant",
  dark_store: "Blinkit dark store",
  food_bank: "Feeding India",
};
const NETWORK_ICON: Record<string, IconName> = { restaurant: "store", dark_store: "box", food_bank: "heart" };
const DECISION_TEXT: Record<string, string> = {
  DELIVER: "Delivered as planned",
  ASSIGN: "Routed to the best outlet",
  REDIRECT: "Redirected",
  DONATE: "Donated",
  DISCARD: "Discarded",
};
const TOP_N = 5;

type Preset = {
  id: string;
  label: string;
  detail: string;
  product: string;
  origin: string;
  city: string;
  vehicle: string;
  label_days: number;
  planned: string;
  incidents: { type: string; at_h?: number; minutes?: number }[];
};
const PRESETS: Preset[] = [
  {
    id: "live", label: "Break it live",
    detail: "Chicken with 1.5 days on the label, booked for a Rajajinagar restaurant. While it drives, hit “Compressor fails” and watch FreshSense re-route it on the highway; leave it on the dock and it goes to a food bank.",
    product: "chicken", origin: "ORG-NMK", city: "BLR", vehicle: "reefer", label_days: 1.5, planned: "R-06", incidents: [],
  },
  {
    id: "clean", label: "Clean run",
    detail: "Strawberries, 3 days on the label, Mahabaleshwar → Bengaluru by reefer. FreshSense picks the best outlet.",
    product: "strawberries", origin: "ORG-MBW", city: "BLR", vehicle: "reefer", label_days: 3, planned: "", incidents: [],
  },
  {
    id: "redirect", label: "Compressor fails",
    detail: "Chicken with 1.5 days on the label, planned for a Rajajinagar restaurant; 5 h compressor failure → redirected.",
    product: "chicken", origin: "ORG-NMK", city: "BLR", vehicle: "reefer", label_days: 1.5, planned: "R-06",
    incidents: [{ type: "compressor", at_h: 2, minutes: 300 }],
  },
  {
    id: "donate", label: "Too late to sell",
    detail: "Same chicken, plus 3 h on the arrival dock → only food banks can take it.",
    product: "chicken", origin: "ORG-NMK", city: "BLR", vehicle: "reefer", label_days: 1.5, planned: "R-06",
    incidents: [{ type: "compressor", at_h: 2, minutes: 300 }, { type: "dock", minutes: 180 }],
  },
  {
    id: "spoiled", label: "Spoiled",
    detail: "Insulated van, 8 h compressor-style warming and 8 h on the dock → rejected everywhere.",
    product: "chicken", origin: "ORG-NMK", city: "BLR", vehicle: "insulated", label_days: 3, planned: "R-06",
    incidents: [{ type: "compressor", at_h: 0.5, minutes: 480 }, { type: "dock", minutes: 480 }],
  },
];

const post = (path: string, body: unknown) =>
  fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    return d;
  });

const hm = (minute: number) => `${Math.floor(minute / 60)}h ${String(Math.round(minute % 60)).padStart(2, "0")}m`;

export function Shipment() {
  const [opts, setOpts] = useState<any>(null);
  const [product, setProduct] = useState("strawberries");
  const [origin, setOrigin] = useState("ORG-MBW");
  const [city, setCity] = useState("BLR");
  const [vehicle, setVehicle] = useState("reefer");
  const [labelDays, setLabelDays] = useState(3);
  const [planned, setPlanned] = useState("");
  const [incidents, setIncidents] = useState<Incident[]>([
    { type: "door", at_h: 3, minutes: 10, on: false },
    { type: "compressor", at_h: 2, minutes: 300, on: false },
    { type: "shock", at_h: 6, minutes: 1, on: false },
    { type: "dock", at_h: 0, minutes: 90, on: false },
  ]);
  const [result, setResult] = useState<any>(null);
  const [runId, setRunId] = useState(0);
  const [live, setLive] = useState<any>(null);
  const [liveSummary, setLiveSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(API_BASE + "/api/shipments/options")
      .then((r) => {
        if (!r.ok) throw new Error(`Backend has no shipment API (HTTP ${r.status}). Restart the backend.`);
        return r.json();
      })
      .then(setOpts)
      .catch((e) => setError(e.message));
  }, []);

  const cityObj = opts?.cities.find((c: any) => c.id === city);
  const originsForProduct = (opts?.origins ?? []).filter((o: any) => o.products.includes(product));
  useEffect(() => {
    if (opts && !originsForProduct.some((o: any) => o.id === origin) && originsForProduct[0])
      setOrigin(originsForProduct[0].id);
  }, [product, opts]); // eslint-disable-line react-hooks/exhaustive-deps
  const plannedValid = cityObj?.outlets.some((l: any) => l.id === planned) ? planned : "";

  const run = async (over?: Partial<Preset>, mode: "live" | "instant" = "live") => {
    const p = {
      product: over?.product ?? product,
      origin: over?.origin ?? origin,
      city: over?.city ?? city,
      vehicle: over?.vehicle ?? vehicle,
      label_days: over?.label_days ?? labelDays,
      planned: over?.planned ?? plannedValid,
      incidents: over?.incidents ?? incidents.filter((i) => i.on).map(({ type, at_h, minutes }) => ({ type, at_h, minutes })),
    };
    setBusy(true);
    setError(null);
    const body = {
      product: p.product,
      origin_id: p.origin,
      destination_city: p.city,
      vehicle: p.vehicle,
      printed_expiry_days: p.label_days,
      planned_outlet_id: p.planned || null,
      incidents: p.incidents,
    };
    try {
      if (mode === "live") {
        const snap = await post("/api/live/start", { ...body, trip_seconds: 60 });
        setResult(null);
        setLiveSummary(null);
        setLive(snap);
      } else {
        setLive(null);
        setLiveSummary(null);
        setResult(await post("/api/shipments/simulate", body));
      }
      setRunId((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const applyPreset = (pr: Preset) => {
    setProduct(pr.product);
    setOrigin(pr.origin);
    setCity(pr.city);
    setVehicle(pr.vehicle);
    setLabelDays(pr.label_days);
    setPlanned(pr.planned);
    setIncidents((all) =>
      all.map((x) => {
        const m = pr.incidents.find((i) => i.type === x.type);
        return m ? { ...x, ...m, on: true } : { ...x, on: false };
      }),
    );
    run(pr);
  };

  return (
    <div className="ship-layout">
      <section className="panel ship-form">
        <div className="panel-heading">
          <div>
            <h2>New shipment</h2>
            <p>What’s on the label and where it’s going. The tag senses the rest.</p>
          </div>
        </div>
        {!opts ? (
          <p className="ship-muted">{error ?? "Loading options…"}</p>
        ) : (
          <>
            <div className="ship-presets">
              <span>Try</span>
              {PRESETS.map((pr) => (
                <button key={pr.id} onClick={() => applyPreset(pr)} title={pr.detail}>
                  {pr.label}
                </button>
              ))}
            </div>
            <div className="ship-products">
              {Object.values(opts.products as Record<string, any>).map((p) => (
                <button key={p.id} className={product === p.id ? "selected" : ""} onClick={() => setProduct(p.id)}>
                  <Icon name={PRODUCT_ICONS[p.id]} size={16} />
                  {p.label.replace(" (curd/yogurt)", "")}
                </button>
              ))}
            </div>
            <div className="ship-fields">
              <Field label="Label expiry: days left at dispatch">
                <Range value={labelDays} min={0.5} max={30} step={0.5} onChange={setLabelDays} unit="days" />
              </Field>
              <Field label="Origin">
                <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
                  {originsForProduct.map((o: any) => (
                    <option key={o.id} value={o.id}>
                      {o.name}, {o.state}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Destination city">
                <select value={city} onChange={(e) => setCity(e.target.value)}>
                  {opts.cities.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Planned outlet (optional)">
                <select value={plannedValid} onChange={(e) => setPlanned(e.target.value)}>
                  <option value="">Let FreshSense choose</option>
                  {cityObj?.outlets
                    .filter((l: any) => l.type !== "food_bank")
                    .map((l: any) => (
                      <option key={l.id} value={l.id}>
                        {l.name.replace(" (demo)", "")}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Vehicle">
                <div className="ship-segment">
                  {opts.vehicles.map((v: any) => (
                    <button key={v.id} className={vehicle === v.id ? "selected" : ""} onClick={() => setVehicle(v.id)} title={v.detail}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
            <div className="ship-subhead">Disruptions</div>
            <div className="ship-incidents">
              {incidents.map((inc, i) => {
                const meta = opts.incidents.find((m: any) => m.id === inc.type);
                const set = (patch: Partial<Incident>) =>
                  setIncidents((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <div key={inc.type} className={`ship-incident ${inc.on ? "on" : ""}`}>
                    <label className="ship-incident-head">
                      <input type="checkbox" checked={inc.on} onChange={(e) => set({ on: e.target.checked })} />
                      <b>{meta.label}</b>
                    </label>
                    {inc.on && (
                      <div className="ship-incident-params">
                        {inc.type !== "dock" && (
                          <Range value={inc.at_h} min={0} max={24} step={0.5} onChange={(v) => set({ at_h: v })} unit="h in" />
                        )}
                        {(inc.type === "compressor" || inc.type === "dock") && (
                          <Range value={inc.minutes} min={15} max={480} step={15} onChange={(v) => set({ minutes: v })} unit="min" />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button className="heat-button ship-go" disabled={busy} onClick={() => run()}>
              <Icon name="truck" size={16} />
              {busy ? "Starting…" : live && !result ? "Restart live trip" : "Start live trip"}
            </button>
            <button className="text-button ship-instant" disabled={busy} onClick={() => run(undefined, "instant")}>
              Skip to the arrival report
            </button>
            {error && <p className="testlab-error">{error}</p>}
          </>
        )}
      </section>

      <div className="ship-main">
        {live && !result ? (
          <LiveTrip
            key={live.id}
            start={live}
            onDone={(r) => {
              const n = r.events.filter((e: any) => e.type === "replan").length;
              setLiveSummary(n ? `Live trip finished · FreshSense re-routed the crate ${n}× while it was on the road` : "Live trip finished");
              setResult(r);
              setRunId((k) => k + 1);
            }}
          />
        ) : !result ? (
          <section className="panel ship-empty">
            <span className="product-icon brand-icon">
              <Icon name="route" size={24} />
            </span>
            <h3>Pick a preset or fill the form, then “Start live trip”</h3>
            <p>
              The truck drives in real time (sped up). The tag streams temperature, humidity and shocks, you can break
              the trip while it runs, and FreshSense re-plans where the crate should go after every reading.
            </p>
          </section>
        ) : (
          <>
            {liveSummary && (
              <div className="live-summary">
                <Icon name="check" size={14} />
                {liveSummary}
              </div>
            )}
            <Result key={runId} result={result} />
          </>
        )}
      </div>
    </div>
  );
}

function Result({ result }: { result: any }) {
  const [showAll, setShowAll] = useState(false);
  const { shipment: sh, arrival: a, decision: d, candidates, timeline, events } = result;
  const s = statusInfo(a.status);
  const diff = a.hours_left - a.label_hours_left;
  const maxT = Math.max(...timeline.map((r: any) => r.temp_c));
  const keyEvents = events.filter((e: any) => e.type !== "stage" && e.type !== "status").slice(0, 5);
  const accepting = candidates.filter((c: any) => c.accepts);
  const rows = showAll ? candidates : accepting.slice(0, TOP_N);
  const total = timeline[timeline.length - 1].minute;

  return (
    <>
      <section className="panel ship-arrival">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">
              <span />
              {sh.product_label.toUpperCase()} · {sh.origin.name.toUpperCase()} → {sh.city.name.toUpperCase()} · {sh.distance_km} KM ·{" "}
              {sh.total_h} H · {sh.vehicle === "reefer" ? "REEFER" : "INSULATED VAN"}
            </div>
            <h2>
              {DECISION_TEXT[d.decision]}
              {d.location ? ` → ${d.location.name.replace(" (demo)", "")}` : ""}
            </h2>
            <p>{d.reason}</p>
          </div>
          <span className={`status status-${a.status}`} style={{ "--status-color": s.color } as CSSProperties}>
            <i />
            {s.label}
          </span>
        </div>
        <div className="ship-verdict">
          <div>
            <small>Label says</small>
            <strong>{number(a.label_hours_left, 0)}h</strong>
            <span>left on arrival</span>
          </div>
          <div className="real">
            <small>FreshSense says</small>
            <strong>{number(a.hours_left, 0)}h</strong>
            <span>
              left at {sh.reference_temp_c}°C · {a.stage}
            </span>
          </div>
          <div>
            <small>Lost on the way</small>
            <strong className={diff < -1 ? "neg" : ""}>{number(Math.min(0, diff), 0)}h</strong>
            <span>{diff < -1 ? "label overstates freshness" : "trip stayed within label conditions"}</span>
          </div>
          <div>
            <small>Outlets that accept</small>
            <strong>
              {d.accepting}/{d.total}
            </strong>
            <span>in {sh.city.name}</span>
          </div>
        </div>
      </section>

      <div className="ship-row">
        <section className="panel ship-chart-panel">
          <div className="panel-heading">
            <div>
              <h2>What the tag sensed</h2>
              <p>
                Temperature (red) and bacterial load (dark) · peak {number(maxT)}°C · {a.minutes_above_safe} min above{" "}
                {sh.safe_temp_c}°C · {number(a.extra_life_lost_h)}h of shelf life lost to heat
              </p>
            </div>
          </div>
          <div className="ship-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={timeline} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="minute" type="number" domain={[0, total]} tickFormatter={(m) => `${Math.round(m / 60)}h`} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="t" domain={[-2, (max: number) => Math.max(sh.safe_temp_c + 6, Math.ceil(max + 1))]} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="b" orientation="right" domain={[1.5, (max: number) => Math.max(5.6, Math.ceil(max * 2) / 2)]} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={30} />
                <Tooltip labelFormatter={(m) => hm(Number(m))} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }} />
                <ReferenceLine yAxisId="t" y={sh.safe_temp_c} stroke="var(--brand)" strokeDasharray="4 4" />
                <ReferenceLine yAxisId="b" y={sh.thresholds_log_cfu[2]} stroke="var(--muted)" strokeDasharray="2 4" />
                <Line yAxisId="t" type="monotone" dataKey="temp_c" name="Temp °C" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive animationDuration={DRAW_MS} animationEasing="linear" />
                <Line yAxisId="b" type="monotone" dataKey="tvc" name="Bacteria (log CFU/g)" stroke="var(--ink)" strokeWidth={1.6} dot={false} isAnimationActive animationDuration={DRAW_MS} animationEasing="linear" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="shelf-head">
            <b>Shelf life left</b>
            <small>
              The label assumed {number(sh.printed_expiry_days * 24, 0)} h at dispatch · arrived with {number(a.hours_left, 0)} h vs {number(Math.max(0, a.label_hours_left), 0)} h on the label
            </small>
          </div>
          <ShelfLifeChart rows={timeline} labelHours={sh.printed_expiry_days * 24} total={total} animate />
        </section>
        <section className="panel ship-events">
          <div className="panel-heading">
            <div>
              <h2>What happened</h2>
              <p>{keyEvents.length ? "Key events the tag logged" : "No incidents: clean cold chain"}</p>
            </div>
          </div>
          <ul>
            {keyEvents.map((e: any, i: number) => (
              <li key={`${e.minute}-${i}`} className={`sev-${e.severity}`}>
                <span>{hm(e.minute)}</span>
                <div>
                  <b>{e.title}</b>
                  <small>{e.detail}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Where it can go in {sh.city.name}</h2>
            <p>
              {d.accepting
                ? `${d.accepting} of ${d.total} outlets accept it: each needs a minimum shelf life on arrival (restaurant 24 h, dark store 8 h, food bank 2 h)`
                : "No outlet can accept it"}
            </p>
          </div>
          <button className="text-button" onClick={() => setShowAll(!showAll)}>
            {showAll ? `Show top ${TOP_N}` : `Show all ${d.total}`}
          </button>
        </div>
        <div className="ship-match">
          <OutletMap result={result} />
          <div className="ship-match-table">
            <div className="table-scroll">
              <table className="stage-table">
                <thead>
                  <tr>
                    <th>OUTLET</th>
                    <th>TRAVEL</th>
                    <th>LEFT ON ARRIVAL</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c: any) => (
                    <tr key={c.location_id} className={c.chosen ? "chosen" : c.accepts ? "" : "rejected"} title={c.reason}>
                      <td>
                        <span className="table-product">
                          <Icon name={NETWORK_ICON[c.type]} size={14} />
                        </span>
                        <b>{c.area}</b>
                        <small className="stage-location">{NETWORK_LABEL[c.type]}</small>
                      </td>
                      <td>{c.travel_min} min</td>
                      <td>
                        {number(c.hours_on_arrival, 0)}h <small className="stage-location">needs ≥ {c.min_hours_needed}h</small>
                      </td>
                      <td>
                        {c.chosen ? (
                          <span className="arrival-status safe">
                            <Icon name="check" size={12} />
                            Routed here
                          </span>
                        ) : c.accepts ? (
                          <span className="ship-ok">Accepts</span>
                        ) : (
                          <span className="ship-no">Rejects</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && <div className="compact-empty">Rejected everywhere: it would arrive spoiled. The cause is logged for the truck and route.</div>}
              {!showAll && accepting.length > TOP_N && (
                <div className="compact-empty">+ {accepting.length - TOP_N} more accepting outlets</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** Schematic of the destination city: warehouse, outlets (accepting / rejecting), and the chosen route. */
function OutletMap({ result }: { result: any }) {
  const { candidates, shipment: sh } = result;
  const pts = [...candidates, sh.warehouse];
  const lats = pts.map((p: any) => p.lat),
    lngs = pts.map((p: any) => p.lng);
  const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const W = 320,
    H = 240,
    pad = 22;
  const x = (lng: number) => pad + ((lng - c) / (d - c || 1)) * (W - 2 * pad);
  const y = (lat: number) => H - pad - ((lat - a) / (b - a || 1)) * (H - 2 * pad);
  const chosen = candidates.find((k: any) => k.chosen);
  const side = (lng: number) => (x(lng) > W / 2 ? { dx: -10, anchor: "end" as const } : { dx: 10, anchor: "start" as const });
  return (
    <svg className="outlet-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Outlets in ${sh.city.name}`}>
      <rect x="0" y="0" width={W} height={H} rx="10" fill="var(--surface-subtle)" />
      {chosen && (
        <line x1={x(sh.warehouse.lng)} y1={y(sh.warehouse.lat)} x2={x(chosen.lng)} y2={y(chosen.lat)} stroke="var(--brand)" strokeWidth="2.5" strokeDasharray="6 4" className="route-draw" />
      )}
      {candidates.map((k: any) => (
        <circle key={k.location_id} cx={x(k.lng)} cy={y(k.lat)} r={k.chosen ? 7 : 5} fill={k.chosen ? "var(--brand)" : k.accepts ? (k.type === "food_bank" ? "#db2777" : "#247b42") : "#c4c4c4"} stroke="#fff" strokeWidth="1.5">
          <title>
            {k.name} · {k.reason}
          </title>
        </circle>
      ))}
      {chosen && (
        <text x={x(chosen.lng) + side(chosen.lng).dx} y={y(chosen.lat) + 4} textAnchor={side(chosen.lng).anchor} fontSize="10" fontWeight="600" fill="var(--ink)">
          {chosen.area}
        </text>
      )}
      <rect x={x(sh.warehouse.lng) - 7} y={y(sh.warehouse.lat) - 7} width="14" height="14" rx="3" fill="var(--ink)" />
      <text x={x(sh.warehouse.lng) + side(sh.warehouse.lng).dx} y={y(sh.warehouse.lat) - 10} textAnchor={side(sh.warehouse.lng).anchor} fontSize="10" fill="var(--muted)">
        Warehouse
      </text>
      <g fontSize="9" fill="var(--muted)">
        <circle cx="16" cy={H - 14} r="4" fill="#247b42" />
        <text x="24" y={H - 11}>accepts</text>
        <circle cx="72" cy={H - 14} r="4" fill="#c4c4c4" />
        <text x="80" y={H - 11}>rejects</text>
        <circle cx="128" cy={H - 14} r="4" fill="var(--brand)" />
        <text x="136" y={H - 11}>routed</text>
      </g>
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="ship-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Range({ value, min, max, step, onChange, unit }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; unit: string }) {
  return (
    <span className="ship-range">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <b>
        {value} <small>{unit}</small>
      </b>
    </span>
  );
}
