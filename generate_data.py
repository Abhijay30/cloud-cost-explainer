"""
Synthetic cloud billing dataset in a FOCUS-style (FinOps Open Cost & Usage Specification) schema.

Fictional company: "Northwind Cloud Retail" (fictional, for demonstration only).
Period: 2026-04-01 .. 2026-09-30, daily granularity.

The generator produces:
  data/focus_billing.csv      - the billing rows (one row per series per day)
  data/ground_truth.json      - labelled anomalies (what was planted, where, when, why)
  data/known_events.json      - business calendar (expected events that are NOT anomalies)

Everything is deterministic (fixed seed) so results are reproducible.
"""
import json
import os
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

SEED = 42


START = pd.Timestamp("2026-04-01")
END = pd.Timestamp("2026-09-30")
DAYS = pd.date_range(START, END, freq="D")
N = len(DAYS)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


@dataclass
class Series:
    account: str
    service: str
    category: str  # FOCUS ServiceCategory
    region: str
    usage_type: str  # x_UsageType (provider-specific)
    unit: str  # PricingUnit
    team: str
    base_qty: float  # typical daily quantity
    unit_price: float  # effective $ per unit
    weekday_amp: float = 0.0  # how much weekdays exceed weekends (fraction)
    growth: float = 0.0  # total fractional growth over the period
    noise: float = 0.06  # multiplicative noise (sd)
    traffic_linked: bool = False  # responds to retail traffic (sale events)
    qty: np.ndarray = field(default=None, repr=False)
    price: np.ndarray = field(default=None, repr=False)




def generate(seed=SEED, scale=1.0, write=True):
    """Build the dataset. `scale` shrinks or grows every planted anomaly (1.0 = as documented)."""
    rng = np.random.default_rng(seed)
    ACCOUNTS = {
        "prod-retail": "111122223333",
        "staging": "444455556666",
        "data-platform": "777788889999",
        "ml-sandbox": "121234345656",
    }

    S = [
        # --- production retail workloads -------------------------------------------------
        Series("prod-retail", "Amazon EC2", "Compute", "us-east-1", "BoxUsage:m6i.2xlarge", "Hrs", "checkout", 960, 0.384, 0.18, 0.12, traffic_linked=True),
        Series("prod-retail", "Amazon EC2", "Compute", "us-east-1", "BoxUsage:c6i.4xlarge", "Hrs", "search", 720, 0.68, 0.15, 0.10, traffic_linked=True),
        Series("prod-retail", "Amazon EC2", "Compute", "eu-west-1", "BoxUsage:m6i.2xlarge", "Hrs", "checkout", 480, 0.428, 0.18, 0.08, traffic_linked=True),
        Series("prod-retail", "Amazon RDS", "Databases", "us-east-1", "InstanceUsage:db.r6g.4xlarge", "Hrs", "checkout", 96, 1.84, 0.0, 0.05),
        Series("prod-retail", "Amazon RDS", "Databases", "ap-south-1", "RDS:StorageIOUsage", "IOs (M)", "checkout", 410, 0.20, 0.10, 0.06),
        Series("prod-retail", "Amazon S3", "Storage", "us-east-1", "TimedStorage-ByteHrs", "GB-Mo", "platform", 61000, 0.0230 / 30, 0.0, 0.15, noise=0.01),
        Series("prod-retail", "Amazon CloudFront", "Networking", "global", "DataTransfer-Out-Bytes", "GB", "platform", 8000, 0.085, 0.12, 0.10, traffic_linked=True),
        Series("prod-retail", "AWS Lambda", "Compute", "us-east-1", "Lambda-GB-Second", "GB-s (K)", "checkout", 5200, 0.0166667, 0.20, 0.10, traffic_linked=True),
        Series("prod-retail", "Amazon CloudWatch", "Management and Governance", "us-east-1", "DataProcessing-Bytes", "GB", "platform", 640, 0.50, 0.08, 0.06),
        Series("prod-retail", "Amazon DynamoDB", "Databases", "us-east-1", "ReadRequestUnits", "RRU (M)", "search", 1500, 0.25, 0.12, 0.08, traffic_linked=True),
        # --- staging ----------------------------------------------------------------------
        Series("staging", "Amazon EC2", "Compute", "us-east-1", "BoxUsage:m6i.large", "Hrs", "platform", 480, 0.096, 0.35, 0.0),
        Series("staging", "AWS Lambda", "Compute", "us-east-1", "Lambda-GB-Second", "GB-s (K)", "checkout", 420, 0.0166667, 0.40, 0.0),
        Series("staging", "Amazon RDS", "Databases", "us-east-1", "InstanceUsage:db.t4g.large", "Hrs", "platform", 48, 0.129, 0.0, 0.0),
        # --- data platform ----------------------------------------------------------------
        Series("data-platform", "Amazon EMR", "Analytics", "eu-west-1", "BoxUsage:r6g.4xlarge", "Hrs", "analytics", 380, 0.806, 0.25, 0.10),
        Series("data-platform", "Amazon VPC", "Networking", "eu-west-1", "NatGateway-Bytes", "GB", "analytics", 1100, 0.048, 0.25, 0.05),
        Series("data-platform", "Amazon S3", "Storage", "eu-west-1", "TimedStorage-ByteHrs", "GB-Mo", "analytics", 240000, 0.0230 / 30, 0.0, 0.20, noise=0.01),
        Series("data-platform", "AWS Glue", "Analytics", "eu-west-1", "ETL-DPU-Hour", "DPU-Hr", "analytics", 260, 0.44, 0.30, 0.08),
        Series("data-platform", "Amazon Redshift", "Analytics", "eu-west-1", "Node:ra3.4xlarge", "Hrs", "analytics", 96, 3.26, 0.0, 0.0, noise=0.01),
        Series("data-platform", "AWS Data Transfer", "Networking", "ap-south-1", "DataTransfer-Regional-Bytes", "GB", "analytics", 900, 0.02, 0.10, 0.05),
        # --- ML sandbox ---------------------------------------------------------------------
        Series("ml-sandbox", "Amazon SageMaker", "AI and Machine Learning", "us-east-1", "ml.g5.2xlarge-Training", "Hrs", "ml", 60, 1.515, 0.40, 0.10, noise=0.15),
        Series("ml-sandbox", "Amazon EC2", "Compute", "us-east-1", "BoxUsage:p4d.24xlarge", "Hrs", "ml", 6, 32.77, 0.30, 0.0, noise=0.25),
        Series("ml-sandbox", "Amazon S3", "Storage", "us-east-1", "TimedStorage-ByteHrs", "GB-Mo", "ml", 38000, 0.0230 / 30, 0.0, 0.25, noise=0.01),
    ]

    # --------------------------------------------------------------------------------------------
    # 1. baseline quantities and prices
    # --------------------------------------------------------------------------------------------
    dow = DAYS.dayofweek.values  # 0=Mon
    is_weekday = (dow < 5).astype(float)
    t = np.arange(N) / (N - 1)

    for s in S:
        weekly = 1 + s.weekday_amp * (is_weekday - 5 / 7)  # mean-preserving weekly shape
        trend = 1 + s.growth * t
        noise = rng.lognormal(mean=0, sigma=s.noise, size=N)
        s.qty = s.base_qty * weekly * trend * noise
        s.price = np.full(N, s.unit_price)

    # --------------------------------------------------------------------------------------------
    # 2. known business events (expected; NOT anomalies)
    # --------------------------------------------------------------------------------------------
    known_events = [
        {
            "id": "E1",
            "name": "Monsoon Mega Sale (planned marketing campaign)",
            "start": "2026-07-10",
            "end": "2026-07-14",
            "scope": "prod-retail traffic-linked services",
            "note": "Marketing expected ~35-45% more traffic on customer-facing services.",
        },
        {
            "id": "E2",
            "name": "Quarterly Redshift resize for Q2 close",
            "start": "2026-07-01",
            "end": "2026-07-03",
            "scope": "data-platform / Amazon Redshift",
            "note": "Finance close: cluster temporarily doubled from 4 to 8 nodes.",
        },
    ]

    sale = (DAYS >= "2026-07-10") & (DAYS <= "2026-07-14")
    ramp = np.zeros(N)
    idx = np.where(sale)[0]
    ramp[idx] = [0.30, 0.42, 0.45, 0.40, 0.25]
    for s in S:
        if s.traffic_linked:
            s.qty *= 1 + ramp

    rs = next(s for s in S if s.service == "Amazon Redshift")
    rs.qty[(DAYS >= "2026-07-01") & (DAYS <= "2026-07-03")] *= 2.0


    def get(account, service, usage_type, region=None):
        for s in S:
            if s.account == account and s.service == service and s.usage_type == usage_type and (region is None or s.region == region):
                return s
        raise KeyError((account, service, usage_type, region))


    def window(a, b):
        return (DAYS >= a) & (DAYS <= b)


    # --------------------------------------------------------------------------------------------
    # 3. planted anomalies (ground truth)
    # --------------------------------------------------------------------------------------------
    truth = []


    def plant(aid, title, series, start, end, kind, cause, effect):
        m = window(start, end)
        effect(series, m)
        truth.append(
            {
                "id": aid,
                "title": title,
                "start": start,
                "end": end,
                "kind": kind,  # spike | step | drift | rate
                "account": series.account,
                "service": series.service,
                "region": series.region,
                "usage_type": series.usage_type,
                "team": series.team,
                "true_cause": cause,
            }
        )


    # A1: forgotten GPU instances (step up, 9 days, usage-driven)
    plant(
        "A1", "Idle p4d GPU instances left running", get("ml-sandbox", "Amazon EC2", "BoxUsage:p4d.24xlarge"),
        "2026-05-18", "2026-05-26", "step",
        "Two p4d.24xlarge instances launched for an experiment were never stopped.",
        lambda s, m: s.qty.__setitem__(m, s.qty[m] + scale * 48 * rng.uniform(0.97, 1.0, m.sum())),
    )

    # A2: NAT gateway data processing spike (misrouted S3 traffic, 4 days)
    plant(
        "A2", "NAT Gateway processing surge from misrouted S3 traffic", get("data-platform", "Amazon VPC", "NatGateway-Bytes"),
        "2026-06-09", "2026-06-12", "spike",
        "A new Spark job read S3 through the NAT Gateway because the VPC endpoint route was missing.",
        lambda s, m: s.qty.__setitem__(m, s.qty[m] * (1 + scale * (rng.uniform(6.5, 8.0, m.sum()) - 1))),
    )

    # A3: slow drift in CloudWatch log ingestion (debug logging left on)
    s3 = get("prod-retail", "Amazon CloudWatch", "DataProcessing-Bytes")
    def _drift(s, m):
        k = m.sum()
        s.qty[m] = s.qty[m] * (1 + scale * (np.linspace(1.15, 2.3, k) - 1))
        # stays high afterwards until fixed on 2026-09-04
        after = window("2026-08-31", "2026-09-03")
        s.qty[after] = s.qty[after] * (1 + scale * 1.3)
    plant(
        "A3", "Gradual CloudWatch log ingestion creep (DEBUG logging)", s3,
        "2026-08-10", "2026-08-30", "drift",
        "A release switched the checkout service log level to DEBUG; ingestion grew as traffic was routed to the new version.",
        _drift,
    )
    truth[-1]["end"] = "2026-09-03"

    # A4: Lambda recursive invocation loop in staging (1-day spike)
    plant(
        "A4", "Recursive Lambda invocation loop in staging", get("staging", "AWS Lambda", "Lambda-GB-Second"),
        "2026-06-27", "2026-06-27", "spike",
        "An S3-triggered function wrote back to its own bucket, re-triggering itself until the concurrency limit.",
        lambda s, m: s.qty.__setitem__(m, s.qty[m] * (1 + scale * 37)),
    )

    # A5: cross-region data transfer (snapshot copy job, 3 days)
    plant(
        "A5", "Cross-region snapshot copy traffic", get("data-platform", "AWS Data Transfer", "DataTransfer-Regional-Bytes"),
        "2026-08-19", "2026-08-21", "spike",
        "A DR job copied full (not incremental) RDS snapshots from ap-south-1 to eu-west-1.",
        lambda s, m: s.qty.__setitem__(m, s.qty[m] + scale * rng.uniform(9000, 11000, m.sum())),
    )

    # A6: forgotten load-test fleet in staging (5 days)
    plant(
        "A6", "Forgotten load-test fleet in staging", get("staging", "Amazon EC2", "BoxUsage:m6i.large"),
        "2026-09-14", "2026-09-18", "step",
        "An autoscaling group created for a load test kept 40 extra m6i.large instances running.",
        lambda s, m: s.qty.__setitem__(m, s.qty[m] + scale * 960),
    )

    # A7: Savings Plan expiry -> unit price jump, usage flat (rate anomaly, persistent)
    def _rate(s, m):
        s.price[m] = s.price[m] * (1 + scale * 0.38)
    plant(
        "A7", "Savings Plan expiry raised EC2 unit price", get("prod-retail", "Amazon EC2", "BoxUsage:c6i.4xlarge"),
        "2026-08-01", "2026-08-14", "rate",
        "The 1-year Compute Savings Plan covering the search fleet expired on 31 Jul and was not renewed until 15 Aug.",
        _rate,
    )

    # A8: small RDS IO spike (hard case: low dollar impact)
    plant(
        "A8", "RDS storage I/O spike from missing index", get("prod-retail", "Amazon RDS", "RDS:StorageIOUsage", "ap-south-1"),
        "2026-07-22", "2026-07-23", "spike",
        "A new report query did full-table scans because an index was dropped in a migration.",
        lambda s, m: s.qty.__setitem__(m, s.qty[m] * (1 + scale * 1.6)),
    )

    # --------------------------------------------------------------------------------------------
    # 4. emit FOCUS-style rows
    # --------------------------------------------------------------------------------------------
    rows = []
    for si, s in enumerate(S):
        for d in range(N):
            qty = float(s.qty[d])
            price = float(s.price[d])
            effective = qty * price
            # list (on-demand) cost: prod EC2 is normally covered by a Savings Plan (~28% discount)
            if s.account == "prod-retail" and s.service == "Amazon EC2":
                list_price = s.unit_price / 0.72
            else:
                list_price = s.unit_price
            rows.append(
                {
                    "BillingAccountId": "900000000001",
                    "BillingAccountName": "Northwind Cloud Retail (fictional)",
                    "SubAccountId": ACCOUNTS[s.account],
                    "SubAccountName": s.account,
                    "ProviderName": "AWS",
                    "ChargePeriodStart": DAYS[d].strftime("%Y-%m-%dT00:00:00Z"),
                    "ChargePeriodEnd": (DAYS[d] + pd.Timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z"),
                    "ChargeCategory": "Usage",
                    "ServiceCategory": s.category,
                    "ServiceName": s.service,
                    "RegionId": s.region,
                    "ResourceId": f"nw-{s.account}-{si:02d}",
                    "x_UsageType": s.usage_type,
                    "PricingUnit": s.unit,
                    "PricingQuantity": round(qty, 4),
                    "ListUnitPrice": round(list_price, 6),
                    "ListCost": round(qty * list_price, 4),
                    "EffectiveCost": round(effective, 4),
                    "BilledCost": round(effective, 4),
                    "BillingCurrency": "USD",
                    "Tags": json.dumps({"team": s.team, "env": "prod" if s.account == "prod-retail" else s.account}),
                }
            )

    # monthly recurring non-usage charges (Support fee, Savings Plan commitment) - expected
    for month_start in pd.date_range(START, END, freq="MS"):
        # FOCUS convention: a Savings Plan purchase is billed up-front (BilledCost) but its EffectiveCost is
        # amortised into the covered usage rows, so EffectiveCost = 0 on the purchase row itself.
        for name, amount, cat, eff in [("AWS Support (Business)", 3400.0, "Purchase", True), ("Savings Plans", 11800.0, "Purchase", False)]:
            if name == "Savings Plans" and month_start == pd.Timestamp("2026-08-01"):
                amount = 0.0  # expired during August (see A7)
            if amount == 0:
                continue
            rows.append(
                {
                    "BillingAccountId": "900000000001",
                    "BillingAccountName": "Northwind Cloud Retail (fictional)",
                    "SubAccountId": ACCOUNTS["prod-retail"],
                    "SubAccountName": "prod-retail",
                    "ProviderName": "AWS",
                    "ChargePeriodStart": month_start.strftime("%Y-%m-%dT00:00:00Z"),
                    "ChargePeriodEnd": (month_start + pd.offsets.MonthBegin(1)).strftime("%Y-%m-%dT00:00:00Z"),
                    "ChargeCategory": cat,
                    "ServiceCategory": "Other",
                    "ServiceName": name,
                    "RegionId": "global",
                    "ResourceId": "",
                    "x_UsageType": "Recurring",
                    "PricingUnit": "Month",
                    "PricingQuantity": 1,
                    "ListUnitPrice": amount,
                    "ListCost": amount,
                    "EffectiveCost": amount if eff else 0.0,
                    "BilledCost": amount,
                    "BillingCurrency": "USD",
                    "Tags": json.dumps({"team": "platform", "env": "prod"}),
                }
            )

    df = pd.DataFrame(rows)
    if write:
        os.makedirs(OUT, exist_ok=True)
        df.to_csv(os.path.join(OUT, "focus_billing.csv"), index=False)
        with open(os.path.join(OUT, "ground_truth.json"), "w") as f:
            json.dump(truth, f, indent=2)
        with open(os.path.join(OUT, "known_events.json"), "w") as f:
            json.dump(known_events, f, indent=2)
    return df, truth, known_events


if __name__ == "__main__":
    df, truth, ev = generate()
    print(f"rows={len(df)}  days={N}  total EffectiveCost=${df.EffectiveCost.sum():,.0f}")
    print(df.groupby("ServiceName").EffectiveCost.sum().sort_values(ascending=False).round(0))
