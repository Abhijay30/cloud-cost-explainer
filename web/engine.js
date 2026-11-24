/* Cloud Cost Explainer engine (browser + Node). Port of engine.py / playbook.py.
   Reads billing CSV in a stream, maps columns, aggregates to daily service lines,
   detects anomalies, explains them. Nothing leaves the browser. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ column mapping
  const FIELDS = [
    { id: 'date', label: 'Date', need: true, names: ['ChargePeriodStart', 'lineItem/UsageStartDate', 'UsageStartDate', 'usage_start_time', 'UsageDate', 'Date', 'BillingPeriodStart', 'day', 'usage_date'] },
    { id: 'cost', label: 'Cost', need: true, names: ['EffectiveCost', 'BilledCost', 'lineItem/NetUnblendedCost', 'lineItem/UnblendedCost', 'lineItem/BlendedCost', 'CostInBillingCurrency', 'PreTaxCost', 'cost', 'Cost', 'Amount', 'UnblendedCost'] },
    { id: 'account', label: 'Account', names: ['SubAccountName', 'SubAccountId', 'lineItem/UsageAccountName', 'lineItem/UsageAccountId', 'SubscriptionName', 'SubscriptionId', 'project.name', 'project_name', 'project.id', 'AccountName', 'Account', 'LinkedAccount'] },
    { id: 'service', label: 'Service', names: ['ServiceName', 'product/ProductName', 'product/servicename', 'lineItem/ProductCode', 'MeterCategory', 'ConsumedService', 'service.description', 'service_description', 'Service', 'Product'] },
    { id: 'region', label: 'Region', names: ['RegionId', 'RegionName', 'product/region', 'product/regionCode', 'ResourceLocation', 'location.region', 'location_region', 'Region', 'Location'] },
    { id: 'usage', label: 'Usage type', names: ['x_UsageType', 'lineItem/UsageType', 'UsageType', 'MeterSubCategory', 'MeterName', 'sku.description', 'sku_description', 'SkuDescription', 'ChargeDescription', 'ResourceType'] },
    { id: 'qty', label: 'Quantity', names: ['PricingQuantity', 'ConsumedQuantity', 'lineItem/UsageAmount', 'UsageQuantity', 'Quantity', 'usage.amount', 'usage_amount', 'UsageAmount'] },
    { id: 'unit', label: 'Unit', names: ['PricingUnit', 'ConsumedUnit', 'pricing/unit', 'lineItem/PricingUnit', 'UnitOfMeasure', 'usage.unit', 'usage_unit', 'Unit'] },
    { id: 'category', label: 'Charge type', names: ['ChargeCategory', 'lineItem/LineItemType', 'ChargeType', 'cost_type', 'LineItemType'] },
    { id: 'tags', label: 'Tags', names: ['Tags', 'resourceTags', 'labels', 'tags'] },
    { id: 'team', label: 'Team', names: ['resourceTags/user:team', 'resourceTags/user:Team', 'tag:team', 'Team', 'team', 'resourceTags/user:owner', 'Owner'] },
    { id: 'currency', label: 'Currency', names: ['BillingCurrency', 'lineItem/CurrencyCode', 'BillingCurrencyCode', 'Currency', 'currency'] },
  ];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  function autoMap(header) {
    const byNorm = new Map(header.map((h, i) => [norm(h), i]));
    const map = {};
    for (const f of FIELDS) {
      map[f.id] = -1;
      for (const n of f.names) {
        const i = byNorm.get(norm(n));
        if (i !== undefined) { map[f.id] = i; break; }
      }
    }
    return map;
  }

  // ------------------------------------------------------------------ streaming CSV
  // Calls onRecord(fields[]) for each record. Handles quotes, CRLF, chunk boundaries.
  function makeCsvParser(onRecord) {
    let delim = null, field = '', rec = [], inQ = false, quoteSeen = false, pendingCR = false, head = '';
    function detect(text) {
      head += text;
      const nl = head.search(/\r?\n/);
      if (nl < 0 && head.length < 65536) return false;
      const line = nl < 0 ? head : head.slice(0, nl);
      const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
      let q = false;
      for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
      delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      if (counts[delim] === 0) delim = ',';
      const t = head; head = '';
      feed(t);
      return true;
    }
    function feed(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQ) {
          if (ch === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; }
            else if (i + 1 === text.length) { quoteSeen = true; inQ = false; }
            else inQ = false;
          } else field += ch;
          continue;
        }
        if (quoteSeen) { quoteSeen = false; if (ch === '"') { field += '"'; inQ = true; continue; } }
        if (ch === '"' && field === '') { inQ = true; }
        else if (ch === delim) { rec.push(field); field = ''; }
        else if (ch === '\n') { rec.push(field); field = ''; if (rec.length > 1 || rec[0] !== '') onRecord(rec); rec = []; }
        else if (ch === '\r') { /* ignore */ }
        else field += ch;
      }
    }
    return {
      push(text) { if (delim === null) { detect(text); } else feed(text); },
      end() {
        if (delim === null) { delim = ','; const t = head; head = ''; feed(t); }
        if (field !== '' || rec.length) { rec.push(field); onRecord(rec); }
        field = ''; rec = [];
      },
      get delimiter() { return delim; },
    };
  }

  // ------------------------------------------------------------------ dates and numbers
  function toDay(v) {
    if (!v) return null;
    v = String(v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v); // US style M/D/YYYY (Azure exports)
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = /^(\d{1,2})[.-](\d{1,2})[.-](\d{4})/.exec(v); // D.M.YYYY or D-M-YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const t = Date.parse(v);
    return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  }
  const num = (v) => {
    if (v === undefined || v === null || v === '') return NaN;
    const x = parseFloat(String(v).replace(/[,$€£₹\s]/g, ''));
    return x;
  };
  const dayMs = 864e5;
  const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * dayMs).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / dayMs);

  function teamFrom(tags, teamCol) {
    if (teamCol) return teamCol;
    if (!tags) return '';
    try {
      const o = JSON.parse(tags);
      if (o && typeof o === 'object') return o.team || o.Team || o.owner || o.Owner || '';
    } catch (e) { /* not JSON */ }
    const m = /(?:^|[;,{ ])"?(?:team|Team)"?\s*[:=]\s*"?([^";,}]+)/.exec(tags);
    return m ? m[1].trim() : '';
  }

  // ------------------------------------------------------------------ aggregation
  function makeAggregator(map) {
    const lines = new Map();
    let rows = 0, used = 0, skipped = 0, otherCost = 0, currency = '', minDay = null, maxDay = null, badDates = 0;
    const g = (r, k) => (map[k] >= 0 ? r[map[k]] : '');
    return {
      add(r) {
        rows++;
        const day = toDay(g(r, 'date'));
        const cost = num(g(r, 'cost'));
        if (!day) { badDates++; skipped++; return; }
        if (isNaN(cost)) { skipped++; return; }
        if (!currency && map.currency >= 0) currency = String(g(r, 'currency')).trim();
        const cat = map.category >= 0 ? String(g(r, 'category')).toLowerCase() : '';
        if (cat && !(cat.includes('usage') || cat === 'regular' || cat === 'usage')) { otherCost += cost; return; }
        used++;
        if (!minDay || day < minDay) minDay = day;
        if (!maxDay || day > maxDay) maxDay = day;
        const account = String(g(r, 'account') || '').trim() || 'All accounts';
        const service = String(g(r, 'service') || 'All services').trim() || 'Unknown service';
        const region = String(g(r, 'region') || '').trim() || 'global';
        const usage = String(g(r, 'usage') || '').trim() || 'all usage';
        const key = account + '\u0001' + service + '\u0001' + region + '\u0001' + usage;
        let L = lines.get(key);
        if (!L) {
          L = { account, service, region, usage, unit: String(g(r, 'unit') || '').trim(), teams: new Map(), days: new Map() };
          lines.set(key, L);
        }
        const team = teamFrom(map.tags >= 0 ? g(r, 'tags') : '', map.team >= 0 ? String(g(r, 'team')).trim() : '');
        if (team) L.teams.set(team, (L.teams.get(team) || 0) + Math.abs(cost));
        const q = num(g(r, 'qty'));
        const cur = L.days.get(day) || [0, 0];
        cur[0] += cost; cur[1] += isNaN(q) ? 0 : q;
        L.days.set(day, cur);
      },
      finish() {
        if (!minDay) return { error: 'No usable rows: check that the Date and Cost columns are right.', rows, skipped, badDates };
        const n = diffDays(minDay, maxDay) + 1;
        const days = Array.from({ length: n }, (_, i) => addDays(minDay, i));
        const series = [];
        for (const L of lines.values()) {
          const c = new Float64Array(n), q = new Float64Array(n);
          for (const [d, v] of L.days) { const i = diffDays(minDay, d); c[i] = v[0]; q[i] = v[1]; }
          let team = '', best = -1;
          for (const [t, v] of L.teams) if (v > best) { best = v; team = t; }
          series.push({ account: L.account, service: L.service, region: L.region, usage: L.usage, unit: L.unit, team, cost: c, qty: q });
        }
        return { days, series, rows, used, skipped, badDates, otherCost, currency: currency || 'USD', hasQty: map.qty >= 0 };
      },
    };
  }

  function fromSample(S) {
    const days = Array.from({ length: S.n }, (_, i) => addDays(S.start, i));
    const series = S.series.map((s) => ({ account: s.a, service: s.s, region: s.r, usage: s.u, unit: s.unit, team: s.t,
      cost: Float64Array.from(s.c), qty: Float64Array.from(s.q) }));
    return { days, series, rows: S.rows, used: S.rows, skipped: 0, badDates: 0, otherCost: S.other, currency: S.currency, hasQty: true };
  }

  // ------------------------------------------------------------------ stats helpers
  function median(a) {
    if (!a.length) return NaN;
    const s = Float64Array.from(a).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  }
  function spearman(x, y) {
    const rx = ranks(x), ry = ranks(y), n = x.length;
    const mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
    let num_ = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num_ += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
    return dx && dy ? num_ / Math.sqrt(dx * dy) : 0;
  }

  const DEFAULTS = { warmup: 28, window: 28, z: 4, materiality: 40, minScale: 0.04, driftRatio: 1.25, driftRho: 0.6, rebase: 21 };

  // ------------------------------------------------------------------ detection (one series)
  function detectSeries(cost, qty, wk, P) {
    const n = cost.length;
    let first = 0;
    while (first < n && cost[first] <= 0) first++;
    const logc = Array.from(cost, (c) => Math.log(Math.max(c, 0.01)));
    const base = new Array(n).fill(NaN), bq = new Array(n).fill(NaN), bp = new Array(n).fill(NaN), z = new Array(n).fill(0);
    const flag = new Array(n).fill(false), excl = new Array(n).fill(false), accepted = new Array(n).fill(false), kind = new Array(n).fill('');
    let streak = 0, acceptedFrom = first;
    for (let d = first + P.warmup; d < n; d++) {
      const lo = Math.max(acceptedFrom, d - P.window * 2, first);
      let hist = [];
      for (let i = lo; i < d; i++) if (!excl[i]) hist.push(i);
      hist = hist.slice(-P.window);
      if (hist.length < 10) { hist = []; for (let i = Math.max(first, d - P.window); i < d; i++) hist.push(i); }
      const hl = hist.map((i) => logc[i]);
      const medAll = median(hl);
      const wkVals = hist.filter((i) => wk[i]).map((i) => logc[i]);
      const weVals = hist.filter((i) => !wk[i]).map((i) => logc[i]);
      const adjWk = wkVals.length >= 3 ? median(wkVals) - medAll : 0;
      const adjWe = weVals.length >= 3 ? median(weVals) - medAll : 0;
      const b = medAll + (wk[d] ? adjWk : adjWe);
      const resid = hist.map((i) => logc[i] - (medAll + (wk[i] ? adjWk : adjWe)));
      const rm = median(resid);
      const scale = Math.max(1.4826 * median(resid.map((x) => Math.abs(x - rm))), P.minScale);
      base[d] = Math.exp(b);
      z[d] = (logc[d] - b) / scale;
      const same = hist.filter((i) => wk[i] === wk[d]);
      bq[d] = median((same.length >= 3 ? same : hist).map((i) => qty[i]));
      const prices = hist.filter((i) => qty[i] > 0).map((i) => cost[i] / qty[i]);
      bp[d] = prices.length ? median(prices) : NaN;
      const excess = cost[d] - base[d];
      if (z[d] > P.z && excess > P.materiality) { flag[d] = true; kind[d] = 'level'; }
      else if (d >= first + P.warmup + 7) {
        const older = [];
        for (let i = Math.max(acceptedFrom, d - 35, first); i < d - 7; i++) if (!excl[i]) older.push(cost[i]);
        if (older.length >= 10) {
          const o = median(older);
          let rec = 0; for (let i = d - 6; i <= d; i++) rec += cost[i]; rec /= 7;
          const y = []; for (let i = d - 13; i <= d; i++) y.push(cost[i]);
          const rho = spearman(y.map((_, i) => i), y);
          if (o > 0 && rec / o > P.driftRatio && rho > P.driftRho && rec - o > P.materiality) { flag[d] = true; kind[d] = 'drift'; }
        }
      }
      excl[d] = flag[d];
      streak = flag[d] ? streak + 1 : 0;
      if (streak >= P.rebase) {
        acceptedFrom = d - 6;
        for (let i = d - 6; i <= d; i++) excl[i] = false;
        accepted[d] = true;
        streak = 0;
      }
    }
    return { first, base, bq, bp, z, flag, kind, accepted };
  }

  function runs(flag, gap = 1) {
    const out = [];
    let s = -1, prev = -1;
    for (let i = 0; i < flag.length; i++) {
      if (!flag[i]) continue;
      if (s < 0) { s = prev = i; continue; }
      if (i - prev <= gap + 1) { prev = i; continue; }
      out.push([s, prev]); s = prev = i;
    }
    if (s >= 0) out.push([s, prev]);
    return out;
  }

  // ------------------------------------------------------------------ playbook
  const PLAYBOOK = [
    { id: 'P01', name: 'Idle or forgotten compute', sig: { family: ['compute', 'ml'], effect: 'volume', shape: ['step'], env: ['sandbox', 'staging', 'dev'] },
      causes: 'Instances, GPU nodes or an autoscaling group were launched for a test or experiment and never stopped.',
      checks: ['List running instances in the account created on or just before the start date.', 'Check the new resources for missing owner or expiry tags.', 'Add an auto-stop schedule or expiry policy for sandbox and staging accounts.'] },
    { id: 'P02', name: 'NAT Gateway data processing surge', sig: { family: ['networking'], effect: 'volume', shape: ['spike', 'step'], usage: ['nat'] },
      causes: 'Traffic to cloud services such as object storage is going through the NAT Gateway instead of a free gateway endpoint.',
      checks: ['Check route tables for an S3 or DynamoDB gateway endpoint.', 'Find which subnets or jobs started sending traffic on the start date (flow logs).', 'Route bulk storage traffic through a gateway endpoint.'] },
    { id: 'P03', name: 'Logging or monitoring ingestion creep', sig: { family: ['management'], effect: 'volume', shape: ['drift', 'step'] },
      causes: 'Log volume grew after a change in log level, a noisy new log statement, or a service that ships every request to the log pipeline.',
      checks: ['Find which log groups grew the most.', 'Compare deploys around the start date for log-level changes.', 'Set retention policies and filter DEBUG output in production.'] },
    { id: 'P04', name: 'Runaway serverless invocations', sig: { family: ['serverless'], effect: 'volume', shape: ['spike'] },
      causes: 'A function is invoking itself through an event source, or a retry storm is re-running failed events.',
      checks: ['Look at invocation count and concurrency for the function that day.', 'Check whether it writes to the bucket or queue that triggers it.', 'Turn on recursive-loop detection and set a concurrency limit.'] },
    { id: 'P05', name: 'Cross-region or inter-zone data transfer', sig: { family: ['transfer'], effect: 'volume', shape: ['spike', 'step'] },
      causes: 'A backup, replication or migration job is copying large volumes between regions or zones.',
      checks: ['Check backup, DR and replication jobs that ran in that window.', 'Confirm copies are incremental rather than full.', 'Compress data or keep copies in the same region where possible.'] },
    { id: 'P06', name: 'Commitment expiry (Savings Plan / reservation)', sig: { family: ['compute', 'database'], effect: 'rate', shape: ['step'] },
      causes: 'Usage stayed flat but the price per unit rose, which usually means a Savings Plan or reservation stopped covering this usage.',
      checks: ['Check Savings Plan and reservation expiry dates and coverage for the start date.', 'Confirm the instance family or region did not change.', 'Renew or re-buy commitments for the steady baseline.'] },
    { id: 'P07', name: 'Database I/O or query regression', sig: { family: ['database'], effect: 'volume', shape: ['spike', 'step'], usage: ['io', 'read'] },
      causes: 'A new or changed query is scanning far more data, often because an index was removed or a plan changed.',
      checks: ['Find the top statements by I/O for the window.', 'Compare schema migrations deployed just before the start date.', 'Restore the index or rewrite the query.'] },
    { id: 'P08', name: 'Organic traffic growth', sig: { family: ['compute', 'networking', 'serverless', 'database'], effect: 'volume', shape: ['drift'], env: ['prod'] },
      causes: 'Spend is rising with real customer traffic. This may be expected; check it against business numbers.',
      checks: ['Compare cost per order or per request before and after.', 'If unit cost is flat, treat it as growth, not waste.'] },
    { id: 'P09', name: 'Storage accumulation', sig: { family: ['storage'], effect: 'volume', shape: ['drift', 'step'] },
      causes: 'Data is piling up without lifecycle rules: old versions, snapshots, or temporary data that is never deleted.',
      checks: ['Find the fastest-growing buckets or containers.', 'Add lifecycle rules to move or expire old objects and versions.'] },
    { id: 'P10', name: 'New spend on a line that had none', sig: { shape: ['new'] },
      causes: 'Cost appeared on a service, region or usage type that had no spend before: a new deployment, a new region, or a resource someone launched.',
      checks: ['Find who created the first resources on this line, and whether it was planned.', 'Check the resources carry owner and cost-centre tags.', 'If it was planned, add it to planned events so it is not flagged again.'] },
  ];
  const WEIGHTS = { family: 3, effect: 3, shape: 2, env: 1, usage: 2 };

  function familyOf(service, usage) {
    const s = service.toLowerCase(), u = usage.toLowerCase();
    if (/lambda|functions|cloud run|cloud functions|serverless|fargate/.test(s)) return 'serverless';
    if (/sagemaker|machine learning|vertex|bedrock|openai|cognitive|\bai\b/.test(s)) return 'ml';
    if (/p4d|p5|g5|gpu/.test(u)) return 'compute';
    if (/ec2|elastic compute|compute engine|virtual machine|emr|glue|kubernetes|eks|aks|gke|batch|databricks|dataproc|app service/.test(s)) return 'compute';
    if (/rds|dynamo|redshift|aurora|sql|database|cosmos|bigquery|spanner|elasticache|redis|documentdb|snowflake/.test(s)) return 'database';
    if (/s3|storage|blob|glacier|ebs|efs|disk|backup/.test(s)) return 'storage';
    if (/cloudwatch|monitor|logging|log analytics|stackdriver|cloudtrail|insights/.test(s)) return 'management';
    if (/data transfer|bandwidth|egress|inter-region|interregion/.test(s) || /regional|inter|transfer|egress/.test(u)) return 'transfer';
    if (/vpc|cloudfront|cdn|network|nat|load balanc|front door|gateway/.test(s) || /nat/.test(u)) return 'networking';
    return 'other';
  }
  function usageTags(u) {
    u = u.toLowerCase();
    const t = [];
    if (u.includes('nat')) t.push('nat');
    if (/\bio\b|io[a-z]*usage|iops|storageio/.test(u)) t.push('io');
    if (u.includes('read')) t.push('read');
    return t;
  }
  function envOf(a) {
    a = a.toLowerCase();
    if (/prod/.test(a)) return 'prod';
    if (/stag|test|qa|uat/.test(a)) return 'staging';
    if (/sandbox|dev|experiment|lab/.test(a)) return 'sandbox';
    return 'other';
  }
  function retrieve(f) {
    const scored = PLAYBOOK.filter((p) => !(p.sig.effect === 'rate' && f.effect !== 'rate')).map((p) => {
      let score = 0, possible = 0;
      const reasons = [];
      for (const [k, w] of Object.entries(WEIGHTS)) {
        if (!(k in p.sig)) continue;
        if (f[k] === null || f[k] === undefined) continue;
        possible += w;
        const want = p.sig[k];
        const hit = k === 'usage' ? want.some((x) => f.usage.includes(x)) : Array.isArray(want) ? want.includes(f[k]) : want === f[k];
        if (hit) { score += w; reasons.push(`${k === 'usage' ? 'usage type' : k} = ${k === 'usage' ? want.filter((x) => f.usage.includes(x)).join(', ') : f[k]}`); }
        else if (k === 'family' || k === 'effect') score -= w;
      }
      return { id: p.id, name: p.name, score: possible ? score / possible : 0, reasons };
    }).sort((a, b) => b.score - a.score);
    return scored;
  }

  // ------------------------------------------------------------------ calendar
  function calendarMatch(ev, events) {
    for (const e of events || []) {
      if (!e.start || !e.end) continue;
      if (ev.start > addDays(e.end, 1) || ev.end < addDays(e.start, -1)) continue;
      if (e.account && e.account.trim() && e.account.trim() !== ev.account) continue;
      if (e.service && e.service.trim() && !ev.service.toLowerCase().includes(e.service.trim().toLowerCase())) continue;
      return e;
    }
    return null;
  }

  // ------------------------------------------------------------------ main analysis
  function analyse(data, opts = {}) {
    const P = { ...DEFAULTS, ...(opts.params || {}) };
    const events = opts.events || [];
    const { days, series } = data;
    const n = days.length;
    const wk = days.map((d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w >= 1 && w <= 5; });
    const total = new Float64Array(n);
    const byAcct = new Map();
    for (const s of series) {
      let a = byAcct.get(s.account);
      if (!a) { a = new Float64Array(n); byAcct.set(s.account, a); }
      for (let i = 0; i < n; i++) { total[i] += s.cost[i]; a[i] += s.cost[i]; }
    }
    // account delta vs trailing 28-day median (for share of change)
    const acctDelta = new Map();
    for (const [a, arr] of byAcct) {
      const d = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const h = [];
        for (let j = Math.max(0, i - P.window); j < i; j++) h.push(arr[j]);
        d[i] = h.length >= 10 ? arr[i] - median(h) : 0;
      }
      acctDelta.set(a, d);
    }
    const money = (v) => fmtMoney(v, data.currency);
    const out = [];
    const detail = new Map();
    let scored = 0;
    for (const s of series) {
      let mx = 0; for (let i = 0; i < n; i++) if (s.cost[i] > mx) mx = s.cost[i];
      if (mx < P.materiality) continue; // can never reach the materiality floor
      scored++;
      const det = detectSeries(s.cost, s.qty, wk, P);
      const sid = [s.account, s.service, s.region, s.usage].join(' | ');
      // new spend: line appears after the data starts and runs above the materiality floor
      if (det.first >= P.warmup && det.first < n) {
        const end = Math.min(n - 1, det.first + 6);
        let sum = 0; for (let i = det.first; i <= end; i++) sum += s.cost[i];
        if (sum / (end - det.first + 1) > P.materiality) {
          out.push(explainNew(s, det.first, end, sum, data, money, events, sid));
          detail.set(sid, { s, det });
        }
      }
      for (const [a, b] of runs(det.flag)) {
        out.push(explain(s, det, a, b, data, acctDelta.get(s.account), money, events, sid, P));
        detail.set(sid, { s, det });
      }
    }
    out.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : y.excess - x.excess));
    out.forEach((e, i) => { e.id = 'X' + String(i + 1).padStart(2, '0'); });
    return { params: P, days, total, byAcct, events: out, detail, scored, lines: series.length };
  }

  function fmtMoney(v, cur) {
    const sym = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', AUD: 'A$', CAD: 'C$' }[String(cur || 'USD').toUpperCase()];
    const s = Math.round(Math.abs(v)).toLocaleString('en-US');
    return (v < 0 ? '−' : '') + (sym ? sym + s : s + ' ' + cur);
  }
  const fmtPrice = (p, cur) => {
    const sym = { USD: '$', EUR: '€', GBP: '£', INR: '₹' }[String(cur || 'USD').toUpperCase()] || '';
    return sym + (p >= 0.1 ? p.toFixed(2) : p.toFixed(4));
  };
  const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const unitWord = (u) => ({ Hrs: 'hours', Hours: 'hours', 'GB-Mo': 'GB-months', GB: 'GB' }[u] || u || 'units');
  const shortUsage = (u) => String(u).split(':').pop();
  const whereOf = (s) => `${s.service}${s.usage && s.usage !== 'all usage' ? ` (${shortUsage(s.usage)})` : ''}${s.account !== 'All accounts' ? ' in ' + s.account : ''}${s.region && s.region !== 'global' ? (s.account !== 'All accounts' ? ', ' : ' in ') + s.region : ''}`;

  function explain(s, det, a, b, data, aDelta, money, events, sid, P) {
    const days = b - a + 1;
    let excess = 0, usualSum = 0, actualSum = 0, peak = 0, vol = 0, rate = 0, q0s = 0, q1s = 0, p0s = 0, p1s = 0, pn = 0;
    const ratio = [];
    for (let i = a; i <= b; i++) {
      const c = s.cost[i], bs = det.base[i];
      excess += Math.max(0, c - bs); usualSum += bs; actualSum += c;
      ratio.push(c / bs); peak = Math.max(peak, c / bs);
      const q1 = s.qty[i], q0 = det.bq[i], p0 = det.bp[i];
      if (data.hasQty && q1 > 0 && !isNaN(p0)) {
        const p1 = c / q1;
        vol += (q1 - q0) * p0; rate += q1 * (p1 - p0);
        q0s += q0; q1s += q1; p0s += p0; p1s += p1; pn++;
      }
    }
    const usual = usualSum / days, actual = actualSum / days;
    let effect = null;
    if (pn) { const tot = Math.abs(vol) + Math.abs(rate); effect = tot && Math.abs(vol) / tot < 0.35 ? 'rate' : 'volume'; }
    const rising = days >= 5 && spearman(ratio.map((_, i) => i), ratio) > 0.6 && ratio[0] < 0.6 * Math.max(...ratio);
    const shape = rising ? 'drift' : days <= 2 ? 'spike' : 'step';
    let acct = 0; for (let i = a; i <= b; i++) acct += Math.max(0, aDelta[i]);
    const share = acct > 0 ? Math.min(1, excess / acct) : 1;
    const f = { family: familyOf(s.service, s.usage), effect, shape, env: envOf(s.account), usage: usageTags(s.usage) };
    let matches = retrieve(f);
    const start = data.days[a], end = data.days[b];
    const when = days === 1 ? fmtDate(start) : `${fmtDate(start)} to ${fmtDate(end)} (${days} days)`;
    const where = whereOf(s);
    const verb = shape === 'drift' ? 'has been creeping up' : shape === 'spike' ? 'spiked' : 'jumped';
    const L = [`Spend on ${where} ${verb}: it averaged ${money(actual)}/day over ${when}, against a usual ${money(usual)}/day, and the worst day was ${peak.toFixed(1)}× normal.`,
      `The extra cost was ${money(excess)} in total.`];
    const u = unitWord(s.unit);
    if (effect === 'volume') L.push(`This was driven by usage, not price: quantity went from about ${Math.round(q0s / pn).toLocaleString('en-US')} to ${Math.round(q1s / pn).toLocaleString('en-US')} ${u} per day while the unit price stayed near ${fmtPrice(p0s / pn, data.currency)}.`);
    else if (effect === 'rate') L.push(`Usage hardly changed (${Math.round(q0s / pn).toLocaleString('en-US')} vs ${Math.round(q1s / pn).toLocaleString('en-US')} ${u} per day), but the unit price rose from ${fmtPrice(p0s / pn, data.currency)} to ${fmtPrice(p1s / pn, data.currency)} (${((p1s / p0s - 1) * 100 >= 0 ? '+' : '')}${Math.round((p1s / p0s - 1) * 100)}%), so this is a pricing change, not more usage.`);
    else L.push('The file has no usage quantity column, so a change in usage cannot be told apart from a change in price.');
    L.push(`It accounts for ${Math.round(share * 100)}% of the increase ${s.account === 'All accounts' ? 'in the whole bill' : `in the ${s.account} account`} over the same days${s.team ? ` (team: ${s.team})` : ''}.`);
    const cal = calendarMatch({ start, end, account: s.account, service: s.service }, events);
    let checks;
    if (cal) {
      L.push(`This lines up with a planned event, "${cal.name}", so it is marked as expected rather than raised as an alert.`);
      matches = [{ id: 'CAL', name: cal.name, score: 1, reasons: ['dates and scope match a planned event'] }, matches[0]];
      checks = ['Confirm the increase ends when the event ends.', 'Compare cost per order or request during the event with normal days.'];
    } else {
      const top = PLAYBOOK.find((p) => p.id === matches[0].id);
      if (matches[0].score >= 0.5) { L.push(`Most likely pattern: ${top.name}. ${top.causes}`); checks = top.checks; }
      else { L.push('It does not clearly match any known pattern, so start with who changed what on this line around the start date.'); checks = ['Look at deploys, config changes and new resources on this line around the start date.', 'Check whether usage, price or both moved.']; matches = [{ id: '—', name: 'No clear match', score: matches[0].score, reasons: [] }, matches[0]]; }
    }
    let accOn = null;
    for (let i = a; i <= b; i++) if (det.accepted[i]) { accOn = data.days[i]; break; }
    if (accOn) L.push(`After ${P.rebase} days at this level the explainer started treating it as the new normal on ${fmtDate(accOn)}; it should still be fixed, not ignored.`);
    return { sid, a, b, start, end, days, account: s.account, service: s.service, region: s.region, usage: s.usage, team: s.team, unit: s.unit,
      excess, usual, actual, peak, vol, rate, effect, shape, share, pattern: matches[0], runnerUp: matches[1], checks,
      status: cal ? 'expected' : 'alert', severity: cal ? 'expected' : excess >= 3000 ? 'high' : excess >= 800 ? 'medium' : 'low',
      explanation: L.join(' '), acceptedOn: accOn };
  }

  function explainNew(s, a, b, sum, data, money, events, sid) {
    const start = data.days[a], end = data.days[b];
    const where = whereOf(s);
    const p = PLAYBOOK.find((x) => x.id === 'P10');
    const cal = calendarMatch({ start, end, account: s.account, service: s.service }, events);
    const L = [`New spend started on ${where} on ${fmtDate(start)}: it averaged ${money(sum / (b - a + 1))}/day over its first ${b - a + 1} days, where there was nothing before.`,
      cal ? `This lines up with a planned event, "${cal.name}", so it is marked as expected.` : `${p.causes}`];
    return { sid, a, b, start, end, days: b - a + 1, account: s.account, service: s.service, region: s.region, usage: s.usage, team: s.team, unit: s.unit,
      excess: sum, usual: 0, actual: sum / (b - a + 1), peak: Infinity, vol: sum, rate: 0, effect: 'volume', shape: 'new', share: null,
      pattern: cal ? { id: 'CAL', name: cal.name, score: 1, reasons: ['dates and scope match a planned event'] } : { id: 'P10', name: p.name, score: 1, reasons: ['no spend on this line before'] },
      runnerUp: null, checks: p.checks, status: cal ? 'expected' : 'alert', severity: cal ? 'expected' : sum >= 3000 ? 'high' : sum >= 800 ? 'medium' : 'low',
      explanation: L.join(' '), acceptedOn: null, isNew: true };
  }

  async function readFile(file, onProgress, mapOverride) {
    let stream = file.stream();
    const gz = /\.gz$/i.test(file.name);
    if (gz) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open .gz files. Unzip the file first.');
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    const reader = stream.getReader();
    const dec = new TextDecoder('utf-8');
    let header = null, map = null, agg = null, bytes = 0, first = true;
    const parser = makeCsvParser((rec) => {
      if (!header) {
        header = rec.map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h).trim());
        map = mapOverride ? { ...autoMap(header), ...mapOverride } : autoMap(header);
        if (map.date < 0 || map.cost < 0) throw Object.assign(new Error('need-mapping'), { header, map });
        agg = makeAggregator(map);
        return;
      }
      agg.add(rec);
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      parser.push(dec.decode(value, { stream: true }));
      if (onProgress) onProgress(gz ? null : bytes / file.size, agg ? agg : null);
      if (first) { first = false; }
    }
    parser.push(dec.decode());
    parser.end();
    if (!agg) throw new Error('The file looks empty.');
    const data = agg.finish();
    data.header = header; data.map = map; data.delimiter = parser.delimiter;
    return data;
  }

  const api = { FIELDS, autoMap, makeCsvParser, makeAggregator, fromSample, analyse, readFile, fmtMoney, fmtDate, toDay, PLAYBOOK, DEFAULTS, shortUsage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCE = api;
})(typeof window !== 'undefined' ? window : globalThis);
