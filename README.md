# Cloud Cost Explainer

Detects unusual spend in FOCUS-format cloud billing data and explains each anomaly in plain English: how much extra was spent, whether it came from more usage or a higher unit price, its share of the account's increase, the matching cost pattern, and what to check.

All data is synthetic ("Northwind Cloud Retail" is a made-up company).

## Run

Needs Python 3 with pandas, numpy, scipy, scikit-learn, matplotlib (and Node + `docx` for the report).

```
python3 generate_data.py     # data/focus_billing.csv, ground_truth.json, known_events.json
python3 engine.py            # detect + explain + evaluate -> data/results.json
python3 robustness.py        # 40 regenerated datasets -> data/robustness.json (~5 min)
python3 export_dashboard.py  # dashboard data files -> dash/
python3 figures.py           # report figures -> fig/
node build_report.js         # Word report -> out/
python3 build_sample.py      # sample bill for the website -> web/sample.json
```

### Website

`web/` is a static site with no build step. Serve the folder (for example `python3 -m http.server -d web`) and open it. It accepts FOCUS, AWS Cost and Usage Report, Azure and Google Cloud cost exports as .csv or .csv.gz, maps columns automatically, and never uploads the file anywhere.

## Files

| File | What it does |
|---|---|
| `generate_data.py` | Synthetic 6-month AWS bill, 22 service lines, 8 planted anomalies, 2 planned events. `generate(seed, scale)` |
| `engine.py` | Baseline, detection, event grouping, explanation, business calendar, evaluation vs 3 baselines |
| `playbook.py` | The 9 cost-anomaly patterns and the feature-matching used to pick one |
| `robustness.py` | Seeds 1–10 × anomaly size 25/50/75/100% |
| `web/` | Upload website: drop a billing CSV, analysed in the browser (engine.js is a port of engine.py) |
| `dashboard/` | Page code of the Claude Data dashboard (index.html + app.js, d3) |
| `docs/` | Project report (Word) |
| `build_report.js` | Builds the report from the result files |

## Main result (seed 42)

8/8 planted anomalies found, 2 false alarms (precision 0.80, recall 1.00, F1 0.89). Every detected anomaly got the right pattern and the right usage-vs-price label. Across 40 datasets, detection is on par with Isolation Forest given the same business calendar; the explanation layer is where the value is.
