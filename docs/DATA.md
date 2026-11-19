# Data and model: what is real, what is assumed

## Datasets (in `data/raw/`, included in the repo; sources, licences and citations in `data/raw/README.md`)
| Folder | Dataset | Used for |
|---|---|---|
| `beef_enose/` | [Wijaya et al. 2018, Mendeley mwmhh766fc](https://data.mendeley.com/datasets/mwmhh766fc): 5 series × 36 h, bacterial count (TVC) + 9 MQ gas sensors + temperature | growth rate vs temperature, gas model, test cases (TS5 held out) |
| `beef_12cuts/` | [Wijaya et al. 2020, Mendeley zm5yvskf5c](https://data.mendeley.com/datasets/zm5yvskf5c): 12 beef cuts × 37 h, TVC + 11 MQ sensors | stage thresholds, gas model, test cases (Striploin and Shin held out) |
| `beef_esp32/` | [ESP32 e-nose 2025, Mendeley n8mc3nspfn](https://data.mendeley.com/datasets/n8mc3nspfn): ESP32 + MQ sensors + DHT11 + TVC, 29 h | growth rate vs temperature, stage thresholds, gas model |
| `foodkeeper/` | USDA FSIS FoodKeeper ([data.gov](https://catalog.data.gov/dataset/fsis-foodkeeper-data); FSIS blocks automated download, so a GitHub copy of the same JSON is used) | relative perishability of chicken / curd-yogurt / bagged greens / strawberries vs beef |
| `strawberry/` | [Abdella, Brecht & Uysal 2021](https://arxiv.org/abs/2103.12895), strawberry cold-chain shipments S1–S6, 9 logger points each ([HF copy](https://huggingface.co/datasets/NifferLi/cold-chain-strawberry-sensors), CC BY 4.0) | 42 real truck / cold-room temperature traces, the real pre-cooling and warm-up curves, the benchmark |
| `zenodo_coldchain/` | [Zenodo 20540723](https://zenodo.org/records/20540723) (CC BY 4.0), DHT22 in a refrigerator + MPU6050 accelerometer | real door-opening temperature spike and humidity; real shock / rough-road peaks (`data/processed/vibration.json`) for shipment journeys |

Rebuild everything from raw data:
```bash
pip install -r backend/calibration/requirements-calibration.txt
python -I backend/calibration/build.py
```
This writes `backend/data/calibration.json`, `backend/models/gas_model.joblib`, `data/processed/*.json`, `backend/testcases/*.json` and two charts in `frontend/public/model/`.

## The model
1. **State = bacterial load** (TVC, log CFU/g), the quantity the labs measured.
2. **Quality stages** come from the labelled data: the median of each stage's lowest count gives **good ≥ 3.11, acceptable ≥ 4.05, spoiled ≥ 5.10**.
3. **Growth vs temperature:** the Ratkowsky square-root model, μ(T) = (b·(T − Tmin))².
   - *b* is fitted to the real spoilage curves that have measured temperature (TS1–TS4 + ESP32). It uses each curve's rate up to the "acceptable" threshold, because real curves are S-shaped and plateau.
   - *Tmin* = −8 °C is the **one literature constant** (the team chose this standard model).
   - Counts are capped at the highest count observed (6.31), which is the stationary phase.
4. **Products:** *b* is scaled by USDA FoodKeeper fridge shelf lives relative to beef.
   - Resulting shelf life from fresh at 4.4 °C: chicken 3.4 d, strawberries 5.6 d, greens 9.0 d, beef 9.0 d, dairy 23.5 d.
5. **Gas model:** a gradient-boosted regressor from 6 MQ sensors to TVC.
   - Features are each crate's readings relative to its own first 30 minutes, plus the 1-hour change.
   - It's used for meat only, since it was trained on beef.
6. **Fusion:** inverse-variance weights from leave-one-series-out errors: temperature model 0.35, gas 0.65.

## Results (all on data not used for fitting)
| Metric | Value |
|---|---|
| Gas model, leave-one-series-out | 0.65 log CFU/g error, 88% within one stage, 70% spoiled-vs-not |
| Fused, leave-one-series-out | 0.79 log CFU/g (temperature model alone 1.20 over the full curve incl. plateau) |
| Fully held-out TS5 | fused 0.35, gas 0.73, temperature model 1.19 log CFU/g |
| 12 held-out test cases | **12/12 pass, mean error 0.20 log CFU/g** |
| Benchmark on 42 real shipment traces (10,080 crates) | **27.9% fewer rejected deliveries, 29.9% less food wasted** vs FIFO |

**Disclosure:** the growth-rate fitting method was changed once, from a straight line over the whole curve to the rate up to the acceptable threshold, after the first held-out scorecard (4/12) showed that the plateau made the straight-line fit too slow. Nothing else was tuned on the held-out data.

## What is still an assumption (no public data exists)
`backend/data/assumptions.json`, `locations.json`, `trucks.json`, `network.json` (origin hubs, destination-city outlets, highway speed 45 km/h):
- Bengaluru locations, store demand, trucks and drivers (all labelled "demo").
- Hours a destination needs on arrival: restaurant 24 h, dark store 8 h, food bank 2 h.
- Truck speed (15 km/h), stop time, loading-dock dwell (20–60 min), crates per truck.
- Only dispatching stock still "excellent" or "good".
- Redirect scoring weights, and the trip lengths used in the benchmark.

A pilot replaces these with Hyperpure, Blinkit and Zomato data.

## Known limits
- The gas model is beef-only. It fails on the ESP32 dataset (different sensor scale) and on one cut (Clod/Chuck).
- Chicken, dairy, greens and strawberries use the beef growth law scaled by FoodKeeper. No microbial time series for them was available.
- The 12-cuts data has no temperature, so its test cases assume the other experiments' room temperature (33.8 °C).
- Shocks are logged but don't change freshness, because no dataset links shocks to spoilage.
