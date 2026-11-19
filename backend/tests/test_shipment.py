import pytest

import shipment as S


def base(**kw):
    p = {"product": "strawberries", "origin_id": "ORG-MBW", "destination_city": "BLR", "vehicle": "reefer",
         "printed_expiry_days": 3}
    p.update(kw)
    return p


def test_options_cover_products_origins_cities():
    o = S.options()
    assert {"chicken", "dairy", "greens", "strawberries"} <= set(o["products"])
    assert len(o["origins"]) >= 5 and len(o["cities"]) == 4
    assert all(c["outlets"] for c in o["cities"])


def test_clean_reefer_trip_is_assigned_to_an_accepting_outlet():
    r = S.simulate(base())
    assert r["timeline"][0]["stage"] == "origin_loading" and r["timeline"][-1]["stage"] == "arrival_dock"
    assert r["arrival"]["status"] in ("fresh", "watch")
    assert r["decision"]["decision"] == "ASSIGN"
    chosen = [c for c in r["candidates"] if c["chosen"]]
    assert len(chosen) == 1 and chosen[0]["accepts"]
    assert r["decision"]["accepting"] >= 10


def test_deterministic_for_same_input():
    assert S.simulate(base())["arrival"] == S.simulate(base())["arrival"]


CHICKEN = dict(product="chicken", origin_id="ORG-NMK", destination_city="BLR", vehicle="reefer",
               planned_outlet_id="R-06")
COMPRESSOR = {"type": "compressor", "at_h": 2, "minutes": 300}


def test_disruptions_cost_shelf_life():
    clean = S.simulate(base())
    bad = S.simulate(base(incidents=[COMPRESSOR, {"type": "dock", "minutes": 90}]))
    assert bad["arrival"]["hours_left"] < clean["arrival"]["hours_left"] - 10
    assert bad["arrival"]["extra_life_lost_h"] > clean["arrival"]["extra_life_lost_h"]
    assert any(e["type"] == "compressor" for e in bad["events"])


def test_label_expiry_drives_acceptance():
    """Fewer days on the label -> fewer outlets can accept, down to food banks only."""
    counts = [S.simulate({**CHICKEN, "planned_outlet_id": None, "printed_expiry_days": d})["decision"]["accepting"]
              for d in (3, 1, 0.5)]
    assert counts[0] > counts[1] > counts[2] > 0


def test_demo_presets():
    redirect = S.simulate({**CHICKEN, "printed_expiry_days": 1.5, "incidents": [COMPRESSOR]})
    assert redirect["decision"]["decision"] == "REDIRECT"
    assert redirect["decision"]["location"]["type"] == "dark_store"
    donate = S.simulate({**CHICKEN, "printed_expiry_days": 1.5, "incidents": [COMPRESSOR, {"type": "dock", "minutes": 180}]})
    assert donate["decision"]["decision"] == "DONATE"
    spoiled = S.simulate({**CHICKEN, "printed_expiry_days": 3, "vehicle": "insulated",
                          "incidents": [{"type": "compressor", "at_h": 0.5, "minutes": 480}, {"type": "dock", "minutes": 480}]})
    assert spoiled["decision"]["decision"] == "DISCARD" and spoiled["decision"]["accepting"] == 0


def test_planned_outlet_kept_or_redirected():
    ok = S.simulate({**CHICKEN, "printed_expiry_days": 3})
    assert ok["decision"]["decision"] == "DELIVER"


def test_cargo_never_hotter_than_ambient():
    r = S.simulate({**CHICKEN, "printed_expiry_days": 3, "vehicle": "insulated",
                    "incidents": [COMPRESSOR, {"type": "door", "at_h": 3}, {"type": "dock", "minutes": 480}]})
    assert max(x["temp_c"] for x in r["timeline"]) <= 34


def test_insulated_van_warms_more_than_reefer():
    reefer = S.simulate(base(product="chicken", origin_id="ORG-NMK", destination_city="CHE"))
    van = S.simulate(base(product="chicken", origin_id="ORG-NMK", destination_city="CHE", vehicle="insulated"))
    assert van["arrival"]["minutes_above_safe"] > reefer["arrival"]["minutes_above_safe"]
    assert van["arrival"]["hours_left"] < reefer["arrival"]["hours_left"]


def test_label_vs_real():
    r = S.simulate(base(printed_expiry_days=3))
    assert r["arrival"]["label_hours_left"] == pytest.approx(3 * 24 - r["shipment"]["total_h"], abs=0.2)
    assert r["arrival"]["hours_left_at_dispatch"] == pytest.approx(72, abs=0.5)


def test_bad_input():
    with pytest.raises(S.ShipmentError):
        S.simulate(base(product="pizza"))
    with pytest.raises(S.ShipmentError):
        S.simulate(base(destination_city="XXX"))
    with pytest.raises(S.ShipmentError):
        S.simulate(base(incidents=[{"type": "alien"}]))
    with pytest.raises(S.ShipmentError):
        S.simulate(base(printed_expiry_days=0))


@pytest.mark.parametrize("product,vehicle,days", [("dairy", "reefer", 3), ("strawberries", "reefer", 2),
                                                  ("greens", "insulated", 7), ("chicken", "reefer", 1)])
def test_never_more_than_the_label(product, vehicle, days):
    """The printed label is the maximum; a cold trip can't add time, heat can only take it away."""
    clean = S.simulate(base(product=product, vehicle=vehicle, printed_expiry_days=days))
    a = clean["arrival"]
    assert a["hours_left"] <= max(0, a["label_hours_left"]) + 0.2
    hot = S.simulate(base(product=product, vehicle=vehicle, printed_expiry_days=days,
                          incidents=[{"type": "compressor", "at_h": 1, "minutes": 240}]))
    assert hot["arrival"]["hours_left"] <= a["hours_left"]
