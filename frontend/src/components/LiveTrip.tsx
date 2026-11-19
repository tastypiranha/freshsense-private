import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import toast from "react-hot-toast";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { API_BASE, number, statusInfo } from "../demo/config";
import { Icon } from "./Icon";
import { ShelfLifeChart } from "./ShelfLifeChart";
import type { IconName } from "./Icon";

const STAGE_TEXT: Record<string, string> = {
  origin_loading: "Loading at origin",
  highway: "On the highway",
  arrival_dock: "At the destination warehouse",
};
const DECISION_TEXT: Record<string, string> = {
  DELIVER: "Deliver as planned",
  ASSIGN: "Send to the best outlet",
  REDIRECT: "Redirect",
  DONATE: "Donate",
  DISCARD: "Discard",
};
const TYPE_LABEL: Record<string, string> = { restaurant: "Zomato restaurant", dark_store: "Blinkit dark store", food_bank: "Feeding India" };
const TYPE_ICON: Record<string, IconName> = { restaurant: "store", dark_store: "box", food_bank: "heart" };

const hm = (m: number) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
const evKey = (e: any) => `${e.minute}|${e.type}|${e.title}`;
const clean = (s: string) => s.replace(" (demo)", "");

async function call(path: string, body?: unknown) {
  const r = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
  return d;
}

/** A shipment playing out live: readings stream in over a WebSocket, incidents can be injected, and the
 *  FreshSense plan (projected arrival + best outlet) updates after every reading. */
export function LiveTrip({ start, onDone }: { start: any; onDone: (result: any) => void }) {
  const id: string = start.id;
  const [sh, setSh] = useState<any>(start.shipment);
  const [rows, setRows] = useState<any[]>(start.rows);
  const [events, setEvents] = useState<any[]>(start.events);
  const [forecast, setForecast] = useState<any>(start.forecast);
  const [st, setSt] = useState<any>(start.state);
  const [busy, setBusy] = useState<string | null>(null);
  const seen = useRef(new Set<string>(start.events.map(evKey)));
  const finished = useRef(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let poll: number | undefined;
    let closed = false;

    const addEvents = (list: any[], notify: boolean) => {
      const fresh = list.filter((e) => !seen.current.has(evKey(e)));
      fresh.forEach((e) => seen.current.add(evKey(e)));
      if (!fresh.length) return;
      setEvents((all) => [...all, ...fresh]);
      if (!notify) return;
      for (const e of fresh) {
        if (e.type === "replan") toast(e.title, { icon: "🔀", duration: 5000 });
        else if (e.type === "status" && e.severity === "critical") toast(e.title, { icon: "⚠️" });
      }
    };
    const finish = (result: any) => {
      if (finished.current) return;
      finished.current = true;
      onDone(result);
    };
    const handle = (m: any) => {
      if (m.type === "snapshot") {
        setSh(m.shipment);
        setRows(m.rows);
        addEvents(m.events, false);
        setForecast(m.forecast);
        setSt(m.state);
        if (m.result) finish(m.result);
      } else if (m.type === "tick") {
        if (m.rows.length) setRows((all) => [...all, ...m.rows]);
        addEvents(m.events, true);
        setForecast(m.forecast);
        setSt(m.state);
        setSh(m.shipment);
      } else if (m.type === "state") {
        setSt(m.state);
      } else if (m.type === "done") {
        addEvents(m.events, true);
        setSt(m.state);
        finish(m.result);
      }
    };
    const startPolling = () => {
      if (poll || closed) return;
      poll = window.setInterval(() => {
        fetch(`${API_BASE}/api/live/${id}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((m) => m && handle(m))
          .catch(() => {});
      }, 1000);
    };
    try {
      ws = new WebSocket(`${API_BASE.replace(/^http/, "ws")}/ws/live/${id}`);
      ws.onmessage = (ev) => handle(JSON.parse(ev.data));
      ws.onerror = startPolling;
      ws.onclose = () => !finished.current && startPolling();
    } catch {
      startPolling();
    }
    return () => {
      closed = true;
      if (poll) clearInterval(poll);
      ws?.close();
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    try {
      await call(`/api/live/${id}${path}`, body);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(null);
  };

  const last = rows[rows.length - 1];
  const total = st.total_min;
  const s = statusInfo(last.status);
  const pct = last.progress * 100; // highway progress, origin -> destination warehouse
  const peak = Math.max(...rows.map((r) => r.shock_g));
  const fa = forecast.arrival;
  const fd = forecast.decision;
  const accepting = forecast.candidates.filter((c: any) => c.accepts);
  const top = accepting.slice(0, 5);
  const feed = [...events].filter((e) => e.type !== "stage").sort((a, b) => b.minute - a.minute).slice(0, 8);
  const lost = Math.max(0, fa.label_hours_left - fa.hours_left);
  const onRoad = !st.done;

  return (
    <>
      <section className="panel ship-arrival live-head">
        <div className="panel-heading">
          <div>
            <div className="eyebrow live-eyebrow">
              <span className={onRoad && !st.paused ? "live-dot" : ""} />
              {onRoad ? (st.paused ? "PAUSED" : "LIVE") : "ARRIVED"} · {sh.product_label.toUpperCase()} · {sh.origin.name.toUpperCase()} →{" "}
              {sh.city.name.toUpperCase()} · {sh.distance_km} KM · {sh.vehicle === "reefer" ? "REEFER" : "INSULATED VAN"}
            </div>
            <h2>{STAGE_TEXT[last.stage]}</h2>
            <p>
              The tag sends a reading every 10 minutes of trip time. FreshSense re-plans after each one ({st.replans} re-route
              {st.replans === 1 ? "" : "s"} so far).
            </p>
          </div>
          <div className="live-controls">
            <button className="text-button" disabled={!onRoad} onClick={() => act("pause", "/control", { paused: !st.paused })}>
              <Icon name={st.paused ? "play" : "pause"} size={14} />
              {st.paused ? "Resume" : "Pause"}
            </button>
            <div className="ship-segment live-speed">
              {[1, 2, 4].map((v) => (
                <button key={v} className={st.speed === v ? "selected" : ""} disabled={!onRoad} onClick={() => act("speed", "/control", { speed: v })}>
                  {v}×
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="route-track">
          <div className="route-line">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="route-truck" style={{ left: `${pct}%` }}>
            <Icon name={last.stage === "arrival_dock" ? "warehouse" : "truck"} size={14} />
          </div>
          <div className="route-node live-start done" style={{ left: "0%" }}>
            <i />
            <b>{sh.origin.name}</b>
            <small>{sh.origin.state}</small>
          </div>
          <div className={`route-node live-end ${last.minute >= st.arrival_min ? "done" : ""}`} style={{ left: "100%" }}>
            <i />
            <b>{clean(sh.warehouse.name)}</b>
            <small>{sh.city.name}</small>
          </div>
        </div>
        <div className="ship-clock">
          <span>
            <Icon name="clock" size={13} />
            Trip time <b>{hm(last.minute)}</b> of {hm(total)}
          </span>
          <span>{last.ts.replace("T", " ").slice(0, 16)}</span>
        </div>

        <div className="sensor-grid">
          <Tile icon="temp" label="Temperature" value={`${number(last.temp_c)}°C`} sub={last.temp_c > sh.safe_temp_c ? `above ${sh.safe_temp_c}°C safe limit` : "within the safe limit"} alert={last.temp_c > sh.safe_temp_c} />
          <Tile icon="drop" label="Humidity" value={`${number(last.humidity, 0)}%`} sub={last.humidity > 60 ? "door spike" : "cold-room level"} alert={last.humidity > 60} />
          <Tile icon="shock" label="Shock" value={`${number(last.shock_g, 2)} g`} sub={`trip peak ${number(peak, 2)} g`} alert={last.shock_g >= 2} />
          <Tile icon="activity" label="Bacteria" value={number(last.tvc, 2)} sub="log CFU/g" alert={last.tvc >= sh.thresholds_log_cfu[1]} />
          <Tile icon="clock" label="Shelf life now" value={`${number(last.hours_left, 0)}h`} sub={s.label} dot={s.color} alert={last.status !== "fresh" && last.status !== "watch"} />
        </div>
      </section>

      <div className="ship-row">
        <section className="panel ship-chart-panel">
          <div className="panel-heading">
            <div>
              <h2>What the tag is sensing</h2>
              <p>Temperature (red) and bacterial load (dark), building up reading by reading</p>
            </div>
          </div>
          <div className="ship-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="minute" type="number" domain={[0, total]} tickFormatter={(m) => `${Math.round(m / 60)}h`} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="t" domain={[-2, (max: number) => Math.max(sh.safe_temp_c + 10, Math.ceil(max + 1))]} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} />
                <YAxis yAxisId="b" orientation="right" domain={[1.5, (max: number) => Math.max(5.6, Math.ceil(max * 2) / 2)]} tick={{ fontSize: 9, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={30} />
                <Tooltip labelFormatter={(m) => hm(Number(m))} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }} />
                <ReferenceLine yAxisId="t" y={sh.safe_temp_c} stroke="var(--brand)" strokeDasharray="4 4" />
                <ReferenceLine yAxisId="b" y={sh.thresholds_log_cfu[2]} stroke="var(--muted)" strokeDasharray="2 4" />
                <ReferenceLine yAxisId="t" x={st.arrival_min} stroke="var(--muted)" strokeDasharray="3 3" label={{ value: "warehouse", fontSize: 9, fill: "var(--muted)", position: "insideTopRight" }} />
                <Line yAxisId="t" type="monotone" dataKey="temp_c" name="Temp °C" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line yAxisId="b" type="monotone" dataKey="tvc" name="Bacteria (log CFU/g)" stroke="var(--ink)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="shelf-head">
            <b>Shelf life left</b>
            <small>Restaurants need 24 h on arrival, dark stores 8 h, food banks 2 h</small>
          </div>
          <ShelfLifeChart rows={rows} labelHours={sh.printed_expiry_days * 24} total={total} projected={st.done ? null : { minute: forecast.total_min, hours: fa.hours_left }} />
        </section>
        <section className="panel live-disrupt">
          <div className="panel-heading">
            <div>
              <h2>Disrupt the trip</h2>
              <p>Each one replays a real recorded curve from that moment on</p>
            </div>
          </div>
          <div className="live-actions">
            <button disabled={!onRoad || last.stage === "arrival_dock" || !!busy} onClick={() => act("door", "/incident", { type: "door" })}>
              <Icon name="door" size={16} />
              <span>
                <b>Open the door</b>
                <small>+6 °C spike, ~1 h decay</small>
              </span>
            </button>
            {st.compressor_off ? (
              <button className="fix" disabled={!onRoad || !!busy} onClick={() => act("fix", "/fix")}>
                <Icon name="snow" size={16} />
                <span>
                  <b>Repair compressor</b>
                  <small>cools back along the real curve</small>
                </span>
              </button>
            ) : (
              <button className="danger" disabled={!onRoad || last.stage === "arrival_dock" || !!busy} onClick={() => act("compressor", "/incident", { type: "compressor" })}>
                <Icon name="heat" size={16} />
                <span>
                  <b>Compressor fails</b>
                  <small>stays off until repaired</small>
                </span>
              </button>
            )}
            <button disabled={!onRoad || !!busy} onClick={() => act("shock", "/incident", { type: "shock" })}>
              <Icon name="shock" size={16} />
              <span>
                <b>Hard shock / drop</b>
                <small>real accelerometer peak, logged</small>
              </span>
            </button>
            <button disabled={!onRoad || st.dock_used || !!busy} onClick={() => act("dock", "/incident", { type: "dock", minutes: 120 })}>
              <Icon name="warehouse" size={16} />
              <span>
                <b>{st.dock_used ? "Left on the dock" : "Leave on dock 2 h"}</b>
                <small>warms at the warehouse on arrival</small>
              </span>
            </button>
          </div>
        </section>
      </div>

      <div className="ship-row">
        <section className="panel live-plan">
          <div className="panel-heading">
            <div>
              <h2>FreshSense plan</h2>
              <p>If nothing else goes wrong from here · updates after every reading</p>
            </div>
          </div>
          <div className="live-plan-head" key={`${fd.decision}-${fd.location?.location_id}`}>
            <small>{onRoad ? "Will" : "Did"}</small>
            <strong>
              {DECISION_TEXT[fd.decision]}
              {fd.location ? ` → ${clean(fd.location.name)}` : ""}
            </strong>
            <span>{fd.reason}</span>
          </div>
          <div className="ship-verdict live-verdict">
            <div>
              <small>Label says</small>
              <strong>{number(fa.label_hours_left, 0)}h</strong>
              <span>left on arrival</span>
            </div>
            <div className="real">
              <small>FreshSense projects</small>
              <strong>{number(fa.hours_left, 0)}h</strong>
              <span>left on arrival</span>
            </div>
            <div>
              <small>Lost to the trip</small>
              <strong className={lost > 1 ? "neg" : ""}>{lost > 0.5 ? "−" : ""}{number(lost, 0)}h</strong>
              <span>vs the label</span>
            </div>
            <div>
              <small>Outlets accepting</small>
              <strong>
                {fd.accepting}/{fd.total}
              </strong>
              <span>in {sh.city.name}</span>
            </div>
          </div>
          <ul className="live-outlets">
            {top.map((c: any) => (
              <li key={c.location_id} className={c.chosen ? "chosen" : ""}>
                <Icon name={TYPE_ICON[c.type]} size={14} />
                <b>{c.area}</b>
                <small>{TYPE_LABEL[c.type]}</small>
                <span>
                  {number(c.hours_on_arrival, 0)}h <small>/ needs {c.min_hours_needed}h</small>
                </span>
                {c.chosen && <em>booked</em>}
              </li>
            ))}
            {!top.length && <li className="none">No outlet in {sh.city.name} can take it any more.</li>}
          </ul>
        </section>
        <section className="panel ship-events">
          <div className="panel-heading">
            <div>
              <h2>Live feed</h2>
              <p>{feed.length ? "Newest first" : "Quiet so far: clean cold chain"}</p>
            </div>
          </div>
          <ul>
            {feed.map((e: any) => (
              <li key={evKey(e)} className={`sev-${e.severity} live-in`}>
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
    </>
  );
}

function Tile({ icon, label, value, sub, alert, dot }: { icon: IconName; label: string; value: string; sub: string; alert?: boolean; dot?: string }) {
  return (
    <div className={`sensor-tile ${alert ? "alert" : ""}`}>
      <span>
        <Icon name={icon} size={13} />
        {label}
      </span>
      <strong>{value}</strong>
      <small>
        {dot && <i className="sensor-dot" style={{ "--status-color": dot } as CSSProperties} />}
        {sub}
      </small>
    </div>
  );
}
