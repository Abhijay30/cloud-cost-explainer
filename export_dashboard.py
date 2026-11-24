"""Write the dashboard's data files ({rows, meta} JSON) from data/results.json and data/robustness.json."""
import json
import os

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "dash")
os.makedirs(OUT, exist_ok=True)
R = json.load(open(os.path.join(HERE, "data", "results.json")))
ROB = json.load(open(os.path.join(HERE, "data", "robustness.json")))
truth = R["truth"]


def code(name):
    return {"label": name, "value": open(os.path.join(HERE, name)).read(), "type": "code", "lang": "python"}


def dump(name, rows, meta):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump({"rows": rows, "meta": meta}, f, separators=(",", ":"))
    print(name, len(rows), "rows", os.path.getsize(os.path.join(OUT, name)) // 1024, "KB")


def truth_for(e):
    for t in truth:
        if (t["account"], t["service"], t["region"], t["usage_type"]) != (e["account"], e["service"], e["region"], e["usage_type"]):
            continue
        ts, te = pd.Timestamp(t["start"]), pd.Timestamp(t["end"])
        if pd.Timestamp(e["start"]) <= te + pd.Timedelta(days=1) and pd.Timestamp(e["end"]) >= ts - pd.Timedelta(days=1):
            return t
    return None


# 1. daily spend by account ---------------------------------------------------------------------
daily = []
accts = list(R["by_account"].keys())
for i, d in enumerate(R["dates"]):
    row = {"date": d, "total": R["daily_total"][i]}
    for a in accts:
        row[a] = R["by_account"][a][i]
    daily.append(row)
dump("daily_spend.json", daily, [code("generate_data.py"), {"label": "Input", "value": "generate_data.py (seed 42) -> focus_billing.csv, Usage rows summed by day and SubAccountName"}])

# 2. spend by service ---------------------------------------------------------------------------
svc = [{"service": k, "cost": round(sum(v), 2)} for k, v in R["by_service"].items()]
svc.sort(key=lambda r: -r["cost"])
dump("service_spend.json", svc, [{"label": "Input", "value": "focus_billing.csv, Usage rows, EffectiveCost summed by ServiceName over Apr-Sep 2026"}])

# 3. anomalies found ----------------------------------------------------------------------------
events = []
for i, e in enumerate(R["events"]):
    t = truth_for(e)
    if e["status"] == "expected":
        verdict = "Expected (business calendar)"
    elif t:
        verdict = f"Correct: planted {t['id']}"
    else:
        verdict = "False alarm"
    events.append(
        {
            "id": f"X{i + 1:02d}",
            "start": e["start"],
            "end": e["end"],
            "days": e["days"],
            "status": e["status"],
            "severity": e["severity"],
            "account": e["account"],
            "service": e["service"],
            "region": e["region"],
            "usage_type": e["usage_type"],
            "team": e["team"],
            "excess_cost": e["excess_cost"],
            "usual_per_day": e["usual_per_day"],
            "actual_per_day": e["actual_per_day"],
            "peak_multiple": e["peak_multiple"],
            "volume_effect": e["volume_effect"],
            "rate_effect": e["rate_effect"],
            "effect": e["effect"],
            "shape": e["shape"],
            "pattern_id": e["pattern"]["id"],
            "pattern": e["pattern"]["name"],
            "match_reasons": "; ".join(e["pattern"]["reasons"]),
            "explanation": e["explanation"],
            "checks": " | ".join(e["checks"]),
            "series_id": e["series_id"],
            "verdict": verdict,
            "true_cause": t["true_cause"] if t else "",
        }
    )
dump("anomalies.json", events, [code("engine.py"), code("playbook.py"), {"label": "Input", "value": "focus_billing.csv, known_events.json, ground_truth.json (seed 42)"}])

# 4. series behind each anomaly -----------------------------------------------------------------
series = []
for sid, s in R["series"].items():
    for i, d in enumerate(R["dates"]):
        series.append({"series_id": sid, "date": d, "cost": s["cost"][i], "baseline": s["baseline"][i]})
dump("anomaly_series.json", series, [{"label": "Input", "value": "engine.py detect_series(): daily EffectiveCost and its weekday-aware trailing-median baseline"}])

# 5. evaluation on the main dataset ---------------------------------------------------------------
ev = []
for r in R["evaluation"]:
    ev.append({k: r[k] for k in ("method", "alerts", "true_alerts", "false_alerts", "precision", "recall", "f1", "mean_delay_days")} | {"missed": ", ".join(r["missed"]) or "none"})
dump("evaluation.json", ev, [code("engine.py"), {"label": "Ground truth", "value": "8 planted anomalies A1-A8 in ground_truth.json; 2 business events in known_events.json"}])

# 6. robustness sweep -----------------------------------------------------------------------------
rob = []
for scale, methods in ROB["summary"].items():
    for m, v in methods.items():
        if m.startswith("_"):
            continue
        rob.append({"anomaly_size_pct": int(float(scale) * 100), "method": m, **v})
dump("robustness.json", rob, [code("robustness.py"), {"label": "Input", "value": "10 noise seeds x anomaly size 25/50/75/100% = 40 regenerated datasets"}])
