# Raw datasets

The original public files FreshSense is calibrated on, unchanged. They are redistributed here under their own licences, with attribution. Rebuild everything derived from them with:

```bash
pip install -r backend/calibration/requirements-calibration.txt
python -I backend/calibration/build.py
```

| Folder | Dataset | Source | Licence | Used for |
|---|---|---|---|---|
| `beef_enose/` | Electronic nose dataset for beef quality monitoring under an uncontrolled environment (Wijaya, Sarno, Zulaika). 5 series × 36 h: bacterial count (TVC), 9 MQ gas sensors, temperature, humidity | https://data.mendeley.com/datasets/mwmhh766fc (DOI 10.17632/mwmhh766fc.3) | CC BY 4.0 | Growth rate vs temperature, gas model, held-out test series TS5 |
| `beef_12cuts/` | Data for: Noise-resistant LSTM for electronic nose signal processing in beef quality monitoring (Wijaya et al.). 12 beef cuts × 37 h, TVC + 11 MQ sensors | https://data.mendeley.com/datasets/zm5yvskf5c | **CC BY-NC 3.0 (non-commercial only)** | Quality-stage thresholds, gas model, held-out test cuts (Striploin, Shin) |
| `beef_esp32/` | e-nose based Beef Quality Classification Dataset (4 classes). ESP32 + 8 MQ sensors + DHT11, TVC | https://data.mendeley.com/datasets/n8mc3nspfn | CC BY 4.0 | Growth rate vs temperature, stage thresholds, gas model |
| `foodkeeper/` | USDA FSIS FoodKeeper (fridge shelf life per food, days). This JSON is a community copy of the official file, because FSIS blocks automated downloads | Official: https://catalog.data.gov/dataset/fsis-foodkeeper-data · copy: github.com/josephb333/SmartPantry `data/foodkeeper.json` | Public domain (CC0) | Relative perishability of chicken, curd/yogurt, bagged greens and strawberries vs beef |
| `strawberry/` | A Time-Temperature Dataset for the Strawberry Cold Chain Across Multiple Shipments and Locations (Abdella, Brecht & Uysal, J. Food Engineering 2021). Shipments S1–S6, 9 pallet loggers each | Paper: https://arxiv.org/abs/2103.12895 · processed copy: https://huggingface.co/datasets/NifferLi/cold-chain-strawberry-sensors | CC BY 4.0 | 42 real reefer temperature traces, pre-cooling and warm-up curves, benchmark |
| `zenodo_coldchain/` | Cold Chain Monitoring Dataset: Temperature, Humidity and Vibration Data for TinyML Classification (Manzanares López-Ocaña, UPM 2025) | https://zenodo.org/records/20540723 | CC BY 4.0 | Door-opening temperature spike and fridge humidity; real shock and rough-road peaks |

## Citations
- Wijaya, D. R., Sarno, R., Zulaika, E. (2018). *Electronic nose dataset for beef quality monitoring in uncontrolled ambient conditions.* Data in Brief. Mendeley Data, doi:10.17632/mwmhh766fc.
- Wijaya, D. R. et al. (2020). *Noise-resistant long short-term memory for electronic nose signal processing in beef quality monitoring.* Mendeley Data, doi:10.17632/zm5yvskf5c.1.
- *e nose based Beef Quality Classification Dataset (4 classes)* (2025). Mendeley Data, doi:10.17632/n8mc3nspfn.1.
- *A Multi-Parameter Dataset for Machine Learning Based Fruit Spoilage Prediction in an IoT-Enabled Cold Storage System.* Mendeley Data, doi:10.17632/czz68d9fwj.1.
- Abdella, A., Brecht, J. K., Uysal, I. (2021). *A Time-Temperature Dataset for the Strawberry Cold Chain Across Multiple Shipments and Locations.* Journal of Food Engineering 298, 110477.
- Manzanares López-Ocaña, G., López Vargas, A. (2025). *Cold Chain Monitoring Dataset.* Zenodo, record 20540723.
- USDA Food Safety and Inspection Service. *FoodKeeper Data.* data.gov.

**Licence note:** `beef_12cuts/` is non-commercial (CC BY-NC 3.0). It's fine for this hackathon prototype. Any commercial use of FreshSense would need that dataset removed and the calibration rebuilt, or the authors' permission.
