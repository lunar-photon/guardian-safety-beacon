# Unsafe-area data for India — what's real, and how to load it

Straight truth first: there is no live, street-level "where women are unsafe right now" database for India with an API. Anyone who tells you otherwise is usually selling something. What genuinely exists is coarse (district-level, annual) or crowdsourced (no API). So Guardian takes a practical approach: you load whatever hotspot points you can get into `tools/ingest_hotspots.py`, and the phones warn you when you come within range of one.

Treat imported zones as "be extra alert here," not a precise prediction.

---

## Sources you can actually use

### 1. NCRB — Crime in India (official)
National Crime Records Bureau publishes annual crimes-against-women counts (including rape) per district. No coordinates, mostly no API — it's CSV/PDF.
- Reports: https://ncrb.gov.in/crime-in-india.html
- Machine-readable mirrors:
  - data.gov.in: https://data.gov.in/resource/district-wise-crimes-committed-against-women-during-2013
  - India Data Portal (district-wise 2017+): https://indiadataportal.com (search "crime against women")
- To map it you must join district name to a district centroid (a districts shapefile/centroid CSV). District names are police districts and won't always match revenue districts, so expect some manual cleanup.

### 2. Research dataset — dark spot identification
NCRB district crime merged with census variables (2001–2020), handy if you want to rank districts by risk before placing zones.
- https://data.mendeley.com/datasets/whrdh8c5zb/1

### 3. Safecity (Red Dot Foundation) — crowdsourced
Real public-space harassment reports aggregated into map hotspots. No public API or bulk export — you'd read their map and transcribe pins for your city, or ask Red Dot Foundation for access.
- https://webapp.safecity.in (map) · https://reddotfoundation.org

### 4. Local / city police dark spots and safety audits
Many city police and municipal bodies publish lists of poorly-lit / unsafe spots from women's safety audits. These are often the most accurate and current for a given city. Search e.g. "<your city> police dark spots women safety audit".

### 5. You
The most reliable source for your routes is often your own knowledge. Just add rows to a CSV, or click the dashboard map to drop danger zones by hand.

---

## How to load

1. Make a CSV with this header (see `sample_hotspots.csv`):
   ```
   name,lat,lon,radius,severity
   ```
   `radius` (metres) and `severity` are optional.

2. Import it:
   ```bash
   cd server
   python tools/ingest_hotspots.py \
       --server http://localhost:8000 --token "$SAFETY_TOKEN" \
       --csv data_sources/sample_hotspots.csv --replace
   ```
   Drop `--replace` to append rather than replace existing danger zones.

3. Clear them if needed:
   ```bash
   python tools/ingest_hotspots.py \
       --server http://localhost:8000 --token "$SAFETY_TOKEN" --clear
   ```
