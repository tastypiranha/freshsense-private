"""Live shipments: step-by-step Trip, mid-trip incidents, en-route re-planning, and the live API."""
import pytest
from fastapi.testclient import TestClient

import shipment as S

BOOKED = dict(product="chicken", origin_id="ORG-NMK", destination_city="BLR", vehicle="reefer",
              printed_expiry_days=1.5, planned_outlet_id="R-06")


def run_to(trip, minute):
    while trip.m <= minute and not trip.done:
        trip.step()


def test_stepping_matches_instant_result():
    trip = S.Trip(BOOKED)
    while not trip.done:
        trip.step()
    assert trip.result()["arrival"] == S.simulate(BOOKED)["arrival"]


def test_forecast_does_not_change_the_trip():
    trip = S.Trip(BOOKED)
    run_to(trip, 60)
    before = (trip.m, trip.tvc, len(trip.timeline))
    f = trip.forecast()
    assert (trip.m, trip.tvc, len(trip.timeline)) == before
    assert f["decision"]["decision"] == "DELIVER"


def test_compressor_failure_mid_trip_reroutes_then_repair_recovers():
    trip = S.Trip(BOOKED)
    run_to(trip, 60)
    trip.inject("compressor")
    assert trip.compressor_off
    assert trip.forecast()["decision"]["decision"] == "REDIRECT"  # stays off -> can't make a restaurant
    run_to(trip, 80)
    trip.fix_compressor()
    assert not trip.compressor_off
    assert trip.forecast()["decision"]["decision"] == "DELIVER"   # quick repair -> back on plan


def test_dock_extends_trip_and_can_force_donation():
    trip = S.Trip(BOOKED)
    run_to(trip, 60)
    total = trip.total_min
    trip.inject("compressor")
    trip.inject("dock", 120)
    assert trip.total_min == total + 120
    assert trip.forecast()["decision"]["decision"] == "DONATE"
    with pytest.raises(S.ShipmentError):
        trip.inject("dock", 60)


def test_live_incident_rules():
    trip = S.Trip(BOOKED)
    with pytest.raises(S.ShipmentError):
        trip.fix_compressor()          # nothing to repair
    trip.inject("compressor")
    with pytest.raises(S.ShipmentError):
        trip.inject("compressor")      # already off
    with pytest.raises(S.ShipmentError):
        trip.inject("alien")
    while not trip.done:
        trip.step()
    with pytest.raises(S.ShipmentError):
        trip.inject("door")            # finished


def test_live_api_start_incident_and_errors():
    import main
    with TestClient(main.app) as c:
        snap = c.post("/api/live/start", json={**BOOKED, "trip_seconds": 300}).json()
        tid = snap["id"]
        assert snap["type"] == "snapshot" and len(snap["rows"]) == 1
        assert snap["forecast"]["decision"]["decision"] == "DELIVER"
        assert c.post(f"/api/live/{tid}/incident", json={"type": "compressor"}).status_code == 200
        s = c.get(f"/api/live/{tid}").json()
        assert s["state"]["compressor_off"] and s["forecast"]["decision"]["decision"] == "REDIRECT"
        assert any(e["type"] == "replan" for e in s["events"])
        assert c.post(f"/api/live/{tid}/fix").status_code == 200
        assert c.post(f"/api/live/{tid}/control", json={"speed": 3}).status_code == 400
        assert c.post(f"/api/live/{tid}/control", json={"paused": True, "speed": 2}).json()["ok"]
        assert c.get("/api/live/nope").status_code == 404
        assert c.post("/api/live/start", json={**BOOKED, "product": "pizza"}).status_code == 400
        with c.websocket_connect(f"/ws/live/{tid}") as ws:
            assert ws.receive_json()["type"] == "snapshot"
