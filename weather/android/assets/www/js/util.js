// Shared helpers: weather codes, units, city-local time, colours, DOM.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ WMO weather codes

const CODES = {
  0: ['Clear', 'clear'],
  1: ['Mostly clear', 'mostly-clear'],
  2: ['Partly cloudy', 'partly'],
  3: ['Overcast', 'cloudy'],
  45: ['Fog', 'fog'],
  48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'],
  53: ['Drizzle', 'drizzle'],
  55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'sleet'],
  57: ['Freezing drizzle', 'sleet'],
  61: ['Light rain', 'rain'],
  63: ['Rain', 'rain'],
  65: ['Heavy rain', 'heavy-rain'],
  66: ['Freezing rain', 'sleet'],
  67: ['Heavy freezing rain', 'sleet'],
  71: ['Light snow', 'snow'],
  73: ['Snow', 'snow'],
  75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'],
  80: ['Light showers', 'showers'],
  81: ['Showers', 'showers'],
  82: ['Violent showers', 'heavy-rain'],
  85: ['Snow showers', 'snow'],
  86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'thunder'],
  96: ['Thunderstorm, hail', 'thunder'],
  99: ['Severe thunderstorm, hail', 'thunder'],
};

export const codeLabel = (c) => (CODES[c] || ['Unknown'])[0];
export const codeKind = (c) => (CODES[c] || [null, 'cloudy'])[1];

/** The sky theme behind a city: drives card gradients and the animated backdrop. */
export function skyTheme(code, isDay) {
  const k = codeKind(code);
  let t;
  if (k === 'clear' || k === 'mostly-clear') t = 'clear';
  else if (k === 'partly') t = 'partly';
  else if (k === 'cloudy') t = 'cloudy';
  else if (k === 'fog') t = 'fog';
  else if (k === 'snow' || k === 'sleet') t = 'snow';
  else if (k === 'thunder') t = 'storm';
  else t = 'rain';
  return t + (isDay ? '-day' : '-night');
}

// ------------------------------------------------------------------ units

export const UNIT_OPTIONS = {
  temp: [['c', '°C'], ['f', '°F']],
  wind: [['kmh', 'km/h'], ['mph', 'mph'], ['ms', 'm/s'], ['kn', 'kn']],
  precip: [['mm', 'mm'], ['in', 'in']],
  pressure: [['hpa', 'hPa'], ['inhg', 'inHg'], ['mmhg', 'mmHg']],
  distance: [['km', 'km'], ['mi', 'mi']],
  clock: [['24', '24-hour'], ['12', '12-hour']],
  aqi: [['us', 'US AQI'], ['eu', 'European AQI']],
};

export function defaultSettings() {
  const lang = (navigator.language || 'en').toLowerCase();
  const us = lang === 'en-us' || lang.endsWith('-us') || lang.endsWith('-lr') || lang.endsWith('-mm');
  const uk = lang.endsWith('-gb');
  return {
    temp: us ? 'f' : 'c',
    wind: us || uk ? 'mph' : 'kmh',
    precip: us ? 'in' : 'mm',
    pressure: us ? 'inhg' : 'hpa',
    distance: us || uk ? 'mi' : 'km',
    clock: us || lang.startsWith('en-in') || lang.startsWith('en-au') ? '12' : '24',
    aqi: 'us',
    motion: true,
    locate: true,
  };
}

export function makeUnits(s) {
  const tC = (c) => (s.temp === 'f' ? c * 9 / 5 + 32 : c);
  return {
    s,
    tempN: (c) => (c == null ? null : Math.round(tC(c))),
    temp: (c) => (c == null ? '–' : `${Math.round(tC(c))}°`),
    tempU: (c) => (c == null ? '–' : `${Math.round(tC(c))}°${s.temp === 'f' ? 'F' : 'C'}`),
    tempUnit: s.temp === 'f' ? '°F' : '°C',
    toDisplayTemp: tC,
    windN(kmh) {
      if (kmh == null) return null;
      const v = { kmh, mph: kmh / 1.609344, ms: kmh / 3.6, kn: kmh / 1.852 }[s.wind];
      return s.wind === 'ms' ? Math.round(v * 10) / 10 : Math.round(v);
    },
    wind(kmh) { return kmh == null ? '–' : `${this.windN(kmh)} ${this.windUnit}`; },
    windUnit: { kmh: 'km/h', mph: 'mph', ms: 'm/s', kn: 'kn' }[s.wind],
    precip(mm) {
      if (mm == null) return '–';
      if (s.precip === 'in') { const v = mm / 25.4; return `${v < 0.1 && v > 0 ? v.toFixed(2) : v.toFixed(1)} in`; }
      return `${mm < 10 ? Math.round(mm * 10) / 10 : Math.round(mm)} mm`;
    },
    pressure(hpa) {
      if (hpa == null) return '–';
      if (s.pressure === 'inhg') return `${(hpa * 0.0295299830714).toFixed(2)} inHg`;
      if (s.pressure === 'mmhg') return `${Math.round(hpa * 0.750061683)} mmHg`;
      return `${Math.round(hpa)} hPa`;
    },
    distance(m) {
      if (m == null) return '–';
      if (s.distance === 'mi') { const v = m / 1609.344; return `${v >= 10 ? Math.round(v) : v.toFixed(1)} mi`; }
      const v = m / 1000; return `${v >= 10 ? Math.round(v) : v.toFixed(1)} km`;
    },
  };
}

// ------------------------------------------------------------------ city-local time
// Open-Meteo gives wall-clock strings in the city's zone plus its UTC offset. We keep
// everything as epoch ms and format with the offset, so no timezone database is needed.

export function parseLocal(str, offsetSec) {
  const [d, t = '00:00'] = str.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, day, hh, mm) - offsetSec * 1000;
}

const wall = (epoch, off) => new Date(epoch + off * 1000);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(epoch, off, clock) {
  const d = wall(epoch, off);
  const H = d.getUTCHours(), M = String(d.getUTCMinutes()).padStart(2, '0');
  if (clock === '12') return `${H % 12 || 12}:${M} ${H < 12 ? 'AM' : 'PM'}`;
  return `${String(H).padStart(2, '0')}:${M}`;
}

export function fmtHour(epoch, off, clock) {
  const H = wall(epoch, off).getUTCHours();
  if (clock === '12') return `${H % 12 || 12} ${H < 12 ? 'AM' : 'PM'}`;
  return `${String(H).padStart(2, '0')}`;
}

export const localHour = (epoch, off) => wall(epoch, off).getUTCHours();
export const localDayKey = (epoch, off) => wall(epoch, off).toISOString().slice(0, 10);

export function fmtDay(epoch, off, { long = false, relative = true, nowEpoch = Date.now() } = {}) {
  if (relative) {
    const k = localDayKey(epoch, off);
    if (k === localDayKey(nowEpoch, off)) return 'Today';
    if (k === localDayKey(nowEpoch + 86400000, off)) return 'Tomorrow';
  }
  const d = wall(epoch, off);
  return (long ? DAYS_LONG : DAYS)[d.getUTCDay()];
}

export function fmtDate(epoch, off) {
  const d = wall(epoch, off);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ------------------------------------------------------------------ descriptive scales

export function compass(deg) {
  if (deg == null) return '–';
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
}

export function beaufort(kmh) {
  const lim = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  const names = ['Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze',
    'Strong breeze', 'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane force'];
  let i = 0; while (i < lim.length && kmh >= lim[i]) i++;
  return names[i];
}

export function uvLevel(uv) {
  if (uv == null) return ['–', 0];
  if (uv < 3) return ['Low', 0];
  if (uv < 6) return ['Moderate', 1];
  if (uv < 8) return ['High', 2];
  if (uv < 11) return ['Very high', 3];
  return ['Extreme', 4];
}

export function aqiLevel(v, scale) {
  if (v == null) return { label: 'No data', tone: 0, color: 'var(--muted)' };
  const us = [[50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive groups'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']];
  const eu = [[20, 'Good'], [40, 'Fair'], [60, 'Moderate'], [80, 'Poor'], [100, 'Very poor'], [Infinity, 'Extremely poor']];
  const colors = ['#3ecf6e', '#e6cf3a', '#f59a3a', '#ef5a4a', '#b04ad6', '#8a2b44'];
  const t = scale === 'eu' ? eu : us;
  const i = t.findIndex(([lim]) => v <= lim);
  return { label: t[i][1], tone: i, color: colors[i] };
}

export function humidityComfort(dew) {
  if (dew == null) return '';
  if (dew < 10) return 'Dry';
  if (dew < 16) return 'Comfortable';
  if (dew < 21) return 'Humid';
  if (dew < 24) return 'Muggy';
  return 'Oppressive';
}

// Temperature colour: a diverging scale, cool blue <- neutral (~18°C) -> warm red.
const TEMP_STOPS = [
  [-20, [96, 120, 255]], [-5, [74, 144, 255]], [5, [104, 186, 255]], [12, [150, 214, 240]],
  [18, [226, 230, 214]], [24, [255, 205, 112]], [30, [255, 152, 72]], [36, [244, 96, 60]], [44, [214, 52, 72]],
];
export function tempColor(c) {
  if (c <= TEMP_STOPS[0][0]) return `rgb(${TEMP_STOPS[0][1]})`;
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (c <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      const k = (c - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(lerp(v, c1[j], k))).join(',')})`;
    }
  }
  return `rgb(${TEMP_STOPS[TEMP_STOPS.length - 1][1]})`;
}

// ------------------------------------------------------------------ moon

export function moonPhase(epoch = Date.now()) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  let age = ((epoch - ref) / 86400000) % synodic;
  if (age < 0) age += synodic;
  const frac = age / synodic;
  const illum = (1 - Math.cos(2 * Math.PI * frac)) / 2;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon',
    'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const name = names[Math.round(frac * 8) % 8];
  const toFull = ((0.5 - frac + 1) % 1) * synodic;
  const toNew = ((1 - frac) % 1) * synodic;
  return { frac, illum, name, age, toFull, toNew };
}

// ------------------------------------------------------------------ misc

export function flag(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const haptic = (kind = 'tick') => { try { window.NativeBridge?.haptic(kind); } catch { /* not in the app */ } };

/** Smooth path through points (Catmull-Rom -> cubic Bézier), for curves in SVG. */
export function smoothPath(pts) {
  if (!pts.length) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
