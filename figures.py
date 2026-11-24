"""Figures for the report (PNG, 200 dpi)."""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
FIG = os.path.join(HERE, "fig")
os.makedirs(FIG, exist_ok=True)
R = json.load(open(os.path.join(HERE, "data", "results.json")))
ROB = json.load(open(os.path.join(HERE, "data", "robustness.json")))

BLUE, RED, GREY, ORANGE, GREEN, PURPLE = "#2f5fb3", "#c8443a", "#9a968c", "#d9773d", "#3d9a7a", "#8a55c0"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.edgecolor": "#888", "axes.labelcolor": "#333", "xtick.color": "#444", "ytick.color": "#444"})
dates = pd.to_datetime(R["dates"])


def money(v, _=None):
    if abs(v) >= 1000:
        k = v / 1000
        return f"${k:,.0f}k" if abs(k - round(k)) < 1e-9 else f"${k:,.1f}k"
    return f"${v:,.0f}"


# Fig 2: daily spend with flagged periods ------------------------------------------------------
fig, ax = plt.subplots(figsize=(7.2, 2.9))
for e in R["events"]:
    s, en = pd.Timestamp(e["start"]), pd.Timestamp(e["end"]) + pd.Timedelta(days=1)
    ax.axvspan(s, en, color=RED if e["status"] == "alert" else GREY, alpha=0.18 if e["status"] == "alert" else 0.35, lw=0)
ax.plot(dates, R["daily_total"], color=BLUE, lw=1.3)
ax.set_ylim(0, max(R["daily_total"]) * 1.1)
ax.yaxis.set_major_formatter(plt.FuncFormatter(money))
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b"))
ax.set_ylabel("Daily usage spend")
ax.grid(axis="y", color="#eee")
from matplotlib.patches import Patch
from matplotlib.lines import Line2D
ax.legend(handles=[Line2D([], [], color=BLUE, lw=1.3, label="Daily spend"), Patch(color=RED, alpha=0.3, label="Alert"),
                   Patch(color=GREY, alpha=0.45, label="Expected (business calendar)")], loc="lower left", frameon=False, ncol=3, fontsize=8)
fig.tight_layout()
fig.savefig(os.path.join(FIG, "fig2_daily.png"), dpi=200)
plt.close(fig)

# Fig 3: three case studies --------------------------------------------------------------------
cases = [("A1", "p4d.24xlarge"), ("A7", "c6i.4xlarge"), ("A3", "DataProcessing-Bytes")]
picked = []
for tid, key in cases:
    for e in R["events"]:
        if key in e["usage_type"] and e["status"] == "alert" and e["excess_cost"] > 1000:
            picked.append((tid, e))
            break
fig, axes = plt.subplots(1, 3, figsize=(7.4, 2.5))
titles = {"A1": "A1 · Idle GPU instances (step)", "A7": "A7 · Savings Plan expiry (price)", "A3": "A3 · Log ingestion creep (drift)"}
for ax, (tid, e) in zip(axes, picked):
    s = R["series"][e["series_id"]]
    c = np.array(s["cost"], dtype=float)
    b = np.array([np.nan if v is None else v for v in s["baseline"]], dtype=float)
    st, en = pd.Timestamp(e["start"]), pd.Timestamp(e["end"])
    m = (dates >= st - pd.Timedelta(days=28)) & (dates <= en + pd.Timedelta(days=14))
    ax.axvspan(st, en + pd.Timedelta(days=1), color=RED, alpha=0.15, lw=0)
    ax.plot(dates[m], c[m], color=BLUE, lw=1.3, label="Actual")
    ax.plot(dates[m], b[m], color="#666", lw=1.1, ls="--", label="Baseline")
    ax.set_title(titles[tid], fontsize=8.5, loc="left")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(money))
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=0, interval=2))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%-d %b"))
    ax.tick_params(labelsize=7)
    ax.set_ylim(0, None)
axes[0].legend(frameon=False, fontsize=7, loc="upper left")
fig.tight_layout()
fig.savefig(os.path.join(FIG, "fig3_cases.png"), dpi=200)
plt.close(fig)

# Fig 4: volume vs rate split for all alerts ---------------------------------------------------
alerts = [e for e in R["events"] if e["status"] == "alert"]
alerts.sort(key=lambda e: e["excess_cost"])
fig, ax = plt.subplots(figsize=(7.0, 3.0))
labels = [f"{e['service'].replace('Amazon ', '').replace('AWS ', '')} · {e['account']} ({pd.Timestamp(e['start']).strftime('%-d %b')})" for e in alerts]
vol = [max(0, e["volume_effect"]) for e in alerts]
rate = [max(0, e["rate_effect"]) for e in alerts]
y = np.arange(len(alerts))
ax.barh(y, vol, color=BLUE, label="More usage (volume effect)")
ax.barh(y, rate, left=vol, color=ORANGE, label="Higher unit price (rate effect)")
ax.set_yticks(y, labels, fontsize=7.5)
ax.xaxis.set_major_formatter(plt.FuncFormatter(money))
ax.set_xlabel("Extra cost during the event")
ax.legend(frameon=False, fontsize=7.5, loc="lower right")
ax.grid(axis="x", color="#eee")
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig(os.path.join(FIG, "fig4_split.png"), dpi=200)
plt.close(fig)

# Fig 5: robustness --------------------------------------------------------------------------
methods = [("Explainer (with business calendar)", "Explainer", BLUE),
           ("Isolation Forest + calendar", "Isolation Forest + calendar", ORANGE),
           ("Rolling z-score + calendar", "Rolling z-score + calendar", GREEN),
           ("Static threshold + calendar", "Static threshold + calendar", PURPLE),
           ("Explainer (no calendar)", "Explainer, no calendar", GREY)]
sizes = [25, 50, 75, 100]
fig, axes = plt.subplots(1, 2, figsize=(7.4, 2.7))
for k, (metric, ttl) in enumerate([("f1", "F1 score"), ("recall", "Recall")]):
    ax = axes[k]
    for i, (mth, lab, col) in enumerate(methods):
        mu = [ROB["summary"][str(s / 100)][mth][f"{metric}_mean"] for s in sizes]
        sd = [ROB["summary"][str(s / 100)][mth][f"{metric}_sd"] for s in sizes]
        xs = np.array(sizes) + (i - 2) * 1.2
        ax.errorbar(xs, mu, yerr=sd, color=col, lw=2 if i == 0 else 1.2, marker="o", ms=3.5, capsize=2, label=lab,
                    ls="--" if "no calendar" in lab else "-")
    ax.set_xticks(sizes, [f"{s}%" for s in sizes])
    ax.set_xlabel("Size of planted anomalies")
    ax.set_title(ttl, fontsize=9, loc="left")
    ax.set_ylim(0.2, 1.05)
    ax.grid(axis="y", color="#eee")
axes[1].legend(frameon=False, fontsize=6.8, loc="lower right")
fig.tight_layout()
fig.savefig(os.path.join(FIG, "fig5_robustness.png"), dpi=200)
plt.close(fig)

# Fig 1: pipeline diagram ----------------------------------------------------------------------
fig, ax = plt.subplots(figsize=(7.4, 2.4))
ax.set_xlim(0, 100); ax.set_ylim(0, 30); ax.axis("off")
boxes = [
    (1, "FOCUS billing\nrows", "4,037 rows\n22 service lines"),
    (21, "Baseline", "28-day median,\nweekday-adjusted,\nflagged days excluded"),
    (41, "Detect", "robust z > 4 and\n> $40/day; drift test;\ngroup into events"),
    (61, "Explain", "excess cost, volume\nvs price split, share,\nplaybook match"),
    (81, "Calendar &\noutput", "expected vs alert;\ndashboard, JSON"),
]
from matplotlib.patches import FancyBboxPatch
for x, title, sub in boxes:
    ax.add_patch(FancyBboxPatch((x, 4), 17, 22, boxstyle="round,pad=0.4,rounding_size=1.5", fc="#f3f6fc", ec=BLUE, lw=1))
    ax.text(x + 8.5, 21.5, title, ha="center", va="center", fontsize=8.5, weight="bold", color="#1d2c4c")
    ax.text(x + 8.5, 11, sub, ha="center", va="center", fontsize=6.8, color="#333")
for x in (18.6, 38.6, 58.6, 78.6):
    ax.annotate("", xy=(x + 2.2, 15), xytext=(x, 15), arrowprops=dict(arrowstyle="-|>", color="#555", lw=1))
ax.text(69.5, 0.5, "Pattern playbook (9 entries) ↑", ha="center", fontsize=6.8, color="#555", style="italic")
fig.tight_layout()
fig.savefig(os.path.join(FIG, "fig1_pipeline.png"), dpi=200)
plt.close(fig)
print(sorted(os.listdir(FIG)))
