import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Toaster } from "react-hot-toast";
import { Icon } from "./components/Icon";
import type { IconName } from "./components/Icon";
import { useDemo } from "./hooks/useDemo";
import type { Connection } from "./hooks/useDemo";
import {
  CONFIG,
  DEMO,
  LOCATIONS,
  NETWORK,
  PRODUCTS,
  PRODUCT_ICONS,
  getLocation,
  number,
  statusInfo,
  timeLabel,
} from "./demo/config";
import { feasible } from "./demo/engine";
import type { Crate, DemoAction, World } from "./demo/types";

const CONNECTION_LABEL: Record<Connection, string> = {
  live: "Live backend",
  polling: "Backend (polling)",
  offline: "Backend offline",
};
const JourneyDrawer = lazy(() =>
  import("./components/JourneyDrawer").then((m) => ({ default: m.JourneyDrawer })),
);
const Shipment = lazy(() => import("./components/Shipment").then((m) => ({ default: m.Shipment })));
const TestLab = lazy(() => import("./components/TestLab").then((m) => ({ default: m.TestLab })));
const Analytics = lazy(() =>
  import("./components/Analytics").then((m) => ({ default: m.Analytics })),
);

type Page = "Shipment" | "Overview" | "Crates" | "Dispatch" | "Analytics" | "Activity" | "Test lab";
const NAV: { label: Page; icon: IconName }[] = [
  { label: "Shipment", icon: "truck" },
  { label: "Overview", icon: "grid" },
  { label: "Crates", icon: "box" },
  { label: "Dispatch", icon: "route" },
  { label: "Analytics", icon: "chart" },
  { label: "Activity", icon: "activity" },
  { label: "Test lab", icon: "check" },
];
function StatusBadge({ crate }: { crate: Crate }) {
  const status = statusInfo(crate.status);
  return (
    <span
      className={`status status-${crate.status}`}
      style={{ "--status-color": status.color } as CSSProperties}
    >
      <i />
      {status.label}
    </span>
  );
}
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = [
          ...ref.current!.querySelectorAll<HTMLElement>("button,input,select,a[href]"),
        ];
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </button>
        <span className="product-icon brand-icon">
          <Icon name={title.includes("settings") ? "settings" : "help"} size={24} />
        </span>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}
function TagControls({ world, act }: { world: World; act: (a: DemoAction) => void }) {
  const crate = world.crates.find((c) => c.id === CONFIG.live_tag_id)!;
  const [draft, setDraft] = useState({
    temp_c: crate.temp_c,
    humidity: crate.humidity,
    door_open: crate.door_open,
  });
  const change = (key: keyof typeof draft, value: number | boolean) => {
    const reading = { ...draft, [key]: value };
    setDraft(reading);
    act({ type: "tag", reading });
  };
  return (
    <div className="tag-controls">
      <div className="tag-heading">
        <span className="product-icon brand-icon">
          <Icon name="tag" size={20} />
        </span>
        <div>
          <strong>{CONFIG.live_tag_id} · Virtual tag fallback</strong>
          <p>
            Backup for the Wokwi ESP32 · sends readings to the backend as the live tag ·{" "}
            {getLocation(crate.warehouse_id)?.area} cold room (demo). Never dispatched.
          </p>
        </div>
        <span className="subtle-tag">{crate.is_live_tag ? "Slider active" : "Simulator"}</span>
      </div>
      <div className="tag-slider-grid">
        {[
          {
            key: "temp_c" as const,
            label: "Temperature",
            min: CONFIG.temp_min,
            max: CONFIG.temp_max,
            step: 0.5,
            unit: "°C",
          },
          { key: "humidity" as const, label: "Humidity", min: 0, max: 100, step: 1, unit: "%" },
        ].map((f) => (
          <label key={f.key}>
            <span>
              {f.label}
              <b>
                {number(draft[f.key], f.key === "temp_c" ? 1 : 0)}
                {f.unit}
              </b>
            </span>
            <input
              type="range"
              aria-label={`Live tag ${f.label.toLowerCase()}`}
              min={f.min}
              max={f.max}
              step={f.step}
              value={draft[f.key]}
              onChange={(e) => change(f.key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <label className="door-check">
        <input
          type="checkbox"
          checked={draft.door_open}
          onChange={(e) => change("door_open", e.target.checked)}
        />
        Door open{" "}
        <small>
          The backend simulator takes over again after {CONFIG.live_tag_timeout_s}s without a
          tag update.
        </small>
      </label>
    </div>
  );
}
function DispatchTable({
  world,
  onCrate,
  expanded = false,
}: {
  world: World;
  onCrate: (id: string) => void;
  expanded?: boolean;
}) {
  const [compare, setCompare] = useState(false);
  const candidates = world.crates.filter((c) => c.truck_id);
  const fefo = [...candidates].sort((a, b) => a.hours_left - b.hours_left);
  const fifo = [...candidates].sort(
    (a, b) => a.loaded_at.localeCompare(b.loaded_at) || a.id.localeCompare(b.id),
  );
  const rows = (items: Crate[], legacy = false) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>RANK</th>
            <th>CRATE / PRODUCT</th>
            <th>SHELF LIFE</th>
            <th>{legacy ? "ORIGINAL PLAN" : "DESTINATION"}</th>
            <th>ARRIVAL</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, expanded ? items.length : 5).map((c, i) => {
            const l = getLocation(legacy ? c.original_destination_id : c.destination_id),
              safe = l ? feasible(c, l) : false;
            return (
              <tr
                key={c.id}
                onClick={() => onCrate(c.id)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCrate(c.id);
                }}
              >
                <td>
                  <span className={`rank ${i === 0 ? "first" : ""}`}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </td>
                <td>
                  <span className="table-product">
                    <Icon name={PRODUCT_ICONS[c.product]} size={16} />
                  </span>
                  <b>{c.id}</b>
                  <span className="table-product-name">{c.product_label}</span>
                </td>
                <td>
                  <strong>
                    {number(c.hours_left)} <small>hrs</small>
                  </strong>
                  <span className="mini-bar">
                    <i style={{ width: `${c.freshness_score}%` }} />
                  </span>
                </td>
                <td>
                  <span className="dispatch-place">{l?.area ?? "Unassigned"}</span>
                  <small className="destination-type">
                    {l ? NETWORK.find((n) => n.type === l.type)?.label : "—"} (demo)
                  </small>
                </td>
                <td>
                  <span className={`arrival-status ${safe ? "safe" : "unsafe"}`}>
                    <Icon name={safe ? "check" : "activity"} size={12} />
                    {safe ? "Feasible" : "At risk"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!items.length && (
        <div className="compact-empty">
          All truck crates have completed their journeys. Reset to run another demo.
        </div>
      )}
    </div>
  );
  return (
    <section className="panel dispatch-panel">
      <div className="panel-heading">
        <div>
          <h2>
            Dispatch priority{" "}
            <span className="ai-badge">
              <Icon name="shock" size={11} />
              Dynamic FEFO
            </span>
          </h2>
          <p>Freshness, not loading order. Cold-room tag excluded from dispatch.</p>
        </div>
        <button className="text-button" onClick={() => setCompare(!compare)}>
          {compare ? "Hide comparison" : "Compare with FIFO"}
          <Icon name="arrow" size={14} />
        </button>
      </div>
      <div className={compare ? "dispatch-split" : ""}>
        <div>
          {compare && (
            <div className="dispatch-column-label">
              <b>FRESHSENSE · FEFO</b>
              <span>Current optimized destination</span>
            </div>
          )}
          {rows(fefo)}
        </div>
        {compare && (
          <div>
            <div className="dispatch-column-label">
              <b>STATIC FIFO</b>
              <span>Original plan, no redirects</span>
            </div>
            {rows(fifo, true)}
          </div>
        )}
      </div>
      <div className="table-caption">
        Feasibility accounts for travel time and each destination’s minimum remaining life (backend
        rules). Locations and trucks are demo data; temperatures replay real cold-chain traces.
      </div>
    </section>
  );
}
function Feed({
  world,
  onCrate,
  full = false,
}: {
  world: World;
  onCrate: (id: string) => void;
  full?: boolean;
}) {
  const [tab, setTab] = useState<"alerts" | "redirects">("alerts");
  return (
    <section className="panel activity-panel">
      <div className="panel-heading">
        <h2>Network activity</h2>
        <span className="live-pill">
          <i />
          {world.paused ? "Paused" : "Live demo"}
        </span>
      </div>
      <div className="feed-tabs">
        <button className={tab === "alerts" ? "selected" : ""} onClick={() => setTab("alerts")}>
          Alerts <span>{world.alerts.length}</span>
        </button>
        <button
          className={tab === "redirects" ? "selected" : ""}
          onClick={() => setTab("redirects")}
        >
          Redirects <span>{world.redirects.length}</span>
        </button>
      </div>
      <div className={`activity-items ${full ? "full-feed" : ""}`}>
        {tab === "alerts" &&
          world.alerts.slice(0, full ? world.alerts.length : 5).map((a) => (
            <div className="activity-item" key={a.id}>
              <span className={`event-icon ${a.severity === "critical" ? "heat" : "normal"}`}>
                <Icon
                  name={
                    a.type === "rerouted"
                      ? "route"
                      : a.type === "donated"
                        ? "heart"
                        : a.type === "shock"
                          ? "shock"
                          : a.type.includes("compressor")
                            ? "snow"
                            : "activity"
                  }
                  size={16}
                />
              </span>
              <div>
                <h4>{a.message}</h4>
                <time>
                  {timeLabel(a.ts)} · {a.truck_id ? `${a.truck_id} (demo)` : "System"}
                </time>
                {a.crate_id && (
                  <button className="text-button" onClick={() => onCrate(a.crate_id!)}>
                    View {a.crate_id}
                    <Icon name="arrow" size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        {tab === "redirects" &&
          world.redirects.slice(0, full ? world.redirects.length : 5).map((r) => (
            <div className="redirect-item" key={r.id}>
              <div>
                <span className="ai-badge">{r.decision}</span>
                <time>{timeLabel(r.ts)}</time>
              </div>
              <button onClick={() => onCrate(r.crate_id)}>
                <b>{r.crate_id}</b>
                <Icon name="arrow" size={13} />
                {getLocation(r.to_location_id)?.area ?? "Discard"} (demo)
              </button>
              <p>{r.reason}</p>
              <small>
                {r.decision === "DISCARD"
                  ? "Cause logged"
                  : `${number(r.weight_kg, 0)} kg · ${number(r.travel_min, 0)}m transit`}
              </small>
            </div>
          ))}
        {(tab === "alerts" ? !world.alerts.length : !world.redirects.length) && (
          <div className="feed-empty">
            <span className="product-icon brand-icon">
              <Icon name={tab === "alerts" ? "activity" : "route"} size={22} />
            </span>
            <h3>
              {tab === "alerts"
                ? "Ready for the first scenario."
                : "A better route starts with a signal."}
            </h3>
            <p>
              {tab === "alerts"
                ? "Resume the demo, then trigger a heat excursion to see the network respond."
                : "Redirect decisions and their full reasons will appear here as conditions change."}
            </p>
          </div>
        )}
      </div>
      <div className="feed-footnote">
        <Icon name="clock" size={12} />
        Simulation clock · live from the FreshSense backend
      </div>
    </section>
  );
}
export default function App({ initial }: { initial: World }) {
  const { world, act, connection } = useDemo(initial);
  const [heatMinutes, setHeatMinutes] = useState<number>(CONFIG.heat_minutes_default);
  const [page, setPage] = useState<Page>("Shipment"),
    [selected, setSelected] = useState(DEMO.hero_crate_id),
    [truckId, setTruckId] = useState(DEMO.problem_truck_id);
  const [detail, setDetail] = useState<string | null>(null),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [list, setList] = useState(false);
  const [extra, setExtra] = useState(false),
    [modal, setModal] = useState<"settings" | "help" | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []),
    closeModal = useCallback(() => setModal(null), []);
  const mainRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const extraButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 });
    setExtra(false);
  }, [page]);
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const observer = new ResizeObserver(() => {
      dock.style.setProperty("--dock-height", `${dock.getBoundingClientRect().height}px`);
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!extra) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExtra(false);
        extraButtonRef.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!dockRef.current?.contains(event.target as Node)) setExtra(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, [extra]);
  const selectedTruck = world.trucks.find((t) => t.id === truckId)!;
  const average = world.crates.length
    ? world.crates.reduce((sum, c) => sum + c.freshness_score, 0) / world.crates.length
    : 0;
  const atRisk = world.crates.filter((c) =>
    ["at_risk", "critical", "spoiled"].includes(c.status),
  ).length;
  const activeSelected = world.crates.some((c) => c.id === selected)
    ? selected
    : (world.crates[0]?.id ?? "");
  const filtered = world.crates.filter(
    (c) =>
      (filter === "all" || c.product === filter) &&
      `${c.id} ${c.product_label} ${c.truck_id ?? "cold room"} ${c.destination_name ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const heading =
    page === "Shipment" ? (
      <>
        Track a shipment. <span className="heading-accent">Route it right.</span>
      </>
    ) : page === "Overview" ? (
      <>
        Fresh food. <span className="heading-accent">Zero guesswork.</span>
      </>
    ) : page === "Crates" ? (
      "Every crate. Every degree. In view."
    ) : page === "Dispatch" ? (
      "The right crate. The right destination."
    ) : page === "Test lab" ? (
      "Test the model on real lab data."
    ) : page === "Analytics" ? (
      "Less waste, backed by insight."
    ) : (
      "Your cold chain, in real time."
    );
  const reset = () => {
    act({ type: "reset" });
    setSelected(DEMO.hero_crate_id);
    setTruckId(DEMO.problem_truck_id);
    setDetail(null);
    setExtra(false);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand freshsense-brand"
          href="#"
          aria-label="FreshSense overview"
          onClick={(e) => {
            e.preventDefault();
            setPage("Overview");
          }}
        >
          <span className="freshsense-mark">
            <Icon name="leaf" size={25} />
          </span>
          <span className="freshsense-word">
            freshsense<span>.</span>
          </span>
          <span className="compact-brand" aria-hidden="true">
            fs.
          </span>
        </a>
        <div className="product-lockup">
          <small>FRESHNESS INTELLIGENCE</small>
        </div>
        <div className="workspace">
          <div className="workspace-icon">
            <Icon name="warehouse" size={18} />
          </div>
          <div>
            <strong>Bengaluru network</strong>
            <span>Local simulation · demo</span>
          </div>
          <Icon name="chevron" size={13} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.label}
              className={page === n.label ? "nav-active" : ""}
              aria-label={n.label}
              aria-current={page === n.label ? "page" : undefined}
              onClick={() => setPage(n.label)}
            >
              <Icon name={n.icon} size={19} />
              <span>{n.label}</span>
              {n.label === "Crates" && <small>{world.crates.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="impact-card">
            <span className="impact-icon">
              <Icon name="leaf" size={20} />
            </span>
            <strong>
              Good food deserves
              <br />a better destination.
            </strong>
            <p>
              Sense. Predict. Act.
              <br />
              Make every crate count.
            </p>
            <span>
              Eternal network, connected
              <Icon name="arrow" size={13} />
            </span>
          </div>
          <button className="side-link" onClick={() => setModal("settings")}>
            <Icon name="settings" size={18} />
            Settings
          </button>
          <button className="side-link" onClick={() => setModal("help")}>
            <Icon name="help" size={18} />
            Demo guide
          </button>
          <div className="network-endorsement">
            <span>BUILT FOR THE ETERNAL NETWORK</span>
            <p>
              Hyperpure · Blinkit
              <br />
              Zomato · Feeding India
            </p>
            <small>Independent hackathon demo. Brand names used for context only.</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="breadcrumb-product">FreshSense</span>
            <Icon name="chevron" size={12} />
            <strong>{page}</strong>
          </div>
          <div className="header-right">
            <span className="connection">
              <i className={`live-dot ${world.paused || connection !== "live" ? "paused-dot" : ""}`} />
              {CONNECTION_LABEL[connection]} · {world.paused ? "paused" : "running"}
            </span>
            <span className="header-divider" />
            <button
              className="notification-button"
              aria-label="View activity"
              onClick={() => setPage("Activity")}
            >
              <Icon name="bell" size={19} />
              {!!world.alerts.length && <i />}
            </button>
            <span className="avatar">FS</span>
          </div>
        </header>
        <main ref={mainRef} className="master-main" data-page={page} aria-label={`${page} content`}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                SENSE → PREDICT → ACT
              </div>
              <h1>{heading}</h1>
              <p>Your cold chain, under control. Across the Eternal network.</p>
            </div>
            <div className="date-chip">
              <Icon name="clock" size={15} />
              <span>
                {timeLabel(world.sim_time)} IST
                <small>
                  {new Date(world.sim_time).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}{" "}
                  · demo clock
                </small>
              </span>
              <i className={`live-dot ${world.paused ? "paused-dot" : ""}`} />
            </div>
          </div>
          <div className="demo-notice">
            <span>
              <Icon name="activity" size={14} />
              <b>Live backend · calibrated on real data</b>
              <span>
                Freshness model fitted to public lab spoilage data; temperatures replay real
                cold-chain shipments. Locations, trucks and drivers are demo data.
              </span>
            </span>
            <button onClick={() => setModal("help")}>
              How to demo
              <Icon name="arrow" size={13} />
            </button>
          </div>
          <div className="stats-grid">
            {[
              {
                label: "Monitored crates",
                icon: "box" as IconName,
                value: String(world.crates.length).padStart(2, "0"),
                unit: "crates",
                note: `${world.trucks.length} trucks (demo)`,
                sub: `${Object.keys(PRODUCTS).length} product types`,
              },
              {
                label: "Average freshness",
                icon: "leaf" as IconName,
                value: number(average),
                unit: "%",
                note: "Across active inventory",
                sub: "Calibrated bacterial-growth model",
              },
              {
                label: "Needs attention",
                icon: "temp" as IconName,
                value: String(atRisk).padStart(2, "0"),
                unit: "crates",
                note: "At risk, critical, or spoiled",
                sub: "Based on freshness",
              },
              {
                label: "Redirected volume",
                icon: "route" as IconName,
                value: number(world.impact.kg_saved, 0),
                unit: "kg",
                note: `${world.impact.crates_redirected} redirect decisions`,
                sub: `${world.impact.crates_donated} donations`,
              },
            ].map((s) => (
              <div className="stat" key={s.label}>
                <div className="stat-top">
                  <span>{s.label}</span>
                  <Icon name={s.icon} size={18} />
                </div>
                <div className="stat-value">
                  {s.value}
                  <span className="stat-unit">{s.unit}</span>
                </div>
                <p>
                  <span className="metric-note">{s.note}</span>
                  <span>{s.sub}</span>
                </p>
              </div>
            ))}
          </div>
          {page === "Overview" && (
            <>
              <div className="live-overview-grid">
                <DispatchTable world={world} onCrate={setDetail} />
                <Feed world={world} onCrate={setDetail} />
              </div>
              <div className="network-summary">
                {NETWORK.map((n) => (
                  <div key={n.type}>
                    <Icon name={n.icon} size={19} />
                    <span>
                      <strong>{n.label}</strong>
                      <small>
                        {LOCATIONS.filter((l) => l.type === n.type).length}{" "}
                        {n.description.toLowerCase()} (demo)
                      </small>
                    </span>
                    <span className="network-min">
                      {LOCATIONS.find((l) => l.type === n.type)?.min_hours_needed === null
                        ? "Cold-chain origin"
                        : `≥ ${LOCATIONS.find((l) => l.type === n.type)?.min_hours_needed}h on arrival`}
                    </span>
                  </div>
                ))}
              </div>
              <DispatchTable world={world} onCrate={setDetail} />
            </>
          )}
          {page === "Crates" && (
            <section className="inventory">
              <div className="section-heading">
                <div>
                  <h2>
                    Live inventory <span className="count">{world.crates.length} crates</span>
                  </h2>
                  <p>Click any crate for its full journey, excursions, and dispatch decisions.</p>
                </div>
                <div className="inventory-tools">
                  <select
                    aria-label="Filter by product"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All products</option>
                    {Object.values(PRODUCTS).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <div className="view-switch">
                    <button
                      aria-label="Grid view"
                      className={!list ? "active" : ""}
                      onClick={() => setList(false)}
                    >
                      <Icon name="grid" size={15} />
                    </button>
                    <button
                      aria-label="List view"
                      className={list ? "active" : ""}
                      onClick={() => setList(true)}
                    >
                      <Icon name="list" size={17} />
                    </button>
                  </div>
                </div>
              </div>
              <label className="inventory-search">
                <Icon name="search" size={17} />
                <input
                  aria-label="Search crates"
                  placeholder="Search crate, product, truck, or destination…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button aria-label="Clear search" onClick={() => setSearch("")}>
                    <Icon name="close" size={15} />
                  </button>
                )}
              </label>
              <div className={`crate-grid ${list ? "list-layout" : ""}`}>
                {filtered.map((c) => (
                  <button
                    key={c.id}
                    className={`crate-card ${c.status === "spoiled" ? "spoiled" : ""}`}
                    onClick={() => setDetail(c.id)}
                  >
                    <div className="crate-top">
                      <span className="product-icon">
                        <Icon name={PRODUCT_ICONS[c.product]} size={22} />
                      </span>
                      <StatusBadge crate={c} />
                    </div>
                    <div className="crate-title">
                      <h3>{c.id}</h3>
                      <span>{c.product_label}</span>
                    </div>
                    <p className="item-name">
                      {c.truck_id ? (
                        `${c.truck_id} (demo)`
                      ) : (
                        <>
                          <Icon name="tag" size={10} /> Stationary tag · {c.warehouse_id}
                        </>
                      )}
                    </p>
                    <div className="freshness-label">
                      <span>Freshness</span>
                      <strong>
                        {number(c.freshness_score)}
                        <small>%</small>
                      </strong>
                    </div>
                    <div className="progress">
                      <span style={{ width: `${c.freshness_score}%` }} />
                    </div>
                    <div className="sensor-row">
                      <span className={c.temp_c > PRODUCTS[c.product].max_safe_c ? "hot" : ""}>
                        <Icon name="temp" size={14} />
                        {number(c.temp_c)}
                        <small>°C</small>
                      </span>
                      <span>
                        <Icon name="drop" size={14} />
                        {number(c.humidity, 0)}
                        <small>%</small>
                      </span>
                      <span className="voc" title="Estimated bacterial load (log CFU/g)">
                        {number(c.tvc, 2)} log · {c.quality_stage}
                      </span>
                    </div>
                    <div className="crate-bottom">
                      <span>
                        <Icon name="clock" size={13} />
                        <b>{number(c.hours_left)}h</b> shelf life
                      </span>
                      <span>
                        {c.redirected ? <Icon name="route" size={12} /> : null}
                        {c.destination_id ?? "Cold room"}
                        <Icon name="chevron" size={12} />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {!filtered.length && (
                <div className="empty">
                  <Icon name="search" size={25} />
                  <h3>No matching crates</h3>
                  <button
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
              <div className="inventory-foot">
                <span>
                  <i className="live-dot" />
                  {world.paused
                    ? "Paused · Resume to advance readings"
                    : `${CONFIG.tick_seconds}s real time = ${world.minutes_per_tick} simulated minute${world.minutes_per_tick === 1 ? "" : "s"}`}
                </span>
                <span>
                  {DEMO.statuses.map((s) => (
                    <span className="status-legend" key={s.id}>
                      <i style={{ background: s.color }} />
                      {s.label}
                    </span>
                  ))}
                </span>
              </div>
              {!!world.archive.length && (
                <div className="archive-section">
                  <h2>
                    Completed journeys <span className="count">{world.archive.length}</span>
                  </h2>
                  <p>Delivered and discarded crates remain available for inspection.</p>
                  <div>
                    {world.archive.map((c) => (
                      <button key={c.id} onClick={() => setDetail(c.id)}>
                        <Icon name="box" size={16} />
                        <b>{c.id}</b>
                        <span>
                          {c.discarded
                            ? "Discarded"
                            : `Delivered · ${getLocation(c.delivered_to)?.area} (demo)`}
                        </span>
                        <Icon name="arrow" size={13} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
          {page === "Dispatch" && <DispatchTable world={world} onCrate={setDetail} expanded />}
          {page === "Shipment" && (
            <Suspense fallback={<div className="panel view-loading">Loading…</div>}>
              <Shipment />
            </Suspense>
          )}
          {page === "Test lab" && (
            <Suspense fallback={<div className="panel view-loading">Loading test lab…</div>}>
              <TestLab />
            </Suspense>
          )}
          {page === "Analytics" && (
            <Suspense fallback={<div className="panel view-loading">Preparing analytics…</div>}>
              <Analytics world={world} />
            </Suspense>
          )}
          {page === "Activity" && (
            <div className="activity-page-grid">
              <Feed world={world} onCrate={setDetail} full />
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    Delivery log <span className="count">{world.impact.deliveries_completed}</span>
                  </h2>
                </div>
                {world.deliveries.length ? (
                  world.deliveries.map((d) => (
                    <button
                      className="delivery-entry"
                      key={d.id}
                      onClick={() => setDetail(d.crate_id)}
                    >
                      <Icon name={d.accepted ? "check" : "close"} size={16} />
                      <span>
                        <b>
                          {d.crate_id} · {d.accepted ? "Accepted" : "Rejected"}
                        </b>
                        <small>{getLocation(d.location_id)?.name}</small>
                      </span>
                      <time>{timeLabel(d.ts)}</time>
                    </button>
                  ))
                ) : (
                  <div className="feed-empty">
                    <Icon name="truck" size={26} />
                    <h3>The journey is still ahead.</h3>
                    <p>
                      Resume the simulation. Accepted and rejected arrivals will be recorded here.
                    </p>
                  </div>
                )}
              </section>
            </div>
          )}
          <footer className="main-footer">
            <span>
              <Icon name="leaf" size={13} />
              Built for a world with less food waste.
            </span>
            <span>
              {CONNECTION_LABEL[connection]}
              <i />
              Tick {world.tick}
              <span className="footer-brand">FreshSense · seed {world.seed}</span>
            </span>
          </footer>
        </main>
        <div ref={dockRef} className="control-dock" role="region" aria-label="Simulation controls" style={{ display: page === "Shipment" || page === "Test lab" ? "none" : undefined }}>
          <div className="simulation-bar">
            <div className="sim-title">
              <span className="sim-icon">
                <Icon name="settings" size={18} />
              </span>
              <div>
                <h3>
                  Simulation lab <span>LIVE</span>
                </h3>
                <p>
                  {world.paused
                    ? "Paused. Ready when you are."
                    : `1 real second = ${world.minutes_per_tick} simulated min`}
                </p>
              </div>
            </div>
            <div className="sim-actions">
              <select
                aria-label="Select crate to simulate"
                value={activeSelected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {world.crates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.product_label} · {number(c.hours_left, 0)}h
                    {c.id === DEMO.hero_crate_id ? " · most urgent" : ""}
                  </option>
                ))}
              </select>
              <button
                className="heat-button"
                disabled={!activeSelected}
                onClick={() => act({ type: "heat", id: activeSelected, minutes: heatMinutes })}
              >
                <Icon name="heat" size={15} />
                Leave out of cold
              </button>
              <select
                className="speed-select"
                aria-label="How long the crate stays out of refrigeration"
                value={heatMinutes}
                onChange={(e) => setHeatMinutes(Number(e.target.value))}
              >
                {CONFIG.heat_minutes_options.map((m) => (
                  <option value={m} key={m}>
                    {m < 60 ? `${m} min` : `${m / 60} h`}
                  </option>
                ))}
              </select>
              <button
                className="shock-button"
                disabled={!activeSelected}
                onClick={() => act({ type: "shock", id: activeSelected })}
              >
                <Icon name="shock" size={15} />
                Log shock
              </button>
              <span className="sim-divider" />
              <button
                className="resume-button"
                aria-label={world.paused ? "Resume simulation" : "Pause simulation"}
                onClick={() => act({ type: "control", paused: !world.paused })}
              >
                <Icon name={world.paused ? "play" : "pause"} size={14} />
                {world.paused ? "Resume" : "Pause"}
              </button>
              <select
                className="speed-select"
                aria-label="Simulated minutes per tick"
                value={world.minutes_per_tick}
                onChange={(e) => act({ type: "control", minutes_per_tick: Number(e.target.value) })}
              >
                {Array.from(
                  { length: CONFIG.max_speed - CONFIG.min_speed + 1 },
                  (_, i) => CONFIG.min_speed + i,
                ).map((n) => (
                  <option value={n} key={n}>
                    {n}×
                  </option>
                ))}
              </select>
              <button
                className="icon-button extra-controls-button"
                ref={extraButtonRef}
                aria-label="Truck and live tag controls"
                aria-controls="extra-simulation-controls"
                aria-expanded={extra}
                onClick={() => setExtra(!extra)}
              >
                <Icon name={extra ? "close" : "settings"} size={16} />
              </button>
              <button className="reset-button" onClick={reset}>
                <Icon name="reset" size={14} />
                <span>Reset</span>
              </button>
            </div>
          </div>
          {extra && (
            <div
              id="extra-simulation-controls"
              className="extra-controls panel"
              role="region"
              aria-label="Truck and live tag controls"
            >
              <div className="panel-heading">
                <div>
                  <h2>Truck & live tag controls</h2>
                  <p>Scenarios are queued while paused. Click Resume to advance the demo.</p>
                </div>
                <button aria-label="Close extra controls" onClick={() => setExtra(false)}>
                  <Icon name="close" size={17} />
                </button>
              </div>
              <div className="truck-scenarios">
                <select
                  aria-label="Select truck"
                  value={truckId}
                  onChange={(e) => setTruckId(e.target.value)}
                >
                  {world.trucks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id} · {t.driver}
                    </option>
                  ))}
                </select>
                <button className="shock-button" onClick={() => act({ type: "door", id: truckId })}>
                  <Icon name="door" size={15} />
                  Door open
                </button>
                <button
                  className={selectedTruck.compressor_ok ? "heat-button" : "shock-button"}
                  onClick={() =>
                    act({ type: selectedTruck.compressor_ok ? "fail" : "fix", id: truckId })
                  }
                >
                  <Icon name="snow" size={15} />
                  {selectedTruck.compressor_ok ? "Fail compressor" : "Fix compressor"}
                </button>
                <span className="subtle-tag">
                  {selectedTruck.compressor_ok ? "Compressor on" : "Compressor off"}
                </span>
              </div>
              <TagControls world={world} act={act} />
            </div>
          )}
        </div>
      </div>
      {detail && (
        <Suspense
          fallback={
            <div className="drawer-backdrop">
              <div className="journey-drawer view-loading">Preparing journey report…</div>
            </div>
          }
        >
          <JourneyDrawer world={world} id={detail} onClose={closeDetail} />
        </Suspense>
      )}
      {modal && (
        <Dialog
          title={modal === "settings" ? "Simulation settings" : "Your five-minute demo."}
          onClose={closeModal}
        >
          {modal === "settings" ? (
            <>
              <p className="modal-intro">
                One tick is {CONFIG.tick_seconds} real second. Choose how many simulated minutes it
                advances.
              </p>
              <label className="setting-row">
                Minutes per tick
                <select
                  aria-label="Simulation speed"
                  value={world.minutes_per_tick}
                  onChange={(e) =>
                    act({ type: "control", minutes_per_tick: Number(e.target.value) })
                  }
                >
                  {Array.from({ length: CONFIG.max_speed }, (_, i) => i + CONFIG.min_speed).map(
                    (n) => (
                      <option key={n} value={n}>
                        {n} simulated min
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="setting-row">
                Simulation
                <button
                  className="toggle-button"
                  onClick={() => act({ type: "control", paused: !world.paused })}
                >
                  {world.paused ? "Paused · Resume" : "Running · Pause"}
                </button>
              </label>
              <div className="info-callout">
                <Icon name="help" size={18} />
                <p>
                  All parameters, product data, locations, trucks, and seed crates are configured in
                  src/data. This frontend does not connect to FastAPI or MQTT. Page refresh or Reset
                  discards this session. Completed trucks stay at their final stop until reset.
                </p>
              </div>
              <button className="reset-button settings-reset" onClick={reset}>
                <Icon name="reset" size={15} />
                Reset demo and pause
              </button>
            </>
          ) : (
            <>
              <p className="modal-intro">
                Live dashboard on the FreshSense backend. The freshness model is calibrated on public
                lab spoilage data; truck temperatures replay real cold-chain shipments.
              </p>
              <ol className="help-steps">
                <li>
                  <b>Start fresh, then Resume.</b>
                  <p>
                    {world.crates.length} crates, {world.trucks.length} trucks, and{" "}
                    {LOCATIONS.length} network locations. Reset always pauses.
                  </p>
                </li>
                <li>
                  <b>Leave {DEMO.hero_crate_id} out of the cold.</b>
                  <p>
                    It is the most urgent crate. It warms along a real measured warm-up curve; set
                    speed to 5× and choose 2–8 h. When its planned stop becomes infeasible, its route
                    changes to a reachable Eternal partner.
                  </p>
                </li>
                <li>
                  <b>Fail {DEMO.problem_truck_id}’s compressor.</b>
                  <p>
                    Open the extended controls. Speed up the demo to see redirect, donation, or
                    discard decisions as shelf life declines. Fix the compressor to restore cooling.
                  </p>
                </li>
                <li>
                  <b>Inspect the evidence.</b>
                  <p>
                    Open Crates → select a crate for full history, excursions, and stage
                    attribution. Compare FIFO in Dispatch. Explore Analytics for loss and
                    provenance.
                  </p>
                </li>
                <li>
                  <b>Try the virtual tag.</b>
                  <p>
                    Extended controls include temperature, humidity, and door-open controls for{" "}
                    {CONFIG.live_tag_id}, stationary at the warehouse.
                  </p>
                </li>
              </ol>
              <div className="info-callout">
                <Icon name="help" size={18} />
                <p>
                  Model results come from held-out real lab data (see Analytics). Locations, trucks,
                  drivers and destination rules are demo assumptions. Status colors are limited to
                  semantic dots; truck colors identify map routes.
                </p>
              </div>
            </>
          )}
        </Dialog>
      )}
      <Toaster
        containerStyle={{ display: detail || modal ? "none" : undefined }}
        position="top-right"
        toastOptions={{
          duration: 5000,
          style: {
            background: "var(--surface)",
            color: "var(--ink)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            boxShadow: "var(--shadow-float)",
          },
        }}
      />
    </div>
  );
}
