"""Live shipments: a Trip that plays out in real time (sped up) and streams every tag reading over a WebSocket.

While the crate is on the road, incidents can be injected (door, compressor off/on, shock, dock) and after each
reading FreshSense re-plans: it projects the arrival from the current state and re-ranks every outlet in the
destination city. When the projected best outlet changes, the crate is re-routed while still on the highway.
"""
import asyncio
import math
import time
import uuid

from fastapi import WebSocket

import shipment as SH

TICK_S = 0.5            # wall-clock seconds between updates
KEEP_FINISHED_S = 900   # finished trips stay readable for 15 min
MAX_TRIPS = 12


class LiveTrip:
    def __init__(self, body: dict):
        self.trip = SH.Trip(body)
        self.id = uuid.uuid4().hex[:8]
        self.trip_seconds = min(300.0, max(15.0, float(body.get("trip_seconds") or 60)))
        self.steps_total = math.ceil(self.trip.total_min / SH.STEP_MIN) + 1
        self.speed = 4.0          # demo default: 4x (60 s trip_seconds at 1x -> ~15 s)
        self.paused = False
        self.acc = 0.0
        self.sockets: set[WebSocket] = set()
        self.sent_events = 0
        self.plan = None          # (decision, location_id) currently booked
        self.replans = 0
        self.forecast = None
        self.final = None
        self.finished_at = None
        self.task: asyncio.Task | None = None
        self.trip.step()          # reading at minute 0
        self._replan()

    # ------------------------------------------------------------------ state
    def state(self):
        t = self.trip
        return {"id": self.id, "paused": self.paused, "speed": self.speed, "done": self.final is not None,
                "minute": t.timeline[-1]["minute"], "stage": t.timeline[-1]["stage"],
                "total_min": round(t.total_min), "arrival_min": round(t.arrive_min),
                "compressor_off": t.compressor_off, "on_dock": t.m >= t.arrive_min,
                "dock_used": any(e[0] == "dock" for e in t.events_in), "replans": self.replans}

    def snapshot(self):
        """Everything so far (first message on connect, and the polling fallback)."""
        return {"type": "snapshot", "id": self.id, "shipment": self.trip.meta(), "rows": self.trip.timeline,
                "events": sorted(self.trip.events, key=lambda e: e["minute"]), "forecast": self.forecast,
                "state": self.state(), "result": self.final}

    # ------------------------------------------------------------------ re-planning
    def _replan(self, minute=None):
        f = self.trip.forecast()
        d = f["decision"]
        new = (d["decision"], d["location"]["location_id"] if d["location"] else None)
        if self.plan is not None and new != self.plan:
            self.replans += 1
            old_name = self._name(self.plan[1])
            new_name = d["location"]["name"].replace(" (demo)", "") if d["location"] else "discard"
            sev = "critical" if d["decision"] in ("DONATE", "DISCARD") else "warning" if d["decision"] == "REDIRECT" else "info"
            minute = self.trip.timeline[-1]["minute"] if minute is None else minute
            where = "on the highway" if self.trip.stage_at(minute) == "highway" else "before unloading"
            self.trip.events.append(self.trip._ev(
                minute, "replan", sev,
                f"Re-routed {where}: {old_name} → {new_name}",
                f"Projected {f['arrival']['hours_left']:.0f} h on arrival · {d['decision']}"))
        self.plan = new
        self.forecast = f

    def _name(self, lid):
        if lid is None:
            return "discard"
        return next((l["name"].replace(" (demo)", "") for l in self.trip.city["locations"] if l["id"] == lid), lid)

    # ------------------------------------------------------------------ messages
    def _new_events(self):
        ev = self.trip.events[self.sent_events:]
        self.sent_events = len(self.trip.events)
        return ev

    def tick_message(self, rows):
        return {"type": "tick", "rows": rows, "events": self._new_events(), "forecast": self.forecast,
                "state": self.state(), "shipment": self.trip.meta()}

    async def broadcast(self, msg):
        dead = []
        for ws in list(self.sockets):
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.sockets.discard(ws)

    # ------------------------------------------------------------------ controls (called from the API)
    async def inject(self, typ, minutes=None):
        self.trip.inject(typ, minutes)
        self._replan(self.trip.m)
        await self.broadcast(self.tick_message([]))

    async def fix(self):
        self.trip.fix_compressor()
        self._replan(self.trip.m)
        await self.broadcast(self.tick_message([]))

    async def control(self, paused=None, speed=None):
        if paused is not None:
            self.paused = bool(paused)
        if speed is not None:
            if speed not in (0.5, 1, 2, 4):
                raise SH.ShipmentError("speed must be 0.5, 1, 2 or 4")
            self.speed = float(speed)
        await self.broadcast({"type": "state", "state": self.state()})

    # ------------------------------------------------------------------ loop
    async def run(self):
        self.sent_events = 0
        while not self.trip.done:
            await asyncio.sleep(TICK_S)
            if self.paused:
                continue
            self.acc += self.steps_total / (self.trip_seconds / TICK_S) * self.speed
            n, self.acc = int(self.acc), self.acc - int(self.acc)
            rows = []
            for _ in range(n):
                if self.trip.done:
                    break
                rows.append(self.trip.step())
            if rows:
                self._replan()
                await self.broadcast(self.tick_message(rows))
        self.final = self.trip.result()
        self.finished_at = time.time()
        await self.broadcast({"type": "done", "result": self.final, "events": self._new_events(), "state": self.state()})


TRIPS: dict[str, LiveTrip] = {}


def _cleanup():
    now = time.time()
    for k, lt in list(TRIPS.items()):
        if lt.finished_at and now - lt.finished_at > KEEP_FINISHED_S:
            del TRIPS[k]
    while len(TRIPS) >= MAX_TRIPS:  # drop the oldest
        k = next(iter(TRIPS))
        if TRIPS[k].task:
            TRIPS[k].task.cancel()
        del TRIPS[k]


def start(body: dict) -> LiveTrip:
    _cleanup()
    lt = LiveTrip(body)
    TRIPS[lt.id] = lt
    lt.task = asyncio.create_task(lt.run())
    return lt


def get(trip_id: str) -> LiveTrip | None:
    return TRIPS.get(trip_id)
