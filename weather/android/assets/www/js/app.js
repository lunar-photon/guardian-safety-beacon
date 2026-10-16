// Stratus: state, navigation and views.
import {
  $, $$, esc, clamp, codeLabel, skyTheme, defaultSettings, makeUnits, UNIT_OPTIONS,
  fmtTime, fmtHour, fmtDay, fmtDate, fmtDuration, timeAgo, compass, beaufort, uvLevel, aqiLevel,
  humidityComfort, tempColor, moonPhase, flag, debounce, haptic, localHour,
} from './util.js';
import { iconSvg, glyph } from './icons.js';
import { fetchForecast, fetchAir, fetchNwsAlerts, geocode, reverseGeocode, buildModel, topSeverity, STALE_MS } from './api.js';
import { hourlyStrip, nowcast, compareChart } from './charts.js';
import { Sky } from './sky.js';
import { RadarMap, loadFrames, previewHTML } from './radar.js';

// ------------------------------------------------------------------ persistence

const KEY = 'stratus.v1.';
const load = (k, d) => { try { const v = localStorage.getItem(KEY + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* full or blocked */ } };

const S = {
  cities: load('cities', []),
  here: load('here', null),
  settings: { ...defaultSettings(), ...load('settings', {}) },
  cache: load('cache', {}),
  compare: load('compare', { metric: 'temp', range: 'hours', slots: {} }),
  mode: load('mode', 'cards'),
  editing: false,
  loading: false,
  detailIndex: 0,
  stack: ['home'],
};
let U = makeUnits(S.settings);
let models = {};

const saveCities = () => save('cities', S.cities);
const saveCache = () => {
  const keep = new Set(allCities().map((c) => c.id));
  for (const id of Object.keys(S.cache)) if (!keep.has(id)) delete S.cache[id];
  save('cache', S.cache);
};

function allCities() {
  return [...(S.settings.locate && S.here ? [S.here] : []), ...S.cities];
}

function rebuildModels() {
  models = {};
  for (const c of allCities()) {
    try { models[c.id] = buildModel(S.cache[c.id], U); } catch (e) { console.error('model', c.id, e); models[c.id] = null; }
  }
}

// ------------------------------------------------------------------ bridge & small UI bits

const native = window.NativeBridge || null;

function setInsets(t, r, b, l) {
  const s = document.documentElement.style;
  s.setProperty('--sat', `${t}px`); s.setProperty('--sar', `${r}px`);
  s.setProperty('--sab', `${b}px`); s.setProperty('--sal', `${l}px`);
}

let toastTimer;
function toast(msg, action, fn) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); fn(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 3200);
}

function setLoading(on) {
  S.loading = on;
  let bar = $('.loading-bar');
  if (on && !bar) document.body.append(Object.assign(document.createElement('div'), { className: 'loading-bar' }));
  if (!on && bar) bar.remove();
}

const backdrop = { cur: 'a', theme: '' };
function setBackdrop(theme) {
  if (backdrop.theme === theme) return;
  backdrop.theme = theme;
  const next = backdrop.cur === 'a' ? 'b' : 'a';
  const nextEl = $(`.bd-${next}`), curEl = $(`.bd-${backdrop.cur}`);
  nextEl.className = `bd bd-${next} t-${theme}`;
  nextEl.style.opacity = 1; curEl.style.opacity = 0;
  backdrop.cur = next;
}

// ------------------------------------------------------------------ data refresh

async function refresh(force = false) {
  const list = allCities();
  if (!list.length || S.loading) return;
  const due = list.filter((c) => force || !S.cache[c.id]?.wx || Date.now() - (S.cache[c.id].at || 0) > STALE_MS);
  if (!due.length) return;
  setLoading(true);
  try {
    const [wx, aq] = await Promise.allSettled([fetchForecast(due), fetchAir(due)]);
    if (wx.status === 'rejected') throw wx.reason;
    due.forEach((c, i) => {
      const prev = S.cache[c.id] || {};
      S.cache[c.id] = { ...prev, wx: wx.value[i], aq: aq.status === 'fulfilled' ? aq.value[i] : prev.aq, at: Date.now() };
    });
    saveCache();
    rebuildModels();
    render();
    // official US alerts arrive separately so a slow alert feed never holds up the forecast
    const us = due.filter((c) => c.cc === 'US');
    if (us.length) {
      Promise.all(us.map(async (c) => {
        try { S.cache[c.id].nws = await fetchNwsAlerts(c); } catch { /* keep the last copy */ }
      })).then(() => { saveCache(); rebuildModels(); render(); });
    }
  } catch (e) {
    console.warn('refresh failed', e);
    const have = list.some((c) => S.cache[c.id]?.wx);
    toast(have ? "Couldn't update. Showing the last forecast." : "Couldn't load the forecast. Check your connection.", 'Retry', () => refresh(true));
  } finally {
    setLoading(false);
    endPull();
  }
}

// ------------------------------------------------------------------ location

let locateWaiters = [];
function locate({ quiet = false } = {}) {
  return new Promise((resolve) => {
    locateWaiters.push({ resolve, quiet });
    if (locateWaiters.length > 1) return;
    if (native) native.requestLocation();
    else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => onLocation({ ok: true, lat: p.coords.latitude, lon: p.coords.longitude }),
        (e) => onLocation({ ok: false, code: e.code === 1 ? 'denied' : 'unavailable', message: e.message }),
        { timeout: 20000, maximumAge: 15 * 60000 });
    } else onLocation({ ok: false, code: 'unavailable', message: 'Location is not available.' });
  });
}

async function onLocation(res) {
  const waiters = locateWaiters; locateWaiters = [];
  const quiet = waiters.every((w) => w.quiet);
  if (!res.ok) {
    if (!quiet) {
      if (res.code === 'blocked' && native) toast('Location is blocked for Stratus.', 'Settings', () => native.openAppSettings());
      else toast(res.message || "Couldn't find your location.");
    }
    waiters.forEach((w) => w.resolve(null));
    return;
  }
  let place = null;
  if (res.name) {
    place = { name: res.name, admin1: res.admin1 || '', country: res.country || '', cc: res.cc || '' };
  } else {
    place = await reverseGeocode(res.lat, res.lon);
  }
  const nameChanged = !S.here || S.here.name !== place.name;
  const moved = !S.here || Math.abs(S.here.lat - res.lat) > 0.02 || Math.abs(S.here.lon - res.lon) > 0.02;
  if (moved || nameChanged) {
    if (S.here) delete S.cache.here;
    S.here = { id: 'here', isHere: true, lat: res.lat, lon: res.lon, ...place };
  } else {
    S.here.lat = res.lat;
    S.here.lon = res.lon;
  }
  S.here.locatedAt = Date.now();
  save('here', S.here);
  waiters.forEach((w) => w.resolve(S.here));
  if (moved || nameChanged) { rebuildModels(); render(); refresh(); }
}

// ------------------------------------------------------------------ navigation

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('show', v.id === view));
  if (view === 'home') { setBackdrop('home'); sky.stop(); }
  if (view !== 'radar') radar.hide();
  else sky.stop();
}

function push(view) { S.stack.push(view); show(view); }

function back() {
  if (!$('#sheet').hidden) { closeSheet(); return true; }
  if (S.editing) { toggleEdit(false); return true; }
  if (S.stack.length > 1) {
    S.stack.pop();
    const v = S.stack[S.stack.length - 1];
    show(v);
    if (v === 'detail') syncDetailChrome();
    if (v === 'home') renderHome();
    return true;
  }
  if (S.mode === 'compare') { setMode('cards'); return true; }
  return false;
}

// ------------------------------------------------------------------ home

function cityLine(c, m) {
  const where = [c.admin1, c.country].filter(Boolean).join(', ');
  const time = m ? fmtTime(Date.now(), m.off, S.settings.clock) : '';
  return [c.isHere ? 'Current location' : where, time].filter(Boolean).join(' · ');
}

function cardHTML(c, i, n) {
  const m = models[c.id];
  if (!m) {
    return `<article class="card t-home" data-id="${esc(c.id)}">
      <div class="card-head"><h3>${c.isHere ? glyph('pin') : ''}${esc(c.name)}</h3><p>${esc(cityLine(c, null))}</p></div>
      <div class="card-main"><div class="card-temp muted">–</div><div class="card-cond"><span>Loading forecast…</span></div></div>
      ${editHTML(c, i, n)}</article>`;
  }
  const d0 = m.days.find((d) => d.t + 86400000 > Date.now()) || m.days[0];
  const theme = skyTheme(m.now.code, m.now.isDay);
  const hrs = m.hours.slice(1, 7).map((x) => `<div><span>${fmtHour(x.t, m.off, S.settings.clock)}</span>${iconSvg(x.code, x.isDay)}<b>${U.temp(x.temp)}</b></div>`).join('');
  const top = m.alerts[0];
  const stale = Date.now() - (m.fetchedAt || 0) > 3 * 3600000;
  return `<article class="card t-${theme}" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="${esc(c.name)}, ${esc(U.temp(m.now.temp))}, ${esc(codeLabel(m.now.code))}">
    ${iconSvg(m.now.code, m.now.isDay, 'card-deco')}
    <div class="card-head"><h3>${c.isHere ? glyph('pin') : ''}${esc(c.name)}</h3><p>${esc(cityLine(c, m))}</p></div>
    <div class="card-main">
      <div class="card-temp">${U.temp(m.now.temp)}</div>
      <div class="card-cond"><b>${esc(codeLabel(m.now.code))}</b><span>H ${U.temp(d0.max)} · L ${U.temp(d0.min)}</span></div>
    </div>
    ${top ? `<div class="card-alert"><span class="sev sm sev-${top.severity}">${glyph('alert')}</span>${esc(top.title)}${m.alerts.length > 1 ? ` <span class="muted">+${m.alerts.length - 1}</span>` : ''}</div>` : ''}
    <div class="card-hours">${hrs}</div>
    ${stale ? `<span class="stale">Updated ${timeAgo(m.fetchedAt)}</span>` : ''}
    ${editHTML(c, i, n)}
  </article>`;
}

function editHTML(c, i, n) {
  if (c.isHere) return '<div class="card-edit"><span class="muted" style="margin-right:auto;font-size:13px">Turn off in Settings</span></div>';
  const off = S.settings.locate && S.here ? 1 : 0;
  const j = i - off;
  return `<div class="card-edit">
    <button class="icon-btn" data-act="up" data-id="${esc(c.id)}" aria-label="Move up" ${j === 0 ? 'disabled' : ''}>${glyph('up')}</button>
    <button class="icon-btn" data-act="down" data-id="${esc(c.id)}" aria-label="Move down" ${j === n - off - 1 ? 'disabled' : ''}>${glyph('down')}</button>
    <button class="icon-btn danger" data-act="remove" data-id="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">${glyph('trash')}</button>
  </div>`;
}

const SUGGEST = [
  ['London', 51.5085, -0.1257, 'GB', 'England', 'United Kingdom'],
  ['New York', 40.7143, -74.006, 'US', 'New York', 'United States'],
  ['Tokyo', 35.6895, 139.6917, 'JP', 'Tokyo', 'Japan'],
  ['Mumbai', 19.0728, 72.8826, 'IN', 'Maharashtra', 'India'],
  ['Sydney', -33.8678, 151.2073, 'AU', 'New South Wales', 'Australia'],
  ['Dubai', 25.0772, 55.3093, 'AE', 'Dubai', 'United Arab Emirates'],
];

function renderHome() {
  const list = allCities();
  const sub = list.length ? fmtDate(Date.now(), -new Date().getTimezoneOffset() * 60) : '';
  $('#home-sub').textContent = sub;
  $('#edit-btn').hidden = !S.cities.length || S.mode !== 'cards';
  $('#edit-btn').textContent = S.editing ? 'Done' : 'Edit';
  $$('#mode-seg button').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === S.mode));
  $('.seg-row').hidden = !list.length;
  $('#cards').hidden = S.mode !== 'cards' && list.length > 0;
  $('#compare').hidden = S.mode !== 'compare' || !list.length;
  $('#cards').classList.toggle('editing', S.editing);

  if (!list.length) {
    $('#cards').innerHTML = `<div class="empty" style="grid-column:1/-1">
      ${iconSvg(2, true)}
      <h2>Your skies, side by side</h2>
      <p>Add the places you care about and see all their weather at once.</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn" data-act="search">${glyph('search')}Add a city</button>
        <button class="btn ghost" data-act="use-location">${glyph('locate')}Use my location</button>
      </div>
      <div class="suggest">${SUGGEST.map((s, i) => `<button data-act="suggest" data-i="${i}">${flag(s[3])} ${esc(s[0])}</button>`).join('')}</div>
    </div>`;
  } else {
    $('#cards').innerHTML = list.map((c, i) => cardHTML(c, i, list.length)).join('');
  }
  if (S.mode === 'compare' && list.length) renderCompare();

  const newest = Math.max(0, ...list.map((c) => S.cache[c.id]?.at || 0));
  $('#home-foot').innerHTML = list.length
    ? `${newest ? `Updated ${timeAgo(newest)} · ` : ''}Pull down to refresh<br>Weather data by <a href="https://open-meteo.com/" data-ext>Open-Meteo.com</a>`
    : '';
}

function setMode(mode) {
  S.mode = mode; save('mode', mode);
  if (S.editing) S.editing = false;
  renderHome();
  $('#home-scroll').scrollTop = 0;
}

function toggleEdit(on = !S.editing) {
  S.editing = on;
  haptic();
  renderHome();
}

function moveCity(id, dir) {
  const i = S.cities.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.cities.length) return;
  [S.cities[i], S.cities[j]] = [S.cities[j], S.cities[i]];
  saveCities(); haptic(); renderHome();
}

function removeCity(id) {
  const i = S.cities.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [gone] = S.cities.splice(i, 1);
  const cached = S.cache[id];
  delete S.compare.slots[id]; save('compare', S.compare);
  saveCities(); saveCache(); rebuildModels(); haptic('long');
  if (!S.cities.length) S.editing = false;
  renderHome();
  toast(`Removed ${gone.name}`, 'Undo', () => {
    S.cities.splice(i, 0, gone);
    if (cached) S.cache[id] = cached;
    saveCities(); saveCache(); rebuildModels(); renderHome();
  });
}

function addCity(c) {
  if (S.cities.some((x) => x.id === c.id)) { toast(`${c.name} is already in your list`); return false; }
  S.cities.push({ id: c.id, name: c.name, admin1: c.admin1, country: c.country, cc: c.cc, lat: c.lat, lon: c.lon });
  saveCities(); rebuildModels(); renderHome(); refresh();
  haptic('confirm');
  requestAnimationFrame(() => {
    const el = $(`.card[data-id="${CSS.escape(c.id)}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); }
  });
  return true;
}

// ------------------------------------------------------------------ compare

const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const METRICS = {
  temp: { label: 'Temperature', hour: (x) => U.toDisplayTemp(x.temp), day: (d) => U.toDisplayTemp(d.max), fmt: (v) => `${Math.round(v)}°`, unit: () => U.tempUnit, dayNote: 'Daily highs' },
  feels: { label: 'Feels like', hour: (x) => U.toDisplayTemp(x.feels), day: (d) => U.toDisplayTemp(d.fmax), fmt: (v) => `${Math.round(v)}°`, unit: () => U.tempUnit, dayNote: 'Daily feels-like highs' },
  pop: { label: 'Rain chance', hour: (x) => x.pop, day: (d) => d.pop, fmt: (v) => `${Math.round(v)}%`, unit: () => '%', dayNote: 'Highest chance each day' },
  wind: { label: 'Wind', hour: (x) => U.windN(x.wind), day: (d) => U.windN(d.wmax), fmt: (v) => `${v} ${U.windUnit}`, unit: () => U.windUnit, dayNote: 'Daily maximum wind' },
  hum: { label: 'Humidity', hour: (x) => x.hum, day: null, fmt: (v) => `${Math.round(v)}%`, unit: () => '%' },
};

/** Colour follows the city: a city keeps its slot while selected; new picks take the first free slot. */
function compareSlots() {
  const list = allCities().filter((c) => models[c.id]);
  const slots = S.compare.slots;
  for (const id of Object.keys(slots)) if (!list.some((c) => c.id === id)) delete slots[id];
  if (!Object.keys(slots).length) list.slice(0, 4).forEach((c, i) => { slots[c.id] = i; });
  return list;
}

function toggleCompareCity(id) {
  const slots = S.compare.slots;
  if (id in slots) {
    if (Object.keys(slots).length <= 1) return;
    delete slots[id];
  } else {
    const used = new Set(Object.values(slots));
    const free = SERIES.findIndex((_, i) => !used.has(i));
    if (free < 0) { toast('Compare up to 8 cities at once'); return; }
    slots[id] = free;
  }
  save('compare', S.compare); haptic(); renderCompare();
}

function renderCompare() {
  const list = compareSlots();
  const cfg = S.compare;
  const met = METRICS[cfg.metric] || METRICS.temp;
  const range = met.day ? cfg.range : 'hours';
  const sel = list.filter((c) => c.id in cfg.slots);

  let xLabels, tickEvery;
  const series = sel.map((c) => {
    const m = models[c.id];
    const values = range === 'hours'
      ? m.hours.slice(0, 48).map(met.hour)
      : m.days.slice(0, 14).map(met.day);
    return { id: c.id, name: c.name, color: SERIES[cfg.slots[c.id]], values };
  });
  if (range === 'hours') {
    const n = Math.max(...series.map((s) => s.values.length), 2);
    xLabels = Array.from({ length: n }, (_, i) => (i === 0 ? 'Now' : `+${i}h`));
    tickEvery = 12;
  } else {
    const n = Math.max(...series.map((s) => s.values.length), 2);
    const nowOff = -new Date().getTimezoneOffset() * 60;
    xLabels = Array.from({ length: n }, (_, i) => (i === 0 ? 'Today' : fmtDay(Date.now() + i * 86400000, nowOff, { relative: false })));
    tickEvery = 3;
  }

  const metricSeg = Object.entries(METRICS).map(([k, v]) => `<button data-act="c-metric" data-k="${k}" aria-selected="${k === cfg.metric}">${v.label}</button>`).join('');
  const rangeSeg = `<button data-act="c-range" data-k="hours" aria-selected="${range === 'hours'}">48 hours</button><button data-act="c-range" data-k="days" aria-selected="${range === 'days'}" ${met.day ? '' : 'disabled style="opacity:.4"'}>14 days</button>`;
  const legend = list.map((c) => {
    const on = c.id in cfg.slots;
    return `<button data-act="c-city" data-id="${esc(c.id)}" aria-pressed="${on}"><i style="${on ? `background:${SERIES[cfg.slots[c.id]]}` : ''}"></i>${esc(c.name)}</button>`;
  }).join('');

  const rows = list.map((c) => {
    const m = models[c.id];
    const d0 = m.days.find((d) => d.t + 86400000 > Date.now()) || m.days[0];
    const aqv = S.settings.aqi === 'eu' ? m.aq?.european_aqi : m.aq?.us_aqi;
    const lv = aqiLevel(aqv, S.settings.aqi);
    return `<tr data-act="open" data-id="${esc(c.id)}">
      <td>${esc(c.name)}</td>
      <td>${iconSvg(m.now.code, m.now.isDay)}${U.temp(m.now.temp)}</td>
      <td>${U.temp(d0.max)} / ${U.temp(d0.min)}</td>
      <td>${d0.pop ?? 0}%</td>
      <td>${U.windN(m.now.wind)}</td>
      <td>${aqv == null ? '–' : `<span class="aqi-dot" style="background:${lv.color}"></span>${Math.round(aqv)}`}</td>
    </tr>`;
  }).join('');

  $('#compare').innerHTML = `
    <div class="panel">
      <h2>${esc(met.label)}</h2>
      <p class="sub">${range === 'hours' ? 'Next 48 hours, aligned to the same moment everywhere' : esc(met.dayNote)} · drag across the chart to read values</p>
      <div class="c-controls"><div class="seg">${metricSeg}</div><div class="seg">${rangeSeg}</div></div>
      <div class="legend">${legend}</div>
      <div id="c-chart"></div>
    </div>
    <div class="panel">
      <h2>At a glance</h2>
      <p class="sub">Tap a city for its full forecast</p>
      <table class="ctable"><thead><tr><th>City</th><th>Now</th><th>H / L</th><th>Rain</th><th>Wind</th><th>AQI</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  compareChart($('#c-chart'), { series, xLabels, tickEvery, fmt: met.fmt, yUnit: met.unit(), tipTitle: met.label });
}

// ------------------------------------------------------------------ detail pager

function openDetail(id) {
  const list = allCities();
  const i = Math.max(0, list.findIndex((c) => c.id === id));
  S.detailIndex = i;
  buildPager();
  push('detail');
  const pager = $('#pager');
  pager.scrollLeft = i * pager.clientWidth;
  renderPagesAround(i);
  syncDetailChrome();
}

function buildPager() {
  const list = allCities();
  $('#pager').innerHTML = list.map((c) => `<section class="page" data-id="${esc(c.id)}"></section>`).join('');
  $('#d-dots').innerHTML = list.map((c) => `<i class="${c.isHere ? 'here' : ''}"></i>`).join('');
  $$('#pager .page').forEach((p) => p.addEventListener('scroll', onPageScroll, { passive: true }));
}

function renderPagesAround(i) {
  const pages = $$('#pager .page');
  [i, i - 1, i + 1].forEach((k) => {
    const p = pages[k];
    if (p && !p.dataset.done) { p.innerHTML = pageHTML(allCities()[k]); p.dataset.done = '1'; }
  });
}

function rerenderPages() {
  if (!$('#detail').classList.contains('show')) { $('#pager').innerHTML = ''; return; }
  const list = allCities();
  const pages = $$('#pager .page');
  if (pages.length !== list.length) { const id = list[S.detailIndex]?.id; buildPager(); openDetailIndex(id); return; }
  pages.forEach((p) => { delete p.dataset.done; });
  const keep = pages.map((p) => p.scrollTop);
  renderPagesAround(S.detailIndex);
  pages.forEach((p, k) => { p.scrollTop = keep[k]; });
  syncDetailChrome();
}

function openDetailIndex(id) {
  const list = allCities();
  S.detailIndex = Math.max(0, list.findIndex((c) => c.id === id));
  $('#pager').scrollLeft = S.detailIndex * $('#pager').clientWidth;
  renderPagesAround(S.detailIndex);
  syncDetailChrome();
}

function syncDetailChrome() {
  const list = allCities();
  const c = list[S.detailIndex];
  if (!c) return;
  const m = models[c.id];
  $('#d-name').textContent = c.name;
  $$('#d-dots i').forEach((d, k) => d.classList.toggle('on', k === S.detailIndex));
  const page = $$('#pager .page')[S.detailIndex];
  $('.d-title').classList.toggle('scrolled', (page?.scrollTop || 0) > 140);
  if (m) {
    const theme = skyTheme(m.now.code, m.now.isDay);
    setBackdrop(theme);
    if (S.settings.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const intensity = clamp((m.now.precip || 0) / 4 + (m.hours[0]?.pop || 0) / 200, 0.2, 1);
      sky.set(theme, intensity);
      sky.start();
    } else { sky.set('clear-day', 0); sky.stop(); sky.g.clearRect(0, 0, sky.w, sky.h); }
  }
}

function onPagerScroll() {
  const pager = $('#pager');
  const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
  if (i !== S.detailIndex && i >= 0 && i < allCities().length) {
    S.detailIndex = i;
    renderPagesAround(i);
    syncDetailChrome();
    haptic();
  }
}

function onPageScroll(e) {
  if (e.target === $$('#pager .page')[S.detailIndex]) $('.d-title').classList.toggle('scrolled', e.target.scrollTop > 140);
}

function pageHTML(c) {
  const m = models[c.id];
  if (!m) {
    return `<div class="page-in"><div class="hero"><h2>${esc(c.name)}</h2><div class="hero-temp muted">–</div><p class="muted">${S.loading ? 'Loading forecast…' : 'No forecast yet. Pull down on the home screen to refresh.'}</p></div></div>`;
  }
  const now = m.now;
  const d0 = m.days.find((d) => d.t + 86400000 > Date.now()) || m.days[0];
  const nc = nowcast(m, U);
  const where = c.isHere ? [c.admin1, c.country].filter(Boolean).join(', ') : [c.admin1, c.country].filter(Boolean).join(', ');

  const alertsHTML = m.alerts.length ? `<button class="box" style="display:block;width:100%" data-act="alerts" data-id="${esc(c.id)}">
      ${m.alerts.slice(0, 2).map((a) => `<div class="alert-box" style="margin-bottom:6px">${sevIcon(a)}<div><b>${esc(a.title)}</b><small>${a.source === 'official' ? esc(a.sender) : 'Forecast advisory'}${a.start ? ` · ${esc(whenText(a, m.off))}` : ''}</small></div></div>`).join('')}
      ${m.alerts.length > 2 ? `<small class="muted">+${m.alerts.length - 2} more</small>` : ''}
    </button>` : '';

  const minDay = Math.min(...m.days.map((d) => d.min)), maxDay = Math.max(...m.days.map((d) => d.max));
  const span = Math.max(1, maxDay - minDay);
  const dailyRows = m.days.map((d, i) => {
    const l = ((d.min - minDay) / span) * 100, w = ((d.max - d.min) / span) * 100;
    const isToday = d === d0;
    const dot = isToday && now.temp != null ? `<b style="left:${clamp(((now.temp - minDay) / span) * 100, 0, 100)}%"></b>` : '';
    return `<button class="drow" data-act="day" data-id="${esc(c.id)}" data-i="${i}">
      <span class="dname">${fmtDay(d.t, m.off)}</span>
      ${iconSvg(d.code, true)}
      <span class="dpop">${d.pop >= 10 ? d.pop + '%' : ''}</span>
      <span class="dlo">${U.temp(d.min)}</span>
      <span class="range"><i style="left:${l}%;width:${Math.max(w, 3)}%;background:linear-gradient(90deg,${tempColor(d.min)},${tempColor(d.max)})"></i>${dot}</span>
      <span class="dhi">${U.temp(d.max)}</span>
    </button>`;
  }).join('');

  const summary = daySummary(m, d0);

  return `<div class="page-in">
    <div class="hero">
      <h2>${c.isHere ? glyph('pin') : ''}${esc(c.name)}</h2>
      <div class="place">${esc(where)}${where ? ' · ' : ''}${fmtTime(Date.now(), m.off, S.settings.clock)}</div>
      <div class="hero-temp">${U.temp(now.temp)}</div>
      <div class="hero-cond">${iconSvg(now.code, now.isDay)}${esc(codeLabel(now.code))}</div>
      <div class="hero-hl">H ${U.temp(d0.max)} · L ${U.temp(d0.min)} · Feels like ${U.temp(now.feels)}</div>
      ${nc && !nc.wet ? `<div class="hero-note">${esc(nc.summary)}</div>` : ''}
    </div>
    ${alertsHTML}
    ${nc && nc.wet ? `<div class="box"><div class="box-h">${glyph('umbrella')}Next 2 hours</div><div class="box-sum">${esc(nc.summary)}</div>${nc.html}</div>` : ''}
    <div class="box">
      <div class="box-h">${glyph('clock')}Hourly forecast</div>
      <div class="box-sum">${esc(summary)}</div>
      ${hourlyStrip(m, U)}
    </div>
    <div class="box">
      <div class="box-h">${glyph('chart')}${m.days.length}-day forecast</div>
      ${dailyRows}
    </div>
    ${tilesHTML(m)}
    ${aqHTML(m)}
    ${sunMoonHTML(m)}
    <button class="box radar-card" data-act="radar-city" data-id="${esc(c.id)}" aria-label="Open radar for ${esc(c.name)}">
      ${previewHTML(c.lat, c.lon) || ''}
      <span class="lbl">${glyph('map')}Precipitation radar</span>
    </button>
    <div class="d-foot">Updated ${timeAgo(m.fetchedAt)} · Data by <button data-ext="https://open-meteo.com/">Open-Meteo.com</button> (CC BY 4.0)</div>
  </div>`;
}

function daySummary(m, d0) {
  const next = m.hours.slice(0, 24);
  const wetH = next.find((x) => (x.pop ?? 0) >= 50);
  const label = codeLabel(d0.code).toLowerCase();
  let s = `${codeLabel(m.now.code)} now.`;
  if (wetH) s += ` ${wetH.pop}% chance of rain around ${fmtHour(wetH.t, m.off, S.settings.clock)}${S.settings.clock === '24' ? ':00' : ''}.`;
  else if (next.length) s += ` Mostly dry for the next 24 hours.`;
  const gust = Math.max(0, ...next.map((x) => x.gust || 0));
  if (gust >= 50) s += ` Gusts up to ${U.wind(gust)}.`;
  const evening = localHour(Date.now(), m.off) >= 18;
  const d1 = m.days[m.days.indexOf(d0) + 1];
  if (evening && d1) s += ` Tomorrow: ${codeLabel(d1.code).toLowerCase()}, ${U.temp(d1.min)} to ${U.temp(d1.max)}.`;
  else if (!wetH && label) s += ` Expect ${label} today.`;
  return s;
}

function sevIcon(a) {
  return `<span class="sev sev-${a.severity}">${glyph('alert')}</span>`;
}

function whenText(a, off) {
  const f = (t) => `${fmtDay(t, off)} ${fmtTime(t, off, S.settings.clock)}`;
  const sameDay = a.start && a.end && fmtDate(a.start, off) === fmtDate(a.end - 1, off);
  if (sameDay) return `${f(a.start)}–${fmtTime(a.end, off, S.settings.clock)}`;
  if (a.start && a.end) return `${f(a.start)} – ${f(a.end)}`;
  if (a.start) return `from ${f(a.start)}`;
  return '';
}

// ---- detail tiles

function tilesHTML(m) {
  const n = m.now;
  const d0 = m.days[0];

  const diff = (n.feels ?? n.temp) - n.temp;
  const feelsTxt = Math.abs(diff) < 1.5 ? 'Similar to the actual temperature.'
    : diff > 0 ? (n.hum > 50 ? 'Humidity makes it feel warmer.' : 'Sunshine makes it feel warmer.')
      : (n.wind > 10 ? 'Wind makes it feel colder.' : 'Feels cooler than the actual temperature.');

  const uv = n.uv ?? 0;
  const [uvName] = uvLevel(uv);
  // the next stretch of UV >= 3 within a day: "until" if it's on now, "from–to" if it's coming
  const day = m.hours.slice(0, 24);
  const startI = day.findIndex((x) => (x.uv ?? 0) >= 3);
  let uvTxt = 'Low for the rest of the day.';
  if (startI >= 0) {
    let endI = startI;
    while (endI + 1 < day.length && (day[endI + 1].uv ?? 0) >= 3) endI++;
    const end = fmtTime(day[endI].t + 3600000, m.off, S.settings.clock);
    uvTxt = startI === 0 && uv >= 3 ? `Use sun protection until ${end}.`
      : `Use sun protection ${fmtTime(day[startI].t, m.off, S.settings.clock)}–${end}.`;
  }

  const visKm = (n.vis ?? 0) / 1000;
  const visTxt = n.vis == null ? '' : visKm >= 20 ? 'Perfectly clear view.' : visKm >= 10 ? 'Clear view.' : visKm >= 4 ? 'Light haze.' : visKm >= 1 ? 'Haze or mist is reducing visibility.' : 'Fog: visibility is very poor.';

  const rain24 = m.hours.slice(0, 24).reduce((a, x) => a + (x.precip || 0), 0);
  const nextRain = m.hours.find((x) => (x.precip || 0) >= 0.1);
  const rainTxt = rain24 >= 0.1 ? `Expected in the next 24 hours.` : nextRain ? `Next rain ${fmtDay(nextRain.t, m.off)} around ${fmtHour(nextRain.t, m.off, S.settings.clock)}.` : 'None expected in the next 3 days.';

  const trend = n.pressureTrend;
  const trendTxt = Math.abs(trend) < 0.6 ? 'Steady' : trend > 0 ? 'Rising' : 'Falling';

  return `<div class="tiles">
    <div class="box"><div class="box-h">${glyph('thermo')}Feels like</div>
      <div class="tile-v">${U.temp(n.feels)}</div><div class="tile-s">${feelsTxt}</div></div>
    <div class="box"><div class="box-h">${glyph('drop')}Humidity</div>
      <div class="tile-v">${n.hum ?? '–'}<span class="tile-u">%</span></div>
      <div class="tile-s">${humidityComfort(n.dew)}. Dew point ${U.temp(n.dew)}.</div></div>
    <div class="box"><div class="box-h">${glyph('wind')}Wind</div>
      ${compassSVG(n.windDir, U.windN(n.wind), U.windUnit)}
      <div class="tile-s">${beaufort(n.wind ?? 0)} from ${compass(n.windDir)}. Gusts ${U.wind(n.gust)}.</div></div>
    <div class="box"><div class="box-h">${glyph('sun')}UV index</div>
      <div class="tile-v">${Math.round(uv)} <span class="tile-u">${uvName}</span></div>
      <div class="uvbar"><b style="left:${clamp(uv / 11, 0, 1) * 100}%"></b></div>
      <div class="tile-s">${uvTxt} Today's peak ${Math.round(d0?.uv ?? uv)}.</div></div>
    <div class="box"><div class="box-h">${glyph('umbrella')}Precipitation</div>
      <div class="tile-v">${U.precip(rain24)}</div><div class="tile-s">${rainTxt}</div></div>
    <div class="box"><div class="box-h">${glyph('gauge')}Pressure</div>
      ${gaugeSVG(n.pressure, trend)}
      <div class="tile-s">${U.pressure(n.pressure)} · ${trendTxt}</div></div>
    <div class="box"><div class="box-h">${glyph('eye')}Visibility</div>
      <div class="tile-v">${U.distance(n.vis)}</div><div class="tile-s">${visTxt}</div></div>
    <div class="box"><div class="box-h">${glyph('cloud')}Cloud cover</div>
      <div class="tile-v">${n.cloud ?? '–'}<span class="tile-u">%</span></div>
      <div class="tile-s">${(n.cloud ?? 0) < 20 ? 'Clear skies.' : (n.cloud ?? 0) < 60 ? 'Some clouds.' : (n.cloud ?? 0) < 90 ? 'Mostly cloudy.' : 'Overcast.'}</div></div>
  </div>`;
}

function compassSVG(deg, speed, unit) {
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const a = (i * 10 * Math.PI) / 180, r1 = i % 9 === 0 ? 40 : 43;
    return `<line x1="${50 + Math.sin(a) * r1}" y1="${50 - Math.cos(a) * r1}" x2="${50 + Math.sin(a) * 47}" y2="${50 - Math.cos(a) * 47}" stroke="rgba(255,255,255,${i % 9 === 0 ? 0.6 : 0.25})" stroke-width="${i % 9 === 0 ? 1.6 : 1}"/>`;
  }).join('');
  // the arrow points where the wind blows to (from + 180°)
  const rot = ((deg ?? 0) + 180) % 360;
  return `<svg class="compass tile-art" viewBox="0 0 100 100" aria-label="Wind from ${compass(deg)}">
    ${ticks}
    <text x="50" y="18" text-anchor="middle">N</text><text x="84" y="53.5" text-anchor="middle">E</text>
    <text x="50" y="89" text-anchor="middle">S</text><text x="16" y="53.5" text-anchor="middle">W</text>
    <g transform="rotate(${rot} 50 50)"><line x1="50" y1="76" x2="50" y2="26" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M50,17 L56,29 L44,29 Z" fill="#fff"/></g>
    <circle cx="50" cy="50" r="15" fill="rgba(10,18,36,.85)"/>
    <text x="50" y="51" text-anchor="middle" style="fill:#fff;font-size:13px;font-weight:600">${speed ?? '–'}</text>
    <text x="50" y="60" text-anchor="middle" style="font-size:7px">${esc(unit)}</text>
  </svg>`;
}

function gaugeSVG(hpa, trend) {
  const lo = 970, hi = 1045;
  const k = clamp(((hpa ?? 1013) - lo) / (hi - lo), 0, 1);
  const a0 = -220, a1 = 40; // degrees, 0 = east
  const pt = (deg, r) => [60 + Math.cos((deg * Math.PI) / 180) * r, 56 + Math.sin((deg * Math.PI) / 180) * r];
  const arc = (from, to, r) => {
    const [x0, y0] = pt(from, r), [x1, y1] = pt(to, r);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  const ang = a0 + (a1 - a0) * k;
  const [nx, ny] = pt(ang, 40);
  const arrow = Math.abs(trend) < 0.6 ? '=' : trend > 0 ? '↑' : '↓';
  return `<svg class="gauge tile-art" viewBox="0 0 120 92" aria-hidden="true">
    <path d="${arc(a0, a1, 44)}" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="6" stroke-linecap="round"/>
    <path d="${arc(a0, ang, 44)}" fill="none" stroke="#9ccfff" stroke-width="6" stroke-linecap="round"/>
    <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="5" fill="#fff" stroke="rgba(0,0,0,.3)" stroke-width="2"/>
    <text x="60" y="60" text-anchor="middle" style="fill:#fff;font-size:22px;font-weight:500">${arrow}</text>
    <text x="22" y="90" text-anchor="middle" style="fill:rgba(230,238,250,.58);font-size:9px">Low</text>
    <text x="98" y="90" text-anchor="middle" style="fill:rgba(230,238,250,.58);font-size:9px">High</text>
  </svg>`;
}

// ---- air quality

const WHO = { pm2_5: 15, pm10: 45, ozone: 100, nitrogen_dioxide: 25, sulphur_dioxide: 40, carbon_monoxide: 4000 };
const POL_NAMES = { pm2_5: 'PM2.5', pm10: 'PM10', ozone: 'O₃', nitrogen_dioxide: 'NO₂', sulphur_dioxide: 'SO₂', carbon_monoxide: 'CO' };
const AQ_COLORS = ['#3ecf6e', '#e6cf3a', '#f59a3a', '#ef5a4a', '#b04ad6', '#8a2b44'];

function aqHTML(m) {
  const a = m.aq;
  if (!a) return '';
  const scale = S.settings.aqi;
  const v = scale === 'eu' ? a.european_aqi : a.us_aqi;
  const lv = aqiLevel(v, scale);
  const max = scale === 'eu' ? 100 : 300;
  const k = clamp((v ?? 0) / max, 0, 1);
  const C = 2 * Math.PI * 40;
  const advice = ['Air quality is great. Enjoy the outdoors.', 'Acceptable. Unusually sensitive people should limit long exertion outside.',
    'Sensitive groups should reduce prolonged outdoor exertion.', 'Everyone should reduce prolonged outdoor exertion.',
    'Avoid outdoor exertion; sensitive groups should stay indoors.', 'Health warning: everyone should avoid outdoor activity.'][lv.tone] || '';

  const pols = Object.keys(WHO).filter((p) => a[p] != null).map((p) => {
    const ratio = a[p] / WHO[p];
    const color = ratio <= 1 ? AQ_COLORS[0] : ratio <= 2 ? AQ_COLORS[1] : ratio <= 4 ? AQ_COLORS[2] : AQ_COLORS[3];
    const valTxt = p === 'carbon_monoxide' ? `${Math.round(a[p])}` : `${Math.round(a[p] * 10) / 10}`;
    return `<div class="pol"><div><span>${POL_NAMES[p]}</span><em>${valTxt} <small class="muted">µg/m³</small></em></div><div class="bar"><i style="width:${clamp(ratio / 4, 0.03, 1) * 100}%;background:${color}"></i></div></div>`;
  }).join('');

  const dominant = Object.keys(WHO).filter((p) => a[p] != null).sort((x, y) => a[y] / WHO[y] - a[x] / WHO[x])[0];

  const hrs = (a.hourly || []).slice(0, 24);
  const hmax = Math.max(1, ...hrs.map((x) => (scale === 'eu' ? x.eu : x.us) || 0));
  const bars = hrs.map((x) => {
    const val = scale === 'eu' ? x.eu : x.us;
    const l = aqiLevel(val, scale);
    return `<i style="height:${clamp((val || 0) / hmax, 0.08, 1) * 100}%;background:${l.color}" title="${fmtHour(x.t, m.off, S.settings.clock)}: ${val ?? '–'} (${l.label})"></i>`;
  }).join('');

  const POLLEN = { alder_pollen: 'Alder', birch_pollen: 'Birch', grass_pollen: 'Grass', mugwort_pollen: 'Mugwort', olive_pollen: 'Olive', ragweed_pollen: 'Ragweed' };
  const pollenLevel = (g) => (g < 1 ? 'None' : g < 10 ? 'Low' : g < 50 ? 'Moderate' : g < 200 ? 'High' : 'Very high');
  const pollen = Object.keys(POLLEN).filter((p) => a[p] != null);
  const pollenHTML = pollen.length ? `<div class="pollen"><div class="box-h" style="margin-bottom:4px">${glyph('flower')}Pollen</div>
    ${pollen.map((p) => `<div class="pollen-row"><span>${POLLEN[p]}</span><em>${pollenLevel(a[p])} · ${Math.round(a[p])} grains/m³</em></div>`).join('')}</div>` : '';

  return `<div class="box">
    <div class="box-h">${glyph('leaf')}Air quality<span class="r">${scale === 'eu' ? 'European AQI' : 'US AQI'}</span></div>
    <div class="aq-top">
      <svg class="aq-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="8"/>
        <circle cx="50" cy="50" r="40" fill="none" stroke="${lv.color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(C * k).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/>
        <text x="50" y="57" text-anchor="middle" style="font-size:24px;font-weight:600">${v == null ? '–' : Math.round(v)}</text>
      </svg>
      <div class="aq-label"><b>${esc(lv.label)}</b><span>${esc(advice)}${dominant ? ` Main pollutant: ${POL_NAMES[dominant]}.` : ''}</span></div>
    </div>
    <div class="aq-scale">${AQ_COLORS.map((c, i) => `<i style="background:${c}" class="${i === lv.tone ? 'on' : ''}"></i>`).join('')}</div>
    <div class="pollutants">${pols}</div>
    ${hrs.length ? `<div class="aq-hours" aria-label="Air quality forecast, next 24 hours">${bars}</div><div class="aq-axis"><span>Now</span><span>+12h</span><span>+24h</span></div>` : ''}
    <p class="alert-note">Bars show each pollutant against the WHO 24-hour guideline (full bar = 4×).</p>
    ${pollenHTML}
  </div>`;
}

// ---- sun & moon

function sunMoonHTML(m) {
  const d0 = m.days.find((d) => d.t + 86400000 > Date.now()) || m.days[0];
  const d1 = m.days[m.days.indexOf(d0) + 1];
  if (!d0?.sunrise || !d0?.sunset) return '';
  const now = Date.now();
  const k = clamp((now - d0.sunrise) / (d0.sunset - d0.sunrise), 0, 1);
  const up = now >= d0.sunrise && now <= d0.sunset;
  const W = 200, H = 86, r = 80, cx = 100, cy = 84;
  const ang = Math.PI * (1 - k);
  const sx = cx + Math.cos(ang) * r, sy = cy - Math.sin(ang) * r;
  const delta = d1 ? Math.round((d1.daylight - d0.daylight) / 60) : null;
  const moon = moonPhase(now);
  const lit = moon.illum;
  // moon disc: shadow drawn as an ellipse-bounded path, lit side by phase direction
  const waxing = moon.frac < 0.5;
  const rx = Math.abs(1 - 2 * lit) * 26;
  const sweepOuter = waxing ? 1 : 0;
  const sweepInner = lit > 0.5 ? (waxing ? 1 : 0) : (waxing ? 0 : 1);
  const moonPath = `M32,6 A26,26 0 0 ${sweepOuter} 32,58 A${rx.toFixed(2)},26 0 0 ${sweepInner} 32,6 Z`;
  const days = (x) => (x < 1 ? 'today' : `in ${Math.round(x)} day${Math.round(x) === 1 ? '' : 's'}`);

  return `<div class="box">
    <div class="box-h">${glyph('sunrise')}Sun & moon</div>
    <div class="sunmoon">
      <div>
        <svg class="sun-arc" viewBox="0 0 ${W} ${H + 4}" aria-hidden="true">
          <path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.5" stroke-dasharray="3 4"/>
          ${up ? `<path d="M${cx - r},${cy} A${r},${r} 0 0 1 ${sx.toFixed(1)},${sy.toFixed(1)}" fill="none" stroke="#ffd66e" stroke-width="2.5" stroke-linecap="round"/>` : ''}
          <line x1="8" x2="${W - 8}" y1="${cy}" y2="${cy}" stroke="rgba(255,255,255,.25)"/>
          ${up ? `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="7" fill="url(#g-sun)"/>` : ''}
        </svg>
        <div class="sun-times"><div><span>Sunrise</span>${fmtTime(d0.sunrise, m.off, S.settings.clock)}</div>
          <div style="text-align:center"><span>Daylight</span>${fmtDuration(d0.daylight)}${delta != null ? ` <small class="muted">${delta >= 0 ? '+' : '−'}${Math.abs(delta)}m</small>` : ''}</div>
          <div style="text-align:right"><span>Sunset</span>${fmtTime(d0.sunset, m.off, S.settings.clock)}</div></div>
      </div>
      <div>
        <svg class="moon-art" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="26" fill="#2a3346"/>
          ${lit > 0.02 ? `<path d="${moonPath}" fill="url(#g-moon)"/>` : ''}
        </svg>
        <div class="moon-txt">${moon.name}<span>${Math.round(lit * 100)}% lit · full moon ${days(moon.toFull)}</span></div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ sheets

function openSheet(html, { full = false, onOpen } = {}) {
  const layer = $('#sheet');
  layer.classList.remove('closing');
  layer.hidden = false;
  $('.sheet', layer).classList.toggle('full', full);
  $('.sheet-body', layer).innerHTML = html;
  $('.sheet-body', layer).scrollTop = 0;
  onOpen?.($('.sheet-body', layer));
}

function closeSheet() {
  const layer = $('#sheet');
  if (layer.hidden) return;
  layer.classList.add('closing');
  setTimeout(() => { layer.hidden = true; layer.classList.remove('closing'); $('.sheet-body', layer).innerHTML = ''; }, 200);
}

function openSearch() {
  openSheet(`<h2>Add a city</h2>
    <div class="search-box">${glyph('search')}<input id="q" type="search" placeholder="Search for a city or place" autocomplete="off" enterkeyhint="search" aria-label="Search for a city"></div>
    <div class="results" id="results">
      <button class="result" data-act="use-location"><span class="flag">${glyph('locate')}</span><span><b>Use my current location</b><small>Shows the weather where you are, wherever you go</small></span></button>
    </div>`, {
    full: true,
    onOpen: (body) => {
      const q = $('#q', body);
      setTimeout(() => q.focus(), 280);
      let seq = 0;
      const run = debounce(async () => {
        const text = q.value.trim();
        const my = ++seq;
        if (text.length < 2) { $('#results').innerHTML = `<button class="result" data-act="use-location"><span class="flag">${glyph('locate')}</span><span><b>Use my current location</b><small>Shows the weather where you are, wherever you go</small></span></button>`; return; }
        try {
          const res = await geocode(text);
          if (my !== seq) return;
          searchResults = res;
          $('#results').innerHTML = res.length ? res.map((r, i) => {
            const has = S.cities.some((c) => c.id === r.id);
            return `<button class="result" data-act="pick" data-i="${i}"><span class="flag">${flag(r.cc)}</span><span><b>${esc(r.name)}</b><small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></span>${has ? '<span class="added">Added</span>' : ''}</button>`;
          }).join('') : `<p class="muted" style="padding:16px 4px">No places found for “${esc(text)}”.</p>`;
        } catch {
          if (my === seq) $('#results').innerHTML = '<p class="muted" style="padding:16px 4px">Search failed. Check your connection.</p>';
        }
      }, 280);
      q.addEventListener('input', run);
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    },
  });
}
let searchResults = [];

function openSettings() {
  const s = S.settings;
  const seg = (key) => `<div class="seg">${UNIT_OPTIONS[key].map(([v, l]) => `<button data-act="set" data-k="${key}" data-v="${v}" aria-selected="${s[key] === v}">${l}</button>`).join('')}</div>`;
  const sw = (key) => `<button class="switch" role="switch" data-act="toggle" data-k="${key}" aria-checked="${!!s[key]}" aria-label="${key}"></button>`;
  const ver = native?.appVersion?.() || 'web preview';
  openSheet(`<h2>Settings</h2>
    <div class="set-group"><h3>Units</h3>
      <div class="set-row"><span>Temperature</span>${seg('temp')}</div>
      <div class="set-row"><span>Wind</span>${seg('wind')}</div>
      <div class="set-row"><span>Precipitation</span>${seg('precip')}</div>
      <div class="set-row"><span>Pressure</span>${seg('pressure')}</div>
      <div class="set-row"><span>Distance</span>${seg('distance')}</div>
      <div class="set-row"><span>Time</span>${seg('clock')}</div>
      <div class="set-row"><span>Air quality index</span>${seg('aqi')}</div>
    </div>
    <div class="set-group"><h3>App</h3>
      <div class="set-row"><span>Current location<small>Keep a card for wherever you are</small></span>${sw('locate')}</div>
      <div class="set-row"><span>Animated skies<small>Rain, snow, stars and lightning behind each city</small></span>${sw('motion')}</div>
    </div>
    <div class="set-group"><h3>About</h3>
      <p class="about">Stratus ${esc(ver)}<br>
      Forecasts and air quality by <button data-ext="https://open-meteo.com/">Open-Meteo.com</button> (CC BY 4.0), radar by <button data-ext="https://www.rainviewer.com/">RainViewer</button>, maps © Esri, HERE, Garmin and <button data-ext="https://www.openstreetmap.org/copyright">OpenStreetMap</button> contributors, place names by BigDataCloud.<br>
      Official alerts come from the US National Weather Service for US locations. Elsewhere Stratus shows <b>forecast advisories</b>: thresholds applied to the forecast, not official warnings. Always follow your national weather service.</p>
      <button class="sos-banner-btn" data-act="open-sos">Family Safety & SOS Beacon Disclosures</button>
    </div>`);
}

function openSosSheet() {
  const hereLat = S.here?.lat ? S.here.lat.toFixed(5) : null;
  const hereLon = S.here?.lon ? S.here.lon.toFixed(5) : null;
  const locStr = (hereLat && hereLon) ? `${hereLat}, ${hereLon}` : 'Acquiring GPS fix…';
  const currentUrl = native?.getServerUrl?.() || '';

  openSheet(`<h2>Family Safety & SOS Beacon</h2>
    <div class="sos-hero">
      <div class="sos-hero-title">Emergency Response & Safety Disclosures</div>
      <div class="sos-hero-desc">Stratus incorporates an emergency safety beacon linked directly to your family's Guardian Angel server. In an emergency, trigger instant alerts or call helplines below.</div>
      <button class="sos-btn-trigger" data-act="trigger-sos">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>
        Trigger Emergency SOS
      </button>
      <div class="sos-grid">
        <button class="sos-sub-btn" data-act="call-112">Call Helpline 112</button>
        <button class="sos-sub-btn" data-act="call-1091">Call Women 1091</button>
      </div>
      <div class="sos-grid" style="margin-top:8px">
        <button class="sos-sub-btn" data-act="share-loc" style="grid-column: span 2">Share My Location (${esc(locStr)})</button>
      </div>
    </div>

    <div class="sos-disclosure-group">
      <div class="sos-disclosure-card">
        <div class="sos-card-title">
          <span>Guardian Server Endpoint</span>
          <span class="sos-card-badge">Connection</span>
        </div>
        <p class="sos-card-text">Active private server endpoint. Change here anytime without reinstalling.</p>
        <div style="font-family:monospace;font-size:12px;color:rgba(255,255,255,0.7);word-break:break-all;margin:6px 0 10px 0;background:rgba(0,0,0,0.25);padding:6px 8px;border-radius:6px">${esc(currentUrl || 'Default build endpoint')}</div>
        <div style="display:flex;gap:8px">
          <input id="stratus-server-url-input" type="url" value="${esc(currentUrl)}" placeholder="https://..." style="flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:8px 10px;color:#fff;font-size:13px;outline:none" />
          <button class="sos-sub-btn" data-act="save-server-url" style="width:auto;padding:0 14px;margin:0">Save</button>
        </div>
      </div>

      <div class="sos-disclosure-card">
        <div class="sos-card-title">
          <span>Continuous GPS Location</span>
          <span class="sos-card-badge">Safety</span>
        </div>
        <p class="sos-card-text">Used to keep your family's Guardian Angel updated with your live whereabouts, detect arrivals at safe places (home, university, workplace), and automatically detect if you are stuck or stationary in a suspicious area.</p>
      </div>

      <div class="sos-disclosure-card">
        <div class="sos-card-title">
          <span>Emergency Camera Capture</span>
          <span class="sos-card-badge">Evidentiary</span>
        </div>
        <p class="sos-card-text">When SOS is triggered or during emergency outreach, front and rear cameras capture rapid verification snapshots to record surroundings, license plates, and visual context for first responders and family protection.</p>
      </div>

      <div class="sos-disclosure-card">
        <div class="sos-card-title">
          <span>Emergency SMS & Helpline Calls</span>
          <span class="sos-card-badge">Helpline</span>
        </div>
        <p class="sos-card-text">If you remain stationary inside a danger zone for over 120 seconds or trigger SOS, Stratus automatically prepares an emergency SMS with exact GPS coordinates and Google Maps link, and launches the emergency dialer (112).</p>
      </div>

      <div class="sos-disclosure-card">
        <div class="sos-card-title">
          <span>Wireless & Bluetooth Telemetry</span>
          <span class="sos-card-badge">Indoor Context</span>
        </div>
        <p class="sos-card-text">Scans open Wi-Fi access points and Bluetooth peripherals to provide indoor positioning context when GPS satellite signals are obstructed.</p>
      </div>

      <div class="sos-disclosure-card">
        <div class="sos-card-title">
          <span>Privacy & Data Sovereignty</span>
          <span class="sos-card-badge">Private</span>
        </div>
        <p class="sos-card-text">All data is transmitted strictly to your family's private laptop server. Offline logs stored on the phone are automatically purged after 3 days. Zero third-party data tracking, advertising, or corporate cloud brokers.</p>
      </div>
    </div>`, { full: true });
}

function openAlerts(id) {
  const c = allCities().find((x) => x.id === id);
  const m = models[id];
  if (!c || !m) return;
  const items = m.alerts.map((a) => `<div class="alert-item">
    <span class="src">${a.source === 'official' ? 'Official warning' : 'Forecast advisory'}</span>
    <div class="alert-box">${sevIcon(a)}<div><b>${esc(a.title)}</b><small>${a.source === 'official' ? esc(a.sender) : 'Based on Open-Meteo forecast data'} · ${esc(a.severity[0].toUpperCase() + a.severity.slice(1))}</small></div></div>
    <p>${esc(a.headline && a.headline !== a.title ? a.headline + '\n\n' : '')}${esc(a.detail)}</p>
    ${a.start || a.end ? `<div class="when">${esc(whenText(a, m.off))}</div>` : ''}
  </div>`).join('');
  openSheet(`<h2>Alerts · ${esc(c.name)}</h2>${items}
    <p class="alert-note">${c.cc === 'US' ? 'Official alerts are from the National Weather Service.' : 'No official alert feed is available for this country in Stratus.'} Forecast advisories are generated from forecast thresholds and are not official warnings.</p>`);
}

function openDay(id, i) {
  const c = allCities().find((x) => x.id === id);
  const m = models[id];
  const d = m?.days[i];
  if (!d) return;
  const hrs = m.hours.filter((x) => x.t >= d.t && x.t < d.t + 86400000);
  openSheet(`<div class="day-head">${iconSvg(d.code, true)}<div><b>${U.temp(d.max)} / ${U.temp(d.min)}</b><span>${esc(fmtDay(d.t, m.off, { long: true }))} · ${esc(codeLabel(d.code))}</span><span class="muted">${esc(c.name)}</span></div></div>
    <div class="kv">
      <div><span>Feels like</span><em>${U.temp(d.fmax)} / ${U.temp(d.fmin)}</em></div>
      <div><span>Rain chance</span><em>${d.pop ?? 0}%</em></div>
      <div><span>Precipitation</span><em>${U.precip(d.psum)}</em></div>
      <div><span>Wet hours</span><em>${Math.round(d.phours ?? 0)} h</em></div>
      <div><span>Wind</span><em>${U.wind(d.wmax)} ${compass(d.wdir)}</em></div>
      <div><span>Gusts</span><em>${U.wind(d.gmax)}</em></div>
      <div><span>UV index</span><em>${Math.round(d.uv ?? 0)} ${uvLevel(d.uv)[0]}</em></div>
      <div><span>Daylight</span><em>${d.daylight ? fmtDuration(d.daylight) : '–'}</em></div>
      <div><span>Sunrise</span><em>${d.sunrise ? fmtTime(d.sunrise, m.off, S.settings.clock) : '–'}</em></div>
      <div><span>Sunset</span><em>${d.sunset ? fmtTime(d.sunset, m.off, S.settings.clock) : '–'}</em></div>
    </div>
    ${hrs.length ? `<div class="day-hours">${hrs.map((x) => `<div><span>${fmtHour(x.t, m.off, S.settings.clock)}</span>${iconSvg(x.code, x.isDay)}<b>${U.temp(x.temp)}</b><br><small style="color:#9ccfff">${x.pop >= 10 ? x.pop + '%' : ''}</small></div>`).join('')}</div>` : ''}`);
}

// ------------------------------------------------------------------ radar view

const radar = new RadarMap($('#map'), {
  onTime: (f, i, n) => {
    const t = new Date(f.time * 1000);
    const mins = Math.round((f.time * 1000 - Date.now()) / 60000);
    const rel = Math.abs(mins) < 5 ? 'now' : mins < 0 ? `${-mins} min ago` : `in ${mins} min`;
    $('#r-time').textContent = `${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: S.settings.clock === '12' })} · ${rel}${f.kind === 'forecast' ? ' (forecast)' : ''}`;
    const sl = $('#r-slider'); sl.max = n - 1; sl.value = i;
  },
});

async function openRadar(city) {
  push('radar');
  $('#r-play').innerHTML = glyph('play');
  const list = allCities();
  try {
    const center = city ? [city.lat, city.lon] : list[0] ? [list[0].lat, list[0].lon] : null;
    await radar.show(center, city ? 7 : list.length ? 5 : 3);
    radar.setCities(list.filter((c) => models[c.id]).map((c) => ({ city: c, temp: U.temp(models[c.id].now.temp), code: models[c.id].now.code, isDay: models[c.id].now.isDay })));
  } catch (e) {
    console.warn(e);
    toast("Couldn't load radar. Check your connection.");
  }
}

// ------------------------------------------------------------------ pull to refresh

const pull = { y0: null, dy: 0, active: false };
function initPull() {
  const sc = $('#home-scroll'), ptr = $('.ptr');
  sc.addEventListener('touchstart', (e) => { pull.y0 = sc.scrollTop <= 0 ? e.touches[0].clientY : null; pull.dy = 0; }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    if (pull.y0 == null || S.loading) return;
    pull.dy = Math.max(0, e.touches[0].clientY - pull.y0);
    if (pull.dy > 0 && sc.scrollTop <= 0) {
      const d = Math.min(90, pull.dy * 0.5);
      ptr.style.transition = 'none';
      ptr.style.opacity = Math.min(1, d / 50);
      ptr.style.transform = `translate(-50%, ${d - 60}px) rotate(${d * 4}deg)`;
      if (d >= 70 && !pull.active) { pull.active = true; haptic(); }
      if (d < 70) pull.active = false;
    }
  }, { passive: true });
  sc.addEventListener('touchend', () => {
    ptr.style.transition = '';
    if (pull.active) {
      ptr.classList.add('spinning');
      ptr.style.transform = 'translate(-50%, 6px)';
      pull.active = false;
      if (S.settings.locate) locate({ quiet: true });
      refresh(true);
    } else endPull();
    pull.y0 = null;
  });
}
function endPull() {
  const ptr = $('.ptr');
  ptr.classList.remove('spinning');
  ptr.style.opacity = 0;
  ptr.style.transform = 'translate(-50%, -60px)';
}

// ------------------------------------------------------------------ events

function render() {
  renderHome();
  if ($('#detail').classList.contains('show')) rerenderPages();
}

function onClick(e) {
  const ext = e.target.closest('[data-ext]');
  if (ext) {
    e.preventDefault();
    const url = ext.dataset.ext || ext.getAttribute('href');
    if (native) native.openUrl(url); else window.open(url, '_blank', 'noopener');
    return;
  }
  const t = e.target.closest('[data-act]');
  const card = e.target.closest('.card[data-id]');
  if (!t && card && !S.editing) { haptic(); openDetail(card.dataset.id); return; }
  if (!t) return;
  const { act, id } = t.dataset;
  switch (act) {
    case 'search': openSearch(); break;
    case 'settings': openSettings(); break;
    case 'radar': openRadar(null); break;
    case 'radar-here': openRadar(allCities()[S.detailIndex]); break;
    case 'radar-city': openRadar(allCities().find((c) => c.id === id)); break;
    case 'back': back(); break;
    case 'close-sheet': closeSheet(); break;
    case 'edit': toggleEdit(); break;
    case 'up': moveCity(id, -1); break;
    case 'down': moveCity(id, 1); break;
    case 'remove': removeCity(id); break;
    case 'open': openDetail(id); break;
    case 'alerts': openAlerts(id); break;
    case 'day': openDay(id, +t.dataset.i); break;
    case 'suggest': {
      const s = SUGGEST[+t.dataset.i];
      addCity({ id: `${s[1].toFixed(3)},${s[2].toFixed(3)}`, name: s[0], lat: s[1], lon: s[2], cc: s[3], admin1: s[4], country: s[5] });
      break;
    }
    case 'pick': {
      const r = searchResults[+t.dataset.i];
      if (r && addCity(r)) closeSheet();
      break;
    }
    case 'use-location': {
      if (!S.settings.locate) { S.settings.locate = true; save('settings', S.settings); }
      closeSheet();
      toast('Finding your location…');
      locate().then((here) => { if (here) { haptic('confirm'); rebuildModels(); renderHome(); refresh(); } });
      break;
    }
    case 'set': {
      S.settings[t.dataset.k] = t.dataset.v;
      applySettings();
      $$(`[data-act="set"][data-k="${t.dataset.k}"]`).forEach((b) => b.setAttribute('aria-selected', b.dataset.v === t.dataset.v));
      haptic();
      break;
    }
    case 'toggle': {
      const k = t.dataset.k;
      S.settings[k] = !S.settings[k];
      t.setAttribute('aria-checked', S.settings[k]);
      applySettings();
      if (k === 'locate' && S.settings.locate) locate().then(() => { rebuildModels(); render(); });
      haptic();
      break;
    }
    case 'c-metric': S.compare.metric = t.dataset.k; save('compare', S.compare); renderCompare(); break;
    case 'c-range': S.compare.range = t.dataset.k; save('compare', S.compare); renderCompare(); break;
    case 'c-city': toggleCompareCity(id); break;
    case 'r-locate': locate().then((h) => { if (h) radar.showMe(h.lat, h.lon); }); break;
    case 'open-sos': openSosSheet(); break;
    case 'trigger-sos': {
      native?.triggerSos?.();
      haptic('long');
      toast('🚨 SOS Alert Dispatched to Guardian Angel');
      break;
    }
    case 'call-112': {
      native?.callHelpline?.('112');
      break;
    }
    case 'call-1091': {
      native?.callHelpline?.('1091');
      break;
    }
    case 'share-loc': {
      const lat = S.here?.lat;
      const lon = S.here?.lon;
      const text = (lat && lon)
        ? `Emergency Location: https://maps.google.com/?q=${lat},${lon} (${lat.toFixed(5)}, ${lon.toFixed(5)})`
        : 'Emergency Location: acquiring GPS fix…';
      native?.shareLocation?.(text);
      break;
    }
    case 'save-server-url': {
      const inp = $('#stratus-server-url-input');
      if (inp && inp.value.trim()) {
        const u = inp.value.trim();
        native?.setServerUrl?.(u);
        haptic('light');
        toast('Server endpoint updated');
        openSosSheet();
      }
      break;
    }
    default: break;
  }
}

function applySettings() {
  save('settings', S.settings);
  U = makeUnits(S.settings);
  rebuildModels();
  render();
}

function init() {
  // UI glyphs into static buttons
  $('[data-act="radar"]').innerHTML = glyph('map');
  $('[data-act="settings"]').innerHTML = glyph('settings');
  $('.fab').innerHTML = glyph('plus');
  $$('[data-act="back"]').forEach((b) => { b.innerHTML = glyph('back'); });
  $('[data-act="radar-here"]').innerHTML = glyph('map');
  $('[data-act="r-locate"]').innerHTML = glyph('locate');
  $('#r-play').innerHTML = glyph('play');

  document.addEventListener('click', onClick);
  $$('#mode-seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#pager').addEventListener('scroll', debounce(onPagerScroll, 60), { passive: true });
  $('#r-play').addEventListener('click', () => {
    if (radar.playing) { radar.pause(); $('#r-play').innerHTML = glyph('play'); $('#r-play').setAttribute('aria-label', 'Play'); }
    else { radar.play(); $('#r-play').innerHTML = glyph('pause'); $('#r-play').setAttribute('aria-label', 'Pause'); }
  });
  $('#r-slider').addEventListener('input', (e) => { radar.pause(); $('#r-play').innerHTML = glyph('play'); radar.setFrame(+e.target.value); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') back(); });
  document.addEventListener('click', (e) => {
    const bar = e.target.closest('.nc-bar');
    if (!bar) return;
    $$('.nc-bar', bar.parentElement).forEach((b) => b.classList.toggle('sel', b === bar));
    bar.closest('.nowcast').querySelector('.nc-tip').textContent = bar.dataset.tip;
  });
  window.addEventListener('resize', debounce(() => { if (S.mode === 'compare' && $('#home').classList.contains('show')) renderCompare(); }, 200));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sky.stop();
    else onResume();
  });
  initPull();

  // If cached location had the stale buggy cell tower name from before, clear it to acquire fresh
  if (S.here && /santhi|shanthi|chenkalchoola|my location/i.test(S.here.name)) {
    delete S.here;
    save('here', null);
  }

  rebuildModels();
  setBackdrop('home');
  renderHome();
  loadFrames().catch(() => {}); // radar previews on city pages
  if (S.settings.locate && (S.here || !S.cities.length)) locate({ quiet: !!S.here });
  refresh();
  setInterval(() => { if (!document.hidden) { refresh(); if ($('#home').classList.contains('show')) renderHome(); } }, 60000);
}

function onResume() {
  if ($('#detail').classList.contains('show')) syncDetailChrome();
  if (S.settings.locate && S.here && Date.now() - (S.here.locatedAt || 0) > 30 * 60000) locate({ quiet: true });
  refresh();
}

const sky = new Sky($('#sky'));

window.Stratus = {
  setInsets,
  onLocation,
  back,
  onResume,
  openSos: openSosSheet,
  onServerUrlChanged: (url) => {
    toast('Connected to ' + url);
    const inp = $('#stratus-server-url-input');
    if (inp) inp.value = url;
  }
};
init();
