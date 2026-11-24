"""
Cloud Cost Explainer engine.

Pipeline
  1. Load FOCUS billing rows, keep Usage charges, build one daily series per
     (account, service, region, usage type).
  2. Detect anomalies per series with a weekday-aware robust baseline
     (trailing median, MAD scale, flagged days excluded from the baseline)
     plus a separate drift test for slow creep.
  3. Group flagged days into events, check them against the business calendar.
  4. Explain each event: excess cost, peak multiple, volume-vs-rate split,
     share of the account's change, shape, matching playbook pattern, checks.
  5. Evaluate against the planted ground truth, alongside three baselines.

Outputs data/results.json (used by the dashboard and the report).
"""
import json
import os

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import IsolationForest

import playbook as pb

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

WARMUP = 28           # days of history needed before scoring
WINDOW = 28           # trailing baseline window
Z_SPIKE = 4.0         # robust z threshold
MIN_SCALE = 0.04      # floor on log-scale noise, avoids over-sensitivity on very smooth series
MATERIALITY = 40.0    # minimum $/day excess to raise an alert
REBASE_AFTER = 21     # consecutive flagged days before a level shift is accepted as the new normal
DRIFT_RATIO = 1.25
DRIFT_RHO = 0.6

KEY = ["SubAccountName", "ServiceName", "RegionId", "x_UsageType"]


# --------------------------------------------------------------------------------------------
def load():
    df = pd.read_csv(os.path.join(DATA, "focus_billing.csv"))
    df["date"] = pd.to_datetime(df["ChargePeriodStart"]).dt.tz_localize(None).dt.normalize()
    df["team"] = df["Tags"].map(lambda s: json.loads(s).get("team", "untagged"))
    usage = df[df.ChargeCategory == "Usage"].copy()
    other = df[df.ChargeCategory != "Usage"].copy()
    truth = json.load(open(os.path.join(DATA, "ground_truth.json")))
    events = json.load(open(os.path.join(DATA, "known_events.json")))
    return df, usage, other, truth, events


def series_table(usage):
    g = usage.groupby(KEY + ["team", "PricingUnit", "date"], as_index=False).agg(
        cost=("EffectiveCost", "sum"), qty=("PricingQuantity", "sum")
    )
    out = {}
    for key, part in g.groupby(KEY + ["team", "PricingUnit"]):
        part = part.set_index("date").sort_index()
        out[key] = part[["cost", "qty"]]
    return out


# --------------------------------------------------------------------------------------------
# Our detector
# --------------------------------------------------------------------------------------------
def detect_series(s: pd.DataFrame):
    """Return per-day dataframe with baseline, z, flag, kind for one series."""
    cost = s["cost"].values.astype(float)
    qty = s["qty"].values.astype(float)
    dates = s.index
    n = len(cost)
    wk = (dates.dayofweek < 5)
    logc = np.log(np.maximum(cost, 1e-6))

    base = np.full(n, np.nan)
    base_qty = np.full(n, np.nan)
    base_price = np.full(n, np.nan)
    z = np.zeros(n)
    flag = np.zeros(n, dtype=bool)
    excluded = np.zeros(n, dtype=bool)  # days kept out of the baseline
    accepted = np.zeros(n, dtype=bool)  # day on which a level shift was accepted as the new normal
    kind = np.array([""] * n, dtype=object)
    streak = 0
    accepted_from = 0  # index from which history counts (moves on accepted level shift)

    for d in range(WARMUP, n):
        lo = max(accepted_from, d - WINDOW * 2)
        hist = [i for i in range(lo, d) if not excluded[i]][-WINDOW:]
        if len(hist) < 10:
            hist = list(range(max(0, d - WINDOW), d))
        hist = np.array(hist)
        h_log = logc[hist]
        h_wk = wk[hist]
        med_all = np.median(h_log)
        # weekday / weekend adjustment
        same = h_log[h_wk == wk[d]]
        adj = (np.median(same) - med_all) if len(same) >= 3 else 0.0
        b = med_all + adj
        resid = h_log - (med_all + np.where(h_wk, np.median(h_log[h_wk]) - med_all if h_wk.sum() >= 3 else 0, np.median(h_log[~h_wk]) - med_all if (~h_wk).sum() >= 3 else 0))
        scale = max(1.4826 * np.median(np.abs(resid - np.median(resid))), MIN_SCALE)
        base[d] = np.exp(b)
        z[d] = (logc[d] - b) / scale

        # quantity / unit price baselines (for volume-vs-rate split)
        q_hist = qty[hist]
        p_hist = cost[hist] / np.maximum(qty[hist], 1e-9)
        q_same = q_hist[h_wk == wk[d]]
        base_qty[d] = np.median(q_same) if len(q_same) >= 3 else np.median(q_hist)
        base_price[d] = np.median(p_hist)

        excess = cost[d] - base[d]
        if z[d] > Z_SPIKE and excess > MATERIALITY:
            flag[d] = True
            kind[d] = "level"
        else:
            # drift test: last 7 days vs older clean history, with a monotonic trend
            if d >= WARMUP + 7:
                recent = cost[d - 6 : d + 1]
                older_idx = [i for i in range(max(accepted_from, d - 35), d - 7) if not excluded[i]]
                if len(older_idx) >= 10:
                    older = np.median(cost[older_idx])
                    ratio = recent.mean() / older
                    rho = spearmanr(np.arange(14), cost[d - 13 : d + 1]).statistic
                    if ratio > DRIFT_RATIO and rho > DRIFT_RHO and (recent.mean() - older) > MATERIALITY:
                        flag[d] = True
                        kind[d] = "drift"
        excluded[d] = flag[d]
        streak = streak + 1 if flag[d] else 0
        if streak >= REBASE_AFTER:
            # accept the new level: the baseline restarts from the last 7 days, which now count as normal.
            # The flags stay, so the event is still reported, and the acceptance is noted in its explanation.
            accepted_from = d - 6
            excluded[d - 6 : d + 1] = False
            accepted[d] = True
            streak = 0

    return pd.DataFrame(
        {"cost": cost, "qty": qty, "baseline": base, "base_qty": base_qty, "base_price": base_price, "z": z, "flag": flag, "kind": kind, "accepted": accepted},
        index=dates,
    )


def group_events(flags: pd.Series, gap: int = 1):
    """Merge flagged days into [start, end] runs, allowing `gap` unflagged days inside a run."""
    days = list(flags[flags].index)
    if not days:
        return []
    runs, start, prev = [], days[0], days[0]
    for d in days[1:]:
        if (d - prev).days <= gap + 1:
            prev = d
            continue
        runs.append((start, prev))
        start = prev = d
    runs.append((start, prev))
    return runs


# --------------------------------------------------------------------------------------------
# Baseline detectors (for comparison)
# --------------------------------------------------------------------------------------------
def detect_static(s):
    c = s["cost"]
    ref = c.shift(1).rolling(7).mean()
    f = (c > 1.5 * ref) & ((c - ref) > MATERIALITY)
    f.iloc[:WARMUP] = False
    return f


def detect_zscore(s):
    c = s["cost"]
    m = c.shift(1).rolling(WINDOW).mean()
    sd = c.shift(1).rolling(WINDOW).std()
    f = ((c - m) / sd > 3.0) & ((c - m) > MATERIALITY)
    f.iloc[:WARMUP] = False
    return f.fillna(False)


def detect_iforest(s):
    c = s["cost"]
    feat = pd.DataFrame(
        {
            "log_cost": np.log(c),
            "chg_1d": np.log(c / c.shift(1)),
            "chg_7d": np.log(c / c.shift(7)),
            "weekday": (c.index.dayofweek < 5).astype(int),
        }
    ).fillna(0)
    model = IsolationForest(n_estimators=200, contamination=0.03, random_state=0)
    pred = model.fit_predict(feat.values) == -1
    # only count upward cost moves that are material, like the other detectors
    ref = c.shift(1).rolling(7).mean()
    f = pd.Series(pred, index=c.index) & ((c - ref) > MATERIALITY)
    f.iloc[:WARMUP] = False
    return f


# --------------------------------------------------------------------------------------------
# Calendar and explanation
# --------------------------------------------------------------------------------------------
def calendar_match(ev, events):
    for e in events:
        es, ee = pd.Timestamp(e["start"]), pd.Timestamp(e["end"])
        if ev["start"] > ee + pd.Timedelta(days=1) or ev["end"] < es - pd.Timedelta(days=1):
            continue
        scope = e["scope"]
        if "/" in scope:
            acct, svc = [x.strip() for x in scope.split("/")]
            if ev["account"] == acct and ev["service"] == svc:
                return e
        elif ev["account"] in scope:
            return e
    return None


def money(x):
    return f"${x:,.0f}"


def price(p):
    return f"${p:,.2f}" if p >= 0.1 else f"${p:.4f}"


def fmt_date(d):
    return pd.Timestamp(d).strftime("%-d %b %Y")


def explain(ev, det, account_delta_by_day, events):
    s, e = ev["start"], ev["end"]
    w = det.loc[s:e]
    days = len(w)
    excess = float((w["cost"] - w["baseline"]).clip(lower=0).sum())
    peak_idx = (w["cost"] / w["baseline"]).idxmax()
    peak_mult = float(w.loc[peak_idx, "cost"] / w.loc[peak_idx, "baseline"])
    usual = float(w["baseline"].mean())
    actual = float(w["cost"].mean())

    # volume vs rate split (sums to actual - baseline within rounding)
    q1, p1 = w["qty"], w["cost"] / w["qty"]
    q0, p0 = w["base_qty"], w["base_price"]
    vol = float(((q1 - q0) * p0).sum())
    rate = float((q1 * (p1 - p0)).sum())
    tot = abs(vol) + abs(rate)
    vol_share = abs(vol) / tot if tot else 1.0
    effect = "rate" if vol_share < 0.35 else "volume"

    # shape
    ratio = (w["cost"] / w["baseline"]).values
    rising = days >= 5 and spearmanr(np.arange(days), ratio).statistic > 0.6 and ratio[0] < 0.6 * ratio.max()
    if rising:
        shape = "drift"
    elif days <= 2:
        shape = "spike"
    else:
        shape = "step"

    # share of the whole account's change on those days
    acct_delta = account_delta_by_day.loc[s:e].clip(lower=0).sum()
    share = float(min(1.0, excess / acct_delta)) if acct_delta > 0 else 1.0

    feats = {
        "family": pb.family_of(ev["service"], ev["usage_type"]),
        "effect": effect,
        "shape": shape,
        "env": pb.env_of(ev["account"]),
        "usage": pb.usage_tags(ev["usage_type"]),
    }
    matches = pb.retrieve(feats, k=2)
    top = pb.entry(matches[0]["id"])

    unit = ev["unit"]
    unit_word = {"Hrs": "hours", "GB-Mo": "GB-months", "GB": "GB"}.get(unit, unit)
    qty_before = float(q0.mean())
    qty_during = float(q1.mean())
    price_before = float(p0.mean())
    price_during = float(p1.mean())

    when = fmt_date(s) if days == 1 else f"{fmt_date(s)} to {fmt_date(e)} ({days} days)"
    where = f"{ev['service']} ({ev['usage_type'].split(':')[-1]}) in {ev['account']}, {ev['region']}"
    lines = []
    verb = "has been creeping up" if shape == "drift" else ("spiked" if shape == "spike" else "jumped")
    lines.append(
        f"Spend on {where} {verb}: it averaged {money(actual)}/day over {when}, against a usual "
        f"{money(usual)}/day, and the worst day was {peak_mult:.1f}× normal."
    )
    lines.append(f"The extra cost was {money(excess)} in total.")
    if effect == "volume":
        lines.append(
            f"This was driven by usage, not price: quantity went from about {qty_before:,.0f} to {qty_during:,.0f} {unit_word} per day "
            f"while the unit price stayed near {price(price_before)}."
        )
    else:
        lines.append(
            f"Usage hardly changed ({qty_before:,.0f} vs {qty_during:,.0f} {unit_word} per day), but the effective unit price rose "
            f"from {price(price_before)} to {price(price_during)} ({(price_during / price_before - 1) * 100:+.0f}%), so this is a pricing change, not more usage."
        )
    lines.append(f"It accounts for {share * 100:.0f}% of the increase in the {ev['account']} account over the same days (team: {ev['team']}).")
    cal = calendar_match(ev, events)
    status = "expected" if cal else "alert"
    if cal:
        lines.append(f"This lines up with a known business event, \"{cal['name']}\" ({cal['note'].rstrip('.')}), so it is marked as expected rather than raised as an alert.")
        matches = [{"id": cal["id"], "name": cal["name"], "score": 1.0, "reasons": ["date and scope match the business calendar"]}, matches[0]]
        checks = ["Confirm the increase ends when the event ends.", "Compare cost per order during the event with normal days."]
    else:
        lines.append(f"Most likely pattern: {top['name']}. {top['causes']}")
        checks = top["checks"]
    acc_days = w.index[w["accepted"].values]
    if len(acc_days):
        lines.append(f"After {REBASE_AFTER} days at this level the detector started treating it as the new normal on {fmt_date(acc_days[0])}; it should still be fixed, not ignored.")

    sev = "high" if excess >= 3000 else "medium" if excess >= 800 else "low"
    return {
        **{k: v for k, v in ev.items() if k not in ("start", "end")},
        "start": s.strftime("%Y-%m-%d"),
        "end": e.strftime("%Y-%m-%d"),
        "days": days,
        "excess_cost": round(excess, 2),
        "usual_per_day": round(usual, 2),
        "actual_per_day": round(actual, 2),
        "peak_multiple": round(peak_mult, 2),
        "volume_effect": round(vol, 2),
        "rate_effect": round(rate, 2),
        "effect": effect,
        "shape": shape,
        "account_share": round(share, 3),
        "pattern": matches[0],
        "runner_up": matches[1],
        "checks": checks,
        "accepted_on": acc_days[0].strftime("%Y-%m-%d") if len(acc_days) else None,
        "status": status,
        "calendar_event": cal["id"] if cal else None,
        "severity": sev if status == "alert" else "expected",
        "explanation": " ".join(lines),
        "max_z": round(float(w["z"].max()), 2),
    }


# --------------------------------------------------------------------------------------------
# Evaluation
# --------------------------------------------------------------------------------------------
EXPECTED_PATTERN = {"A1": "P01", "A2": "P02", "A3": "P03", "A4": "P04", "A5": "P05", "A6": "P01", "A7": "P06", "A8": "P07"}
EXPECTED_EFFECT = {"A7": "rate"}


def series_of_truth(t):
    return (t["account"], t["service"], t["region"], t["usage_type"])


def evaluate(pred_events, truth, label):
    """pred_events: list of dicts with account, service, region, usage_type, start, end (Timestamps or str)."""
    tp_pred = 0
    matched = {}
    for p in pred_events:
        key = (p["account"], p["service"], p["region"], p["usage_type"])
        ps, pe = pd.Timestamp(p["start"]), pd.Timestamp(p["end"])
        hit = None
        for t in truth:
            if series_of_truth(t) != key:
                continue
            ts, te = pd.Timestamp(t["start"]), pd.Timestamp(t["end"])
            if ps <= te + pd.Timedelta(days=1) and pe >= ts - pd.Timedelta(days=1):
                hit = t
                break
        if hit:
            tp_pred += 1
            delay = (ps - pd.Timestamp(hit["start"])).days
            if hit["id"] not in matched or delay < matched[hit["id"]]["delay"]:
                matched[hit["id"]] = {"delay": max(delay, 0), "event": p}
    n_pred = len(pred_events)
    precision = tp_pred / n_pred if n_pred else 0.0
    recall = len(matched) / len(truth)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    delays = [m["delay"] for m in matched.values()]
    return {
        "method": label,
        "alerts": n_pred,
        "true_alerts": tp_pred,
        "false_alerts": n_pred - tp_pred,
        "detected": sorted(matched),
        "missed": sorted(set(t["id"] for t in truth) - set(matched)),
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "mean_delay_days": round(float(np.mean(delays)), 2) if delays else None,
        "_matched": matched,
    }


# --------------------------------------------------------------------------------------------
def run(df, truth, events, full=True):
    df = df.copy()
    df["date"] = pd.to_datetime(df["ChargePeriodStart"]).dt.tz_localize(None).dt.normalize()
    df["team"] = df["Tags"].map(lambda s: json.loads(s).get("team", "untagged"))
    usage = df[df.ChargeCategory == "Usage"].copy()
    other = df[df.ChargeCategory != "Usage"].copy()
    table = series_table(usage)

    # account-level daily delta vs. its own trailing 28-day weekday-aware median (for share-of-change)
    acct_daily = usage.groupby(["SubAccountName", "date"]).EffectiveCost.sum().unstack(0).sort_index()
    acct_base = acct_daily.shift(1).rolling(WINDOW, min_periods=10).median()
    acct_delta = acct_daily - acct_base

    ours_events, static_events, z_events, if_events = [], [], [], []
    det_store = {}
    for key, s in table.items():
        account, service, region, usage_type, team, unit = key
        meta = {"account": account, "service": service, "region": region, "usage_type": usage_type, "team": team, "unit": unit}
        det = detect_series(s)
        det_store[key] = det
        for a, b in group_events(det["flag"]):
            ev = {**meta, "start": a, "end": b}
            ours_events.append(explain(ev, det, acct_delta[account], events))
        for fn, bucket in ((detect_static, static_events), (detect_zscore, z_events), (detect_iforest, if_events)):
            for a, b in group_events(fn(s)):
                bucket.append({**meta, "start": a, "end": b})

    ours_events.sort(key=lambda e: e["start"])
    alerts = [e for e in ours_events if e["status"] == "alert"]

    res_ours = evaluate(alerts, truth, "Explainer (with business calendar)")
    res_ours_nocal = evaluate(ours_events, truth, "Explainer (no calendar)")
    res_static = evaluate(static_events, truth, "Static threshold (>1.5x 7-day mean)")
    res_z = evaluate(z_events, truth, "Rolling z-score (mean/std, z>3)")
    res_if = evaluate(if_events, truth, "Isolation Forest")
    # fairness check: give the baselines the same business calendar
    def with_cal(evs):
        return [e for e in evs if calendar_match(e, events) is None]
    res_static_c = evaluate(with_cal(static_events), truth, "Static threshold + calendar")
    res_z_c = evaluate(with_cal(z_events), truth, "Rolling z-score + calendar")
    res_if_c = evaluate(with_cal(if_events), truth, "Isolation Forest + calendar")
    all_res = [res_ours, res_ours_nocal, res_static, res_z, res_if, res_static_c, res_z_c, res_if_c]
    if not full:
        return all_res, ours_events

    # explanation quality on detected anomalies (ours)
    quality = []
    for tid, m in res_ours["_matched"].items():
        ev = m["event"]
        t = next(x for x in truth if x["id"] == tid)
        quality.append(
            {
                "truth": tid,
                "title": t["title"],
                "delay_days": m["delay"],
                "pattern_expected": EXPECTED_PATTERN[tid],
                "pattern_top1": ev["pattern"]["id"],
                "pattern_top2": ev["runner_up"]["id"],
                "pattern_correct": ev["pattern"]["id"] == EXPECTED_PATTERN[tid],
                "pattern_in_top2": EXPECTED_PATTERN[tid] in (ev["pattern"]["id"], ev["runner_up"]["id"]),
                "effect_expected": EXPECTED_EFFECT.get(tid, "volume"),
                "effect_found": ev["effect"],
                "effect_correct": ev["effect"] == EXPECTED_EFFECT.get(tid, "volume"),
                "excess_cost": ev["excess_cost"],
            }
        )
    quality.sort(key=lambda q: q["truth"])

    # truth: injected excess (actual - what it would have been is unknown here; report detected excess instead)

    # dashboard data -------------------------------------------------------------------
    daily_total = usage.groupby("date").EffectiveCost.sum()
    by_service = usage.groupby(["date", "ServiceName"]).EffectiveCost.sum().unstack(fill_value=0)
    top_services = by_service.sum().sort_values(ascending=False).index.tolist()
    by_account = usage.groupby(["date", "SubAccountName"]).EffectiveCost.sum().unstack(fill_value=0)
    by_team = usage.groupby("team").EffectiveCost.sum().sort_values(ascending=False)

    series_payload = {}
    for e in ours_events:
        key = (e["account"], e["service"], e["region"], e["usage_type"], e["team"], e["unit"])
        sid = "|".join(key[:4])
        if sid in series_payload:
            continue
        det = det_store[key]
        series_payload[sid] = {
            "cost": [round(x, 2) for x in det["cost"]],
            "baseline": [None if np.isnan(x) else round(x, 2) for x in det["baseline"]],
        }
    for e in ours_events:
        e["series_id"] = "|".join([e["account"], e["service"], e["region"], e["usage_type"]])

    month = usage.assign(m=usage.date.dt.strftime("%Y-%m")).groupby("m").EffectiveCost.sum()

    def clean(r):
        return {k: v for k, v in r.items() if not k.startswith("_")}

    out = {
        "meta": {
            "company": "Northwind Cloud Retail (fictional)",
            "period": [str(daily_total.index.min().date()), str(daily_total.index.max().date())],
            "rows": int(len(df)),
            "series": len(table),
            "total_usage_cost": round(float(usage.EffectiveCost.sum()), 2),
            "total_other_cost": round(float(other.EffectiveCost.sum()), 2),
            "params": {"warmup": WARMUP, "window": WINDOW, "z": Z_SPIKE, "materiality": MATERIALITY, "drift_ratio": DRIFT_RATIO, "drift_rho": DRIFT_RHO, "rebase_after": REBASE_AFTER},
        },
        "dates": [d.strftime("%Y-%m-%d") for d in daily_total.index],
        "daily_total": [round(x, 2) for x in daily_total.values],
        "by_service": {s: [round(x, 2) for x in by_service[s].values] for s in top_services},
        "by_account": {a: [round(x, 2) for x in by_account[a].values] for a in by_account.columns},
        "by_team": {k: round(float(v), 2) for k, v in by_team.items()},
        "monthly": {k: round(float(v), 2) for k, v in month.items()},
        "events": ours_events,
        "series": series_payload,
        "known_events": events,
        "truth": truth,
        "evaluation": [clean(r) for r in all_res],
        "explanation_quality": quality,
        "playbook": [{"id": p["id"], "name": p["name"], "causes": p["causes"]} for p in pb.PLAYBOOK],
    }

    def conv(o):
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, (np.bool_,)):
            return bool(o)
        if isinstance(o, set):
            return sorted(o)
        if isinstance(o, pd.Timestamp):
            return o.strftime("%Y-%m-%d")
        raise TypeError(type(o))

    with open(os.path.join(DATA, "results.json"), "w") as f:
        json.dump(out, f, indent=1, default=conv)
    return out, ours_events, quality


def main():
    df, _, _, truth, events = load()
    out, ours_events, quality = run(df, truth, events)
    alerts = [e for e in ours_events if e["status"] == "alert"]

    # console summary ------------------------------------------------------------------------
    print(f"events found: {len(ours_events)}  alerts: {len(alerts)}  expected (calendar): {len(ours_events) - len(alerts)}")
    for e in ours_events:
        print(f"  [{e['status']:8}] {e['start']}..{e['end']} {e['account']:13} {e['service']:18} {e['usage_type'][:24]:24} "
              f"excess={e['excess_cost']:>9,.0f} {e['shape']:5} {e['effect']:6} -> {e['pattern']['id']} ({e['pattern']['score']})")
    print()
    for r in out["evaluation"]:
        print(f"  {r['method']:40} alerts={r['alerts']:3} TP={r['true_alerts']:3} FP={r['false_alerts']:3} "
              f"P={r['precision']:.2f} R={r['recall']:.2f} F1={r['f1']:.2f} delay={r['mean_delay_days']} missed={r['missed']}")
    print()
    for q in quality:
        print(f"  {q['truth']} delay={q['delay_days']} pattern {q['pattern_top1']} (want {q['pattern_expected']}) ok={q['pattern_correct']}  "
              f"effect {q['effect_found']} ok={q['effect_correct']}")


if __name__ == "__main__":
    main()
