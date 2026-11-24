// Cloud Cost Explainer dashboard
window.cce = window.cce || { filter: 'alert', sel: null, acct: '' };

const OURS = 'Explainer (with business calendar)';
const ROB_METHODS = [
  'Explainer (with business calendar)',
  'Isolation Forest + calendar',
  'Rolling z-score + calendar',
  'Static threshold + calendar',
];
const enc = (v) => String(v).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
const num = (v) => (v === null || v === undefined || v === '' ? NaN : +v);
const fmtUSD = (v) => '$' + d3.format(',.0f')(v);
const fmtUSDk = (v) => (Math.abs(v) >= 1e6 ? '$' + d3.format('.2f')(v / 1e6) + 'M' : Math.abs(v) >= 1e4 ? '$' + d3.format(',.0f')(v / 1e3) + 'k' : fmtUSD(v));
const parseDay = d3.utcParse('%Y-%m-%d');
const fmtDay = d3.utcFormat('%-d %b');
const fmtDayY = d3.utcFormat('%-d %b %Y');
const reduceMotion = !window.matchMedia || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches;

function statusOf(...ids) {
  for (const id of ids) {
    const s = dash.data(id).status;
    if (s !== 'ok') return s;
  }
  return 'ok';
}
function placeholder(el, st) {
  el.classList.toggle('dash-skeleton', st === 'loading');
  if (st === 'error') el.textContent = 'This part could not load.';
  else if (st !== 'ok') el.textContent = '—';
}
function setText(el, text) {
  el.classList.remove('dash-skeleton');
  el.textContent = text;
}
function mk(tag, attrs, text) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
function tipBox(el) {
  const t = mk('div', { class: 'cce-tip', role: 'status' });
  t.hidden = true;
  el.appendChild(t);
  return {
    show(lines, x, y) {
      t.replaceChildren();
      lines.forEach((l, i) => {
        const row = mk('div');
        if (i === 0) row.appendChild(mk('b', null, l));
        else row.textContent = l;
        t.appendChild(row);
      });
      t.hidden = false;
      const w = el.clientWidth;
      const tw = t.offsetWidth;
      t.style.left = Math.max(0, Math.min(w - tw, x + 12)) + 'px';
      t.style.top = Math.max(0, y - 10) + 'px';
    },
    hide() { t.hidden = true; },
  };
}
const alertColor = 'var(--cds-chart-status-critical)';
const mutedColor = 'var(--cds-chart-muted)';

// ---------------------------------------------------------------------------------------------
// Calculations (shown to readers in Sources)
// ---------------------------------------------------------------------------------------------
dash.calc('by_service', {
  inputs: ['billing'],
  title: 'Usage spend by service',
  description: 'EffectiveCost of every Usage row in the bill, summed by ServiceName.',
  fn: (billing) => {
    const totals = new Map();
    for (const r of billing) {
      if (r.ChargeCategory !== 'Usage') continue;
      totals.set(r.ServiceName, (totals.get(r.ServiceName) || 0) + (+r.EffectiveCost || 0));
    }
    return [...totals].map(([service, cost]) => ({ service, cost: Math.round(cost * 100) / 100 })).sort((a, b) => b.cost - a.cost);
  },
});

dash.calc('kpi', {
  inputs: ['billing', 'anomalies', 'daily'],
  title: 'Headline figures',
  description: 'Total spend from the bill, and alert counts and extra cost from the anomalies found.',
  fn: (billing, anomalies, daily) => {
    const total = billing.reduce((s, r) => s + (+r.EffectiveCost || 0), 0);
    const alerts = anomalies.filter((a) => a.status === 'alert');
    const expected = anomalies.filter((a) => a.status === 'expected');
    const month = (m) => daily.filter((r) => String(r.date).startsWith(m)).reduce((s, r) => s + (+r.total || 0), 0);
    const apr = month('2026-04');
    const sep = month('2026-09');
    const top = alerts.slice().sort((a, b) => b.excess_cost - a.excess_cost)[0];
    const excess = alerts.reduce((s, a) => s + a.excess_cost, 0);
    return [{
      total_spend: Math.round(total * 100) / 100,
      apr_usage: Math.round(apr * 100) / 100,
      sep_usage: Math.round(sep * 100) / 100,
      sep_vs_apr_pct: Math.round((sep / apr - 1) * 1000) / 10,
      alerts: alerts.length,
      expected: expected.length,
      false_alarms: alerts.filter((a) => a.verdict === 'False alarm').length,
      alert_excess: Math.round(excess * 100) / 100,
      top_excess_share_pct: top ? Math.round((top.excess_cost / excess) * 1000) / 10 : 0,
    }];
  },
});

// legend swatches (style only)
dash.onData(() => {
  const c = dash.colors;
  const sw = { line: c[0], alert: alertColor, expected: mutedColor, m0: c[0], m1: c[1], m2: c[2], m3: c[3] };
  document.querySelectorAll('.cce [data-sw]').forEach((e) => {
    const k = e.getAttribute('data-sw');
    if (sw[k]) e.style.background = sw[k];
    if (k === 'alert' || k === 'expected') e.style.opacity = '0.45';
  });
});

// ---------------------------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------------------------
dash.draw('takeaway', (el) => {
  const st = statusOf('kpi', 'anomalies');
  if (st !== 'ok') return placeholder(el, st);
  const k = dash.data('kpi').data[0];
  const a = dash.data('anomalies').data.filter((x) => x.status === 'alert').sort((p, q) => q.excess_cost - p.excess_cost);
  const top = a[0];
  el.classList.remove('dash-skeleton');
  el.replaceChildren(
    'Over six months the explainer raised ',
    mk('span', { 'data-source': 'kpi', 'data-field': 'alerts', 'data-row': '0' }, String(k.alerts)),
    ' alerts covering ',
    mk('span', { 'data-source': 'kpi', 'data-field': 'alert_excess', 'data-row': '0' }, fmtUSD(k.alert_excess)),
    ' of spend above normal, and recognised ',
    mk('span', { 'data-source': 'kpi', 'data-field': 'expected', 'data-row': '0' }, String(k.expected)),
    ' other spikes as planned business events. The biggest was ',
    mk('span', { 'data-source': 'anomalies', 'data-field': 'pattern', 'data-where': 'id=' + top.id }, top.pattern.toLowerCase()),
    ' in ',
    mk('span', { 'data-source': 'anomalies', 'data-field': 'account', 'data-where': 'id=' + top.id }, top.account),
    ', at ',
    mk('span', { 'data-source': 'anomalies', 'data-field': 'excess_cost', 'data-where': 'id=' + top.id }, fmtUSD(top.excess_cost)),
    ' extra, or ',
    mk('span', { 'data-source': 'kpi', 'data-field': 'top_excess_share_pct', 'data-row': '0' }, k.top_excess_share_pct + '%'),
    ' of the total.'
  );
});

dash.draw('kpi-spend', (el) => {
  const st = statusOf('kpi');
  if (st !== 'ok') return placeholder(el, st);
  setText(el, fmtUSDk(dash.data('kpi').data[0].total_spend));
});
dash.draw('kpi-spend-note', (el) => {
  const st = statusOf('kpi');
  if (st !== 'ok') return placeholder(el, st);
  const k = dash.data('kpi').data[0];
  const up = k.sep_vs_apr_pct >= 0;
  el.replaceChildren(
    mk('span', { class: up ? 'cce-warn' : 'cce-ok', 'data-source': 'kpi', 'data-field': 'sep_vs_apr_pct', 'data-row': '0' }, (up ? '+' : '') + k.sep_vs_apr_pct + '%'),
    ' usage spend, Sep vs Apr'
  );
});
dash.draw('kpi-alerts', (el) => {
  const st = statusOf('kpi');
  if (st !== 'ok') return placeholder(el, st);
  setText(el, String(dash.data('kpi').data[0].alerts));
});
dash.draw('kpi-alerts-note', (el) => {
  const st = statusOf('kpi');
  if (st !== 'ok') return placeholder(el, st);
  const k = dash.data('kpi').data[0];
  el.replaceChildren(
    mk('span', { 'data-source': 'kpi', 'data-field': 'false_alarms', 'data-row': '0', class: k.false_alarms ? 'cce-warn' : 'cce-ok' }, String(k.false_alarms)),
    ' false alarms · ',
    mk('span', { 'data-source': 'kpi', 'data-field': 'expected', 'data-row': '0' }, String(k.expected)),
    ' planned spikes not alerted'
  );
});
dash.draw('kpi-excess', (el) => {
  const st = statusOf('kpi');
  if (st !== 'ok') return placeholder(el, st);
  setText(el, fmtUSD(dash.data('kpi').data[0].alert_excess));
});
dash.draw('kpi-excess-note', (el) => {
  const st = statusOf('kpi');
  if (st !== 'ok') return placeholder(el, st);
  el.textContent = 'Includes the false alarms. Expected events are not counted.';
});
dash.draw('kpi-f1', (el) => {
  const st = statusOf('evaluation');
  if (st !== 'ok') return placeholder(el, st);
  const r = dash.data('evaluation').data.find((x) => x.method === OURS);
  setText(el, r ? d3.format('.2f')(r.f1) : '—');
});
dash.draw('kpi-f1-note', (el) => {
  const st = statusOf('evaluation');
  if (st !== 'ok') return placeholder(el, st);
  const rows = dash.data('evaluation').data;
  const best = rows.filter((x) => !x.method.startsWith('Explainer')).sort((a, b) => b.f1 - a.f1)[0];
  el.replaceChildren(
    'Best other method: ',
    mk('span', { 'data-source': 'evaluation', 'data-field': 'f1', 'data-where': 'method=' + enc(best.method) }, d3.format('.2f')(best.f1)),
    ' (',
    mk('span', { 'data-source': 'evaluation', 'data-field': 'method', 'data-where': 'method=' + enc(best.method) }, best.method.replace(' + calendar', ' with calendar')),
    ')'
  );
});

// ---------------------------------------------------------------------------------------------
// Daily spend chart
// ---------------------------------------------------------------------------------------------
dash.draw('acct', (sel) => {
  const g = dash.data('daily');
  const cols = g.status === 'ok' ? (g.columns || Object.keys(g.data[0] || {})).filter((c) => c !== 'date' && c !== 'total') : [];
  sel.replaceChildren(new Option('All accounts', ''), ...cols.map((c) => new Option(c, c)));
  sel.value = window.cce.acct;
  sel.onchange = () => { window.cce.acct = sel.value; dash.draw('daily-chart'); };
});

dash.draw('daily-chart', (el) => {
  const st = statusOf('daily', 'anomalies');
  if (st !== 'ok') return placeholder(el, st);
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  const acct = window.cce.acct;
  const field = acct || 'total';
  const rows = dash.data('daily').data.map((r) => ({ date: parseDay(r.date), v: num(r[field]) }));
  const evs = dash.data('anomalies').data.filter((a) => !acct || a.account === acct);
  const W = el.clientWidth || 600;
  const H = 280;
  const m = { t: 10, r: 12, b: 26, l: 52 };
  const x = d3.scaleUtc().domain(d3.extent(rows, (r) => r.date)).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.v) * 1.08]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', `Daily cloud spend for ${acct || 'all accounts'}, April to September 2026, with flagged periods shaded`);
  const yAxis = svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat((v) => fmtUSDk(v)));
  yAxis.select('.domain').remove();
  let maxw = 0;
  yAxis.selectAll('text').each(function () { maxw = Math.max(maxw, this.getComputedTextLength()); });
  if (maxw + 10 > m.l) {
    m.l = maxw + 12; x.range([m.l, W - m.r]);
    yAxis.attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat((v) => fmtUSDk(v)));
    yAxis.select('.domain').remove();
  }
  const day = 864e5;
  svg.append('g').selectAll('rect').data(evs).join('rect')
    .attr('x', (e) => x(parseDay(e.start)) - 1)
    .attr('width', (e) => Math.max(3, x(new Date(+parseDay(e.end) + day)) - x(parseDay(e.start))))
    .attr('y', m.t).attr('height', H - m.b - m.t)
    .style('fill', (e) => (e.status === 'alert' ? alertColor : mutedColor)).style('opacity', 0.22);
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 110))).tickFormat(d3.utcFormat('%b')));
  const line = d3.line().x((r) => x(r.date)).y((r) => y(r.v));
  const path = svg.append('path').datum(rows).attr('d', line).style('fill', 'none').style('stroke', dash.colors[0]).style('stroke-width', 1.6);
  if (!reduceMotion && !window.cce.played) {
    const L = path.node().getTotalLength();
    path.attr('stroke-dasharray', `${L} ${L}`).attr('stroke-dashoffset', L).transition().duration(900).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0);
    window.cce.played = true;
  }
  const dot = svg.append('circle').attr('r', 3.5).style('fill', dash.colors[0]).style('display', 'none');
  const tip = tipBox(el);
  const bis = d3.bisector((r) => r.date).center;
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).style('fill', 'transparent')
    .on('pointermove', (ev) => {
      const [px, py] = d3.pointer(ev);
      const r = rows[bis(rows, x.invert(px))];
      dot.style('display', null).attr('cx', x(r.date)).attr('cy', y(r.v));
      const ds = d3.utcFormat('%Y-%m-%d')(r.date);
      const lines = [fmtDayY(r.date), `${acct || 'All accounts'}: ${fmtUSD(r.v)}`];
      evs.filter((e) => e.start <= ds && e.end >= ds).forEach((e) => lines.push(`${e.status === 'alert' ? 'Alert' : 'Expected'}: ${e.service} (${e.account})`));
      const scale = el.clientWidth / W;
      tip.show(lines, x(r.date) * scale, py * scale);
    })
    .on('pointerleave', () => { tip.hide(); dot.style('display', 'none'); })
    .on('click', (ev) => {
      const [px] = d3.pointer(ev);
      const ds = d3.utcFormat('%Y-%m-%d')(rows[bis(rows, x.invert(px))].date);
      const hit = evs.find((e) => e.start <= ds && e.end >= ds);
      if (hit) {
        window.cce.sel = hit.id;
        window.cce.filter = hit.status;
        document.querySelectorAll('.cce [data-filter]').forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-filter') === hit.status));
        dash.draw('alist'); dash.draw('detail');
        const target = document.getElementById('anomalies');
        if (target) target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }
    });
});

// ---------------------------------------------------------------------------------------------
// Anomaly list + detail
// ---------------------------------------------------------------------------------------------
document.querySelectorAll('.cce [data-filter]').forEach((b) => {
  b.addEventListener('click', () => {
    window.cce.filter = b.getAttribute('data-filter');
    document.querySelectorAll('.cce [data-filter]').forEach((o) => o.classList.toggle('is-on', o === b));
    dash.draw('alist'); dash.draw('detail');
  });
});

function visibleAnomalies() {
  const f = window.cce.filter;
  return dash.data('anomalies').data.filter((a) => f === 'all' || a.status === f).sort((a, b) => (a.start < b.start ? -1 : 1));
}
function selected() {
  const vis = visibleAnomalies();
  let s = vis.find((a) => a.id === window.cce.sel);
  if (!s) {
    s = vis.slice().sort((a, b) => b.excess_cost - a.excess_cost)[0];
    if (s) window.cce.sel = s.id;
  }
  return s;
}

dash.draw('alist', (tb) => {
  const st = statusOf('anomalies');
  tb.replaceChildren();
  if (st !== 'ok') {
    const tr = mk('tr'); const td = mk('td', { colspan: '4' }, st === 'error' ? 'The anomaly list could not load.' : '—');
    tr.appendChild(td); tb.appendChild(tr); return;
  }
  const sel = selected();
  for (const a of visibleAnomalies()) {
    const tr = mk('tr', { tabindex: '0', 'data-key': enc(a.id), 'aria-selected': String(!!(sel && sel.id === a.id)) });
    if (sel && sel.id === a.id) tr.classList.add('is-sel');
    const c1 = mk('td');
    c1.appendChild(document.createTextNode(fmtDay(parseDay(a.start))));
    if (a.days > 1) c1.appendChild(mk('div', { class: 'cce-muted' }, a.days + ' days'));
    const c2 = mk('td');
    c2.appendChild(document.createTextNode(a.service));
    c2.appendChild(mk('div', { class: 'cce-muted' }, a.pattern));
    const tagClass = a.status === 'expected' ? 'cce-muted' : a.verdict === 'False alarm' ? 'cce-warn' : 'cce-bad';
    const c3 = mk('td', null, a.account);
    c3.appendChild(mk('div', null)).appendChild(mk('span', { class: 'cce-tag ' + tagClass }, a.status === 'expected' ? 'expected' : a.severity));
    const c4 = mk('td', { class: 'num' }, fmtUSD(a.excess_cost));
    tr.append(c1, c2, c3, c4);
    const pick = () => { window.cce.sel = a.id; dash.draw('alist'); dash.draw('detail'); };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    tb.appendChild(tr);
  }
});

dash.draw('detail', (el) => {
  const st = statusOf('anomalies', 'series');
  if (st !== 'ok') return placeholder(el, st);
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  const a = selected();
  if (!a) { el.textContent = 'Nothing in this list.'; return; }
  const M = (f, txt, tag = 'span', extra = {}) => mk(tag, { 'data-source': 'anomalies', 'data-field': f, 'data-where': 'id=' + enc(a.id), ...extra }, txt);

  const h = mk('h3');
  h.append(M('service', a.service), ' · ', M('usage_type', a.usage_type.split(':').pop()), ' · ', M('account', a.account));
  el.appendChild(h);
  const sub = mk('div', { class: 'cce-muted' });
  sub.append(
    fmtDayY(parseDay(a.start)) + (a.days > 1 ? ' – ' + fmtDayY(parseDay(a.end)) : ''),
    ' · ', M('region', a.region), ' · team ', M('team', a.team)
  );
  el.appendChild(sub);

  const figs = mk('div', { class: 'cce-detail-figs' });
  const fig = (label, node) => { const d = mk('div'); d.append(mk('div', { class: 'cce-fig-l' }, label)); const v = mk('div', { class: 'cce-fig-v' }); v.append(node); d.append(v); figs.append(d); };
  fig('Usual per day', M('usual_per_day', fmtUSD(a.usual_per_day)));
  fig('During, per day', M('actual_per_day', fmtUSD(a.actual_per_day)));
  fig('Worst day', M('peak_multiple', d3.format('.1f')(a.peak_multiple) + '×'));
  fig('Extra cost', M('excess_cost', fmtUSD(a.excess_cost), 'span', { class: a.status === 'alert' ? 'cce-bad' : '' }));
  el.appendChild(figs);

  // series chart
  const box = mk('div', { class: 'cce-chart', style: 'min-height:200px', 'data-source': 'series', id: 'anomaly-series' });
  el.appendChild(box);
  const all = dash.data('series').data.filter((r) => r.series_id === a.series_id);
  const s0 = +parseDay(a.start), s1 = +parseDay(a.end), day = 864e5;
  const rows = all.map((r) => ({ date: parseDay(r.date), cost: num(r.cost), base: num(r.baseline) }))
    .filter((r) => +r.date >= s0 - 35 * day && +r.date <= s1 + 21 * day);
  const W = el.clientWidth || 480, H = 200, m = { t: 8, r: 10, b: 24, l: 48 };
  const x = d3.scaleUtc().domain(d3.extent(rows, (r) => r.date)).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => Math.max(r.cost, isNaN(r.base) ? 0 : r.base)) * 1.1]).nice().range([H - m.b, m.t]);
  const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', `Daily cost of ${a.service} ${a.usage_type} against its usual level, around the flagged period`);
  const ya = svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(fmtUSDk));
  ya.select('.domain').remove();
  svg.append('rect').attr('x', x(new Date(s0))).attr('width', Math.max(3, x(new Date(s1 + day)) - x(new Date(s0))))
    .attr('y', m.t).attr('height', H - m.t - m.b).style('fill', a.status === 'alert' ? alertColor : mutedColor).style('opacity', 0.18);
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 100))).tickFormat(fmtDay));
  svg.append('path').datum(rows.filter((r) => !isNaN(r.base))).attr('d', d3.line().x((r) => x(r.date)).y((r) => y(r.base)))
    .style('fill', 'none').style('stroke', 'var(--cds-chart-reference)').style('stroke-width', 1.5).style('stroke-dasharray', '4 3');
  svg.append('path').datum(rows).attr('d', d3.line().x((r) => x(r.date)).y((r) => y(r.cost)))
    .style('fill', 'none').style('stroke', dash.colors[0]).style('stroke-width', 1.7);
  const dot = svg.append('circle').attr('r', 3.5).style('fill', dash.colors[0]).style('display', 'none');
  const tip = tipBox(box);
  const bis = d3.bisector((r) => r.date).center;
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).style('fill', 'transparent')
    .on('pointermove', (ev) => {
      const [px, py] = d3.pointer(ev);
      const r = rows[bis(rows, x.invert(px))];
      dot.style('display', null).attr('cx', x(r.date)).attr('cy', y(r.cost));
      const sc = box.clientWidth / W;
      tip.show([fmtDayY(r.date), 'Actual: ' + fmtUSD(r.cost), 'Usual: ' + (isNaN(r.base) ? 'not enough history' : fmtUSD(r.base))], x(r.date) * sc, py * sc);
    })
    .on('pointerleave', () => { tip.hide(); dot.style('display', 'none'); });
  const lg = mk('div', { class: 'cce-legend' });
  const s1n = mk('span'); const swa = mk('i', { class: 'cce-sw' }); swa.style.background = dash.colors[0]; s1n.append(swa, 'Actual daily cost');
  const s2n = mk('span'); s2n.append(mk('i', { class: 'cce-sw-line' }), 'Usual level (baseline)');
  lg.append(s1n, s2n);
  el.appendChild(lg);

  // explanation
  el.appendChild(mk('h3', { style: 'margin-top:var(--cds-gap-md)' }, 'What happened'));
  el.appendChild(M('explanation', a.explanation, 'p', { class: 'cce-explain' }));

  // volume vs rate
  el.appendChild(mk('div', { class: 'cce-fig-l' }, 'Where the extra cost came from'));
  const bars = mk('div', { class: 'cce-bars' });
  const mx = Math.max(Math.abs(a.volume_effect), Math.abs(a.rate_effect), 1);
  [['More usage', 'volume_effect', a.volume_effect], ['Higher unit price', 'rate_effect', a.rate_effect]].forEach(([lab, f, v]) => {
    const track = mk('div', { class: 'cce-bar-track' });
    const fill = mk('div', { class: 'cce-bar-fill' });
    fill.style.width = (Math.max(0, v) / mx) * 100 + '%';
    fill.style.background = dash.colors[0];
    track.appendChild(fill);
    bars.append(mk('span', null, lab), track, M(f, fmtUSD(v)));
  });
  el.appendChild(bars);

  // pattern + checks
  const pat = mk('p', { class: 'cce-muted', style: 'margin-top:var(--cds-gap-md)' });
  pat.append('Matched pattern: ', M('pattern', a.pattern));
  if (a.match_reasons) pat.append(' — because ', M('match_reasons', a.match_reasons));
  el.appendChild(pat);
  el.appendChild(mk('h3', null, 'What to check'));
  const ul = mk('ul', { class: 'cce-checks', 'data-source': 'anomalies', 'data-field': 'checks', 'data-where': 'id=' + enc(a.id) });
  a.checks.split(' | ').forEach((c) => ul.appendChild(mk('li', null, c)));
  el.appendChild(ul);

  // ground truth
  const v = mk('div', { class: 'cce-verdict' });
  v.style.borderLeftColor = a.verdict === 'False alarm' ? 'var(--color-warn)' : a.status === 'expected' ? 'var(--cds-chart-muted)' : 'var(--color-ok)';
  v.append(mk('b', null, 'Check against the planted truth: '), M('verdict', a.verdict));
  if (a.true_cause) v.append('. What was actually planted: ', M('true_cause', a.true_cause));
  else if (a.verdict === 'False alarm') v.append('. Nothing was planted here; this is random day-to-day noise that crossed the threshold.');
  el.appendChild(v);
});

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------
dash.draw('svc-chart', (el) => {
  const st = statusOf('by_service');
  if (st !== 'ok') return placeholder(el, st);
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  const rows = dash.data('by_service').data;
  const W = el.clientWidth || 600, bh = 22, gap = 6;
  const H = rows.length * (bh + gap) + 8;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', 'Horizontal bar chart of usage spend by AWS service, largest first');
  // measure label widths
  const probe = svg.append('g');
  let lw = 0, vw = 0;
  rows.forEach((r) => {
    const t = probe.append('text').text(r.service); lw = Math.max(lw, t.node().getComputedTextLength());
    const t2 = probe.append('text').text(fmtUSDk(r.cost)); vw = Math.max(vw, t2.node().getComputedTextLength());
  });
  probe.remove();
  const l = Math.min(lw + 10, W * 0.45);
  const x = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.cost)]).range([0, Math.max(40, W - l - vw - 14)]);
  const total = d3.sum(rows, (r) => r.cost);
  const tip = tipBox(el);
  const g = svg.selectAll('g.r').data(rows).join('g').attr('class', 'r').attr('transform', (r, i) => `translate(0,${i * (bh + gap) + 4})`);
  g.append('text').attr('x', l - 8).attr('y', bh / 2).attr('dy', '0.35em').attr('text-anchor', 'end').text((r) => r.service);
  g.append('rect').attr('x', l).attr('height', bh).attr('rx', 3).attr('width', (r) => Math.max(1, x(r.cost))).style('fill', dash.colors[0]);
  g.append('text').attr('x', (r) => l + x(r.cost) + 6).attr('y', bh / 2).attr('dy', '0.35em').text((r) => fmtUSDk(r.cost));
  g.append('rect').attr('x', 0).attr('width', W).attr('height', bh).style('fill', 'transparent')
    .on('pointermove', (ev, r) => {
      const [px, py] = d3.pointer(ev, el);
      tip.show([r.service, fmtUSD(r.cost), d3.format('.1%')(r.cost / total) + ' of usage spend'], px, py);
    })
    .on('pointerleave', () => tip.hide());
});

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------
dash.draw('eval-table', (tb) => {
  const st = statusOf('evaluation');
  tb.replaceChildren();
  if (st !== 'ok') { const tr = mk('tr'); tr.appendChild(mk('td', { colspan: '8' }, st === 'error' ? 'The scores could not load.' : '—')); tb.appendChild(tr); return; }
  for (const r of dash.data('evaluation').data) {
    const tr = mk('tr');
    const name = mk('td', null, r.method);
    if (r.method === OURS) name.style.fontWeight = 'var(--cds-font-weight-medium)';
    tr.append(
      name,
      mk('td', { class: 'num' }, String(r.alerts)),
      mk('td', { class: 'num' }, String(r.false_alerts)),
      mk('td', { class: 'num' }, d3.format('.2f')(r.precision)),
      mk('td', { class: 'num' }, d3.format('.2f')(r.recall)),
      mk('td', { class: 'num' }, d3.format('.2f')(r.f1)),
      mk('td', { class: 'num' }, r.mean_delay_days === null ? '—' : d3.format('.2f')(r.mean_delay_days)),
      mk('td', null, r.missed)
    );
    tb.appendChild(tr);
  }
});

dash.draw('rob-chart', (el) => {
  const st = statusOf('robustness');
  if (st !== 'ok') return placeholder(el, st);
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  const data = dash.data('robustness').data;
  const series = ROB_METHODS.map((mth, i) => ({ mth, i, pts: data.filter((r) => r.method === mth).sort((a, b) => a.anomaly_size_pct - b.anomaly_size_pct) }));
  const W = el.clientWidth || 600, H = 280, m = { t: 12, r: 16, b: 34, l: 40 };
  const x = d3.scalePoint().domain([25, 50, 75, 100]).range([m.l, W - m.r]).padding(0.3);
  const y = d3.scaleLinear().domain([0.3, 1]).range([H - m.b, m.t]);
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', 'Line chart of mean F1 score against anomaly size for four detection methods, each using the business calendar');
  const ya = svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(d3.format('.1f')));
  ya.select('.domain').remove();
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((d) => d + '%'));
  svg.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', H - 4).attr('text-anchor', 'middle').text('Size of planted anomalies');
  const color = (i) => dash.colors[i];
  const off = (i) => (i - 1.5) * 4;
  series.forEach((s) => {
    // ±1 sd whiskers
    svg.append('g').selectAll('line').data(s.pts).join('line')
      .attr('x1', (p) => x(p.anomaly_size_pct) + off(s.i)).attr('x2', (p) => x(p.anomaly_size_pct) + off(s.i))
      .attr('y1', (p) => y(Math.max(0.3, p.f1_mean - p.f1_sd))).attr('y2', (p) => y(Math.min(1, p.f1_mean + p.f1_sd)))
      .style('stroke', color(s.i)).style('opacity', 0.5);
    svg.append('path').datum(s.pts).attr('d', d3.line().x((p) => x(p.anomaly_size_pct) + off(s.i)).y((p) => y(p.f1_mean)))
      .style('fill', 'none').style('stroke', color(s.i)).style('stroke-width', s.i === 0 ? 2.4 : 1.5);
    svg.append('g').selectAll('circle').data(s.pts).join('circle')
      .attr('cx', (p) => x(p.anomaly_size_pct) + off(s.i)).attr('cy', (p) => y(p.f1_mean)).attr('r', s.i === 0 ? 4 : 3)
      .style('fill', color(s.i));
  });
  const tip = tipBox(el);
  svg.append('g').selectAll('rect').data([25, 50, 75, 100]).join('rect')
    .attr('x', (d) => x(d) - x.step() / 2).attr('width', x.step()).attr('y', m.t).attr('height', H - m.t - m.b).style('fill', 'transparent')
    .on('pointermove', (ev, d) => {
      const [px, py] = d3.pointer(ev, el);
      const lines = [`Anomalies at ${d}% size`];
      series.forEach((s) => { const p = s.pts.find((q) => q.anomaly_size_pct === d); if (p) lines.push(`${s.mth.replace(' (with business calendar)', '').replace(' + calendar', '')}: F1 ${d3.format('.2f')(p.f1_mean)} ± ${d3.format('.2f')(p.f1_sd)}`); });
      tip.show(lines, px, py);
    })
    .on('pointerleave', () => tip.hide());
});

dash.draw('rob-note', (el) => {
  const st = statusOf('robustness');
  if (st !== 'ok') return placeholder(el, st);
  const d = dash.data('robustness').data;
  const f = (mth, size) => d.find((r) => r.method === mth && r.anomaly_size_pct === size);
  const ours25 = f(ROB_METHODS[0], 25), iso100 = f(ROB_METHODS[1], 100), ours100 = f(ROB_METHODS[0], 100), z100 = f(ROB_METHODS[2], 100);
  const mark = (r, field, txt) => mk('span', { 'data-source': 'robustness', 'data-field': field, 'data-where': `anomaly_size_pct=${r.anomaly_size_pct}&method=${enc(r.method)}` }, txt);
  el.replaceChildren(
    'At full size the explainer averages F1 ', mark(ours100, 'f1_mean', d3.format('.2f')(ours100.f1_mean)),
    ', against ', mark(iso100, 'f1_mean', d3.format('.2f')(iso100.f1_mean)), ' for Isolation Forest and ',
    mark(z100, 'f1_mean', d3.format('.2f')(z100.f1_mean)),
    ' for the rolling z-score, so its detection is on par with good baselines rather than clearly better. Its edge is the explanation. At a quarter of the size it still finds ',
    mark(ours25, 'recall_mean', d3.format('.0%')(ours25.recall_mean)),
    ' of the anomalies; the misses are small, slow or price-only changes.'
  );
});
