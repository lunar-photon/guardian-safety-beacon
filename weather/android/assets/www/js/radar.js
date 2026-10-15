// Radar: RainViewer precipitation frames over Esri's dark gray base map (Leaflet), plus a
// cheap static preview (a few tiles, no map engine) for the radar card on city pages.
/* global L */
import { iconSvg } from './icons.js';
import { esc } from './util.js';

const MAPS = 'https://api.rainviewer.com/public/weather-maps.json';
// Esri's dark gray canvas: no key needed (CARTO's free basemaps started requiring one)
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const BASE = `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const LABELS = `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
const RADAR_MAX_NATIVE_ZOOM = 7; // RainViewer's free tiles stop at zoom 7; Leaflet upscales past it

let frames = null, framesAt = 0, host = '';

export async function loadFrames(force = false) {
  if (!force && frames && Date.now() - framesAt < 5 * 60000) return frames;
  const r = await fetch(MAPS);
  const d = await r.json();
  host = d.host;
  frames = [...(d.radar?.past || []).map((f) => ({ ...f, kind: 'past' })), ...(d.radar?.nowcast || []).map((f) => ({ ...f, kind: 'forecast' }))];
  framesAt = Date.now();
  return frames;
}

const tileUrl = (f) => `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;

/** A static radar preview around a point: 3×3 tiles at zoom 6, centred with CSS. */
export function previewHTML(lat, lon) {
  if (!frames?.length) return '';
  const f = frames.filter((x) => x.kind === 'past').pop() || frames[frames.length - 1];
  const z = 6, n = 2 ** z;
  const px = ((lon + 180) / 360) * n * 256;
  const rad = (lat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * 256;
  const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
  const ox = px - tx * 256, oy = py - ty * 256;
  let imgs = '';
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = (((tx + dx) % n) + n) % n, y = ty + dy;
      if (y < 0 || y >= n) continue;
      const style = `left:${(dx + 1) * 256}px;top:${(dy + 1) * 256}px`;
      imgs += `<img src="${ESRI}/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}" style="${style}" alt="" loading="lazy">`;
      imgs += `<img src="${host}${f.path}/256/${z}/${x}/${y}/2/1_1.png" style="${style};opacity:.85" alt="" loading="lazy">`;
    }
  }
  // the city point sits at (256+ox, 256+oy) inside the 768px block; centre it in the card
  return `<div class="mini-map"><div style="position:absolute;left:50%;top:50%;width:768px;height:768px;transform:translate(${-(256 + ox)}px,${-(256 + oy)}px)">${imgs}</div>
    <div class="me-dot" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)"></div></div>`;
}

export class RadarMap {
  constructor(el, { onTime }) {
    this.el = el; this.onTime = onTime;
    this.map = null; this.layers = []; this.i = 0; this.timer = null; this.markers = [];
  }

  ensure() {
    if (this.map) return;
    this.map = L.map(this.el, { zoomControl: false, attributionControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 11 })
      .setView([20, 78], 4);
    L.tileLayer(BASE, { maxZoom: 11, maxNativeZoom: 16 }).addTo(this.map);
    this.map.createPane('labels');
    this.map.getPane('labels').style.zIndex = 450;
    this.map.getPane('labels').style.pointerEvents = 'none';
    L.tileLayer(LABELS, { maxZoom: 11, maxNativeZoom: 16, pane: 'labels' }).addTo(this.map);
  }

  async show(center, zoom) {
    this.ensure();
    setTimeout(() => this.map.invalidateSize(), 50);
    if (center) this.map.setView(center, zoom ?? 7, { animate: false });
    const fr = await loadFrames();
    if (this.layers.length !== fr.length || this.layers[0]?.path !== fr[0]?.path) this.buildLayers(fr);
    this.setFrame(this.lastPast());
  }

  lastPast() {
    let i = this.layers.length - 1;
    while (i > 0 && this.layers[i].kind !== 'past') i--;
    return i;
  }

  buildLayers(fr) {
    this.layers.forEach((l) => this.map.removeLayer(l.layer));
    this.layers = fr.map((f) => ({
      ...f,
      layer: L.tileLayer(tileUrl(f), { opacity: 0, maxNativeZoom: RADAR_MAX_NATIVE_ZOOM, maxZoom: 11, zIndex: 5 }).addTo(this.map),
    }));
  }

  setFrame(i) {
    if (!this.layers.length) return;
    this.i = (i + this.layers.length) % this.layers.length;
    this.layers.forEach((l, k) => l.layer.setOpacity(k === this.i ? 0.82 : 0));
    const f = this.layers[this.i];
    this.onTime?.(f, this.i, this.layers.length);
  }

  play() {
    if (this.timer) return;
    const tick = () => {
      const atEnd = this.i === this.layers.length - 1;
      this.setFrame(this.i + 1);
      this.timer = setTimeout(tick, atEnd ? 500 : this.i === this.layers.length - 1 ? 1600 : 520);
    };
    tick();
  }

  pause() { clearTimeout(this.timer); this.timer = null; }
  get playing() { return !!this.timer; }

  setCities(list) {
    if (!this.map) return;
    this.markers.forEach((m) => this.map.removeLayer(m));
    this.markers = list.map(({ city, temp, code, isDay }) => L.marker([city.lat, city.lon], {
      icon: L.divIcon({
        className: '', iconSize: null,
        html: `<div class="city-pin">${iconSvg(code, isDay)}${esc(temp)} <span style="font-weight:500;opacity:.8">${esc(city.name)}</span></div>`,
      }),
      keyboard: false,
    }).addTo(this.map));
  }

  showMe(lat, lon) {
    if (!this.map) return;
    if (this.me) this.map.removeLayer(this.me);
    this.me = L.marker([lat, lon], { icon: L.divIcon({ className: '', iconSize: [16, 16], html: '<div class="me-dot"></div>' }) }).addTo(this.map);
    this.map.setView([lat, lon], Math.max(this.map.getZoom(), 7));
  }

  hide() { this.pause(); }
}
