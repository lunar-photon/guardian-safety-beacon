// Charts: the hourly strip (icons + temperature curve + rain chance), the 2-hour
// precipitation bars, and the multi-city compare chart with a crosshair tooltip.
import { iconSvg, sunEventSvg } from './icons.js';
import { esc, fmtHour, fmtTime, smoothPath, clamp, tempColor } from './util.js';

const COL = 58;

/** Hourly strip: 48 hours plus sunrise/sunset columns; a temperature curve runs through them all. */
export function hourlyStrip(m, U) {
  const hours = m.hours.slice(0, 48);
  if (!hours.length) return '';
  const t0 = hours[0].t, t1 = hours[hours.length - 1].t;
  const items = hours.map((x) => ({ kind: 'hour', t: x.t, x }));
  for (const d of m.days.slice(0, 4)) {
    for (const [kind, t] of [['sunrise', d.sunrise], ['sunset', d.sunset]]) {
      if (t && t > t0 && t < t1) items.push({ kind, t });
    }
  }
  items.sort((a, b) => a.t - b.t);
  // a sun column's temperature is interpolated between its neighbouring hours
  const tempAt = (t) => {
    const i = hours.findIndex((x) => x.t > t);
    if (i <= 0) return hours[0].temp;
    const a = hours[i - 1], b = hours[i];
    return a.temp + (b.temp - a.temp) * ((t - a.t) / (b.t - a.t));
  };
  items.forEach((it) => { it.temp = it.kind === 'hour' ? it.x.temp : tempAt(it.t); });

  const temps = items.map((it) => U.toDisplayTemp(it.temp));
  const lo = Math.min(...temps), hi = Math.max(...temps);
  const CH = 64, PAD_T = 22, PAD_B = 8;
  const y = (v) => PAD_T + (hi === lo ? 0.5 : 1 - (v - lo) / (hi - lo)) * (CH - PAD_T - PAD_B);
  const pts = temps.map((v, i) => [i * COL + COL / 2, y(v)]);
  const W = items.length * COL;
  const line = smoothPath(pts);
  const area = `${line} L${pts[pts.length - 1][0]},${CH} L${pts[0][0]},${CH} Z`;
  const grad = items.map((it, i) => `<stop offset="${(i / Math.max(1, items.length - 1)).toFixed(3)}" stop-color="${tempColor(it.temp)}"/>`).join('');

  let first = true;
  const cols = items.map((it, i) => {
    const top = (pts[i][1] - 20).toFixed(0);
    if (it.kind !== 'hour') {
      return `<div class="hcol sun">
        <div class="h-time">${fmtTime(it.t, m.off, U.s.clock)}</div>
        ${sunEventSvg(it.kind)}
        <div class="h-curve"><span class="h-temp" style="top:${top}px">${it.kind === 'sunrise' ? 'Sunrise' : 'Sunset'}</span></div>
        <div class="h-pop"></div>
      </div>`;
    }
    const x = it.x;
    const label = first ? 'Now' : fmtHour(x.t, m.off, U.s.clock);
    const dayStart = !first && new Date(x.t + m.off * 1000).getUTCHours() === 0;
    first = false;
    const pop = x.pop ?? 0;
    return `<div class="hcol${dayStart ? ' day-start' : ''}">
      <div class="h-time">${label}</div>
      ${iconSvg(x.code, x.isDay, 'h-icon')}
      <div class="h-curve"><span class="h-temp" style="top:${top}px">${U.temp(x.temp)}</span></div>
      <div class="h-pop${pop >= 20 ? ' on' : ''}">
        <div class="h-popbar"><i style="height:${Math.max(2, pop * 0.24)}px"></i></div>
        <span>${pop >= 5 ? pop + '%' : ''}</span>
      </div>
    </div>`;
  }).join('');

  return `<div class="hourly" role="list" aria-label="Hourly forecast">
    <div class="hourly-in" style="width:${W}px">
      <svg class="h-svg" width="${W}" height="${CH}" viewBox="0 0 ${W} ${CH}" aria-hidden="true">
        <defs><linearGradient id="hgrad" x1="0" x2="${W}" y1="0" y2="0" gradientUnits="userSpaceOnUse">${grad}</linearGradient>
        <linearGradient id="harea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
        <path d="${area}" fill="url(#harea)"/>
        <path d="${line}" fill="none" stroke="url(#hgrad)" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="4" fill="#fff" stroke="rgba(0,0,0,.25)" stroke-width="2"/>
      </svg>
      ${cols}
    </div>
  </div>`;
}

/** Next ~2 hours of precipitation in 15-minute steps, or null when it stays dry. */
export function nowcast(m, U) {
  const now = Date.now();
  const pts = m.minutely.filter((p) => p.t + 15 * 60000 > now).slice(0, 8);
  if (pts.length < 4) return null;
  const wet = pts.map((p) => p.p >= 0.05);
  let summary;
  const mins = (i) => Math.max(15, Math.round((pts[i].t - now) / 60000 / 5) * 5);
  if (!wet.some(Boolean)) summary = 'No precipitation expected for the next 2 hours';
  else if (wet[0]) {
    const stop = wet.indexOf(false);
    summary = stop === -1 ? 'Precipitation continuing for at least 2 hours' : `Precipitation stopping in about ${mins(stop)} min`;
  } else summary = `Precipitation starting in about ${mins(wet.indexOf(true))} min`;

  const kind = (mm) => (mm < 0.05 ? 'None' : mm < 0.6 ? 'Light' : mm < 2 ? 'Moderate' : 'Heavy');
  const H = 56;
  const bars = pts.map((p, i) => {
    const hgt = p.p < 0.05 ? 2 : clamp(8 + Math.sqrt(p.p / 3) * (H - 8), 8, H);
    const tip = `${i === 0 ? 'Now' : '+' + Math.round((p.t - pts[0].t) / 60000) + ' min'}: ${kind(p.p)} · ${U.precip(p.p)} in 15 min`;
    return `<button class="nc-bar" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><i style="height:${hgt.toFixed(0)}px"></i></button>`;
  }).join('');
  return {
    wet: wet.some(Boolean),
    summary,
    html: `<div class="nowcast">
      <div class="nc-bars" style="height:${H}px">${bars}</div>
      <div class="nc-axis"><span>Now</span><span></span><span>30m</span><span></span><span>60m</span><span></span><span>90m</span><span></span></div>
      <div class="nc-tip" aria-live="polite"></div>
    </div>`,
  };
}

// ------------------------------------------------------------------ compare chart

const niceStep = (span, count) => {
  const raw = span / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
};

/**
 * series: [{id, name, color, values:[number|null]}], all on the same x index.
 * xLabels: label per index (sparse labels drawn at tickEvery). fmt: value -> string.
 */
export function compareChart(el, { series, xLabels, tickEvery, fmt, yUnit, tipTitle }) {
  const W = Math.max(280, el.clientWidth || 340), H = 230;
  const M = { l: 34, r: 14, t: 24, b: 26 };
  const n = xLabels.length;
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  if (!all.length || n < 2) { el.innerHTML = '<p class="muted pad">No data to compare yet.</p>'; return; }
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 4) { lo -= 2; hi += 2; }
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = (i) => M.l + (i / (n - 1)) * (W - M.l - M.r);
  const Y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);

  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid += `<line class="c-grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"/>`
      + `<text class="c-tick" x="${M.l - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v * 10) / 10}</text>`;
  }
  let xt = '';
  for (let i = 0; i < n; i += tickEvery) {
    xt += `<text class="c-tick" x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${esc(xLabels[i])}</text>`;
  }

  const lines = series.map((s) => {
    const pts = []; s.values.forEach((v, i) => { if (v != null) pts.push([X(i), Y(v)]); });
    return `<path d="${smoothPath(pts)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');

  // direct end labels only when there are few series and they don't collide
  let ends = '';
  if (series.length <= 4) {
    const e = series.map((s) => {
      let i = s.values.length - 1; while (i > 0 && s.values[i] == null) i--;
      return { s, y: Y(s.values[i]), x: X(i), v: s.values[i] };
    }).sort((a, b) => a.y - b.y);
    const clear = e.every((p, i) => i === 0 || p.y - e[i - 1].y >= 14);
    if (clear) {
      ends = e.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${p.s.color}" class="c-ring"/>`).join('');
    }
  }

  el.innerHTML = `<div class="c-wrap">
    <svg class="c-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(tipTitle)} comparison chart">
      <text class="c-tick" x="${M.l - 6}" y="10" text-anchor="end">${esc(yUnit)}</text>
      ${grid}${xt}${lines}${ends}
      <g class="c-cross" style="display:none"><line y1="${M.t}" y2="${H - M.b}"/>${series.map((s) => `<circle r="4.5" fill="${s.color}" class="c-ring"/>`).join('')}</g>
      <rect class="c-hit" x="${M.l}" y="0" width="${W - M.l - M.r}" height="${H}" fill="transparent"/>
    </svg>
    <div class="c-tip" role="status"></div>
  </div>`;

  const svg = el.querySelector('svg'), cross = el.querySelector('.c-cross'), tip = el.querySelector('.c-tip');
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const x = clientX - r.left;
    const i = clamp(Math.round(((x - M.l) / (W - M.l - M.r)) * (n - 1)), 0, n - 1);
    cross.style.display = '';
    cross.querySelector('line').setAttribute('x1', X(i));
    cross.querySelector('line').setAttribute('x2', X(i));
    const dots = cross.querySelectorAll('circle');
    series.forEach((s, k) => {
      const v = s.values[i];
      dots[k].style.display = v == null ? 'none' : '';
      if (v != null) { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); }
    });
    const rows = series.map((s) => ({ s, v: s.values[i] })).filter((o) => o.v != null).sort((a, b) => b.v - a.v);
    tip.innerHTML = `<b>${esc(xLabels[i])}</b>${rows.map((o) =>
      `<div><i style="background:${o.s.color}"></i><span>${esc(o.s.name)}</span><em>${esc(fmt(o.v))}</em></div>`).join('')}`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    let left = X(i) + 12; if (left + tw > W) left = X(i) - tw - 12;
    tip.style.left = `${Math.max(0, left)}px`;
  };
  const hide = () => { cross.style.display = 'none'; tip.style.display = 'none'; };
  const hit = el.querySelector('.c-hit');
  hit.addEventListener('pointerdown', (e) => { show(e.clientX); hit.setPointerCapture(e.pointerId); });
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerup', () => setTimeout(hide, 1800));
  hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
}
