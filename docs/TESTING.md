# Testing FreshSense — inputs and expected outputs

There are three ways to test, from quickest to most thorough.

## 1. Held-out real lab cases (ground truth)
Real beef spoilage experiments that were **never used for fitting**: series TS5 (Wijaya 2018), and cuts 6.Striploin and 11.Shin (Wijaya 2020). Each case gives the model the first 6, 15, 24 or 30 hours of real readings (temperature + 6 gas sensors). It must predict the bacterial count the lab actually measured at that moment.

```bash
cd backend && python run_testcases.py              # scorecard for all 12 cases
cd backend && python run_testcases.py TS5_t15h     # one case: full input and output
```
In the dashboard, open **🧪 Test Lab** and click **▶ Run all**, or **Load** a case and then **Predict freshness**.

**Pass rule:** the error is ≤ 0.6 log CFU/g **and** the quality stage is the same or a neighbouring stage. Current result: **12/12 pass, mean error 0.20 log CFU/g.**
The case files are in `backend/testcases/*.json`: `input` is exactly what is sent to the API, and `expected` holds the lab values.

## 2. The prediction API with your own readings
`POST http://localhost:8000/api/predict`

**Input**
```json
{
  "product": "chicken",                      // beef | chicken | dairy | greens | strawberries
  "initial_tvc": 2.3,                        // optional, log CFU/g at packing (default: median measured = 1.88)
  "readings": [                              // any spacing; resampled to 1 minute
    {"minute": 0,   "temp_c": 2.0},
    {"minute": 360, "temp_c": 15.0, "humidity": 70},
    {"minute": 720, "temp_c": 2.0,
     "gas": {"MQ2": 16.5, "MQ3": 24.1, "MQ4": 12.3, "MQ5": 9.0, "MQ135": 17.9, "MQ136": 15.6}}   // optional, meat only, every reading, >= 30 min
  ],
  "location": {"lat": 13.0707, "lng": 77.7982},   // optional: where the crate is now
  "destination_id": "R-06"                        // optional: planned stop -> routing recommendation
}
```

**Output** (main fields)
| Field | Meaning |
|---|---|
| `tvc_estimate_log_cfu` | Estimated bacterial load now (temperature model fused with gas sensors when available) |
| `tvc_kinetic_log_cfu`, `tvc_gas_log_cfu` | The two estimates before fusion |
| `quality_stage` | excellent / good / acceptable / spoiled, using thresholds from labelled lab data (3.11 / 4.05 / 5.10) |
| `status` | fresh / watch / at_risk / critical / spoiled (the dashboard colours) |
| `freshness_score` | 0–100 |
| `hours_left_at_reference_temp` | Hours until spoiled if kept at 4.4 °C (the USDA fridge limit) |
| `hours_left_if_temperature_stays` | Hours until spoiled if it stays at its last temperature |
| `minutes_above_safe_temp`, `extra_life_lost_to_heat_h` | How much temperature abuse it has had |
| `recommendation` | KEEP / REDIRECT / DONATE / DISCARD plus a place and the reason (only when `location` and `destination_id` are sent) |
| `notes` | Warnings, e.g. gas readings ignored for a non-meat product |

**Ready-made inputs** are in `backend/examples/`. Run one with:
```bash
curl -s -X POST localhost:8000/api/predict -H 'content-type: application/json' -d @backend/examples/B_chicken_24h_with_6h_at_15C.json
```

**Expected outputs** (current calibration):

| Example file | What it is | bacteria (log) | stage | status | hours left @4.4 °C | if temp stays | min above 4.4 °C | extra life lost | recommendation |
|---|---|---|---|---|---|---|---|---|---|
| `A_chicken_cold_24h` | chicken, 24 h at 2 °C | 2.50 | excellent | fresh | 65.0 | 99.9 | 0 | 0.0 h | – |
| `B_chicken_24h_with_6h_at_15C` | same, but 6 h at 15 °C | 3.16 | good | watch | 48.6 | 74.8 | 397 | 14.0 h | – |
| `C_chicken_24h_at_room_temp_30C` | chicken left at 30 °C for a day | 6.31 (plateau) | spoiled | spoiled | 0 | 0 | 1440 | 201.4 h | – |
| `D_strawberries_48h_at_1C` | strawberries, 2 days at 1 °C | 2.49 | excellent | fresh | 109.0 | 207.0 | 0 | 0.0 h | – |
| `E_dairy_7days_at_4C` | curd/yogurt, a week at 4 °C | 2.78 | excellent | fresh | 406.9 | 434.5 | 0 | 0.0 h | – |
| `F_chicken_old_stock_to_Rajajinagar` | old chicken (start load 4.3) heading to a restaurant from Hoskote | 4.33 | acceptable | at_risk | 19.2 | 24.4 | 0 | 0.0 h | **REDIRECT → DS-04** (Blinkit Whitefield) |

What you should see when you change inputs:
- **Warmer or longer** → higher bacteria, fewer hours left, more extra life lost.
- **Same total time, one warm spell** → worse than all-cold (compare A and B).
- **Product order** at the same conditions: chicken spoils fastest, then strawberries, then greens ≈ beef, and dairy slowest. This follows USDA FoodKeeper.
- **Hours left below what the planned stop needs** (restaurant 24 h, dark store 8 h, food bank 2 h, on arrival) → REDIRECT or DONATE.

## 3. Shipment journeys
`POST http://localhost:8000/api/shipments/simulate` (the **Shipment** page uses this). Options for the form: `GET /api/shipments/options`.

**Input**
```json
{
  "product": "chicken",                 // beef | chicken | dairy | greens | strawberries
  "printed_expiry_days": 1.5,           // label: days of shelf life left at dispatch (sets the starting freshness)
  "origin_id": "ORG-NMK",               // see /api/shipments/options → origins
  "destination_city": "BLR",            // BLR | MUM | HYD | CHE
  "vehicle": "reefer",                  // reefer (real shipment trace) | insulated (real warm-up curve)
  "planned_outlet_id": "R-06",          // optional: otherwise FreshSense assigns the best outlet
  "incidents": [                        // optional
    {"type": "compressor", "at_h": 2, "minutes": 300},
    {"type": "door", "at_h": 5},
    {"type": "shock", "at_h": 7},
    {"type": "dock", "minutes": 90}
  ]
}
```
The label sets where the crate starts (N days left at fridge temperature). The tag then measures what the trip did to it. If the trip was colder than the label assumes, the crate can end up with *more* time than the label; heat makes it less. The cargo is never warmer than the measured ambient (33.8 °C).

**Output:** `arrival` (status, hours left vs `label_hours_left`), `candidates` (every outlet in the city: travel, hours on arrival, the minimum it needs, accepts or rejects) and `decision` (DELIVER / ASSIGN / REDIRECT / DONATE / DISCARD plus the reason), plus `timeline` and `events` for the chart and the event list.

**Expected results** (Shipment page presets; locked in `backend/tests/test_shipment.py`):

| Preset | Input | Expected |
|---|---|---|
| Clean run | strawberries, label 3 days, ORG-MBW → BLR, reefer | **ASSIGN**, 20/20 outlets accept |
| Compressor fails | chicken, label 1.5 days, ORG-NMK → BLR, reefer, planned R-06, compressor at 2 h for 300 min | **REDIRECT** to a Blinkit dark store, 10/20 accept (restaurants need 24 h; it arrives with ~22 h) |
| Too late to sell | the same, plus 180 min on the arrival dock | **DONATE** to a Feeding India partner (only food banks accept) |
| Spoiled | chicken, label 3 days, insulated van, 480 min compressor + 480 min dock | **DISCARD**, 0/20 accept |

A quick sweep to try yourself (chicken, ORG-NMK → BLR, reefer, no incidents): label 3 days → 20/20 accept · 1 day → 10/20 (restaurants drop out) · 0.5 day → 2/20 (food banks only).

## 4. The live simulation
Dashboard → **🔄 Reset demo** → **▶ Resume** → set **5 min/tick** → choose the most urgent crate's truck → **❄️ Compressor fail**.
- **Expected:** the cargo warms along the real warm-up curve (about +6 °C in 30 min, levelling off near +11 °C). Hours left fall faster. Within about 20–30 s the most urgent crate is **rerouted** (see Dispatch). It's also the crate the control panel selects by default.
- **🔥 Leave out of cold** (choose 2–8 h) does the same for a single crate.
- **🚪 Open door** gives a short spike (the real fridge-door curve, +6 °C, decaying over about an hour). It usually isn't enough to force a redirect, which is realistic.

## Automated tests
```bash
cd backend && python -m pytest -q      # 29 tests: calibration, model physics, redirect rules, shipments, API contract, held-out cases
```
