// Data: Open-Meteo forecast + air quality (batched for every city in one request each),
// US National Weather Service alerts for US cities, and our own forecast-based advisories.
import { parseLocal, codeKind } from './util.js';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const NWS = 'https://api.weather.gov/alerts/active';

const CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,dew_point_2m,uv_index';
const HOURLY = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,uv_index,visibility,is_day,dew_point_2m,cloud_cover,pressure_msl';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,precipitation_probability_max,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant';
const AIR_CURRENT = 'us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen';
const AIR_HOURLY = 'us_aqi,european_aqi';

export const STALE_MS = 15 * 60 * 1000;

async function getJSON(url, { timeout = 20000, headers } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const coords = (cities) => ({
  latitude: cities.map((c) => c.lat.toFixed(4)).join(','),
  longitude: cities.map((c) => c.lon.toFixed(4)).join(','),
});
const asList = (d) => (Array.isArray(d) ? d : [d]);

export async function fetchForecast(cities) {
  const q = new URLSearchParams({
    ...coords(cities), timezone: 'auto', forecast_days: 16, forecast_hours: 72,
    forecast_minutely_15: 9, current: CURRENT, hourly: HOURLY, daily: DAILY, minutely_15: 'precipitation',
  });
  return asList(await getJSON(`${FORECAST}?${q}`));
}

export async function fetchAir(cities) {
  const q = new URLSearchParams({
    ...coords(cities), timezone: 'auto', forecast_hours: 48, current: AIR_CURRENT, hourly: AIR_HOURLY,
  });
  return asList(await getJSON(`${AIR}?${q}`));
}

export async function fetchNwsAlerts(city) {
  const d = await getJSON(`${NWS}?point=${city.lat.toFixed(4)},${city.lon.toFixed(4)}`,
    { timeout: 12000, headers: { Accept: 'application/geo+json' } });
  const sev = { Extreme: 'extreme', Severe: 'severe', Moderate: 'moderate', Minor: 'minor' };
  return (d.features || []).map((f) => {
    const p = f.properties;
    return {
      id: p.id,
      source: 'official',
      sender: p.senderName || 'National Weather Service',
      title: p.event,
      headline: p.headline,
      severity: sev[p.severity] || 'moderate',
      start: Date.parse(p.onset || p.effective) || null,
      end: Date.parse(p.ends || p.expires) || null,
      detail: [p.description, p.instruction].filter(Boolean).join('\n\n'),
      area: p.areaDesc,
    };
  });
}

export async function geocode(name) {
  let raw = [];
  try {
    const q = new URLSearchParams({ name, count: 12, language: 'en', format: 'json' });
    const d = await getJSON(`${GEO}?${q}`, { timeout: 6000 });
    const list = d.results || [];
    if (list.length > 0) {
      raw = list.map((r) => ({
        id: `${r.latitude.toFixed(3)},${r.longitude.toFixed(3)}`,
        name: r.name,
        admin1: r.admin1 || '',
        country: r.country || '',
        cc: r.country_code || '',
        lat: r.latitude,
        lon: r.longitude,
        pop: r.population || 0,
      }));
    }
  } catch (_) {}

  // Fallback to Nominatim search for smaller towns and villages
  if (!raw.length) {
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=8`;
      const d = await getJSON(nomUrl, { timeout: 6000, headers: { 'User-Agent': 'StratusApp/1.0' } });
      raw = (d || []).map((r) => {
        const parts = (r.display_name || '').split(',').map((s) => s.trim());
        return {
          id: `${Number(r.lat).toFixed(3)},${Number(r.lon).toFixed(3)}`,
          name: r.name || parts[0] || name,
          admin1: parts[parts.length - 3] || '',
          country: parts[parts.length - 1] || '',
          cc: (r.address?.country_code || '').toUpperCase(),
          lat: Number(r.lat),
          lon: Number(r.lon),
          pop: 0,
        };
      });
    } catch (_) {}
  }

  // Deduplicate results so administrative duplicates don't show twice
  const seen = new Set();
  const deduped = [];
  for (const item of raw) {
    const key = `${(item.name || '').toLowerCase()}|${(item.admin1 || '').toLowerCase()}|${(item.country || '').toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

export async function reverseGeocode(lat, lon) {
  // 1. Nominatim OpenStreetMap (exact village, town, municipality, city)
  try {
    const nomUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const nom = await getJSON(nomUrl, { timeout: 4000, headers: { 'User-Agent': 'StratusApp/1.0' } });
    if (nom && nom.address) {
      const a = nom.address;
      // In OpenStreetMap, address hierarchy prioritizes actual town/village/city:
      const name = a.village || a.town || a.municipality || a.city || a.hamlet || a.suburb || a.neighbourhood || a.county;
      if (name) {
        return {
          name,
          admin1: a.state || a.region || '',
          country: a.country || '',
          cc: (a.country_code || '').toUpperCase(),
        };
      }
    }
  } catch (_) {}

  // 2. BigDataCloud reverse geocode fallback
  try {
    const q = new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: 'en' });
    const d = await getJSON(`${REVERSE}?${q}`, { timeout: 6000 });
    let bestName = '';
    const admins = d.localityInfo?.administrative || [];
    for (let i = admins.length - 1; i >= 0; i--) {
      const a = admins[i];
      if ((a.adminLevel || 0) <= 5) continue;
      const raw = a.name || '';
      const cleaned = raw.replace(/\b(Grama Panchayat|Block Panchayat|Municipal Corporation|Municipality|taluk|Taluk|City of)\b/gi, '').trim();
      if (cleaned.length > 2) {
        bestName = cleaned;
        break;
      }
    }
    const finalName = bestName || d.city || d.locality || d.principalSubdivision || 'My location';
    return {
      name: finalName,
      admin1: d.principalSubdivision || '',
      country: d.countryName || '',
      cc: d.countryCode || '',
    };
  } catch {
    return { name: 'My location', admin1: '', country: '', cc: '' };
  }
}

// ------------------------------------------------------------------ model

/** Turns raw API responses into the shape the views use: epoch times, current hour onward. */
export function buildModel(entry, U) {
  const wx = entry?.wx;
  if (!wx) return null;
  const off = wx.utc_offset_seconds || 0;
  const c = wx.current || {};
  const H = wx.hourly, D = wx.daily, M = wx.minutely_15;
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000;

  const hours = [];
  H.time.forEach((t, i) => {
    const e = parseLocal(t, off);
    if (e < nowHour) return;
    hours.push({
      t: e, temp: H.temperature_2m[i], feels: H.apparent_temperature[i], pop: H.precipitation_probability[i],
      precip: H.precipitation[i], code: H.weather_code[i], wind: H.wind_speed_10m[i], windDir: H.wind_direction_10m[i],
      gust: H.wind_gusts_10m[i], hum: H.relative_humidity_2m[i], uv: H.uv_index[i], vis: H.visibility[i],
      isDay: H.is_day[i] === 1, dew: H.dew_point_2m[i], cloud: H.cloud_cover[i], pressure: H.pressure_msl[i],
    });
  });

  const days = D.time.map((t, i) => ({
    t: parseLocal(t, off), code: D.weather_code[i], max: D.temperature_2m_max[i], min: D.temperature_2m_min[i],
    fmax: D.apparent_temperature_max[i], fmin: D.apparent_temperature_min[i],
    sunrise: D.sunrise[i] ? parseLocal(D.sunrise[i], off) : null, sunset: D.sunset[i] ? parseLocal(D.sunset[i], off) : null,
    daylight: D.daylight_duration[i], uv: D.uv_index_max[i], psum: D.precipitation_sum[i],
    pop: D.precipitation_probability_max[i], phours: D.precipitation_hours[i], wmax: D.wind_speed_10m_max[i],
    gmax: D.wind_gusts_10m_max[i], wdir: D.wind_direction_10m_dominant[i],
  })).filter((d) => d.max != null);

  const minutely = M ? M.time.map((t, i) => ({ t: parseLocal(t, off), p: M.precipitation[i] ?? 0 })) : [];

  const now = {
    t: c.time ? parseLocal(c.time, off) : Date.now(), temp: c.temperature_2m, feels: c.apparent_temperature,
    hum: c.relative_humidity_2m, dew: c.dew_point_2m, isDay: c.is_day === 1, code: c.weather_code,
    cloud: c.cloud_cover, pressure: c.pressure_msl, wind: c.wind_speed_10m, windDir: c.wind_direction_10m,
    gust: c.wind_gusts_10m, vis: c.visibility, uv: c.uv_index, precip: c.precipitation,
  };

  // pressure tendency over the next 3 hours
  const p3 = hours[3]?.pressure;
  now.pressureTrend = p3 == null || now.pressure == null ? 0 : p3 - now.pressure;

  let aq = null;
  if (entry.aq?.current) {
    const a = entry.aq;
    const aoff = a.utc_offset_seconds || 0;
    aq = {
      ...a.current,
      hourly: (a.hourly?.time || []).map((t, i) => ({ t: parseLocal(t, aoff), us: a.hourly.us_aqi[i], eu: a.hourly.european_aqi[i] }))
        .filter((x) => x.t >= nowHour),
    };
  }

  const model = { off, tz: wx.timezone, now, hours, days, minutely, aq, fetchedAt: entry.at };
  model.alerts = [...(entry.nws || []).filter((a) => !a.end || a.end > Date.now()), ...deriveAdvisories(model, U)];
  return model;
}

// ------------------------------------------------------------------ forecast advisories
// Not official warnings: plain thresholds on the forecast, so every city gets a heads-up
// even where no open alert feed exists. The UI always labels them as such.

const RANK = { minor: 0, moderate: 1, severe: 2, extreme: 3 };

export function deriveAdvisories(m, U) {
  const out = [];
  const add = (id, severity, title, detail, start, end, kind) =>
    out.push({ id, source: 'forecast', severity, title, detail, start, end, kind });
  const next = m.hours.slice(0, 48);
  const span = (pred) => {
    const hit = next.filter(pred);
    return hit.length ? [hit[0].t, hit[hit.length - 1].t + 3600000] : null;
  };

  const storm = span((h) => codeKind(h.code) === 'thunder');
  if (storm) {
    const hail = next.some((x) => x.code === 96 || x.code === 99);
    add('thunder', hail ? 'severe' : 'moderate', hail ? 'Thunderstorms with hail' : 'Thunderstorms expected',
      'Lightning is possible. Move indoors when thunder is heard and avoid open ground, water and tall isolated trees.', ...storm, 'thunder');
  }

  const heavyHour = next.reduce((a, x) => Math.max(a, x.precip || 0), 0);
  const day0 = m.days.slice(0, 3);
  const wetDay = day0.reduce((a, d) => (d.psum > (a?.psum ?? -1) ? d : a), null);
  if ((wetDay && wetDay.psum >= 50) || heavyHour >= 15) {
    const sev = (wetDay?.psum ?? 0) >= 115 || heavyHour >= 30 ? 'severe' : 'moderate';
    add('rain', sev, sev === 'severe' ? 'Very heavy rain' : 'Heavy rain',
      `Up to ${U.precip(wetDay?.psum ?? 0)} of rain in a day, with bursts of ${U.precip(heavyHour)} in an hour. Watch for waterlogging and flash flooding in low-lying areas.`,
      wetDay?.t, wetDay ? wetDay.t + 86400000 : null, 'rain');
  }

  const hot = day0.reduce((a, d) => Math.max(a, d.fmax ?? -99), -99);
  const hotT = day0.reduce((a, d) => Math.max(a, d.max ?? -99), -99);
  if (hot >= 41 || hotT >= 40) {
    const sev = hot >= 54 || hotT >= 45 ? 'severe' : 'moderate';
    add('heat', sev, sev === 'severe' ? 'Extreme heat' : 'Heat advisory',
      `It may feel like ${U.tempU(hot)}. Drink water often, avoid the midday sun and check on vulnerable people.`, null, null, 'heat');
  }

  const cold = day0.reduce((a, d) => Math.min(a, d.fmin ?? 99), 99);
  if (cold <= -25) {
    add('cold', cold <= -35 ? 'severe' : 'moderate', 'Extreme cold',
      `Wind chill down to ${U.tempU(cold)}. Frostbite can set in quickly on exposed skin.`, null, null, 'cold');
  }

  const gust = next.reduce((a, x) => Math.max(a, x.gust || 0), 0);
  if (gust >= 70) {
    const g = span((x) => (x.gust || 0) >= 70);
    add('wind', gust >= 100 ? 'severe' : 'moderate', gust >= 100 ? 'Damaging winds' : 'Strong winds',
      `Gusts up to ${U.wind(gust)}. Secure loose objects; expect possible travel disruption.`, ...(g || [null, null]), 'wind');
  }

  const snow = next.filter((x) => x.code === 75 || x.code === 86);
  if (snow.length >= 3) add('snow', 'moderate', 'Heavy snow', 'Heavy snowfall is forecast. Roads may become slippery or impassable.', snow[0].t, snow[snow.length - 1].t + 3600000, 'snow');

  const ice = next.filter((x) => [56, 57, 66, 67].includes(x.code));
  if (ice.length) add('ice', 'moderate', 'Freezing rain', 'Ice may form on roads, pavements and power lines.', ice[0].t, ice[ice.length - 1].t + 3600000, 'ice');

  const fog = next.filter((x) => x.vis != null && x.vis < 200 && codeKind(x.code) === 'fog');
  if (fog.length >= 2) add('fog', 'minor', 'Dense fog', `Visibility may drop below ${U.distance(200)}. Drive slowly with low-beam lights.`, fog[0].t, fog[fog.length - 1].t + 3600000, 'fog');

  const uv = m.days[0]?.uv ?? 0;
  if (uv >= 8) add('uv', uv >= 11 ? 'moderate' : 'minor', uv >= 11 ? 'Extreme UV' : 'Very high UV',
    `UV index peaks at ${Math.round(uv)} today. Seek shade around midday and use SPF 30+ sunscreen.`, null, null, 'uv');

  const aqi = m.aq?.us_aqi;
  if (aqi != null && aqi > 150) add('aqi', aqi > 200 ? 'severe' : 'moderate', 'Unhealthy air quality',
    `US AQI is ${Math.round(aqi)}. Limit time outdoors and consider a mask; sensitive groups should avoid exertion outside.`, null, null, 'aqi');

  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

export const topSeverity = (alerts) =>
  alerts.reduce((s, a) => (RANK[a.severity] > RANK[s] ? a.severity : s), alerts.length ? 'minor' : null);
