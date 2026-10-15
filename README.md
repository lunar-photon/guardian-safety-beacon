# 🛡️ Guardian — silent safety beacon + watcher console

A replacement for closed "Find My"-style apps, built for personal safety in India.

The design is two halves:

- The phone is a silent beacon disguised as a Weather app. After a one-time setup it displays a fully-functional local weather and forecast interface, legitimately justifying continuous location access. Underneath it continuously broadcasts GPS, battery, and (on request) webcam frames to your server. Emergency controls and beacon settings are accessible via a discrete gesture.
- **The server is the console.** A trusted watcher opens the dashboard on a laptop
  or phone and sees everything live — map, trail, timeline, webcam — and holds all
  the **"reach help"** options: call the helplines, snapshot or start live video on
  the phone remotely, and get loud alerts on SOS / danger zones / going silent.

Two phone clients:
- **PWA** (`server/pwa/`) — works on any phone today, nothing to compile.
- **Android app** (`android/`) — true background beacon: WiFi scanning, restart on
  boot, hideable icon. Build it in Android Studio.

---

## ⚠️ Intended use — read this

Install this on **your own phone** (or a phone whose owner knows and agrees),
pointed at **your own server**. The silent/decoy behaviour is so an attacker who
grabs *your* phone can't find and kill the tracker — **not** to secretly monitor
another person. Covertly tracking another adult is stalkerware and is illegal.

---

## 1. Server (your laptop)

```bash
cd server
export SAFETY_TOKEN="pick-a-long-random-secret"
./run.sh                       # makes a venv, installs deps, starts on :8000
```

- **Dashboard:** http://localhost:8000/ → paste the token.
- Data is stored in `server/data/` (SQLite + webcam JPEGs).

Expose it to the phone with **ngrok**:

```bash
ngrok http 8000                # optionally add  --basic-auth "user:pass"
```

Use the printed **https** URL on the phone (HTTPS is required for GPS + camera).

---

## 2. Phone — PWA (silent beacon)

1. Open the ngrok https URL + `/pwa/` on the phone.
2. First run shows a quick setup: Server URL, token, device name (or pair by code / QR).
3. Tap Save & Connect. The phone switches to an authentic Weather forecast screen showing live temperatures, hourly forecasts, and local metrics.
4. Underneath, it continuously broadcasts location and obeys remote commands.
5. To open beacon controls or emergency SOS later: triple-tap the location title / temperature or tap the gear icon in the top bar.

---

## 3. The dashboard (the watcher)

- **Map + trail** of every device; click a device to see its track and control it.
- **Timeline** of events: `Reached Home` / `Left Office`, **danger-zone** entry,
  **SOS**, **went silent**, and operator commands. Critical events flash + sound an alarm.
- **Reach help** — one-tap call buttons for **112** (emergency), **1091** and **181**
  (women's helplines). (Dialling works if the dashboard is open on a phone; on a
  laptop the number is shown to dial.)
- **Control selected phone** — remotely tell the silent phone to:
  📸 take a snapshot · 🎥 start/stop live frames · 📍 locate now · 🚨 trigger SOS.
  The phone acts on its next poll (~5 s).
- **Places** — name learned spots; set Home/Office; see **frequently-visited places**
  the server learns automatically and tap to name them.
- **Webcam frames** gallery.

### Places: auto-logging + learning

- Mark **Home/Office** (from the phone setup, or by selecting a device on the
  dashboard → *Set Home/Office here*). Crossing in/out is logged as
  **"Reached Home" / "Left Office"** automatically.
- The server clusters each device's location history and, every few minutes,
  **auto-marks frequently-visited spots** as "Frequent place N". They appear under
  **Places** and in **Suggestions** for you to rename.

---

## 4. Unsafe-area danger zones (India data)

There is **no live, street-level "unsafe areas" API for India** — see
`server/data_sources/README.md` for the honest rundown (NCRB is district-level and
annual; Safecity has no public API). Guardian instead lets you **import any hotspot
points you have** and warns on approach.

```bash
cd server
python tools/ingest_hotspots.py \
    --server http://localhost:8000 --token "$SAFETY_TOKEN" \
    --csv data_sources/sample_hotspots.csv --replace
```

CSV columns: `name,lat,lon,radius,severity`. Sources and how to get coordinates
(NCRB district centroids, local police "dark spot" lists, Safecity, your own marks)
are documented in `server/data_sources/README.md`. You can also just click the map
on the dashboard to drop danger zones by hand.

When a phone comes within range of a danger zone, the dashboard logs a **critical**
alert. (On the PWA the warning is silent-to-the-carrier by design; the watcher sees it.)

---

## 5. Android app (the real beacon)

Open `android/` in **Android Studio** (it fetches the Gradle wrapper on first sync),
then Run/Build an APK. Beyond the PWA it adds:

- Foreground service + wake lock → keeps broadcasting with the screen off.
- **Nearby WiFi scanning** (helps locate indoors where GPS is weak).
- **Remote commands** from the dashboard (snapshot / live frames / SOS / locate).
- **Restart on reboot** and if the OS kills it.
- **Hide launcher icon** — vanishes from the app drawer, keeps running.

Grant **Location → Allow all the time**, **Camera**, **Nearby devices**,
**Notifications**, and set the app to **Unrestricted** battery, or Android throttles
background GPS. Android forces a persistent notification for any background service —
it's worded as a routine "System / Sync active" and can't be removed (OS rule).

---

## 6. Find my devices — phone ↔ laptop (both ways)

Every paired device can see where the others are, how far away and in which
direction, and can **ring** them. The phone finds the laptop; the laptop finds the phone.

| Where | How to open it |
|---|---|
| Phone (web app) | The **📍 Find my devices** card on the main screen |
| Phone (Android app) | **📍 Find my devices** button → opens the map in your browser |
| Laptop | Dashboard → **📍 Find my devices**, or `http://localhost:8000/pwa/find.html` |

Per device: live map pin + accuracy circle, online / last seen, battery, distance +
compass arrow, **🔔 Ring** (loud even on silent — Android uses the alarm stream; the laptop
unmutes and goes to full volume, then restores it), **📍 Locate** (fresh fix now), **🧭 Go**
(Google Maps directions). If the server is unreachable, the map shows the **last known
positions** it cached.

### Laptop beacon (`laptop/guardian_agent.py`)

Laptops have no GPS. The agent (pure Python stdlib, Linux + NetworkManager) reports
position + battery every 60 s and obeys Ring / Locate:

```bash
# Dashboard → "Pair a device" shows this exact command with your code filled in
python3 laptop/guardian_agent.py pair --server http://<laptop-ip>:8000 --code ABC123
python3 laptop/guardian_agent.py locate     # test: where does it think it is?
python3 laptop/guardian_agent.py install    # run at every login (systemd user service)
```

Where the laptop's position comes from, best first:

1. **Your personal WiFi map** (server-side, nothing leaves your server). Your Android
   phone uploads the WiFi networks it sees with each GPS fix, so when the laptop sees the
   same networks, the server places it there (~25–100 m). This works anywhere your
   phone has been with the Android app running: home, office, college.
2. **beaconDB** (`api.beacondb.net`), a free crowdsourced WiFi database. Coverage in
   India is thin, so it often has no answer.
3. **IP geolocation** (`ipinfo.io`), city-level only (~10 km), shown as *"Approximate"*.

Steps 2–3 send nearby WiFi MACs / your IP to those services. Use `--source ip` or
`--source none` to limit that.

**Limit:** the server runs *on* the laptop by default, so if the laptop is off or offline,
nothing can reach it. The phone will still show the laptop's last known position. To
track a lost laptop properly, run the server on an always-on machine (a VPS, a Raspberry Pi)
and point the agent at it.

---

## Helplines wired in (India)

| Number | Line |
|---|---|
| **112** | National emergency (police / fire / ambulance) |
| **1091** | Women Helpline |
| **181** | Women / domestic-abuse helpline |

Edit the `HELPLINES` list in `server/app.py` to change them.

---

## Security notes

- Everything is gated by `SAFETY_TOKEN`. Pick a long random one; anyone with it +
  the ngrok URL sees your data. Consider ngrok `--basic-auth`.
- Data lives only on your laptop in `server/data/`.
- Single-operator tool. For separate users, run separate servers.

## Layout

```
server/
  app.py                device/dashboard API, websocket, watchdog, places, commands
  db.py                 SQLite storage
  run.sh                venv bootstrap + launch
  static/dashboard.html live console (map, timeline, control, help, places)
  pwa/                  silent-beacon phone app (decoy Weather UI)
  pwa/find.html, find.js   "Find my devices" two-way map (also embedded in the phone app)
  tools/ingest_hotspots.py   import unsafe-area CSV -> danger zones
  data_sources/        where to get India hotspot data (+ sample CSV)
android/               Kotlin/Gradle silent-beacon app (service, GPS, WiFi, commands)
laptop/guardian_agent.py   laptop beacon: WiFi/IP location, battery, ring (stdlib only)
```
