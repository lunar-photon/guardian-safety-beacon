# Stratus

A weather app for Android that shows many places at once: a card per city on the home screen, a Compare view that charts them against each other, and a full forecast page per city that you swipe between.

## Features

- Multi-city dashboard: search and add cities, reorder and remove them (Edit), with an optional card for your current location. Pull down to refresh.
- Compare: temperature, feels-like, rain chance, wind or humidity for up to 8 cities on one chart (48 hours or 14 days), plus a table of all cities.
- City pages: 48-hour forecast with sunrise and sunset, a 16-day forecast (tap a day for details), precipitation for the next 2 hours, feels-like, humidity and dew point, wind compass, UV, pressure trend, visibility, cloud cover, sun and moon.
- Air quality: US or European AQI, pollutants against WHO guidelines, a 24-hour AQI forecast, and pollen where the data covers it (Europe).
- Radar: animated precipitation radar for the past ~2 hours, with your cities on the map.
- Alerts: official National Weather Service alerts for US cities. Everywhere else, forecast advisories (thunderstorms, heavy rain, heat, wind, UV, poor air), which are thresholds on the forecast, not official warnings.
- Animated sky behind each city (rain, snow, stars, lightning), switchable off in Settings.
- Units for temperature, wind, rain, pressure, distance, 12/24-hour time.

## Build

```sh
./build.sh          # -> Stratus.apk
```

It uses the same Gradle-free toolchain as Orbit (~/.local/share/android-toolchain: aapt2, javac, D8, uber-apk-signer). Every build gets a newer version code, so it installs over the previous one.

## Layout

- android/src/.../MainActivity.java: the native shell. A WebView serving assets/www from an https origin, plus location, edge-to-edge insets, back button, haptics, external links.
- android/assets/www/: the app itself (HTML, CSS, ES modules).
  - js/app.js: state, navigation, views
  - js/api.js: Open-Meteo, NWS alerts, geocoding, forecast advisories
  - js/charts.js, js/icons.js, js/sky.js, js/radar.js, js/util.js

To work on the UI in a desktop browser:

```sh
python3 -m http.server -d android/assets/www 8000   # then open http://localhost:8000
```

## Data

Forecasts and air quality: Open-Meteo (CC BY 4.0, free for non-commercial use). Radar: RainViewer (free tiles stop at zoom 7 and are upscaled beyond). Base map: Esri dark gray canvas. Place names for your location: BigDataCloud. No API keys.
