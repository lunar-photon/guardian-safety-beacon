# Guardian & Stratus: Silent Safety Beacon and Tracking Console

> Notice: Work in Progress — An open-source research and engineering prototype dedicated to women's safety, family protection, and personal emergency response in India.

Guardian is a personal safety system paired with an authentic weather application (Stratus) that provides discrete emergency signaling, real-time location telemetry, and helpline dispatch for trusted watchers.

---

## Important Notice: Ethical Use and Legal Disclaimer

This repository is developed strictly for lawful, consensual safety purposes:
- Women's safety and emergency response: Designed to give individuals and their trusted circles real-time awareness and rapid helpline access during emergencies.
- Strictly prohibited for non-consensual surveillance: Covertly tracking another adult without informed consent constitutes criminal stalking under Section 354D of the Indian Penal Code (IPC) / Bharatiya Nyaya Sanhita (BNS), violates the Digital Personal Data Protection Act (DPDPA 2023), and breaches the Information Technology Act (Sections 43, 66E).
- Disclaimer of liability: This software is provided as an open-source educational prototype on an "as is" basis. The maintainers and contributors disclaim all liability for unlawful, unethical, or unauthorized deployments by third parties. See ETHICS_AND_LEGAL.md for the full legal disclaimer.

---

## Design Rationale and Threat Model

A frequent question in personal safety technology is: why disguise the tracker inside a weather app, and why capture snapshots from both cameras? 

These architectural decisions stem directly from adversary threat modeling and victim-centered safety research.

### Why Disguise the Tracker Inside a Weather App?

1. Attacker Psychology and Device Seizure
In physical confrontations, kidnapping, domestic harassment, or robbery, an aggressor's first action is almost always to seize and inspect the victim's phone.
- If the phone contains an obvious app named "Safety Tracker", "SOS Alert", or "Life360", the aggressor will immediately demand its removal, toggle Airplane mode, power down the device, or destroy it.
- A functional weather application raises zero alarm. An assailant inspecting the device sees live local temperatures, hourly rain probabilities, and atmospheric data. There is no motivation to scrutinize or delete a standard utility.

2. Preventing Retaliation During Escalation
Forcing a victim to open an app and press a prominent on-screen panic button in front of an aggressive person frequently triggers immediate physical violence. Operating as a background weather utility allows trusted guardians to monitor route deviations, distress signals, or silence alarms without requiring the victim to make conspicuous, dangerous gestures.

3. Eliminating Social Stigma and Scrutiny
In conservative social environments, colleges, or shared households, having a visible tracking or safety app on one's home screen can lead to unwanted questioning, peer teasing, or victim-blaming. A weather app is completely neutral and socially invisible.

4. Legitimate Justification for Continuous OS Location
Modern mobile operating systems (Android 10+ and iOS) aggressively terminate background services that demand ongoing location fixes without a clear user-facing purpose.
- Providing accurate local temperatures, weather alerts, and UV metrics gives the operating system and user an authentic functional reason to grant continuous location permissions without battery-cleaner services killing the process.

---

### Why Dual-Camera Capture (Front and Back)?

When an operator on the laptop requests visual verification during an alert, firing snapshots from both the front and back cameras serves three tactical purposes:

1. Orientation Uncertainty
The remote watcher has no way of knowing how the phone is physically oriented. It may be resting face-down on a car seat, screen-up on a desk, or tucked into a purse. Triggering both cameras guarantees that whichever lens has an unobstructed line of sight captures usable visual information.

2. Dual Context: Surroundings vs. Identity
Each lens captures distinct intelligence essential for emergency dispatch:
- Back camera: Captures the physical environment, such as vehicle interiors, street signs, building facades, license plates, or road landmarks.
- Front camera: Captures the user perspective, recording who is holding, operating, or standing over the device.

3. Lightweight Intelligence on Degraded Cellular Networks
Streaming continuous live video consumes immense battery and frequently drops when traveling through low-reception 2G or 3G zones.
- Two discrete, compressed JPEG snapshots require only ~150 to 250 KB of total bandwidth.
- They upload reliably even over marginal connections, providing immediate visual confirmation without triggering audible or visible indicators that could endanger the phone owner.

---

### Evidentiary Value and Post-Incident Investigation

In safety incidents, disappearances, or crimes, real-time intervention is not always possible before a situation unfolds. In such critical circumstances, the recorded telemetry, offline logs, and visual frames become indispensable forensic evidence for family, first responders, and law enforcement:

1. Unbroken Timeline Reconstruction
Every location fix recorded by Guardian includes precise GPS coordinates, timestamp, speed, heading, and accuracy radius. This enables investigators to reconstruct the victim's exact trajectory, travel speeds, route anomalies, and unscheduled stops down to the second.

2. Offline Continuity in Signal Dead Zones
Standard cloud tracking applications drop completely when an abducted or distressed individual is transported through underground parking, basements, or rural dead zones lacking cellular connectivity.
- Stratus continues silently recording fixes into its local SQLite database on the device.
- As soon as the phone briefly regains connectivity or is recovered by authorities, all queued offline logs are streamed to the server.
- This prevents the critical loss of location breadcrumbs precisely when an individual is in the highest danger.

3. Evidentiary Photographic Verification
Dual-camera snapshots record vehicle interiors, license plates, road signage, and the faces of individuals holding or inspecting the phone. These time-stamped visual records provide objective physical evidence during official missing-person and police inquiries.

4. Safe Remote Persistence
Even if an assailant destroys, powers off, or discards the phone, all data and photos transmitted up to that point remain safely preserved on the watcher's private server, protecting vital clues that cannot be wiped by tampering with the phone.

---

## System Overview

The setup consists of two primary components:
- The Phone (Stratus): A fully functional weather application with live forecasts, hourly temperatures, and meteorological metrics that legitimately justifies continuous location access. In the background, it silently logs and reports GPS coordinates, battery level, motion, and on-demand camera captures. If disconnected or if the laptop is offline, Stratus securely caches location fixes in a local SQLite database and auto-purges logs older than 3 days.
- The Laptop (Guardian): A private, self-hosted watcher dashboard displaying live position on an interactive map, motion speed, heading, visited places, activity events, and remote emergency controls. When a tracking session expires or is stopped, hosting terminates immediately and all links return HTTP 404 Not Found.

---

## Quick Start: One-Command Installer

Setup is completely self-contained. Run the installer from the repository root:

```bash
./install.sh
```

During installation, you are asked which permanent connection method to configure:
1. localhost.run (Native SSH Reverse Tunnel) - Recommended. Zero accounts or configuration needed. Uses built-in Linux SSH to establish a permanent HTTPS connection whenever your laptop is on.
2. Cloudflare Named Tunnel - Uses your free Cloudflare Zero Trust account and tunnel token for permanent 24/7 custom domain routing.
3. Local Network Only - Operates exclusively over your local Wi-Fi without public internet access.

The installer automatically:
- Configures Python virtual environments and installs all server dependencies.
- Generates your private safety token and initializes the database.
- Establishes the chosen tunnel and retrieves the active endpoint.
- Compiles and signs Stratus.apk using the lightweight Gradle-free toolchain.
- Places the ready-to-install APK at ~/Downloads/Stratus.apk.
- Installs the global sshlocation command to ~/.local/bin/sshlocation.
- Opens the live tracking dashboard in your default browser.

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

## Core Capabilities

### 1. Offline Location Caching and Batch Streaming
When your laptop is turned off or the phone is without internet:
- Stratus silently logs GPS fixes, accuracy, speed, heading, and battery into a local SQLite database on the phone.
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

- Outbound-only tunnel: Your home router does not require any port forwarding or open inbound ports.
- Bearer token authorization: All dashboard views, WebSocket feeds, and command dispatches require your high-entropy safety token.
- Strict session gating: The link stops existing (404 Not Found) when you stop hosting or when the session duration elapses.
- Isolated device credentials: Paired phones use independent scoped tokens that cannot access admin settings.
- Transparent licensing: Distributed under the MIT License with full anti-abuse terms in ETHICS_AND_LEGAL.md.
