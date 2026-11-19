# FreshSense

**Per-crate freshness intelligence for the Eternal cold chain, calibrated on real data.**
A tag on every crate senses temperature, humidity and spoilage gases. FreshSense estimates each crate's **bacterial load and hours of shelf life left**, keeps its **full journey history**, and when a crate can't reach its destination fresh enough, **redirects it on a live map** to the best place in the Eternal network: a Blinkit dark store, a nearer Zomato restaurant, or a Feeding India partner.

Built for the Eternal hackathon, track *Reducing Food Wastage through Data & Analytics*.

## Results on real data
| | |
|---|---|
| Held-out lab test cases (beef never used for fitting) | **12/12 pass, mean error 0.20 log CFU/g** |
| Gas model (6 MQ sensors → bacterial load), unseen series | 0.65 log CFU/g error, 88% within one quality stage |
| FIFO vs FreshSense on 42 real cold-chain shipment traces | see `backend/data/benchmark_results.json` (≈28% fewer rejections, ≈30% less waste) |

Details, datasets, the one literature constant and every remaining assumption: **[docs/DATA.md](docs/DATA.md)**.
How to test, with inputs and expected outputs: **[docs/TESTING.md](docs/TESTING.md)**.

## Run it
**Backend** (Python 3.11+):
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
FRESHSENSE_MQTT_TOPIC="freshsense/<TEAMCODE>/tag/C-001" uvicorn main:app --port 8000
```
**Dashboard** (Node 20+), in a second terminal:
```bash
cd frontend && npm install && npm run dev
```
Open http://localhost:5173. The **Shipment** page opens first:
1. Pick a demo preset (**Clean run**, **Compressor fails**, **Too late to sell**) or fill in the form: product, packed hours ago, printed expiry, origin hub, destination city, vehicle, disruptions.
2. Click **Dispatch shipment**. The tag's readings play back (temperature from a real reefer shipment, real door/warm-up curves, real accelerometer shocks).
3. On arrival you see the **printed label vs real shelf life**, and every restaurant, dark store and food bank in the city marked accepts/rejects. The crate is routed to the best one.

The live fleet simulation is still under **Overview / Crates / Dispatch** (Resume, then trigger incidents from the bottom dock). **Test lab** runs the held-out cases or your own readings.

**Tests:** `cd backend && python -m pytest -q` · **Scorecard:** `cd backend && python run_testcases.py`
**Rebuild the model from raw data:** see [docs/DATA.md](docs/DATA.md) (`python -I backend/calibration/build.py`).
**Virtual tag:** `firmware/wokwi/README.md`.

## Repo
| Folder | What |
|---|---|
| `backend/calibration/` | raw public datasets → fitted parameters, gas model, replay traces, test cases |
| `backend/` | FastAPI: calibrated freshness model, gas fusion, shipment journeys (`shipment.py`), data-driven fleet simulator, redirect rules, prediction API, analytics |
| `backend/testcases/`, `backend/examples/` | held-out real cases + example inputs with documented outputs |
| `data/processed/` | real temperature traces, event curves and e-nose replay library (generated) |
| `frontend/` | React + TypeScript dashboard (team's Figma design): Shipment journey, fleet simulation, analytics, Test lab |
| `firmware/wokwi/` | ESP32 tag firmware + Wokwi circuit |
| `pitch/` | demo scripts, Q&A sheet, QA checklist |
| `docs/` | DATA.md (datasets and calibration), TESTING.md (inputs and expected outputs) |

**Pitch deck:** https://claude.ai/artifact/Topph2cTRBxW16DvgFd4yV (private until shared from its Share menu)

Datasets: see docs/DATA.md (CC BY 4.0 / public domain).

## Team
_Add names here._
