"""
Robustness sweep: re-generate the dataset with 10 different noise seeds and with the planted
anomalies shrunk to 25%, 50%, 75% and 100% of their documented size, then re-run every detector.
This guards against the result being an artefact of one lucky dataset.
Writes data/robustness.json.
"""
import json
import os

import numpy as np

import engine
import generate_data as gen

SEEDS = list(range(1, 11))
SCALES = [0.25, 0.5, 0.75, 1.0]

rows = []
pattern_hits = []
for scale in SCALES:
    for seed in SEEDS:
        df, truth, events = gen.generate(seed=seed, scale=scale, write=False)
        res, ours = engine.run(df, truth, events, full=False)
        for r in res:
            rows.append({"scale": scale, "seed": seed, "method": r["method"], "precision": r["precision"],
                         "recall": r["recall"], "f1": r["f1"], "alerts": r["alerts"], "false_alerts": r["false_alerts"],
                         "missed": r["missed"]})
        # explanation accuracy for detected anomalies
        for tid, m in res[0]["_matched"].items():
            ev = m["event"]
            pattern_hits.append({"scale": scale, "seed": seed, "truth": tid,
                                 "pattern_ok": ev["pattern"]["id"] == engine.EXPECTED_PATTERN[tid],
                                 "effect_ok": ev["effect"] == engine.EXPECTED_EFFECT.get(tid, "volume")})
        print(f"scale={scale} seed={seed} done", flush=True)

summary = {}
for scale in SCALES:
    for method in dict.fromkeys(r["method"] for r in rows):
        sel = [r for r in rows if r["scale"] == scale and r["method"] == method]
        summary.setdefault(str(scale), {})[method] = {
            "precision_mean": round(float(np.mean([r["precision"] for r in sel])), 3),
            "precision_sd": round(float(np.std([r["precision"] for r in sel])), 3),
            "recall_mean": round(float(np.mean([r["recall"] for r in sel])), 3),
            "recall_sd": round(float(np.std([r["recall"] for r in sel])), 3),
            "f1_mean": round(float(np.mean([r["f1"] for r in sel])), 3),
            "f1_sd": round(float(np.std([r["f1"] for r in sel])), 3),
            "false_alerts_mean": round(float(np.mean([r["false_alerts"] for r in sel])), 2),
        }
    ph = [p for p in pattern_hits if p["scale"] == scale]
    summary[str(scale)]["_explanation"] = {
        "detected": len(ph),
        "pattern_accuracy": round(float(np.mean([p["pattern_ok"] for p in ph])), 3) if ph else None,
        "effect_accuracy": round(float(np.mean([p["effect_ok"] for p in ph])), 3) if ph else None,
    }

# which anomalies get missed most, for our method
miss_counts = {}
for r in rows:
    if r["method"].startswith("Explainer (with"):
        for m in r["missed"]:
            miss_counts.setdefault(str(r["scale"]), {}).setdefault(m, 0)
            miss_counts[str(r["scale"])][m] += 1

json.dump({"seeds": SEEDS, "scales": SCALES, "summary": summary, "miss_counts": miss_counts, "runs": rows},
          open(os.path.join(engine.DATA, "robustness.json"), "w"), indent=1)

for scale in SCALES:
    print(f"\n== anomaly size {int(scale*100)}% ==")
    for method, v in summary[str(scale)].items():
        if method.startswith("_"):
            print(f"  explanation: {v}")
            continue
        print(f"  {method:40} P={v['precision_mean']:.2f}±{v['precision_sd']:.2f} R={v['recall_mean']:.2f}±{v['recall_sd']:.2f} "
              f"F1={v['f1_mean']:.2f}±{v['f1_sd']:.2f} FP={v['false_alerts_mean']}")
print("\nmisses (ours):", miss_counts)
