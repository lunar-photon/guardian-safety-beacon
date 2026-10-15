# 🛡️ Guardian — silent safety beacon + watcher console

A replacement for closed "Find My"-style apps, built for personal safety in India.

The design is two halves:

- **The phone is a silent beacon.** After a one-time setup it shows only a decoy
  **Notes** screen and does nothing visible. Underneath it continuously broadcasts
  GPS, battery and (on request) webcam frames to your server. There are no safety
  buttons on the phone for an attacker to find and disable.
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

1. Open the **ngrok https URL + `/pwa/`** on the phone.
2. First run shows a short setup: **Server URL**, **token**, **device name**.
   Optionally tap **Set Home / Set Office** here so arrivals get logged.
3. Tap **Save & go silent** → the phone switches to a plain **Notes** screen (it's a
   real, working notepad) and broadcasts in the background.
4. To get settings back later: **triple-tap the word "Notes"** at the top.

Keep the page open and "screen awake" for best results; for always-on, use Android.

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
  pwa/                  silent-beacon phone app (decoy Notes UI)
  tools/ingest_hotspots.py   import unsafe-area CSV -> danger zones
  data_sources/        where to get India hotspot data (+ sample CSV)
android/               Kotlin/Gradle silent-beacon app (service, GPS, WiFi, commands)
```
