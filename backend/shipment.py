"""One shipment, end to end: origin hub -> highway -> destination-city warehouse -> best accepting outlet.

The crate tag "senses" the trip from real data:
  - temperature: a real reefer shipment trace (strawberry cold-chain loggers), or for an insulated van the
    real warm-up curve measured after refrigeration stops
  - door openings / compressor failure / dock exposure: real door-spike, warm-up and cool-down curves
  - shocks: peak magnitudes from real accelerometer recordings (rough road, sudden shock)
Freshness follows the calibrated Ratkowsky model. At the destination warehouse every restaurant, dark store and
food bank in the city is checked against the hours it needs on arrival, and the crate is routed to the best one.
"""
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
    planned = p.get("planned_outlet_id") or None
    warehouse = _loc(city, city["warehouse_id"])
    dist = haversine_km((origin["lat"], origin["lng"]), (warehouse["lat"], warehouse["lng"])) * NET["highway_road_factor"]
    transit_min = max(60.0, dist / NET["highway_speed_kmh"] * 60)
    total_min = LOADING_MIN + transit_min + UNLOADING_MIN

    key = json.dumps({k: p.get(k) for k in ("product", "origin_id", "destination_city", "vehicle", "seed")}, sort_keys=True)
    rng = random.Random(int(hashlib.sha1(key.encode()).hexdigest()[:8], 16))
    trace = rng.choice(T.TRACE_IDS)
    t0 = T.cold_start_minute(trace) + rng.uniform(0, 600)
    cold_start_temp = T.temp_at(trace, t0)

    # incidents (times are hours into the highway leg)
    events_in = []
    for inc in p.get("incidents") or []:
        typ = inc.get("type")
        at = LOADING_MIN + max(0.0, min(transit_min, float(inc.get("at_h", 0)) * 60))
        mins = max(1.0, float(inc.get("minutes", 30)))
        if typ == "door":
            events_in.append(("door", at, None))
        elif typ == "compressor":
            events_in.append(("compressor", at, at + mins))
        elif typ == "shock":
            events_in.append(("shock", at, None))
        elif typ == "dock":
            events_in.append(("dock", LOADING_MIN + transit_min, LOADING_MIN + transit_min + mins))
        else:
            raise ShipmentError(f"unknown incident type '{typ}'")
    dock_extra = next((e[2] - e[1] for e in events_in if e[0] == "dock"), 0.0)
    total_min += dock_extra
    # rough-road jolts: ~1 per 200 km of highway, peaks from the real 'dangerous vibration' recording
    jolts = sorted(rng.uniform(LOADING_MIN, LOADING_MIN + transit_min) for _ in range(int(dist // 200)))
    shocks = [("shock", t, None) for t in jolts] + [e for e in events_in if e[0] == "shock"]
    shock_peaks = VIB["shock"]["peak_deviation_g"]
    rough_peaks = VIB["rough_road"]["peak_deviation_g"]

    # Starting freshness from the label: "expires in N days" = N days of shelf life left at fridge temperature.
    mu_ref = M.mu(M.REF_T, product)
    tvc = max(min(M.TVC0_VALUES), M.SPOIL - mu_ref * printed_days * 24)
    label_capped = tvc <= min(M.TVC0_VALUES) + 1e-9
    tvc_start = tvc
    depart = _parse_departure(p.get("departure"))
    limit = M.PRODUCTS[product]["max_safe_c"]
    timeline, events = [], []
    in_exc, exc_start, last_status = False, None, None
    shocks_done = set()
    extra_total = 0.0
    m = 0.0
    while m <= total_min + 1e-9:
        if m < LOADING_MIN:
            stage = "origin_loading"
            temp = cold_start_temp + M.warm_delta(m)
        elif m < LOADING_MIN + transit_min:
            stage = "highway"
            leg = m - LOADING_MIN
            temp = T.temp_at(trace, t0 + leg) if vehicle == "reefer" else cold_start_temp + M.warm_delta(leg)
        else:
            stage = "arrival_dock"
            temp = T.temp_at(trace, t0 + transit_min) if vehicle == "reefer" else cold_start_temp + M.warm_delta(transit_min)
            temp += M.warm_delta(m - LOADING_MIN - transit_min)
        temp = min(temp, M.AMBIENT_C)  # cargo can't get warmer than the surrounding air
        hum = M.PROFILES["fridge_humidity_pct"]["value"]
        for typ, a, b in events_in:
            if typ == "compressor":
                temp += _excess(a, b, m)
            elif typ == "door" and m >= a:
                d = M.door_delta(m - a)
                temp += d
                hum += d / max(M._DOOR) * M.DOOR_HUMIDITY_DELTA
        temp = min(temp, M.AMBIENT_C)
        shock_g = 0.0
        for i, (typ, a, _) in enumerate(shocks):
            if i not in shocks_done and a <= m:
                shocks_done.add(i)
                manual = i >= len(jolts)
                g = rng.choice(shock_peaks if manual else rough_peaks)
                shock_g = max(shock_g, g)
                events.append(_ev(depart, m, "shock", "critical" if g >= 2 else "warning",
                                  f"{'Hard shock' if manual else 'Rough-road jolt'} · {g:.2f} g peak",
                                  "Logged for inspection at arrival (no dataset links shocks to spoilage)"))
        if m > 0:
            # The label is the ceiling: it already assumes fridge temperature (4.4 °C) all the way, so a colder
            # trip earns no extra time (growth never runs slower than the label's pace); heat takes time away.
            tvc, _, extra = M.step(tvc, max(temp, M.REF_T), STEP_MIN / 60, product)
            extra_total += extra
        d = M.describe(tvc, temp, product)
        if temp > limit and not in_exc:
            in_exc, exc_start = True, m
        elif temp <= limit and in_exc:
            in_exc = False
            if m - exc_start >= 20:
                events.append(_ev(depart, exc_start, "excursion", "warning",
                                  f"Temperature above {limit} °C for {m - exc_start:.0f} min", _stage_label(stage)))
        if last_status and d["status"] != last_status and M.STAGES and _worse(d["status"], last_status):
            events.append(_ev(depart, m, "status", "critical" if d["status"] in ("critical", "spoiled") else "warning",
                              f"Freshness dropped to {d['status'].replace('_', ' ')}", f"{d['hours_left']:.0f} h left at {M.REF_T} °C"))
        last_status = d["status"]
        prog = min(1.0, max(0.0, (m - LOADING_MIN) / transit_min))
        lat = origin["lat"] + (warehouse["lat"] - origin["lat"]) * prog
        lng = origin["lng"] + (warehouse["lng"] - origin["lng"]) * prog
        timeline.append({
            "minute": round(m), "ts": (depart + timedelta(minutes=m)).strftime(TS), "stage": stage,
            "temp_c": round(temp, 2), "humidity": round(min(100, hum), 1), "shock_g": round(shock_g, 2),
            "tvc": round(tvc, 3), "freshness_score": d["freshness_score"], "hours_left": d["hours_left"],
            "status": d["status"], "progress": round(prog, 4), "lat": round(lat, 5), "lng": round(lng, 5),
        })
        m += STEP_MIN
    if in_exc and m - exc_start >= 20:
        events.append(_ev(depart, exc_start, "excursion", "warning", f"Temperature above {limit} °C at arrival", "Arrival dock"))
    for typ, a, b in events_in:
        if typ == "door":
            events.append(_ev(depart, a, "door", "warning", "Door opened", "Real fridge-door temperature spike"))
        elif typ == "compressor":
            events.append(_ev(depart, a, "compressor", "critical", f"Compressor failure for {b - a:.0f} min", "Cargo warms along the real warm-up curve"))
        elif typ == "dock":
            events.append(_ev(depart, a, "dock", "warning", f"Left on the arrival dock for {b - a:.0f} min", warehouse["name"]))
    events.append(_ev(depart, 0, "stage", "info", f"Loading at {origin['name']}", f"Tag starts sensing · label: {printed_days:g} days left"))
    events.append(_ev(depart, LOADING_MIN, "stage", "info", f"Departed on the highway · {dist:.0f} km", "Reefer truck" if vehicle == "reefer" else "Insulated van"))
    events.append(_ev(depart, LOADING_MIN + transit_min, "stage", "info", f"Arrived at {warehouse['name']}", "Matching outlets in the city"))
    events.sort(key=lambda e: e["minute"])

    final = timeline[-1]
    arrival = {
        **M.describe(tvc, M.REF_T, product),
        "tvc_start": round(tvc_start, 3),
        "extra_life_lost_h": round(extra_total, 1),
        "minutes_above_safe": sum(STEP_MIN for r in timeline if r["temp_c"] > limit),
        "shocks": len(shocks), "max_shock_g": max([r["shock_g"] for r in timeline] + [0]),
        "label_hours_left": round(printed_days * 24 - total_min / 60, 1),
        "hours_left_at_dispatch": M.describe(tvc_start, M.REF_T, product)["hours_left"],
        "label_capped_to_fresh": label_capped,
    }
    candidates, decision = _match(city, warehouse, product, arrival, planned)
    return {
        "shipment": {
            "product": product, "product_label": M.PRODUCTS[product]["label"], "emoji": M.PRODUCTS[product]["emoji"],
            "origin": origin, "city": {"id": city["id"], "name": city["name"]}, "warehouse": warehouse,
            "vehicle": vehicle, "distance_km": round(dist), "transit_h": round(transit_min / 60, 1),
            "total_h": round(total_min / 60, 1), "departed_at": timeline[0]["ts"], "arrived_at": final["ts"],
            "printed_expiry_days": printed_days,
            "temperature_source": f"real shipment trace {trace}" if vehicle == "reefer" else "real warm-up curve (no active cooling)",
            "safe_temp_c": limit, "reference_temp_c": M.REF_T, "thresholds_log_cfu": M.THRESHOLDS,
            "planned_outlet_id": planned,
        },
        "timeline": timeline, "events": events, "arrival": arrival,
        "candidates": candidates, "decision": decision,
    }


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
