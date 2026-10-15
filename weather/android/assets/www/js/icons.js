// Weather icons drawn as inline SVG (64×64). Gradients live once in #svg-defs (index.html).
import { codeKind } from './util.js';

const CLOUD = 'M17,47 H47 A10,10 0 0 0 48.5,27.1 A14.5,14.5 0 0 0 21,23.4 A12,12 0 0 0 17,47 Z';

const sun = (cx, cy, r, rays = true) => {
  let s = '';
  if (rays) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x1 = cx + Math.cos(a) * (r + 4), y1 = cy + Math.sin(a) * (r + 4);
      const x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#ffc53d" stroke-width="3" stroke-linecap="round"/>`;
    }
  }
  return `<g class="i-sun">${s}<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g-sun)"/></g>`;
};

const moon = (cx, cy, r) =>
  `<path d="M${cx + r * 0.25},${cy - r} A${r},${r} 0 1 0 ${cx + r},${cy + r * 0.3} A${r * 0.8},${r * 0.8} 0 1 1 ${cx + r * 0.25},${cy - r} Z" fill="url(#g-moon)"/>`;

const cloud = (tx = 0, ty = 0, s = 1, dark = false, opacity = 1) =>
  `<path d="${CLOUD}" transform="translate(${tx} ${ty}) scale(${s})" fill="url(#${dark ? 'g-cloud-dark' : 'g-cloud'})" opacity="${opacity}"/>`;

const drops = (n, heavy = false) => {
  const xs = n === 2 ? [26, 38] : n === 3 ? [22, 32, 42] : [18, 26, 34, 42, 50];
  return xs.map((x, i) => {
    const y = 50 + (i % 2) * 3;
    return `<line x1="${x}" y1="${y}" x2="${x - 3}" y2="${y + (heavy ? 9 : 7)}" stroke="#5fb4ff" stroke-width="${heavy ? 3 : 2.6}" stroke-linecap="round"/>`;
  }).join('');
};

const dots = () => [22, 32, 42].map((x, i) =>
  `<circle cx="${x - (i % 2)}" cy="${53 + (i % 2) * 3}" r="1.9" fill="#7cc4ff"/>`).join('');

const flakes = (xs = [22, 32, 42]) => xs.map((x, i) => {
  const y = 54 + (i % 2) * 3;
  return `<g stroke="#eaf4ff" stroke-width="1.8" stroke-linecap="round"><line x1="${x}" y1="${y - 3.5}" x2="${x}" y2="${y + 3.5}"/><line x1="${x - 3}" y1="${y - 1.8}" x2="${x + 3}" y2="${y + 1.8}"/><line x1="${x - 3}" y1="${y + 1.8}" x2="${x + 3}" y2="${y - 1.8}"/></g>`;
}).join('');

const bolt = () => '<path d="M34,44 L27,55 H32.5 L29.5,63 L39.5,50.5 H34 L37.5,44 Z" fill="url(#g-bolt)"/>';

const fogLines = () => [50, 56].map((y, i) =>
  `<line x1="${14 + i * 6}" y1="${y}" x2="${50 - i * 2}" y2="${y}" stroke="#cdd8e6" stroke-width="3" stroke-linecap="round" opacity="${0.9 - i * 0.2}"/>`).join('');

const peek = (day) => (day ? sun(22, 22, 9) : moon(22, 21, 9));

export function iconSvg(code, isDay = true, cls = '') {
  const k = codeKind(code);
  let body;
  switch (k) {
    case 'clear': body = isDay ? sun(32, 32, 13) : moon(30, 30, 16); break;
    case 'mostly-clear': body = (isDay ? sun(28, 28, 12) : moon(27, 27, 14)) + cloud(16, 18, 0.62); break;
    case 'partly': body = peek(isDay) + cloud(2, 4, 0.92); break;
    case 'cloudy': body = cloud(-6, -8, 0.78, true, 0.9) + cloud(2, 2, 0.95); break;
    case 'fog': body = cloud(0, -6, 0.95, false, 0.85) + fogLines(); break;
    case 'drizzle': body = cloud(0, -8, 1) + dots(); break;
    case 'rain': body = cloud(0, -8, 1, true) + drops(3); break;
    case 'heavy-rain': body = cloud(0, -9, 1, true) + drops(5, true); break;
    case 'showers': body = peek(isDay) + cloud(2, -4, 0.92) + drops(2); break;
    case 'snow': body = cloud(0, -8, 1) + flakes(); break;
    case 'sleet': body = cloud(0, -8, 1) + drops(2) + flakes([44]); break;
    case 'thunder': body = cloud(0, -10, 1, true) + bolt() + drops(2); break;
    default: body = cloud(0, 0, 1);
  }
  return `<svg class="wx-icon ${cls}" viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
}

/** Sunrise / sunset: a half sun on the horizon with an up or down arrow. */
export function sunEventSvg(kind) {
  const up = kind === 'sunrise';
  return `<svg class="wx-icon h-icon" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M18,42 A14,14 0 0 1 46,42 Z" fill="url(#g-sun)"/>
    ${[-60, -30, 0, 30, 60].map((a) => { const r = (a - 90) * Math.PI / 180; return `<line x1="${32 + Math.cos(r) * 18}" y1="${42 + Math.sin(r) * 18}" x2="${32 + Math.cos(r) * 23}" y2="${42 + Math.sin(r) * 23}" stroke="#ffc53d" stroke-width="2.6" stroke-linecap="round"/>`; }).join('')}
    <line x1="10" y1="43" x2="54" y2="43" stroke="#ffd66e" stroke-width="2.6" stroke-linecap="round"/>
    <path d="${up ? 'M32,60 V49 M27,54 L32,49 L37,54' : 'M32,48 V59 M27,54 L32,59 L37,54'}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ------------------------------------------------------------------ UI glyphs (24×24, stroke)

const G = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  locate: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  chart: '<path d="M4 19h16"/><path d="m4 15 5-5 4 3 7-7"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  gauge: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="m12 13 4-5"/>',
  thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.3 1.5A3.3 3.3 0 0 0 7 18z"/>',
  sunrise: '<path d="M17 18a5 5 0 0 0-10 0M12 2v7M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1M8 6l4-4 4 4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6"/>',
  flower: '<circle cx="12" cy="12" r="3"/><path d="M12 2a3 3 0 0 1 3 3c0 1.7-3 4-3 4S9 6.7 9 5a3 3 0 0 1 3-3zM12 22a3 3 0 0 1-3-3c0-1.7 3-4 3-4s3 2.3 3 4a3 3 0 0 1-3 3zM2 12a3 3 0 0 1 3-3c1.7 0 4 3 4 3s-2.3 3-4 3a3 3 0 0 1-3-3zM22 12a3 3 0 0 1-3 3c-1.7 0-4-3-4-3s2.3-3 4-3a3 3 0 0 1 3 3z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  umbrella: '<path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9zM12 12v7a2 2 0 0 0 4 0"/>',
};

export const glyph = (name, cls = '') =>
  `<svg class="glyph ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[name] || ''}</svg>`;
