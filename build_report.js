// Builds the project report (Word) from the result files.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, ImageRun, PageBreak, Footer, PageNumber, LevelFormat, ExternalHyperlink,
} = require('docx');

const HERE = __dirname;
const R = JSON.parse(fs.readFileSync(path.join(HERE, 'data/results.json')));
const ROB = JSON.parse(fs.readFileSync(path.join(HERE, 'data/robustness.json')));
const TRUTH = R.truth;
const FONT = 'Arial';
const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
const f2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2));

// ---------- helpers ----------
const P = (text, opts = {}) => new Paragraph({ spacing: { after: 120, line: 300 }, alignment: opts.align, children: runs(text, opts) });
function runs(text, opts = {}) {
  // **bold** and _italic_ markup
  const out = [];
  const re = /(\*\*[^*]+\*\*|~[^~]+~)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), size: opts.size, italics: opts.italics, color: opts.color }));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), bold: true, size: opts.size, color: opts.color }));
    else out.push(new TextRun({ text: t.slice(1, -1), italics: true, size: opts.size, color: opts.color }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), size: opts.size, italics: opts.italics, color: opts.color }));
  return out;
}
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const bullet = (t) => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60, line: 290 }, children: runs(t) });
const numbered = (t, ref = 'steps') => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 80, line: 290 }, children: runs(t) });
const caption = (t) => new Paragraph({ spacing: { before: 60, after: 220 }, alignment: AlignmentType.CENTER, children: runs(t, { size: 18, italics: true, color: '555555' }) });

function figure(file, widthIn, cap) {
  const buf = fs.readFileSync(path.join(HERE, 'fig', file));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const wpx = widthIn * 96;
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, keepNext: true,
      children: [new ImageRun({ type: 'png', data: buf, transformation: { width: wpx, height: Math.round(wpx * h / w) } })] }),
    caption(cap),
  ];
}

const CONTENT_W = 9026; // A4 with 1" margins, in DXA
const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const borders = { top: border, bottom: border, left: border, right: border };
function table(headers, rows, widths, opts = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = CONTENT_W / total;
  const w = widths.map((x) => Math.floor(x * scale));
  w[w.length - 1] += CONTENT_W - w.reduce((a, b) => a + b, 0);
  const cell = (text, i, head, bold) => new TableCell({
    width: { size: w[i], type: WidthType.DXA }, borders,
    shading: head ? { fill: 'E8EEF8', type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new Paragraph({ alignment: opts.right && opts.right.includes(i) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), size: 17, bold: head || bold })] })],
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: w,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, i, true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, i, false, opts.boldRow && opts.boldRow(r))) })),
    ],
  });
}

// ---------- numbers ----------
const meta = R.meta;
const alerts = R.events.filter((e) => e.status === 'alert');
const expected = R.events.filter((e) => e.status === 'expected');
const alertExcess = alerts.reduce((s, e) => s + e.excess_cost, 0);
const ev = Object.fromEntries(R.evaluation.map((r) => [r.method, r]));
const OURS = 'Explainer (with business calendar)';
const rkey = (s) => (s === 1 ? '1.0' : String(s));
const rs = (size, m) => ROB.summary[rkey(size)][m];
const a7 = alerts.find((e) => e.effect === 'rate');
const a1 = alerts.slice().sort((a, b) => b.excess_cost - a.excess_cost)[0];
const a3 = alerts.find((e) => e.shape === 'drift');
const fa = alerts.filter((e) => !TRUTH.some((t) => t.account === e.account && t.service === e.service && t.usage_type === e.usage_type
  && e.start <= t.end && e.end >= t.start));

// ---------- document body ----------
const body = [];

// Title block
body.push(
  new Paragraph({ spacing: { before: 1800, after: 200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Cloud Cost Explainer', bold: true, size: 48, font: FONT })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 600 }, children: [new TextRun({ text: 'Detecting and explaining cloud spend anomalies in FOCUS billing data', size: 28, color: '444444' })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Project Report', size: 24, bold: true })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Abhijay J R', size: 24 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Department of Computer Science and Engineering', size: 22 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: 'Dayananda Sagar University, Bengaluru', size: 22 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 1200 }, children: [new TextRun({ text: 'November 2026', size: 22 })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'All billing data in this report is synthetic. "Northwind Cloud Retail" is a made-up company.', size: 18, italics: true, color: '666666' })] }),
  new Paragraph({ children: [new PageBreak()] }),
);

// Abstract
body.push(H1('Abstract'));
body.push(P(`Cloud bills change every day, and the teams who pay them often find out about a costly mistake weeks later, when the invoice arrives. Existing anomaly alerts tell a team that spend went up, but usually not why, or what to check first. This project builds a **Cloud Cost Explainer**: a system that reads billing data in the FinOps Open Cost and Usage Specification (FOCUS) format, finds unusual spend on each service line, and writes a plain-English explanation of every anomaly. Each explanation states how much extra was spent, whether the cause was more usage or a higher unit price, how much of the account's increase it accounts for, and which known cost pattern it matches, with concrete checks to run.`));
body.push(P(`Because no public billing dataset comes with labelled anomalies, the system was tested on a synthetic six-month AWS bill (${meta.rows.toLocaleString()} FOCUS rows, ${meta.series} service lines, ${usd(meta.total_usage_cost + meta.total_other_cost)} total) with eight planted faults whose causes are known. The explainer found all eight with ${ev[OURS].false_alerts} false alarms (precision ${f2(ev[OURS].precision)}, recall ${f2(ev[OURS].recall)}, F1 ${f2(ev[OURS].f1)}), and matched every detected fault to the correct cause pattern and the correct usage-versus-price split. Across 40 regenerated datasets its detection was on par with an Isolation Forest and a rolling z-score that were given the same business calendar, not clearly better. The report's main finding is therefore that the explanation layer, and the business calendar, add the most value, while the detector itself is ordinary. All results come from synthetic data designed by the same author as the detector, which limits what they prove; Section 7 discusses this.`));
body.push(new Paragraph({ children: [new PageBreak()] }));

// 1. Introduction
body.push(H1('1. Introduction'));
body.push(P(`Public cloud pricing is pay-as-you-go, so a forgotten GPU instance, a misrouted network path or an expired discount starts costing money immediately. FinOps teams rely on anomaly alerts to catch these, but an alert that says "EC2 spend is up 40%" still leaves an engineer to work out which account, which resource type, whether the cause is usage or price, and whether it was planned. That triage step is slow and is where most of the cost of an anomaly builds up.`));
body.push(P(`This project asks a practical question: **given only the billing data, how much of that triage can be automated and explained in plain language?**`));
body.push(H2('1.1 Objectives'));
[
  'Build a detector that works on standard FOCUS billing rows, per service line, and copes with weekly cycles, growth and slow drift.',
  'For every anomaly, produce an explanation a non-specialist can act on: extra cost, usage-versus-price split, share of the account\'s increase, likely cause and checks.',
  'Separate planned spikes (sales, scheduled jobs) from real anomalies using a business calendar.',
  'Measure detection and explanation quality against known ground truth, and compare with standard baselines.',
  'Present the results in an interactive dashboard.',
].forEach((t) => body.push(numbered(t, 'objectives')));
body.push(H2('1.2 Contributions'));
[
  'A reproducible synthetic FOCUS-format dataset generator with eight labelled anomaly types and two labelled business events, controllable by random seed and anomaly size.',
  'A transparent detector and explainer, about 750 lines of Python, whose every number can be traced back to billing rows.',
  'A volume-versus-rate decomposition that distinguishes "we used more" from "we paid more per unit", which identified the Savings Plan expiry case that a plain threshold missed.',
  'An honest evaluation across 40 datasets that includes baselines given the same business calendar, so the gain from the calendar is not credited to the detector.',
  'An interactive dashboard (Claude Data artifact) showing spend, anomalies, explanations and scores.',
].forEach((t) => body.push(bullet(t)));

// 2. Background
body.push(H1('2. Background and related work'));
body.push(H2('2.1 The FOCUS billing format'));
body.push(P(`FOCUS is an open specification from the FinOps Foundation that defines common columns, types and values for cloud, SaaS and on-premises billing data, so that bills from different providers can be analysed the same way. Version 1.4 was ratified on 4 June 2026 [1]. Two of its cost columns matter most here. **BilledCost** is what appears on the invoice, while **EffectiveCost** spreads commitment purchases (Savings Plans, reservations) across the usage they cover [2]. A one-year reservation paid up front therefore shows a large BilledCost on day one, but its EffectiveCost appears day by day on the usage rows. This project works on EffectiveCost, because a jump in daily EffectiveCost reflects a real change in the cost of running something.`));
body.push(H2('2.2 Cost anomaly detection in practice'));
body.push(P(`AWS Cost Anomaly Detection uses machine-learning models to flag unusual spend and ranks root causes by dollar impact across four dimensions: service, account, region and usage type [3]. Since November 2024 it ranks combinations of these dimensions and shows up to ten root causes per anomaly [4], and in June 2026 AWS added an AI-assisted investigation that uses Amazon Q to explain an anomaly's root cause [5]. Commercial FinOps tools offer similar features. These services answer "which dimension moved", but the models are not open, so a team cannot see why something was or was not flagged, and they do not separate a price change from a usage change.`));
body.push(H2('2.3 Detection methods used as baselines'));
body.push(P(`Three common methods are used as comparison points. A **static threshold** flags any day more than 1.5 times the trailing seven-day mean. A **rolling z-score** flags days more than three standard deviations above a 28-day rolling mean. Both are simple, but the mean and standard deviation are pulled up by the very spikes they are trying to find. **Isolation Forest** [6] is an unsupervised method that isolates unusual points with random splits; it is widely used for anomaly detection and is available in scikit-learn [7]. The explainer's own detector instead uses the median and the median absolute deviation (MAD), which a few outliers barely move; this is the approach Leys et al. recommend over mean-and-standard-deviation rules [8].`));

// 3. Dataset
body.push(H1('3. Dataset'));
body.push(H2('3.1 Why synthetic data'));
body.push(P(`Real cloud bills are confidential, and the few public cloud cost datasets have no labels saying which days were anomalous or why. Without labels it is impossible to measure recall or check whether an explanation is right. A synthetic bill with planted faults gives exact ground truth, at the cost of realism. The generator (~generate_data.py~) is deterministic for a given seed.`));
body.push(H2('3.2 What the bill contains'));
body.push(P(`The bill covers a made-up online retailer, Northwind Cloud Retail, from 1 April to 30 September 2026 (183 days). It has four AWS accounts (prod-retail, staging, data-platform, ml-sandbox) and ${meta.series} service lines across EC2, RDS, S3, CloudFront, Lambda, CloudWatch, DynamoDB, EMR, VPC/NAT Gateway, Glue, Redshift, SageMaker and inter-region data transfer. Each line has its own baseline quantity, unit price, weekday-versus-weekend pattern, growth trend over the period and random day-to-day noise (log-normal, 1–25%). Monthly AWS Support fees and Savings Plan purchases are added as non-usage rows, following the FOCUS convention that a commitment purchase has BilledCost but zero EffectiveCost. Total EffectiveCost is ${usd(meta.total_usage_cost + meta.total_other_cost)}, of which ${usd(meta.total_usage_cost)} is usage.`));
body.push(table(['Column', 'Example', 'Used for'], [
  ['ChargePeriodStart', '2026-05-18T00:00:00Z', 'Day of the charge'],
  ['SubAccountName', 'ml-sandbox', 'Service line key; account share'],
  ['ServiceName / ServiceCategory', 'Amazon EC2 / Compute', 'Service line key; pattern family'],
  ['RegionId', 'us-east-1', 'Service line key'],
  ['x_UsageType (provider column)', 'BoxUsage:p4d.24xlarge', 'Service line key; pattern hints'],
  ['ChargeCategory', 'Usage / Purchase', 'Only Usage rows are scored'],
  ['PricingQuantity, PricingUnit', '54.1 Hrs', 'Volume side of the split'],
  ['EffectiveCost', '1,773.21', 'The cost that is scored'],
  ['BilledCost, ListCost', '—', 'Kept for completeness'],
  ['Tags', '{"team": "ml"}', 'Team named in explanations'],
], [2600, 2200, 3000]));
body.push(caption('Table 1. FOCUS columns in the dataset and how the explainer uses them. FOCUS 1.4 defines many more columns; this dataset uses a core subset.'));
body.push(H2('3.3 Planted anomalies and planned events'));
body.push(P(`Eight faults were planted, chosen to cover the main shapes a cost problem can take: sudden steps, one-day spikes, slow drift, and a pure price change with flat usage (Table 2). Two planned business events were also added: a five-day "Monsoon Mega Sale" that lifts traffic-linked production services by 25–45%, and a three-day Redshift resize for a quarterly close. These are **not** anomalies, and a detector that alerts on them is counted as raising false alarms.`));
body.push(table(['ID', 'What was planted', 'Service line', 'Dates', 'Shape'],
  TRUTH.map((t) => [t.id, t.title, `${t.service.replace('Amazon ', '').replace('AWS ', '')} · ${t.account}`, `${t.start.slice(5)} → ${t.end.slice(5)}`, t.kind]),
  [500, 3300, 2600, 1500, 700]));
body.push(caption('Table 2. The eight planted anomalies (ground truth). A7 changes only the unit price; A8 is deliberately small (about $130 a day).'));
body.push(...figure('fig2_daily.png', 6.3, `Figure 1. Daily usage spend for the whole company, with the explainer's alerts (red) and the events it marked as planned (grey).`));

// 4. Method
body.push(H1('4. How the explainer works'));
body.push(...figure('fig1_pipeline.png', 6.3, 'Figure 2. The explainer pipeline.'));
body.push(H2('4.1 Service lines and baselines'));
body.push(P(`Usage rows are grouped into daily series, one per account, service, region and usage type. For each day after a 28-day warm-up, the expected cost is the median of the last 28 **normal** days, shifted by the typical gap between weekdays and weekends in that window. "Normal" means not already flagged: excluding flagged days keeps a nine-day GPU incident from becoming its own baseline. The spread is 1.4826 × MAD of the log-cost residuals, with a floor of 0.04 so that very smooth series such as storage do not alert on tiny wobbles.`));
body.push(H2('4.2 Detection'));
body.push(P(`A day is flagged when its log cost is more than **4 robust standard deviations** above the baseline **and** the excess is at least **$40**. The dollar floor matters: without it, a 300% jump on a $5-a-day line would page someone. A second rule catches slow creep that never jumps far in one day: the last 7 days average at least 25% above the previous month, the last 14 days have a Spearman rank correlation above 0.6 with time (steadily rising), and the difference is at least $40 a day. Flagged days on the same line, with at most a one-day gap, are joined into a single event. If a line stays flagged for 21 days in a row, the new level is accepted as the baseline so that a permanent change does not alert forever; the explanation then says so, because accepting a level is not the same as fixing it.`));
body.push(H2('4.3 Explanation'));
body.push(P(`For each event the explainer computes the following and writes them into a fixed sentence template:`));
[
  '**Excess cost**: the sum over the event of actual cost minus baseline, and the average daily cost against the usual level.',
  '**Volume-versus-rate split**: with baseline quantity q₀ and unit price p₀, and actual q₁ and p₁, the change in cost is (q₁ − q₀)·p₀ (more usage) plus q₁·(p₁ − p₀) (higher price). If less than 35% of the change is from volume, the event is called a price change.',
  '**Shape**: spike (1–2 days), step (flat and sustained), or drift (rising steadily through the event).',
  '**Account share**: the event\'s excess as a share of the whole account\'s increase over the same days, which tells the reader whether this line is the whole story.',
  '**Pattern match**: the event\'s features (service family, effect, shape, environment, usage-type hints) are scored against a playbook of nine known cost patterns (Table 3). The best match supplies the likely cause and three checks. Each match lists the features that produced it, so the reasoning is visible.',
].forEach((t) => body.push(bullet(t)));
body.push(table(['ID', 'Pattern', 'Signature (simplified)'], [
  ['P01', 'Idle or forgotten compute', 'compute/ML · more usage · step · sandbox/staging'],
  ['P02', 'NAT Gateway processing surge', 'networking · more usage · NAT usage type'],
  ['P03', 'Logging ingestion creep', 'monitoring · more usage · drift/step'],
  ['P04', 'Runaway serverless invocations', 'serverless · more usage · spike'],
  ['P05', 'Cross-region data transfer', 'transfer · more usage · spike/step'],
  ['P06', 'Commitment expiry', 'compute/database · higher price · step'],
  ['P07', 'Database I/O or query regression', 'database · more usage · I/O or read usage type'],
  ['P08', 'Organic traffic growth', 'customer-facing · more usage · drift · prod'],
  ['P09', 'Storage accumulation', 'storage · more usage · drift/step'],
], [600, 3000, 4400]));
body.push(caption('Table 3. The pattern playbook. Weights: family 3, effect 3, usage-type hint 2, shape 2, environment 1; a mismatch on family or effect counts against the entry.'));
body.push(H2('4.4 Business calendar'));
body.push(P(`Events that overlap a planned business event in the right scope (an account, or an account and service) are kept and explained, but marked "expected" instead of raising an alert. The same filter was applied to every baseline in the evaluation, so the comparison measures the detectors, not the calendar.`));
body.push(H2('4.5 Implementation'));
body.push(P(`The system is written in Python (pandas, NumPy, SciPy, scikit-learn). ~generate_data.py~ builds the bill, ~engine.py~ detects, explains and evaluates, ~playbook.py~ holds the patterns, ~robustness.py~ runs the 40-dataset sweep, and ~export_dashboard.py~ writes the dashboard's data files. A full run on one dataset takes about 7 seconds. The dashboard is a Claude Data artifact built with d3; every number on it is linked to the data file it came from.`));

// 5. Results
body.push(H1('5. Results'));
body.push(H2('5.1 What the explainer found'));
body.push(P(`On the main dataset (seed 42) the explainer produced ${R.events.length} events: ${alerts.length} alerts and ${expected.length} events marked expected (five lines affected by the sale and the Redshift resize). The alerts cover ${usd(alertExcess)} of spend above normal. The largest was the forgotten GPU instances in ml-sandbox at ${usd(a1.excess_cost)}, ${Math.round(a1.excess_cost / alertExcess * 100)}% of the total. ${fa.length} alerts were false alarms: a one-day ${usd(fa[0].excess_cost)} blip on the same GPU line and a ${usd(fa[1].excess_cost)} DynamoDB blip, both random noise that crossed the threshold.`));
body.push(P(`Below is the explanation the system wrote for the largest anomaly, unedited:`));
body.push(new Paragraph({ spacing: { after: 160, line: 290 }, indent: { left: 567, right: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2F5FB3', space: 8 } },
  children: [new TextRun({ text: a1.explanation, italics: true, size: 20 })] }));
body.push(...figure('fig3_cases.png', 6.4, 'Figure 3. Three anomalies against their baselines (dashed). In A3 the baseline jumps after day 21, when the new level is accepted; the real fix came three days later, so the drop afterwards does not alert.'));
body.push(H2('5.2 Usage or price?'));
body.push(P(`The split separated the one price-driven fault from the rest (Figure 4). For the Savings Plan expiry (A7), ${usd(a7.rate_effect)} of the ${usd(a7.excess_cost)} excess came from a higher unit price and only ${usd(a7.volume_effect)} from usage, so the explanation reads: "Usage hardly changed … so this is a pricing change, not more usage." This is the case where the explanation saves the most time. An engineer looking only at a cost graph would start by hunting for new instances that do not exist.`));
body.push(...figure('fig4_split.png', 6.2, 'Figure 4. Extra cost in each alert, split into usage (blue) and price (orange) effects.'));
body.push(H2('5.3 Detection compared with baselines'));
const evalRows = R.evaluation.map((r) => [r.method, r.alerts, r.false_alerts, f2(r.precision), f2(r.recall), f2(r.f1), f2(r.mean_delay_days), r.missed.length ? r.missed.join(', ') : 'none']);
body.push(table(['Method', 'Alerts', 'False', 'Precision', 'Recall', 'F1', 'Delay (d)', 'Missed'], evalRows,
  [2700, 650, 650, 1050, 800, 650, 1000, 900], { right: [1, 2, 3, 4, 5, 6], boldRow: (r) => r[0] === OURS }));
body.push(caption('Table 4. Detection on the main dataset (8 planted anomalies). An alert is correct if it overlaps a planted anomaly on the same service line, within a day. Delay is days from the true start to the first alert.'));
body.push(P(`Without the calendar, every method alerts on the sale and the Redshift resize. The explainer's precision falls from ${f2(ev[OURS].precision)} to ${f2(ev['Explainer (no calendar)'].precision)}, and so the calendar is the single largest gain in precision. With the calendar applied to all methods, the rolling z-score comes close (F1 ${f2(ev['Rolling z-score + calendar'].f1)} against ${f2(ev[OURS].f1)}), although it splits some anomalies into several alerts. The static threshold misses both the slow log creep (A3) and the price-only change (A7). A ratio against the last seven days never jumps far enough for either.`));
body.push(H2('5.4 Robustness across 40 datasets'));
body.push(P(`One dataset can flatter a method. The bill was regenerated with ten noise seeds at four anomaly sizes (25%, 50%, 75% and 100% of the sizes in Table 2), and every method was rerun (Figure 5, Table 5).`));
body.push(...figure('fig5_robustness.png', 6.4, 'Figure 5. Mean F1 and recall over 10 datasets at each anomaly size; bars show ±1 standard deviation.'));
const robM = ['Explainer (with business calendar)', 'Isolation Forest + calendar', 'Rolling z-score + calendar', 'Static threshold + calendar', 'Explainer (no calendar)'];
body.push(table(['Method', 'F1 at 25%', 'F1 at 50%', 'F1 at 75%', 'F1 at 100%', 'False alarms at 100%'],
  robM.map((m) => [m, ...[0.25, 0.5, 0.75, 1.0].map((s) => `${f2(rs(s, m).f1_mean)} ± ${f2(rs(s, m).f1_sd)}`), rs(1.0, m).false_alerts_mean.toFixed(1)]),
  [3000, 1200, 1200, 1200, 1200, 1300], { right: [1, 2, 3, 4, 5] }));
body.push(caption('Table 5. Mean ± standard deviation over 10 datasets per anomaly size.'));
body.push(P(`At full size the explainer averaged F1 ${f2(rs(1.0, OURS).f1_mean)}, Isolation Forest with the calendar ${f2(rs(1.0, robM[1]).f1_mean)} and the z-score ${f2(rs(1.0, robM[2]).f1_mean)}. These differences are smaller than the spread between seeds, so **the explainer's detector is not better than a well-configured Isolation Forest**. Its recall matched or beat the z-score's at every size. The clearest difference is the price-only change: at full size the z-score missed A7 in 8 of 10 runs and the explainer in none, most likely because the explainer removes the weekday cycle before measuring noise. A 38% price rise on a line that already swings 15% between weekdays and weekends looks ordinary to a plain mean-and-standard-deviation rule. At 25% size, recall drops to about ${Math.round(rs(0.25, OURS).recall_mean * 100)}% for all three methods. The explainer's misses are the small staging fleet (A6, missed in all 10 runs), the price change shrunk to +9.5% (A7, missed in 8), and the slow log creep (A3, missed in 6).`));
body.push(H2('5.5 Are the explanations right?'));
const q = R.explanation_quality;
body.push(table(['ID', 'Detected after', 'Pattern found', 'Pattern expected', 'Usage/price split', 'Extra cost'],
  q.map((x) => [x.truth, `${x.delay_days} day${x.delay_days === 1 ? '' : 's'}`, x.pattern_top1, x.pattern_expected, `${x.effect_found} ${x.effect_correct ? '✓' : '✗'}`, usd(x.excess_cost)]),
  [600, 1300, 1300, 1400, 1700, 1300], { right: [5] }));
body.push(caption('Table 6. Explanation accuracy on the main dataset.'));
const e25 = ROB.summary['0.25']._explanation;
body.push(P(`On the main dataset every detected anomaly got the correct pattern and the correct usage-versus-price label. Across all 40 datasets, pattern accuracy was 100% at 75% and 100% size and ${(e25.pattern_accuracy * 100).toFixed(1)}% at 25% size (${Math.round(e25.detected * (1 - e25.pattern_accuracy))} errors in ${e25.detected} detected anomalies). This number should be read with care: the playbook and the planted faults were written by the same person, so a perfect match is the expected result, not evidence that the playbook would work on a real bill.`));

// 6. Dashboard
body.push(H1('6. The dashboard'));
body.push(P(`The interactive dashboard presents the same results for a reader who does not want to run code. It opens with a one-sentence summary and four headline figures (total spend, alerts raised, extra spend in alerts, detection F1 next to the best baseline). A daily spend chart shades every flagged period and can be filtered by account. Clicking a band or a row in the anomaly list opens that anomaly's detail: its cost against the baseline, the written explanation, the usage-versus-price bars, the matched pattern and the reasons for the match, the checks, and how it compares with the planted truth. Further sections show spend by service, the scores table and the robustness chart. Every number links to the data file it came from, including the code that produced it.`));

// 7. Discussion
body.push(H1('7. Limitations and threats to validity'));
[
  '**The test is circular.** The same author designed the faults, the detector and the playbook. The 100% pattern accuracy and perfect recall at full size show that the parts fit together, not that they generalise. A fair test needs real bills with incidents labelled by the people who fixed them.',
  '**Synthetic noise is too tidy.** Real bills have missing days, late-arriving charges, credits, refunds, currency effects and resources that change type. None of these are modelled, and each could cause false alarms.',
  '**The detector is not the contribution.** Isolation Forest matched it. A production version could swap in any detector and keep the explanation layer.',
  '**The calendar is doing a lot of work.** It raised precision by about 30 points. In practice, calendars go stale and teams forget to log events, so real precision would be lower.',
  '**Accepting a new level hides problems.** After 21 days a persistent fault becomes the baseline. The explanation says this, but an unread alert would still be lost.',
  '**Templates, not language.** The explanations are fixed sentences filled from numbers. They are consistent and checkable, but cannot describe a cause the playbook does not contain. In that case the system still gives the cost, split and share, but its likely cause will be the nearest wrong pattern.',
  '**One provider, one granularity.** Only AWS-style usage types and daily data were used. Hourly data would detect faster; multi-cloud FOCUS data would test whether the playbook features carry over.',
].forEach((t) => body.push(bullet(t)));

// 8. Conclusion
body.push(H1('8. Conclusion and future work'));
body.push(P(`The Cloud Cost Explainer shows that billing data alone is enough to answer most of the first questions an engineer asks about a cost spike: how much, where, since when, usage or price, and what it most likely is. On a synthetic six-month bill it found all eight planted faults with two false alarms and explained each one correctly. Its detection is no better than standard methods once they share a business calendar; its value lies in the explanation, especially the usage-versus-price split, which turned a confusing pricing change into a one-line diagnosis.`));
body.push(P(`The most useful next steps are, in order:`));
[
  'Test on real, labelled bills, for example from a university cloud account or a FinOps team willing to share anonymised incidents.',
  'Add resource-level drill-down (ResourceId) so explanations can name the instance or bucket.',
  'Learn playbook weights from labelled incidents instead of setting them by hand.',
  'Use a language model to phrase explanations, while keeping the numbers computed and cited as they are now, so the text cannot invent figures.',
  'Run hourly and stream alerts, to cut the time from fault to alert from a day to an hour.',
].forEach((t) => body.push(numbered(t, 'future')));

// References
body.push(H1('References'));
const refs = [
  ['FinOps Foundation. FOCUS: FinOps Open Cost and Usage Specification, version 1.4 (ratified 4 June 2026). ', 'https://focus.finops.org/'],
  ['Microsoft. "Learning FOCUS: Cost columns." Microsoft FinOps Blog, 5 December 2024. ', 'https://techcommunity.microsoft.com/blog/finopsblog/-/4352713'],
  ['Amazon Web Services. "Detecting unusual spend with AWS Cost Anomaly Detection." AWS Cost Management User Guide. ', 'https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html'],
  ['Amazon Web Services. "AWS delivers enhanced root cause insights to help explain cost anomalies." 25 November 2024. ', 'https://aws.amazon.com/about-aws/whats-new/2024/11/aws-enhanced-root-cause-insights-cost-anomalies'],
  ['Amazon Web Services. "AWS now provides AI-powered cost investigations for cost anomalies." 8 June 2026. ', 'https://aws.amazon.com/about-aws/whats-new/2026/06/aws-ai-powered-cost-investigations/'],
  ['F. T. Liu, K. M. Ting and Z.-H. Zhou. "Isolation Forest." Proc. IEEE International Conference on Data Mining (ICDM), 2008, pp. 413–422.', null],
  ['F. Pedregosa et al. "Scikit-learn: Machine Learning in Python." Journal of Machine Learning Research, 12, 2011, pp. 2825–2830.', null],
  ['C. Leys, C. Ley, O. Klein, P. Bernard and L. Licata. "Detecting outliers: Do not use standard deviation around the mean, use absolute deviation around the median." Journal of Experimental Social Psychology, 49(4), 2013, pp. 764–766.', null],
];
refs.forEach(([t, url], i) => body.push(new Paragraph({ spacing: { after: 100, line: 280 }, indent: { left: 454, hanging: 454 },
  children: [new TextRun({ text: `[${i + 1}]\t${t}`, size: 19 }), ...(url ? [new ExternalHyperlink({ link: url, children: [new TextRun({ text: url, size: 19, style: 'Hyperlink' })] })] : [])] })));

// Appendix
body.push(H1('Appendix A. Parameters and how to reproduce'));
const p = meta.params;
body.push(table(['Parameter', 'Value', 'Meaning'], [
  ['Warm-up', `${p.warmup} days`, 'No scoring before enough history exists'],
  ['Baseline window', `${p.window} days`, 'Trailing normal days used for the median'],
  ['Robust z threshold', String(p.z), 'Standard deviations above baseline to flag'],
  ['Materiality', `$${p.materiality}/day`, 'Minimum excess to raise an alert'],
  ['Drift ratio', String(p.drift_ratio), '7-day mean vs previous month'],
  ['Drift trend', `ρ > ${p.drift_rho}`, 'Spearman correlation with time over 14 days'],
  ['Accept new level after', `${p.rebase_after} days`, 'Consecutive flagged days'],
  ['Random seed (main run)', '42', 'Robustness sweep uses seeds 1–10'],
], [2600, 1600, 4800]));
body.push(caption('Table 7. Explainer parameters.'));
body.push(P('To reproduce every number in this report:'));
['python3 generate_data.py', 'python3 engine.py', 'python3 robustness.py', 'python3 figures.py'].forEach((c) =>
  body.push(new Paragraph({ spacing: { after: 40 }, indent: { left: 567 }, children: [new TextRun({ text: c, font: 'Courier New', size: 19 })] })));

// ---------- document ----------
const doc = new Document({
  creator: 'Abhijay J R',
  title: 'Cloud Cost Explainer — Project Report',
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 30, bold: true, color: '1D2C4C' }, paragraph: { spacing: { before: 360, after: 160 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 24, bold: true, color: '2F4A7A' }, paragraph: { spacing: { before: 240, after: 100 }, keepNext: true, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 567, hanging: 283 } } } }] },
      ...['objectives', 'steps', 'future'].map((ref) => ({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 567, hanging: 340 } } } }] })),
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '777777' })] })] }) },
    children: body,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'out', 'Cloud_Cost_Explainer_Report.docx'), buf);
  console.log('written', buf.length);
});
