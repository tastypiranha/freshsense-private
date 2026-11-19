"""One shipment, end to end: origin hub -> highway -> destination-city warehouse -> best accepting outlet.

The crate tag "senses" the trip from real data:
  - temperature: a real reefer shipment trace (strawberry cold-chain loggers), or for an insulated van the
    real warm-up curve measured after refrigeration stops
  - door openings / compressor failure / dock exposure: real door-spike, warm-up and cool-down curves
  - shocks: peak magnitudes from real accelerometer recordings (rough road, sudden shock)
Freshness follows the calibrated Ratkowsky model. At the destination warehouse every restaurant, dark store and
food bank in the city is checked against the hours it needs on arrival, and the crate is routed to the best one.
"""
import copy
import hashlib
import json
import math
import random
from datetime import datetime, timedelta
from pathlib import Path

import model as M
import traces as T
from config import ASSUMPTIONS

BASE = Path(__file__).parent
NET = json.loads((BASE / "data" / "network.json").read_text())
VIB = json.loads((BASE.parent / "data" / "processed" / "vibration.json").read_text())
ORIGINS = {o["id"]: o for o in NET["origins"]}
CITIES = {c["id"]: c for c in NET["cities"]}
W = ASSUMPTIONS["redirect_score_weights"]
STEP_MIN = 10
LOADING_MIN = 30
UNLOADING_MIN = 30
TS = "%Y-%m-%dT%H:%M:%S"


class ShipmentError(ValueError):
    pass


def haversine_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def options():
    """Everything the form needs."""
    return {
        "products": {k: {"id": k, "label": v["label"], "emoji": v["emoji"],
                         "foodkeeper_fridge_days": v["foodkeeper_fridge_days"],
                         "model_shelf_life_days_at_ref": v["model_shelf_life_days_at_ref"],
                         "gas_model": v["gas_model"]} for k, v in M.PRODUCTS.items()},
        "origins": NET["origins"],
        "cities": [{"id": c["id"], "name": c["name"], "warehouse": _loc(c, c["warehouse_id"]),
                    "outlets": [l for l in c["locations"] if l["type"] != "warehouse"]} for c in NET["cities"]],
        "vehicles": [{"id": "reefer", "label": "Reefer truck", "detail": "Active cooling · replays a real cold-chain shipment"},
                     {"id": "insulated", "label": "Insulated van", "detail": "No active cooling · real warm-up curve"}],
        "incidents": [{"id": "door", "label": "Door left open", "detail": "Real fridge-door spike (+6 °C, ~1 h decay)"},
                      {"id": "compressor", "label": "Compressor failure", "detail": "Real warm-up while off, real cool-down after"},
                      {"id": "dock", "label": "Left on arrival dock", "detail": "Real warm-up curve for the minutes chosen"},
                      {"id": "shock", "label": "Hard shock / drop", "detail": "Peak from a real accelerometer shock recording"}],
    }


def _loc(city, lid):
    return next(l for l in city["locations"] if l["id"] == lid)


def _excess(start, end, now):
    """Warm-up while an event is active, then real cool-down (°C above base)."""
    if now < start:
        return 0.0
    if end is None or now < end:
        return M.warm_delta(now - start)
    return M.warm_delta(end - start) * M.cool_fraction(now - end)


def simulate(p):
    """Whole trip in one go (the instant API)."""
    trip = Trip(p)
    while not trip.done:
        trip.step()
    return trip.result()


INCIDENT_TYPES = ("door", "compressor", "shock", "dock")


class Trip:
    """A shipment that advances one STEP_MIN reading at a time, so it can also run live: incidents can be
    injected mid-trip, and forecast() projects the arrival decision from the current state."""

    def __init__(self, p):
        product = p.get("product")
        if product not in M.PRODUCTS:
            raise ShipmentError(f"unknown product '{product}'")
        origin = ORIGINS.get(p.get("origin_id"))
        if origin is None:
            raise ShipmentError("unknown origin_id")
        city = CITIES.get(p.get("destination_city"))
        if city is None:
            raise ShipmentError("unknown destination_city")
        vehicle = p.get("vehicle", "reefer")
        if vehicle not in ("reefer", "insulated"):
            raise ShipmentError("vehicle must be reefer or insulated")
        printed_days = M.safe_float(p.get("printed_expiry_days"))
        if printed_days is None or not 0 < printed_days <= 60:
            raise ShipmentError("printed_expiry_days (days left on the label at dispatch) must be between 0 and 60")
        scheduled = p.get("incidents") or []
        for inc in scheduled:
            if inc.get("type") not in INCIDENT_TYPES:
                raise ShipmentError(f"unknown incident type '{inc.get('type')}'")
        self.product, self.origin, self.city, self.vehicle = product, origin, city, vehicle
        self.printed_days = printed_days
        self.planned = p.get("planned_outlet_id") or None
        self.warehouse = _loc(city, city["warehouse_id"])
        self.dist = haversine_km((origin["lat"], origin["lng"]), (self.warehouse["lat"], self.warehouse["lng"])) * NET["highway_road_factor"]
        self.transit_min = max(60.0, self.dist / NET["highway_speed_kmh"] * 60)
        self.arrive_min = LOADING_MIN + self.transit_min
        self.total_min = self.arrive_min + UNLOADING_MIN

        key = json.dumps({k: p.get(k) for k in ("product", "origin_id", "destination_city", "vehicle", "seed")}, sort_keys=True)
        self.rng = random.Random(int(hashlib.sha1(key.encode()).hexdigest()[:8], 16))
        self.trace = self.rng.choice(T.TRACE_IDS)
        self.t0 = T.cold_start_minute(self.trace) + self.rng.uniform(0, 600)
        self.cold_start_temp = T.temp_at(self.trace, self.t0)
        self.depart = _parse_departure(p.get("departure"))
        self.m = 0.0
        self.events_in, self.events = [], []

        def at_of(inc):  # scheduled times are hours into the highway leg
            return LOADING_MIN + max(0.0, min(self.transit_min, float(inc.get("at_h", 0)) * 60))

        for inc in scheduled:
            if inc["type"] != "shock":
                self._add(inc["type"], at_of(inc), max(1.0, float(inc.get("minutes", 30))))
        # rough-road jolts: ~1 per 200 km of highway, peaks from the real 'dangerous vibration' recording
        self.jolts = sorted(self.rng.uniform(LOADING_MIN, self.arrive_min) for _ in range(int(self.dist // 200)))
        self.shocks = [("shock", t, None) for t in self.jolts]
        self.shocks += [("shock", at_of(inc), None) for inc in scheduled if inc["type"] == "shock"]
        self.shocks_done = set()

        # Starting freshness from the label: "expires in N days" = N days of shelf life left at fridge temperature.
        self.tvc = max(min(M.TVC0_VALUES), M.SPOIL - M.mu(M.REF_T, product) * printed_days * 24)
        self.label_capped = self.tvc <= min(M.TVC0_VALUES) + 1e-9
        self.tvc_start = self.tvc
        self.limit = M.PRODUCTS[product]["max_safe_c"]
        self.timeline = []
        self.in_exc, self.exc_start, self.last_status = False, None, None
        self.extra_total = 0.0

    # ------------------------------------------------------------------ incidents
    def _add(self, typ, at, mins):
        """Register an incident at minute `at`. Compressor with mins=None stays off until fix_compressor()."""
        if typ == "door":
            self.events_in.append(["door", at, None])
            self.events.append(self._ev(at, "door", "warning", "Door opened", "Real fridge-door temperature spike"))
        elif typ == "compressor":
            self.events_in.append(["compressor", at, None if mins is None else at + mins])
            self.events.append(self._ev(at, "compressor", "critical",
                                        "Compressor failure" + ("" if mins is None else f" for {mins:.0f} min"),
                                        "Cargo warms along the real warm-up curve"))
        elif typ == "dock":
            if any(e[0] == "dock" for e in self.events_in):
                raise ShipmentError("the crate is already waiting on the dock")
            start = max(self.arrive_min, self.m)
            self.events_in.append(["dock", start, start + mins])
            self.total_min = max(self.total_min, self.total_min + mins if start == self.arrive_min else start + mins)
            self.events.append(self._ev(start, "dock", "warning", f"Left on the arrival dock for {mins:.0f} min", self.warehouse["name"]))
        elif typ == "shock":
            self.shocks.append(("shock", at, None))

    def inject(self, typ, minutes=None):
        """A live incident at the current minute (the dock one applies on arrival)."""
        if self.done:
            raise ShipmentError("the trip has already finished")
        if typ not in INCIDENT_TYPES:
            raise ShipmentError(f"unknown incident type '{typ}'")
        if typ == "compressor" and self.compressor_off:
            raise ShipmentError("the compressor is already off")
        if typ == "compressor" and self.m >= self.arrive_min:
            raise ShipmentError("the crate is already off the truck")
        mins = None if minutes is None else max(1.0, float(minutes))
        if typ == "dock" and mins is None:
            mins = 120.0
        self._add(typ, self.m, mins)

    def fix_compressor(self):
        if self.done:
            raise ShipmentError("the trip has already finished")
        for e in self.events_in:
            if e[0] == "compressor" and e[1] <= self.m and (e[2] is None or e[2] > self.m):
                e[2] = self.m
                self.events.append(self._ev(self.m, "repair", "info", "Compressor repaired", "Cargo cools along the real cool-down curve"))
                return
        raise ShipmentError("the compressor is running")

    @property
    def compressor_off(self):
        return any(e[0] == "compressor" and e[1] <= self.m and (e[2] is None or e[2] > self.m) for e in self.events_in)

    @property
    def done(self):
        return self.m > self.total_min + 1e-9

    def stage_at(self, m):
        if m < LOADING_MIN:
            return "origin_loading"
        return "highway" if m < self.arrive_min else "arrival_dock"

    # ------------------------------------------------------------------ one reading
    def step(self):
        m, transit_min = self.m, self.transit_min
        stage = self.stage_at(m)
        if stage == "origin_loading":
            temp = self.cold_start_temp + M.warm_delta(m)
        elif stage == "highway":
            leg = m - LOADING_MIN
            temp = T.temp_at(self.trace, self.t0 + leg) if self.vehicle == "reefer" else self.cold_start_temp + M.warm_delta(leg)
        else:
            temp = T.temp_at(self.trace, self.t0 + transit_min) if self.vehicle == "reefer" else self.cold_start_temp + M.warm_delta(transit_min)
            temp += M.warm_delta(m - self.arrive_min)
        temp = min(temp, M.AMBIENT_C)  # cargo can't get warmer than the surrounding air
        hum = M.PROFILES["fridge_humidity_pct"]["value"]
        for typ, a, b in self.events_in:
            if typ == "compressor":
                temp += _excess(a, b, m)
            elif typ == "door" and m >= a:
                d = M.door_delta(m - a)
                temp += d
                hum += d / max(M._DOOR) * M.DOOR_HUMIDITY_DELTA
        temp = min(temp, M.AMBIENT_C)
        shock_g = 0.0
        for i, (typ, a, _) in enumerate(self.shocks):
            if i not in self.shocks_done and a <= m:
                self.shocks_done.add(i)
                manual = i >= len(self.jolts)
                g = self.rng.choice(VIB["shock"]["peak_deviation_g"] if manual else VIB["rough_road"]["peak_deviation_g"])
                shock_g = max(shock_g, g)
                self.events.append(self._ev(m, "shock", "critical" if g >= 2 else "warning",
                                            f"{'Hard shock' if manual else 'Rough-road jolt'} · {g:.2f} g peak",
                                            "Logged for inspection at arrival (no dataset links shocks to spoilage)"))
        if m > 0:
            # The label is the ceiling: it already assumes fridge temperature (4.4 °C) all the way, so a colder
            # trip earns no extra time (growth never runs slower than the label's pace); heat takes time away.
            self.tvc, _, extra = M.step(self.tvc, max(temp, M.REF_T), STEP_MIN / 60, self.product)
            self.extra_total += extra
        d = M.describe(self.tvc, temp, self.product)
        if temp > self.limit and not self.in_exc:
            self.in_exc, self.exc_start = True, m
        elif temp <= self.limit and self.in_exc:
            self.in_exc = False
            if m - self.exc_start >= 20:
                self.events.append(self._ev(self.exc_start, "excursion", "warning",
                                            f"Temperature above {self.limit} °C for {m - self.exc_start:.0f} min", _stage_label(stage)))
        if self.last_status and d["status"] != self.last_status and _worse(d["status"], self.last_status):
            self.events.append(self._ev(m, "status", "critical" if d["status"] in ("critical", "spoiled") else "warning",
                                        f"Freshness dropped to {d['status'].replace('_', ' ')}", f"{d['hours_left']:.0f} h left at {M.REF_T} °C"))
        self.last_status = d["status"]
        prog = min(1.0, max(0.0, (m - LOADING_MIN) / transit_min))
        o, w = self.origin, self.warehouse
        row = {
            "minute": round(m), "ts": (self.depart + timedelta(minutes=m)).strftime(TS), "stage": stage,
            "temp_c": round(temp, 2), "humidity": round(min(100, hum), 1), "shock_g": round(shock_g, 2),
            "tvc": round(self.tvc, 3), "freshness_score": d["freshness_score"], "hours_left": d["hours_left"],
            "status": d["status"], "progress": round(prog, 4),
            "lat": round(o["lat"] + (w["lat"] - o["lat"]) * prog, 5), "lng": round(o["lng"] + (w["lng"] - o["lng"]) * prog, 5),
        }
        self.timeline.append(row)
        self.m += STEP_MIN
        return row

    # ------------------------------------------------------------------ outputs
    def forecast(self):
        """The arrival decision if nothing else happens from here (a compressor that is off stays off)."""
        sim = copy.deepcopy(self)
        while not sim.done:
            sim.step()
        r = sim.result()
        return {"arrival": r["arrival"], "decision": r["decision"], "candidates": r["candidates"],
                "total_min": round(sim.total_min)}

    def result(self):
        events = list(self.events)
        if self.in_exc and self.m - self.exc_start >= 20:
            events.append(self._ev(self.exc_start, "excursion", "warning", f"Temperature above {self.limit} °C at arrival", "Arrival dock"))
        events.append(self._ev(0, "stage", "info", f"Loading at {self.origin['name']}", f"Tag starts sensing · label: {self.printed_days:g} days left"))
        if self.m > LOADING_MIN:
            events.append(self._ev(LOADING_MIN, "stage", "info", f"Departed on the highway · {self.dist:.0f} km",
                                   "Reefer truck" if self.vehicle == "reefer" else "Insulated van"))
        if self.m > self.arrive_min:
            events.append(self._ev(self.arrive_min, "stage", "info", f"Arrived at {self.warehouse['name']}", "Matching outlets in the city"))
        events.sort(key=lambda e: e["minute"])
        tl = self.timeline
        arrival = {
            **M.describe(self.tvc, M.REF_T, self.product),
            "tvc_start": round(self.tvc_start, 3),
            "extra_life_lost_h": round(self.extra_total, 1),
            "minutes_above_safe": sum(STEP_MIN for r in tl if r["temp_c"] > self.limit),
            "shocks": len(self.shocks), "max_shock_g": max([r["shock_g"] for r in tl] + [0]),
            "label_hours_left": round(self.printed_days * 24 - self.total_min / 60, 1),
            "hours_left_at_dispatch": M.describe(self.tvc_start, M.REF_T, self.product)["hours_left"],
            "label_capped_to_fresh": self.label_capped,
        }
        candidates, decision = _match(self.city, self.warehouse, self.product, arrival, self.planned)
        return {"shipment": self.meta(), "timeline": tl, "events": events, "arrival": arrival,
                "candidates": candidates, "decision": decision}

    def meta(self):
        tl = self.timeline
        arrived = tl[-1]["ts"] if tl and self.done else (self.depart + timedelta(minutes=self.total_min)).strftime(TS)
        return {
            "product": self.product, "product_label": M.PRODUCTS[self.product]["label"], "emoji": M.PRODUCTS[self.product]["emoji"],
            "origin": self.origin, "city": {"id": self.city["id"], "name": self.city["name"]}, "warehouse": self.warehouse,
            "vehicle": self.vehicle, "distance_km": round(self.dist), "transit_h": round(self.transit_min / 60, 1),
            "total_h": round(self.total_min / 60, 1), "total_min": round(self.total_min),
            "loading_min": LOADING_MIN, "arrival_min": round(self.arrive_min),
            "departed_at": self.depart.strftime(TS), "arrived_at": arrived,
            "printed_expiry_days": self.printed_days,
            "temperature_source": f"real shipment trace {self.trace}" if self.vehicle == "reefer" else "real warm-up curve (no active cooling)",
            "safe_temp_c": self.limit, "reference_temp_c": M.REF_T, "thresholds_log_cfu": M.THRESHOLDS,
            "planned_outlet_id": self.planned,
        }

    def _ev(self, minute, typ, severity, title, detail):
        return _ev(self.depart, minute, typ, severity, title, detail)


def _match(city, warehouse, product, arrival, planned):
    rows = []
    hl = arrival["hours_left"]
    w = M.PRODUCTS[product]["weight_kg"]
    for l in city["locations"]:
        if l["type"] == "warehouse":
            continue
        km = haversine_km((warehouse["lat"], warehouse["lng"]), (l["lat"], l["lng"])) * NET["city_road_factor"]
        th = km / NET["city_speed_kmh"]
        on_arrival = hl - th
        demand = l["demand_kg_per_day"].get(product, 0)
        need = l["min_hours_needed"]
        ok = demand > 0 and arrival["status"] != "spoiled" and on_arrival >= need
        why = ("No demand for this product" if demand <= 0 else
               "Spoiled on arrival" if arrival["status"] == "spoiled" else
               f"Would arrive with {on_arrival:.0f} h; needs {need} h" if not ok else
               f"Arrives with {on_arrival:.0f} h (needs {need} h) · {demand} kg/day demand")
        score = None
        if ok:
            score = (W["demand_match"] * min(1, demand / (w * 2)) + W["time_margin"] * min(1, (on_arrival - need) / 24)
                     - W["distance_penalty"] * min(1, km / 40)
                     + {"restaurant": W["type_bonus_restaurant"], "dark_store": W["type_bonus_dark_store"]}.get(l["type"], 0))
        rows.append({"location_id": l["id"], "name": l["name"], "type": l["type"], "area": l["area"],
                     "lat": l["lat"], "lng": l["lng"], "travel_min": round(th * 60), "distance_km": round(km, 1),
                     "hours_on_arrival": round(on_arrival, 1), "min_hours_needed": need, "demand_kg_per_day": demand,
                     "accepts": ok, "score": None if score is None else round(score, 3), "reason": why})
    # food banks are the fallback, so sellers rank first
    rows.sort(key=lambda r: (not r["accepts"], r["type"] == "food_bank", -(r["score"] or 0), r["travel_min"]))
    sellers = [r for r in rows if r["accepts"] and r["type"] != "food_bank"]
    banks = [r for r in rows if r["accepts"] and r["type"] == "food_bank"]
    planned_row = next((r for r in rows if r["location_id"] == planned), None)
    if planned_row and planned_row["accepts"]:
        best, kind = planned_row, "DELIVER"
        reason = f"Planned outlet still accepts it: {planned_row['reason']}."
    elif sellers:
        best = sellers[0]
        kind = "REDIRECT" if planned_row else "ASSIGN"
        lead = f"Planned outlet rejects it ({planned_row['reason'].lower()}). " if planned_row else ""
        reason = f"{lead}Best match of {len(sellers)} accepting outlets: {best['reason']}."
    elif banks:
        best, kind = banks[0], "DONATE"
        reason = f"Too little shelf life left to sell anywhere in {city['name']}; still safe, so donated ({best['reason']})."
    else:
        best, kind = None, "DISCARD"
        reason = "Spoiled or no outlet can receive it in time. Discarded and cause logged."
    for r in rows:
        r["chosen"] = best is not None and r["location_id"] == best["location_id"]
    return rows, {"decision": kind, "location": best, "reason": reason,
                  "accepting": len(sellers) + len(banks), "total": len(rows)}


def _parse_departure(v):
    if v:
        try:
            return datetime.fromisoformat(str(v)).replace(second=0, microsecond=0)
        except ValueError as e:
            raise ShipmentError(f"bad departure: {e}")
    return datetime.now().replace(minute=0, second=0, microsecond=0)


ORDER = ["fresh", "watch", "at_risk", "critical", "spoiled"]


def _worse(a, b):
    return ORDER.index(a) > ORDER.index(b)


def _stage_label(s):
    return {"origin_loading": "Loading at origin", "highway": "Highway transit", "arrival_dock": "Arrival dock"}[s]


def _ev(depart, minute, typ, severity, title, detail):
    return {"minute": round(minute), "ts": (depart + timedelta(minutes=minute)).strftime(TS),
            "type": typ, "severity": severity, "title": title, "detail": detail}
