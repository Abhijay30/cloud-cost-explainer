{
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const KEY = 'cce-site-v1';
  const st = { data: null, res: null, file: null, map: null, header: null, sample: null, isSample: false,
    filter: 'alert', sortBy: 'date', sel: null, acct: '', params: { ...CCE.DEFAULTS }, events: [], userEvents: [] };

  function load() { try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); if (o.params) Object.assign(st.params, o.params); if (Array.isArray(o.events)) st.userEvents = o.events; } catch (e) { /* storage unavailable */ } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ params: { z: st.params.z, materiality: st.params.materiality, window: st.params.window }, events: st.userEvents })); } catch (e) { /* ignore */ } }
  load();

  const money = (v) => CCE.fmtMoney(v, st.data ? st.data.currency : 'USD');
  const moneyK = (v) => {
    const a = Math.abs(v), sym = money(0).replace(/0.*$/, '');
    if (a >= 1e6) return sym + (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return sym + Math.round(v / 1e3) + 'k';
    if (a >= 1e3) return sym + (v / 1e3).toFixed(1) + 'k';
    return money(v);
  };
  const dShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const status = (msg, err) => { const s = $('#status'); s.textContent = msg; s.classList.toggle('err', !!err); };
  const progress = (f) => { const b = $('#bar'); if (f === null) { b.hidden = true; return; } b.hidden = false; b.firstElementChild.style.width = Math.round(f * 100) + '%'; };

  // ---------------------------------------------------------------- loading
  async function loadSample() {
    status('Loading the sample bill…');
    try {
      if (!st.sample) st.sample = await (await fetch('sample.json')).json();
      st.data = CCE.fromSample(st.sample);
      st.isSample = true; st.file = null; st.header = null; st.map = null;
      st.events = st.sample.events.map((e) => ({ ...e }));
      run();
      status('Showing the sample bill (synthetic data for a made-up retailer).');
    } catch (e) { status('Could not load the sample bill.', true); }
  }

  async function loadFile(file, override) {
    st.file = file;
    status(`Reading ${file.name}…`); progress(0);
    const t0 = performance.now();
    try {
      const data = await CCE.readFile(file, (f, agg) => { if (f !== null) progress(f); }, override);
      progress(null);
      st.data = data; st.header = data.header; st.map = data.map; st.isSample = false;
      st.events = st.userEvents;
      if (data.error) { status(data.error, true); renderMapping(); return; }
      run();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      status(`Read ${data.rows.toLocaleString('en-US')} rows from ${file.name} in ${secs}s.${data.skipped ? ` ${data.skipped.toLocaleString('en-US')} rows skipped (no date or cost).` : ''}`);
    } catch (e) {
      progress(null);
      if (e.message === 'need-mapping') {
        st.header = e.header; st.map = e.map; st.isSample = false;
        renderMapping();
        status('Could not find the date and cost columns. Pick them under "Columns in your file", then read the file again.', true);
        $('#setup').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
      } else status('Could not read this file: ' + e.message, true);
    }
  }

  function run() {
    st.res = CCE.analyse(st.data, { params: st.params, events: st.events });
    const alerts = st.res.events.filter((e) => e.status === 'alert');
    const pick = (st.filter === 'all' ? st.res.events : st.res.events.filter((e) => e.status === st.filter));
    st.sel = (pick.slice().sort((a, b) => b.excess - a.excess)[0] || alerts[0] || st.res.events[0] || {}).id || null;
    st.acct = '';
    render();
  }

  // ---------------------------------------------------------------- render
  function render() {
    const r = st.res, d = st.data;
    const alerts = r.events.filter((e) => e.status === 'alert');
    const planned = r.events.filter((e) => e.status === 'expected');
    const usage = r.total.reduce((s, v) => s + v, 0);
    const all = usage + (d.otherCost || 0);
    const extra = alerts.reduce((s, e) => s + e.excess, 0);
    const top = alerts.slice().sort((a, b) => b.excess - a.excess)[0];
    const tooShort = r.days.length < st.params.warmup + 7;

    $('#finding').textContent = tooShort
      ? `This file covers ${r.days.length} days; the explainer needs about ${st.params.warmup + 7} to judge what is normal.`
      : alerts.length
        ? `${alerts.length} cost ${alerts.length === 1 ? 'anomaly' : 'anomalies'} added ${money(extra)} above normal. The biggest was ${top.pattern.name.toLowerCase()} ${top.account === 'All accounts' ? 'on ' + top.service : 'in ' + top.account}: ${money(top.excess)}.`
        : 'No unusual spend found in this bill.';
    const first = r.days[0], last = r.days[r.days.length - 1];
    $('#source').innerHTML = `${st.isSample ? '<span class="tag">Sample data</span> ' : ''}${esc(st.isSample ? st.sample.name : st.file.name)} · ${esc(CCE.fmtDate(first))} to ${esc(CCE.fmtDate(last))} · ${r.lines.toLocaleString('en-US')} service lines, ${r.scored.toLocaleString('en-US')} large enough to score`;

    const n = r.days.length, w = Math.min(30, Math.floor(n / 2));
    const lastW = r.total.slice(n - w).reduce((s, v) => s + v, 0), prevW = r.total.slice(n - 2 * w, n - w).reduce((s, v) => s + v, 0);
    const ch = prevW > 0 ? (lastW / prevW - 1) * 100 : 0;
    $('#kpis').innerHTML = [
      [money(all), 'Total spend', `last ${w} days vs the ${w} before: <span class="k" style="color:${ch > 0 ? 'var(--warn)' : 'var(--ok)'}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</span>`],
      [String(alerts.length), 'Alerts', `${planned.length} planned spike${planned.length === 1 ? '' : 's'} not alerted`],
      [money(extra), 'Extra cost in alerts', `${all > 0 ? ((extra / all) * 100).toFixed(1) : '0'}% of total spend`],
      [top ? money(top.excess) : '—', 'Biggest anomaly', top ? `${esc(top.service)} · ${esc(top.account)}` : 'none found'],
    ].map(([v, l, s]) => `<div class="kpi"><span>${l}</span><b>${esc(v)}</b><span>${s}</span></div>`).join('');

    const accts = [...r.byAcct.keys()].sort();
    $('#acct').innerHTML = '<option value="">All accounts</option>' + accts.map((a) => `<option>${esc(a)}</option>`).join('');
    $('#acct').value = st.acct;
    $('#acct').closest('.head').querySelector('select').hidden = accts.length < 2;

    drawDaily(); renderList(); renderDetail(); renderServices(); renderMapping(); renderSettings(); renderEvents();
  }

  // ---------------------------------------------------------------- charts
  function lineChart(box, { days, ys, base, bands, onBand, label, small }) {
    const W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    const narrow = W < 520;
    const m = { t: 10, r: 10, b: 26, l: 0 };
    let ymax = 0; ys.forEach((v, i) => { ymax = Math.max(ymax, v, base ? base[i] || 0 : 0); });
    ymax = ymax > 0 ? ymax * 1.08 : 1;
    const step = Math.pow(10, Math.floor(Math.log10(ymax))); const nice = [1, 2, 2.5, 5, 10].map((k) => k * step).find((k) => ymax / k <= (small ? 4 : 5)) || step * 10;
    const ticks = []; for (let v = 0; v <= ymax + 1e-9; v += nice) ticks.push(v);
    const top = ticks[ticks.length - 1] < ymax ? ticks[ticks.length - 1] + nice : ticks[ticks.length - 1];
    if (ticks[ticks.length - 1] < top) ticks.push(top);
    m.l = Math.max(...ticks.map((v) => moneyK(v).length)) * 7.4 + 10;
    const x = (i) => m.l + (i / Math.max(1, days.length - 1)) * (W - m.l - m.r);
    const y = (v) => H - m.b - (v / top) * (H - m.t - m.b);
    let s = '';
    ticks.forEach((v) => { s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(moneyK(v))}</text>`; });
    const bw = (W - m.l - m.r) / Math.max(1, days.length - 1);
    (bands || []).forEach((b, k) => {
      const x0 = x(b.a) - bw / 2, x1 = x(b.b) + bw / 2;
      s += `<rect data-band="${k}" x="${x0}" y="${m.t}" width="${Math.max(3, x1 - x0)}" height="${H - m.t - m.b}" fill="${b.status === 'alert' ? 'var(--mag)' : 'var(--plan)'}" opacity="${b.status === 'alert' ? 0.22 : 0.55}" style="cursor:${onBand ? 'pointer' : 'default'}"/>`;
    });
    // month ticks
    let lastM = '', cnt = 0;
    days.forEach((d, i) => {
      if (d.slice(8) !== '01' && i !== 0) return;
      const mo = new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
      if (mo === lastM) return; lastM = mo; cnt++;
      if (narrow && cnt % 2 === 0) return;
      s += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${esc(days.length > 400 ? mo + ' ' + d.slice(2, 4) : mo)}</text>`;
    });
    if (base) {
      const pts = base.map((v, i) => (isNaN(v) ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
      if (pts.length) s += `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    }
    s += `<polyline id="ln" points="${ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--blue)" stroke-width="${small ? 1.8 : 2}" stroke-linejoin="round"/>`;
    s += `<circle id="dot" r="4" fill="var(--blue)" style="display:none"/><rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>`;
    box.innerHTML = `<svg role="img" aria-label="${esc(label)}" viewBox="0 0 ${W} ${H}">${s}</svg><div class="tip" hidden></div>`;
    const svg = box.querySelector('svg'), tip = box.querySelector('.tip'), dot = svg.querySelector('#dot'), hit = svg.querySelector('#hit');
    const idxAt = (ev) => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(days.length - 1, Math.round(((ev.clientX - r.left) - m.l) / Math.max(1e-9, (W - m.l - m.r)) * (days.length - 1)))); };
    hit.addEventListener('pointermove', (ev) => {
      const i = idxAt(ev);
      dot.style.display = ''; dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(ys[i]));
      const inB = (bands || []).filter((b) => i >= b.a && i <= b.b);
      tip.innerHTML = `<b>${esc(CCE.fmtDate(days[i]))}</b><br>${esc(money(ys[i]))}${base && !isNaN(base[i]) ? `<br><span class="sub">Usual: ${esc(money(base[i]))}</span>` : ''}${inB.map((b) => `<br><span style="color:${b.status === 'alert' ? 'var(--mag)' : 'var(--muted)'}">${esc(b.text)}</span>`).join('')}`;
      tip.hidden = false;
      const tx = x(i) + 14, tw = tip.offsetWidth;
      tip.style.left = (tx + tw > W ? x(i) - tw - 14 : tx) + 'px';
      tip.style.top = Math.max(0, y(ys[i]) - 40) + 'px';
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; dot.style.display = 'none'; });
    if (onBand) hit.addEventListener('click', (ev) => { const i = idxAt(ev); const b = (bands || []).find((q) => i >= q.a && i <= q.b); if (b) onBand(b); });
  }

  function drawDaily() {
    const r = st.res, box = $('#daily');
    const ys = Array.from(st.acct ? r.byAcct.get(st.acct) : r.total);
    const bands = r.events.filter((e) => !st.acct || e.account === st.acct).map((e) => ({ a: e.a, b: e.b, status: e.status, id: e.id, text: `${e.status === 'alert' ? 'Alert' : 'Planned'}: ${e.service} (${e.account})` }));
    lineChart(box, { days: r.days, ys, bands, label: `Daily spend for ${st.acct || 'all accounts'} with anomalies marked`,
      onBand: (b) => { const e = r.events.find((q) => q.id === b.id); st.sel = e.id; st.filter = e.status; syncChips(); renderList(); renderDetail(); $('#anomalies').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); } });
  }

  // ---------------------------------------------------------------- list + detail
  function visible() {
    const ev = st.res.events.filter((e) => st.filter === 'all' || e.status === st.filter);
    return st.sortBy === 'cost' ? ev.slice().sort((a, b) => b.excess - a.excess) : ev;
  }
  function syncChips() {
    document.querySelectorAll('.chip[data-f]').forEach((c) => c.classList.toggle('on', c.dataset.f === st.filter));
    $('#sort').textContent = st.sortBy === 'cost' ? 'Sort: by cost' : 'Sort: by date';
  }
  function renderList() {
    const v = visible();
    if (!v.find((e) => e.id === st.sel)) st.sel = v[0] ? v[0].id : null;
    $('#rows').innerHTML = v.length ? v.map((e) => `<tr tabindex="0" data-id="${esc(e.id)}" class="${e.id === st.sel ? 'sel' : ''}" aria-selected="${e.id === st.sel}">
      <td style="white-space:nowrap">${esc(dShort(e.start))}${e.days > 1 ? `<div class="sub">${e.days} days</div>` : ''}</td>
      <td>${esc(e.service)}<div class="sub">${esc(e.account)} · ${esc(e.pattern.name)}</div></td>
      <td class="n">${esc(money(e.excess))}<div><span class="sev ${esc(e.severity)}">${esc(e.severity)}</span></div></td></tr>`).join('')
      : `<tr><td colspan="3" class="empty">${st.filter === 'alert' ? 'No alerts. Nothing in this bill crossed the threshold.' : 'Nothing here.'}</td></tr>`;
  }
  function renderDetail() {
    const box = $('#detail');
    const e = st.res.events.find((q) => q.id === st.sel);
    if (!e) { box.innerHTML = '<div class="empty">Pick an anomaly from the list to see its explanation.</div>'; return; }
    const truth = st.isSample ? st.sample.truth.find((t) => t.account === e.account && t.service === e.service && t.usage_type === e.usage && e.start <= CCE.toDay(new Date(Date.parse(t.end + 'T00:00:00Z') + 864e5).toISOString()) && e.end >= CCE.toDay(new Date(Date.parse(t.start + 'T00:00:00Z') - 864e5).toISOString())) : null;
    const mx = Math.max(Math.abs(e.vol), Math.abs(e.rate), 1);
    box.innerHTML = `<h3>${esc(e.service)}${e.usage !== 'all usage' ? ' · ' + esc(CCE.shortUsage(e.usage)) : ''}</h3>
      <div class="sub">${esc(e.account)}${e.region !== 'global' ? ' · ' + esc(e.region) : ''}${e.team ? ' · team ' + esc(e.team) : ''} · ${esc(CCE.fmtDate(e.start))}${e.days > 1 ? ' to ' + esc(CCE.fmtDate(e.end)) : ''}</div>
      <div class="figs">
        <div><span>Usual per day</span><b>${e.isNew ? 'nothing' : esc(money(e.usual))}</b></div>
        <div><span>During, per day</span><b>${esc(money(e.actual))}</b></div>
        <div><span>Worst day</span><b>${e.isNew ? 'new' : esc(e.peak.toFixed(1)) + '×'}</b></div>
        <div><span>Extra cost</span><b style="color:${e.status === 'alert' ? 'var(--mag)' : 'inherit'}">${esc(money(e.excess))}</b></div>
      </div>
      <div class="fig small" id="mini"></div>
      <div class="legend"><span><i style="background:var(--blue)"></i>Actual</span><span><i style="background:none;border-top:2px dashed var(--muted);height:0;border-radius:0"></i>Usual level</span></div>
      <h3 style="margin-top:16px">What happened</h3>
      <p class="explain">${esc(e.explanation)}</p>
      ${st.data.hasQty && !e.isNew ? `<div class="sub" style="margin-bottom:6px">Where the extra cost came from</div>
      <div class="bars"><span>More usage</span><div class="track"><i style="width:${Math.max(0, e.vol) / mx * 100}%;background:var(--blue)"></i></div><b>${esc(money(e.vol))}</b>
      <span>Higher unit price</span><div class="track"><i style="width:${Math.max(0, e.rate) / mx * 100}%;background:var(--mag)"></i></div><b>${esc(money(e.rate))}</b></div>` : ''}
      <p class="sub" style="margin-top:14px">Matched pattern: <b>${esc(e.pattern.name)}</b>${e.pattern.reasons && e.pattern.reasons.length ? ' because ' + esc(e.pattern.reasons.join('; ')) : ''}</p>
      <h3 style="margin-top:10px">What to check</h3>
      <ul class="checks">${e.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="row" style="margin-top:12px"><button class="btn" id="copyx" type="button">Copy explanation</button><span class="muted" id="copiedx"></span></div>
      ${st.isSample && e.status === 'alert' ? `<div class="truth" style="border-color:${truth ? 'var(--ok)' : 'var(--warn)'}"><b>${truth ? `Correct: this is planted problem ${esc(truth.id)}.` : 'False alarm.'}</b> ${truth ? 'What was planted: ' + esc(truth.true_cause) : 'Nothing was planted here; random day-to-day noise crossed the threshold.'}</div>` : ''}`;
    const det = st.res.detail.get(e.sid);
    if (det) {
      const a = Math.max(0, e.a - 35), b = Math.min(st.res.days.length - 1, e.b + 21);
      const box2 = $('#mini');
      const draw = () => lineChart(box2, { days: st.res.days.slice(a, b + 1), ys: Array.from(det.s.cost.slice(a, b + 1)), base: det.det.base.slice(a, b + 1),
        bands: [{ a: e.a - a, b: e.b - a, status: e.status, text: e.status === 'alert' ? 'Flagged' : 'Planned' }], label: `Daily cost of ${e.service} against its usual level`, small: true });
      draw();
      miniRO.disconnect(); miniRO.observe(box2); miniDraw = draw;
    }
    $('#copyx').addEventListener('click', () => copy(`${e.explanation}\n\nWhat to check:\n- ${e.checks.join('\n- ')}`, '#copiedx'));
  }
  let miniDraw = null;
  const miniRO = new ResizeObserver(() => { if (miniDraw) miniDraw(); });

  function renderServices() {
    const tot = new Map();
    for (const s of st.data.series) tot.set(s.service, (tot.get(s.service) || 0) + s.cost.reduce((x, v) => x + v, 0));
    const rows = [...tot].sort((a, b) => b[1] - a[1]);
    const shown = rows.slice(0, 12), rest = rows.slice(12).reduce((s, r) => s + r[1], 0);
    if (rest > 0) shown.push([`${rows.length - 12} other services`, rest]);
    const mx = Math.max(...shown.map((r) => r[1]), 1), all = rows.reduce((s, r) => s + r[1], 0);
    $('#svc').innerHTML = shown.map(([n, v]) => `<span>${esc(n)}</span><div class="track" title="${esc(((v / all) * 100).toFixed(1))}%"><i style="width:${Math.max(0.5, (v / mx) * 100)}%;background:var(--blue)"></i></div><b style="font-variant-numeric:tabular-nums;white-space:nowrap">${esc(moneyK(v))} <span class="sub">${esc(((v / all) * 100).toFixed(0))}%</span></b>`).join('');
  }

  // ---------------------------------------------------------------- setup panels
  function renderMapping() {
    const box = $('#map');
    if (st.isSample || !st.header) {
      $('#mapnote').textContent = 'The sample bill is already in FOCUS format. When you load your own file, the columns found in it appear here.';
      box.innerHTML = CCE.FIELDS.slice(0, 9).map((f) => `<span>${esc(f.label)}</span><span class="muted">${esc(f.names[0])}</span>`).join('');
      $('#remap').hidden = true; return;
    }
    $('#remap').hidden = false;
    $('#mapnote').textContent = 'Found automatically. Fix any that are wrong, then read the file again.';
    const opts = (sel) => `<option value="-1">${sel < 0 ? 'Not in file' : 'Not used'}</option>` + st.header.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');
    box.innerHTML = CCE.FIELDS.map((f) => `<label for="m-${f.id}">${esc(f.label)}${f.need ? ' *' : ''}</label><select id="m-${f.id}" data-f="${f.id}">${opts(st.map[f.id])}</select>`).join('');
  }
  function renderSettings() { $('#pz').value = st.params.z; $('#pm').value = st.params.materiality; $('#pw').value = st.params.window; }
  function renderEvents() {
    const list = st.events;
    $('#evrows').innerHTML = list.length ? list.map((e, i) => `<tr data-i="${i}">
      <td><input type="text" data-k="name" value="${esc(e.name)}" aria-label="Event name"></td>
      <td><input type="date" data-k="start" value="${esc(e.start)}" aria-label="From"></td>
      <td><input type="date" data-k="end" value="${esc(e.end)}" aria-label="To"></td>
      <td><input type="text" data-k="account" value="${esc(e.account || '')}" aria-label="Account" placeholder="any"></td>
      <td><input type="text" data-k="service" value="${esc(e.service || '')}" aria-label="Service contains" placeholder="any"></td>
      <td><button class="btn" data-del="${i}" type="button" aria-label="Remove event">×</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="muted">No planned events yet.</td></tr>';
  }
  function readEvents() {
    const out = [];
    document.querySelectorAll('#evrows tr[data-i]').forEach((tr) => {
      const e = {}; tr.querySelectorAll('input').forEach((inp) => { e[inp.dataset.k] = inp.value.trim(); });
      if (e.start && e.end) out.push({ ...e, name: e.name || 'Planned event' });
    });
    st.events = out;
    if (!st.isSample) { st.userEvents = out; save(); }
  }

  async function copy(text, where) {
    try { await navigator.clipboard.writeText(text); $(where).textContent = 'Copied.'; }
    catch (e) { $(where).textContent = 'Copy was blocked by the browser.'; }
    setTimeout(() => { const el = $(where); if (el) el.textContent = ''; }, 2500);
  }
  function csvOf(evs) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['id', 'status', 'severity', 'start', 'end', 'days', 'account', 'service', 'region', 'usage_type', 'team', 'extra_cost', 'usual_per_day', 'actual_per_day', 'usage_effect', 'price_effect', 'shape', 'pattern', 'explanation'];
    return [head.join(','), ...evs.map((e) => [e.id, e.status, e.severity, e.start, e.end, e.days, e.account, e.service, e.region, e.usage, e.team, e.excess.toFixed(2), e.usual.toFixed(2), e.actual.toFixed(2), e.vol.toFixed(2), e.rate.toFixed(2), e.shape, e.pattern.name, e.explanation].map(q).join(','))].join('\n');
  }

  // ---------------------------------------------------------------- events
  const fileIn = $('#file'), drop = $('#drop');
  $('#pick').addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { if (fileIn.files[0]) loadFile(fileIn.files[0]); fileIn.value = ''; });
  $('#sample').addEventListener('click', loadSample);
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer.files[0]; if (f) loadFile(f); });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => { ev.preventDefault(); const f = ev.dataTransfer && ev.dataTransfer.files[0]; if (f && !drop.contains(ev.target)) loadFile(f); });

  $('#acct').addEventListener('change', (ev) => { st.acct = ev.target.value; drawDaily(); });
  document.querySelectorAll('.chip[data-f]').forEach((c) => c.addEventListener('click', () => { st.filter = c.dataset.f; syncChips(); renderList(); renderDetail(); }));
  $('#sort').addEventListener('click', () => { st.sortBy = st.sortBy === 'date' ? 'cost' : 'date'; syncChips(); renderList(); });
  $('#rows').addEventListener('click', (ev) => { const tr = ev.target.closest('tr[data-id]'); if (tr) { st.sel = tr.dataset.id; renderList(); renderDetail(); } });
  $('#rows').addEventListener('keydown', (ev) => { const tr = ev.target.closest('tr[data-id]'); if (tr && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); st.sel = tr.dataset.id; renderList(); renderDetail(); $(`tr[data-id="${st.sel}"]`).focus(); } });
  $('#copycsv').addEventListener('click', () => { if (st.res) copy(csvOf(visible()), '#copied'); });

  $('#remap').addEventListener('click', () => {
    if (!st.file) return;
    const o = {}; document.querySelectorAll('#map select').forEach((s) => { o[s.dataset.f] = +s.value; });
    if (o.date < 0 || o.cost < 0) { status('Pick the Date and Cost columns first.', true); return; }
    loadFile(st.file, o);
  });
  const rerun = () => {
    const z = +$('#pz').value, m = +$('#pm').value, w = Math.round(+$('#pw').value);
    if (z > 0) st.params.z = z; if (m >= 0) st.params.materiality = m; if (w >= 14) { st.params.window = w; }
    readEvents(); save();
    if (st.data) { run(); status('Re-analysed with the new settings.'); }
  };
  $('#rerun').addEventListener('click', rerun);
  $('#rerun2').addEventListener('click', rerun);
  $('#reset').addEventListener('click', () => { st.params = { ...CCE.DEFAULTS }; renderSettings(); rerun(); });
  $('#addev').addEventListener('click', () => { readEvents(); st.events.push({ name: '', start: st.res ? st.res.days[0] : '', end: st.res ? st.res.days[0] : '', account: '', service: '' }); renderEvents(); const ins = document.querySelectorAll('#evrows input[data-k=name]'); if (ins.length) ins[ins.length - 1].focus(); });
  $('#evrows').addEventListener('click', (ev) => { const b = ev.target.closest('[data-del]'); if (b) { readEvents(); st.events.splice(+b.dataset.del, 1); if (!st.isSample) { st.userEvents = st.events; save(); } renderEvents(); } });

  const dailyRO = new ResizeObserver(() => { if (st.res) drawDaily(); });
  dailyRO.observe($('#daily'));

  loadSample();
}
