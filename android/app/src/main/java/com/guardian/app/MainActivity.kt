package com.guardian.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.guardian.app.databinding.ActivityMainBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs
    private var tapCount = 0
    private var lastTapTime = 0L

    private var currentLat: Double? = null
    private var currentLon: Double? = null
    private var isCustomCity = false

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .build()

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED &&
                checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 99)
            }
            refresh()
            fetchCurrentLocationWeather()
        }

    private val scanLauncher =
        registerForActivityResult(ScanContract()) { result ->
            val contents = result.contents
            if (contents.isNullOrBlank()) toast("Scan cancelled")
            else onScanned(contents)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)

        // Show single-action pairing panel if not configured yet
        if (!prefs.isConfigured()) {
            b.beaconPanel.visibility = View.VISIBLE
        }

        // Secret toggle triggers
        val secretTapListener = View.OnClickListener {
            val now = System.currentTimeMillis()
            if (now - lastTapTime < 800) {
                tapCount++
            } else {
                tapCount = 1
            }
            lastTapTime = now

            if (tapCount >= 3) {
                tapCount = 0
                toggleBeaconPanel()
            }
        }
        b.weatherLocationBox.setOnClickListener(secretTapListener)
        b.weatherCard.setOnClickListener(secretTapListener)
        b.weatherSettingsBtn.setOnClickListener { toggleBeaconPanel() }

        // City Search Dialog
        b.weatherSearchBtn.setOnClickListener { showCitySearchDialog() }

        // Refresh weather
        b.weatherRefreshBtn.setOnClickListener {
            toast("Refreshing weather…")
            if (isCustomCity && currentLat != null && currentLon != null) {
                loadOnlineWeather(currentLat!!, currentLon!!)
            } else {
                isCustomCity = false
                fetchCurrentLocationWeather()
            }
        }

        // Single 1-tap QR Scanner
        b.scanBtn.setOnClickListener {
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                toast("Allow camera, then tap Scan again")
                permLauncher.launch(arrayOf(Manifest.permission.CAMERA))
            } else launchScanner()
        }

        // SOS Button
        b.sos.setOnClickListener {
            GuardianService.sos(this)
            toast("🚨 SOS alert dispatched to desktop")
        }

        // Find my devices map
        b.findBtn.setOnClickListener { openFind() }

        // Automatically start background service if configured and core permissions granted
        if (!hasCore()) {
            requestAllPermissions()
        } else {
            fetchCurrentLocationWeather()
            if (prefs.isConfigured() && !prefs.running) {
                GuardianService.start(this)
            }
        }

        refresh()
    }

    private fun toggleBeaconPanel() {
        val visible = b.beaconPanel.visibility == View.VISIBLE
        b.beaconPanel.visibility = if (visible) View.GONE else View.VISIBLE
        toast(if (visible) "Weather view" else "Pairing & Status")
    }

    // ---- City Search Dialog ----
    private fun showCitySearchDialog() {
        val input = EditText(this).apply {
            hint = "City name (e.g. London, Tokyo, Delhi)"
            setSingleLine()
            setPadding(48, 36, 48, 36)
        }

        AlertDialog.Builder(this)
            .setTitle("Search City")
            .setView(input)
            .setPositiveButton("Search") { _, _ ->
                val q = input.text.toString().trim()
                if (q.isNotEmpty()) searchCity(q)
            }
            .setNeutralButton("📍 GPS Location") { _, _ ->
                isCustomCity = false
                fetchCurrentLocationWeather()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun searchCity(query: String) {
        Thread {
            try {
                val encoded = URLEncoder.encode(query, "UTF-8")
                val url = "https://geocoding-api.open-meteo.com/v1/search?name=$encoded&count=5&language=en&format=json"
                val req = Request.Builder().url(url).build()
                httpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        runOnUiThread { toast("City not found") }
                        return@use
                    }
                    val json = JSONObject(resp.body?.string() ?: "{}")
                    val results = json.optJSONArray("results")
                    if (results == null || results.length() == 0) {
                        runOnUiThread { toast("No matching cities found") }
                        return@use
                    }

                    val items = mutableListOf<String>()
                    val coords = mutableListOf<Pair<Double, Double>>()
                    for (i in 0 until results.length()) {
                        val obj = results.getJSONObject(i)
                        val name = obj.optString("name")
                        val country = obj.optString("country", "")
                        val admin = obj.optString("admin1", "")
                        val label = listOf(name, admin, country).filter { it.isNotBlank() }.joinToString(", ")
                        items.add(label)
                        coords.add(Pair(obj.getDouble("latitude"), obj.getDouble("longitude")))
                    }

                    runOnUiThread {
                        AlertDialog.Builder(this)
                            .setTitle("Select City")
                            .setItems(items.toTypedArray()) { _, which ->
                                val (lat, lon) = coords[which]
                                isCustomCity = true
                                currentLat = lat
                                currentLon = lon
                                b.weatherCity.text = items[which].split(",").firstOrNull() ?: items[which]
                                b.weatherSub.text = items[which]
                                loadOnlineWeather(lat, lon)
                            }
                            .setNegativeButton("Cancel", null)
                            .show()
                    }
                }
            } catch (_: Exception) {
                runOnUiThread { toast("Search failed — check connection") }
            }
        }.start()
    }

    // ---- Weather Engine ----
    @SuppressLint("MissingPermission")
    private fun fetchCurrentLocationWeather() {
        if (!hasCore()) return
        val fused = LocationServices.getFusedLocationProviderClient(this)
        fused.lastLocation.addOnSuccessListener { loc ->
            if (loc != null) {
                currentLat = loc.latitude
                currentLon = loc.longitude
                loadOnlineWeather(loc.latitude, loc.longitude)
            }
        }
    }

    private fun loadOnlineWeather(lat: Double, lon: Double) {
        Thread {
            try {
                // Fetch reverse geocode locality if not custom city
                if (!isCustomCity) {
                    val geoUrl = "https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=$lat&longitude=$lon&localityLanguage=en"
                    val geoReq = Request.Builder().url(geoUrl).build()
                    httpClient.newCall(geoReq).execute().use { resp ->
                        if (resp.isSuccessful) {
                            val body = resp.body?.string()
                            if (!body.isNullOrEmpty()) {
                                val json = JSONObject(body)
                                val city = json.optString("city", "").ifEmpty {
                                    json.optString("locality", "").ifEmpty {
                                        json.optString("principalSubdivision", "Current Location")
                                    }
                                }
                                val country = json.optString("countryName", "")
                                runOnUiThread {
                                    b.weatherCity.text = "📍 $city"
                                    b.weatherSub.text = if (country.isNotBlank()) "$country · Live Forecast" else "Live Local Forecast"
                                }
                            }
                        }
                    }
                }

                // Fetch weather from open-meteo
                val weatherUrl = "https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,surface_pressure&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,sunrise,sunset&timezone=auto"
                val wReq = Request.Builder().url(weatherUrl).build()
                httpClient.newCall(wReq).execute().use { resp ->
                    if (resp.isSuccessful) {
                        val body = resp.body?.string()
                        if (!body.isNullOrEmpty()) {
                            val json = JSONObject(body)
                            val curr = json.optJSONObject("current")
                            val daily = json.optJSONObject("daily")
                            if (curr != null) {
                                val temp = curr.optDouble("temperature_2m", 26.0).roundToInt()
                                val humidity = curr.optDouble("relative_humidity_2m", 60.0).roundToInt()
                                val feels = curr.optDouble("apparent_temperature", 28.0).roundToInt()
                                val wind = curr.optDouble("wind_speed_10m", 12.0).roundToInt()
                                val code = curr.optInt("weather_code", 1)
                                val pressure = curr.optDouble("surface_pressure", 1013.0).roundToInt()
                                val isDay = curr.optInt("is_day", 1)

                                val (label, icon) = decodeWMO(code, isDay)

                                val maxArr = daily?.optJSONArray("temperature_2m_max")
                                val minArr = daily?.optJSONArray("temperature_2m_min")
                                val max = if (maxArr != null && maxArr.length() > 0) maxArr.optDouble(0).roundToInt() else temp + 4
                                val min = if (minArr != null && minArr.length() > 0) minArr.optDouble(0).roundToInt() else temp - 4

                                val uvArr = daily?.optJSONArray("uv_index_max")
                                val uvVal = if (uvArr != null && uvArr.length() > 0) uvArr.optDouble(0).roundToInt() else 4
                                val uvText = when {
                                    uvVal <= 2 -> "$uvVal Low"
                                    uvVal <= 5 -> "$uvVal Moderate"
                                    uvVal <= 7 -> "$uvVal High"
                                    else -> "$uvVal Very High"
                                }

                                val sunriseArr = daily?.optJSONArray("sunrise")
                                val sunsetArr = daily?.optJSONArray("sunset")
                                val rise = sunriseArr?.optString(0, "")?.takeLast(5) ?: "06:15"
                                val set = sunsetArr?.optString(0, "")?.takeLast(5) ?: "18:05"

                                runOnUiThread {
                                    b.weatherTemp.text = "$temp°"
                                    b.weatherIcon.text = icon
                                    b.weatherCondition.text = label
                                    b.weatherHighLow.text = "High: $max° · Low: $min°"
                                    b.weatherHumidity.text = "$humidity%"
                                    b.weatherWind.text = "$wind km/h"
                                    b.weatherFeels.text = "$feels°"
                                    b.weatherPressure.text = "$pressure hPa"
                                    b.weatherUv.text = uvText
                                    b.weatherSun.text = "$rise / $set"
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }.start()
    }

    private fun decodeWMO(code: Int, isDay: Int): Pair<String, String> {
        return when (code) {
            0 -> "Clear Sky" to if (isDay == 1) "☀️" else "🌙"
            1 -> "Mainly Clear" to "🌤️"
            2 -> "Partly Cloudy" to "⛅"
            3 -> "Overcast" to "☁️"
            45, 48 -> "Foggy" to "🌫️"
            in 51..55 -> "Drizzle" to "🌦️"
            in 61..65 -> "Rain" to "🌧️"
            in 71..77 -> "Snow" to "🌨️"
            in 80..82 -> "Showers" to "🌦️"
            else -> if (code >= 95) "Thunderstorm" to "⛈️" else "Fair" to "⛅"
        }
    }

    // ---- Single QR Scanner Pairing ----
    private fun launchScanner() {
        val opts = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Point camera at dashboard pairing QR code")
            .setBeepEnabled(false)
            .setOrientationLocked(true)
        scanLauncher.launch(opts)
    }

    private fun onScanned(text: String) {
        val uri = Uri.parse(text.trim())
        val code = uri.getQueryParameter("code")
        val scheme = uri.scheme
        val authority = uri.authority
        if (code.isNullOrBlank() || scheme.isNullOrBlank() || authority.isNullOrBlank()) {
            toast("QR code not recognized as a desktop pairing code"); return
        }
        prefs.server = "$scheme://$authority"
        pairWithCode(code)
    }

    private fun pairWithCode(code: String) {
        toast("Connecting to desktop…")
        Thread {
            val ok = Uploader(prefs).claim(code, prefs.name)
            runOnUiThread {
                if (ok) {
                    toast("Paired with Desktop ✓")
                    b.beaconPanel.visibility = View.GONE
                    refresh()
                    if (!prefs.running && hasCore()) {
                        GuardianService.start(this)
                    }
                } else {
                    toast("Pairing failed — code expired or unreachable")
                }
            }
        }.start()
    }

    private fun openFind() {
        if (!prefs.isConfigured()) { toast("Pair with desktop first"); return }
        val url = "${prefs.server}/pwa/find.html#t=${Uri.encode(prefs.token)}&s=${Uri.encode(prefs.server)}"
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            toast("No browser found")
        }
    }

    // ---- Permissions ----
    private fun requestAllPermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.CAMERA
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms += Manifest.permission.NEARBY_WIFI_DEVICES
        }
        permLauncher.launch(perms.toTypedArray())
    }

    private fun hasCore(): Boolean =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    // ---- UI State ----
    private fun refresh() {
        val configured = prefs.isConfigured()
        b.status.text = if (configured) "Connected to Desktop" else "Not Paired"
        tintDot(if (configured) R.color.ok else R.color.dotGrey)
        b.pairState.text = if (configured) "Desktop: ${prefs.server}" else "Ready to pair — tap Scan QR below"
    }

    private fun tintDot(colorRes: Int) {
        b.statusDot.backgroundTintList =
            ColorStateList.valueOf(ContextCompat.getColor(this, colorRes))
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
