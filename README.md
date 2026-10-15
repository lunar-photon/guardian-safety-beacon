# Guardian & Stratus: Silent Safety Beacon and Tracking Console

Personal safety tracker disguised as an authentic weather application, paired with a self-hosted live watcher console.

The setup consists of two parts:
- The Phone (Stratus): A fully functional weather app with live forecasts, temperature, and atmospheric metrics that justifies continuous location access. In the background, it silently logs and reports GPS fixes, battery, motion, and on-demand camera captures. If disconnected or if the laptop is turned off, the phone caches all location fixes in a local SQLite database and auto-purges logs older than 3 days.
- The Laptop (Guardian): A tracking dashboard showing live position on an interactive map, motion speed, heading, visited places, activity events, and remote camera controls. When a tracking session expires or is stopped, public links stop hosting and return HTTP 404 Not Found.

---

## Quick Start: One-Command Installer

Everything is self-contained. Run the master installer from the project directory:

```bash
./install.sh
```

During installation, the script interactively asks which permanent connection method to configure:
1. localhost.run (Native SSH Reverse Tunnel) - Recommended. Zero accounts or configuration needed. Uses built-in Linux SSH to establish a permanent HTTPS connection whenever your laptop is on.
2. Cloudflare Named Tunnel - Uses your free Cloudflare Zero Trust account and tunnel token for permanent 24/7 custom domain routing.
3. Local Network Only - Operates exclusively over your local Wi-Fi without public internet access.

The installer will:
- Configure Python virtual environments and install dependencies.
- Generate your private safety token and initialize the SQLite database.
- Establish the chosen tunnel and retrieve the active endpoint.
- Compile and sign Stratus.apk using the lightweight Gradle-free toolchain.
- Place the ready-to-install APK at ~/Downloads/Stratus.apk.
- Install the global sshlocation command to ~/.local/bin/sshlocation.
- Open the live tracking dashboard in your default browser.

---

## Daily Usage

Whenever your laptop is awake and you want to start tracking, run the global command in any terminal:

```bash
sshlocation
```

This starts the backend service, establishes the secure tunnel, renews the tracking session, and opens the live dashboard in your browser.

Additional commands:

- Check live status, remaining session time, and public URLs:
```bash
sshlocation status
```

- Stop hosting and terminate the tunnel:
```bash
sshlocation stop
```
Once stopped, all public and local web links immediately return HTTP 404 Not Found.

- Recompile the Android APK with current endpoint settings:
```bash
sshlocation rebuild
```

---

## Key Features

### 1. Offline Location Caching and Batch Streaming
When your laptop is turned off or the phone is without internet:
- Stratus silently logs GPS fixes, accuracy, speed, heading, and battery into an encrypted local SQLite database.
- Entries older than 3 days are purged automatically.
- As soon as the laptop comes online or internet connectivity resumes, Stratus automatically flushes and streams all queued points in batches via /api/ping/batch.

### 2. Session Expiry and 404 Protection
- Every tracking session is active for 24 hours by default.
- You can stop hosting at any time with sshlocation stop.
- Once the session expires or is terminated, all dashboard routes, frame images, and API endpoints return HTTP 404 Not Found.

### 3. Telemetry and Position Statistics
The lower section of the dashboard broadcasts live position insights:
- Current motion status (Stationary or moving speed in km/h)
- Heading (angle in degrees and 16-point compass direction)
- GPS accuracy radius in meters
- Distance travelled
- Maximum speed recorded
- Total logged fixes and time tracked

### 4. Visited Places and Photo Gallery
- Identifies visited places and tracks dwell time and visit counts.
- Photos captured at visited places are sorted chronologically by capture timestamp.
- Stores and displays up to the 5 most recent photos per place.

### 5. Activity Log Retention
- Event logs are restricted to the last 3 days or 3 MB total storage size, whichever threshold is reached first.

### 6. Dual Camera Capture
- Operators can request photos from the front camera, back camera, or both sequentially.
- The phone camera hardware session is released immediately upon capture to ensure the camera indicator does not remain active.

---

## Security Model

- Outbound-only SSH tunnel: Your home router does not require any port forwarding or open inbound ports.
- Bearer token authorization: All dashboard views, WebSocket feeds, and command dispatches require your high-entropy safety token.
- Strict session gating: The link stops existing (404 Not Found) when you stop hosting or when the session duration elapses.
- Isolated device credentials: Paired phones use independent scoped tokens that cannot access admin settings.
