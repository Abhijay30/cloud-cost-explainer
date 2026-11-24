"""
Pattern playbook: a small knowledge base of known cloud-cost anomaly patterns.

Each entry has a *signature* (features an anomaly must show) and the plain-English
likely causes and checks that the explainer retrieves when an anomaly matches it.
Matching is a weighted feature-overlap score, so every retrieval can be explained:
"matched because: service family = networking, effect = volume, shape = spike".
"""

PLAYBOOK = [
    {
        "id": "P01",
        "name": "Idle or forgotten compute",
        "signature": {"family": {"compute", "ml"}, "effect": "volume", "shape": {"step"}, "env": {"sandbox", "staging", "dev"}},
        "causes": "Instances, GPU nodes or an autoscaling group were launched for a test or experiment and never stopped.",
        "checks": [
            "List running instances in the account created on or just before the start date.",
            "Check for missing 'owner' or 'ttl' tags on the new resources.",
            "Add an auto-stop schedule or TTL policy for sandbox and staging accounts.",
        ],
    },
    {
        "id": "P02",
        "name": "NAT Gateway data processing surge",
        "signature": {"family": {"networking"}, "effect": "volume", "shape": {"spike", "step"}, "usage": {"nat"}},
        "causes": "Traffic to AWS services such as S3 or DynamoDB is going through the NAT Gateway instead of a free VPC gateway endpoint.",
        "checks": [
            "Check the VPC route tables for an S3 or DynamoDB gateway endpoint.",
            "Find which subnets or jobs started sending traffic on the start date (VPC Flow Logs).",
            "Route bulk S3 traffic through a gateway endpoint.",
        ],
    },
    {
        "id": "P03",
        "name": "Logging or monitoring ingestion creep",
        "signature": {"family": {"management"}, "effect": "volume", "shape": {"drift", "step"}},
        "causes": "Log volume grew after a change in log level, a noisy new log statement, or a new service that ships every request to the log pipeline.",
        "checks": [
            "Find which log groups grew the most (CloudWatch Logs IncomingBytes by log group).",
            "Compare deploys around the start date for log-level or logging-library changes.",
            "Set retention policies and sample or filter DEBUG output in production.",
        ],
    },
    {
        "id": "P04",
        "name": "Runaway serverless invocations",
        "signature": {"family": {"serverless"}, "effect": "volume", "shape": {"spike"}},
        "causes": "A function is invoking itself (directly or through an event source such as S3 or SQS), or a retry storm is re-running failed events.",
        "checks": [
            "Look at the invocation count and concurrency graph for the function on that day.",
            "Check whether the function writes to the same bucket or queue that triggers it.",
            "Turn on recursive-loop detection and set a reserved concurrency limit.",
        ],
    },
    {
        "id": "P05",
        "name": "Cross-region or inter-AZ data transfer",
        "signature": {"family": {"transfer"}, "effect": "volume", "shape": {"spike", "step"}},
        "causes": "A backup, replication or migration job is copying large volumes of data between regions or availability zones.",
        "checks": [
            "Check scheduled backup, DR and replication jobs that ran in that window.",
            "Confirm copies are incremental rather than full.",
            "Compress data or keep copies in the same region where possible.",
        ],
    },
    {
        "id": "P06",
        "name": "Commitment expiry (Savings Plan / Reserved Instance)",
        "signature": {"family": {"compute", "database"}, "effect": "rate", "shape": {"step"}},
        "causes": "Usage stayed flat but the effective price per unit rose, which usually means a Savings Plan or Reserved Instance stopped covering this usage.",
        "checks": [
            "Check Savings Plan and RI expiry dates and coverage reports for the start date.",
            "Confirm whether the instance family or region changed so the commitment no longer applies.",
            "Renew or re-buy commitments for the steady-state baseline.",
        ],
    },
    {
        "id": "P07",
        "name": "Database I/O or query regression",
        "signature": {"family": {"database"}, "effect": "volume", "shape": {"spike", "step"}, "usage": {"io", "read"}},
        "causes": "A new or changed query is scanning far more data, often because an index was removed or a query plan changed.",
        "checks": [
            "Open Performance Insights / slow-query log for the window and find the top statements by I/O.",
            "Compare schema migrations deployed just before the start date.",
            "Restore the index or rewrite the query.",
        ],
    },
    {
        "id": "P08",
        "name": "Organic traffic growth",
        "signature": {"family": {"compute", "networking", "serverless", "database"}, "effect": "volume", "shape": {"drift"}, "env": {"prod"}},
        "causes": "Spend is rising along with real customer traffic. This may be expected, but it should be checked against business metrics.",
        "checks": [
            "Compare cost per order or cost per request before and after.",
            "If unit cost is flat, treat it as growth, not waste.",
        ],
    },
    {
        "id": "P09",
        "name": "Storage accumulation",
        "signature": {"family": {"storage"}, "effect": "volume", "shape": {"drift", "step"}},
        "causes": "Data is piling up without lifecycle rules: old versions, snapshots, or temporary data that is never deleted.",
        "checks": [
            "Check S3 Storage Lens for the fastest-growing buckets and prefixes.",
            "Add lifecycle rules to move or expire old objects and noncurrent versions.",
        ],
    },
]

WEIGHTS = {"family": 3.0, "effect": 3.0, "shape": 2.0, "env": 1.0, "usage": 2.0}


def family_of(service: str, usage_type: str) -> str:
    s, u = service.lower(), usage_type.lower()
    if "lambda" in s:
        return "serverless"
    if "sagemaker" in s or "p4d" in u or "g5" in u:
        return "ml" if "sagemaker" in s else "compute"
    if "ec2" in s or "emr" in s or "glue" in s:
        return "compute"
    if "rds" in s or "dynamodb" in s or "redshift" in s:
        return "database"
    if "s3" in s:
        return "storage"
    if "cloudwatch" in s:
        return "management"
    if "data transfer" in s or "regional" in u:
        return "transfer"
    if "vpc" in s or "cloudfront" in s or "nat" in u:
        return "networking"
    return "other"


def usage_tags(usage_type: str) -> set:
    u = usage_type.lower()
    tags = set()
    if "nat" in u:
        tags.add("nat")
    if "io" in u:
        tags.add("io")
    if "read" in u:
        tags.add("read")
    return tags


def env_of(account: str) -> str:
    a = account.lower()
    if "prod" in a:
        return "prod"
    if "staging" in a:
        return "staging"
    if "sandbox" in a:
        return "sandbox"
    return "other"


def retrieve(features: dict, k: int = 2):
    """Score every playbook entry against the anomaly's features; return the top-k with reasons."""
    scored = []
    max_score = 0.0
    for p in PLAYBOOK:
        sig = p["signature"]
        score, reasons, possible = 0.0, [], 0.0
        for key, w in WEIGHTS.items():
            if key not in sig:
                continue
            possible += w
            want = sig[key]
            have = features.get(key)
            if key == "usage":
                hit = bool(want & features.get("usage", set()))
            elif isinstance(want, set):
                hit = have in want
            else:
                hit = have == want
            if hit:
                score += w
                reasons.append(f"{key} = {have if key != 'usage' else ','.join(sorted(want & features.get('usage', set())))}")
            elif key in ("family", "effect"):
                score -= w  # a mismatch on a core feature counts against the entry
        norm = score / possible if possible else 0.0
        scored.append({"id": p["id"], "name": p["name"], "score": round(norm, 3), "reasons": reasons})
        max_score = max(max_score, norm)
    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[:k]


def entry(pid):
    return next(p for p in PLAYBOOK if p["id"] == pid)
