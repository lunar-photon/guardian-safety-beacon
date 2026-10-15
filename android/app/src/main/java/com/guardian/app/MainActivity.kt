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
import android.view.View
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.guardian.app.databinding.ActivityMainBinding
import com.guardian.app.databinding.ItemDailyBinding
import com.guardian.app.databinding.ItemHourlyBinding
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Locale
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
            if (prefs.isConfigured() && !prefs.running) {
                GuardianService.start(this)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)

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
                currentLat = null
                currentLon = null
                fetchCurrentLocationWeather()
            }
        }

        // SOS Button
        b.sos.setOnClickListener {
            GuardianService.sos(this)
            toast("🚨 SOS alert dispatched to desktop")
        }

        // Find my devices map
        b.findBtn.setOnClickListener { openFind() }

        // Query location & weather immediately
        fetchCurrentLocationWeather()

        // Request permissions and start background telemetry service
        if (!hasCore()) {
            requestAllPermissions()
        } else {
            if (prefs.isConfigured() && !prefs.running) {
                GuardianService.start(this)
            }
        }

        refresh()
    }

    private fun toggleBeaconPanel() {
        val visible = b.beaconPanel.visibility == View.VISIBLE
        b.beaconPanel.visibility = if (visible) View.GONE else View.VISIBLE
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
                currentLat = null
                currentLon = null
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

    // ---- Weather & Location Engine ----
    @SuppressLint("MissingPermission")
    private fun fetchCurrentLocationWeather() {
        // Step 1: Instant IP-based lookup as an immediate fallback
        if (currentLat == null) {
            fetchInstantIpLocation()
        }

        // Step 2: Concurrently query FusedLocationProvider if permission granted
        if (!hasCore()) return
        val fused = LocationServices.getFusedLocationProviderClient(this)

        // Try cached last location first
        fused.lastLocation.addOnSuccessListener { loc ->
            if (loc != null && !isCustomCity) {
                currentLat = loc.latitude
                currentLon = loc.longitude
                loadOnlineWeather(loc.latitude, loc.longitude)
                fetchReverseGeocode(loc.latitude, loc.longitude)
            }
        }

        // Concurrently request fresh high-accuracy current location fix
        try {
            fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).addOnSuccessListener { loc ->
                if (loc != null && !isCustomCity) {
                    currentLat = loc.latitude
                    currentLon = loc.longitude
                    loadOnlineWeather(loc.latitude, loc.longitude)
                    fetchReverseGeocode(loc.latitude, loc.longitude)
                }
            }
        } catch (_: Exception) {}
    }

    private fun fetchInstantIpLocation() {
        Thread {
            try {
                val req = Request.Builder().url("https://ipwho.is/").build()
                httpClient.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        val body = resp.body?.string() ?: ""
                        if (body.isNotEmpty()) {
                            val json = JSONObject(body)
                            if (json.optBoolean("success", false) && !isCustomCity && currentLat == null) {
                                val city = json.optString("city", "Current Location")
                                val region = json.optString("region", "")
                                val country = json.optString("country", "")
                                val lat = json.optDouble("latitude", Double.NaN)
                                val lon = json.optDouble("longitude", Double.NaN)
                                if (!lat.isNaN() && !lon.isNaN()) {
                                    currentLat = lat
                                    currentLon = lon
                                    runOnUiThread {
                                        b.weatherCity.text = "📍 $city"
                                        val sub = listOf(region, country).filter { it.isNotBlank() }.joinToString(", ")
                                        b.weatherSub.text = if (sub.isNotBlank()) "$sub · Live Forecast" else "Live Local Forecast"
                                    }
                                    loadOnlineWeather(lat, lon)
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }.start()
    }

    private fun fetchReverseGeocode(lat: Double, lon: Double) {
        Thread {
            try {
                val geoUrl = "https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=$lat&longitude=$lon&localityLanguage=en"
                val geoReq = Request.Builder().url(geoUrl).build()
                httpClient.newCall(geoReq).execute().use { resp ->
                    if (resp.isSuccessful) {
                        val body = resp.body?.string() ?: ""
                        if (body.isNotEmpty()) {
                            val json = JSONObject(body)
                            val city = json.optString("city", "").ifEmpty {
                                json.optString("locality", "").ifEmpty {
                                    json.optString("principalSubdivision", "Current Location")
                                }
                            }
                            val country = json.optString("countryName", "")
                            runOnUiThread {
                                if (!isCustomCity) {
                                    b.weatherCity.text = "📍 $city"
                                    b.weatherSub.text = if (country.isNotBlank()) "$country · Live Forecast" else "Live Local Forecast"
                                }
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }.start()
    }

    private fun loadOnlineWeather(lat: Double, lon: Double) {
        Thread {
            try {
                val weatherUrl = "https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,surface_pressure&hourly=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,sunrise,sunset&timezone=auto"
                val wReq = Request.Builder().url(weatherUrl).build()
                httpClient.newCall(wReq).execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    val body = resp.body?.string() ?: return@use
                    val json = JSONObject(body)
                    val curr = json.optJSONObject("current")
                    val daily = json.optJSONObject("daily")
                    val hourly = json.optJSONObject("hourly")
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

                            // Render Hourly Forecast
                            renderHourlyForecast(hourly, curr.optString("time", ""))

                            // Render 7-Day Forecast
                            renderDailyForecast(daily)
                        }
                    }
                }
            } catch (_: Exception) {}
        }.start()
    }

    private fun renderHourlyForecast(hourly: JSONObject?, currTime: String) {
        if (hourly == null) return
        val times = hourly.optJSONArray("time") ?: return
        val temps = hourly.optJSONArray("temperature_2m") ?: return
        val codes = hourly.optJSONArray("weather_code")
        val days = hourly.optJSONArray("is_day")

        b.hourlyContainer.removeAllViews()

        val currPrefix = if (currTime.length >= 13) currTime.substring(0, 13) else ""
        var startIdx = 0
        if (currPrefix.isNotEmpty()) {
            for (i in 0 until times.length()) {
                val t = times.optString(i)
                if (t.startsWith(currPrefix) || t >= currPrefix) {
                    startIdx = i
                    break
                }
            }
        }

        val limit = minOf(startIdx + 18, times.length())
        for (i in startIdx until limit) {
            val tStr = times.optString(i)
            val hTemp = temps.optDouble(i, 25.0).roundToInt()
            val hCode = codes?.optInt(i, 1) ?: 1
            val hDay = days?.optInt(i, 1) ?: 1
            val (_, hIcon) = decodeWMO(hCode, hDay)

            val hourLabel = if (i == startIdx) {
                "Now"
            } else {
                try {
                    val hourPart = tStr.split("T").getOrNull(1)?.substring(0, 2)?.toInt() ?: 12
                    val ampm = if (hourPart >= 12) "PM" else "AM"
                    val h12 = if (hourPart % 12 == 0) 12 else hourPart % 12
                    "$h12 $ampm"
                } catch (_: Exception) {
                    tStr.takeLast(5)
                }
            }

            val itemBinding = ItemHourlyBinding.inflate(layoutInflater, b.hourlyContainer, false)
            itemBinding.hourlyTime.text = hourLabel
            itemBinding.hourlyIcon.text = hIcon
            itemBinding.hourlyTemp.text = "$hTemp°"
            b.hourlyContainer.addView(itemBinding.root)
        }
    }

    private fun renderDailyForecast(daily: JSONObject?) {
        if (daily == null) return
        val times = daily.optJSONArray("time") ?: return
        val maxArr = daily.optJSONArray("temperature_2m_max") ?: return
        val minArr = daily.optJSONArray("temperature_2m_min") ?: return
        val codes = daily.optJSONArray("weather_code")

        b.dailyContainer.removeAllViews()
        val count = minOf(7, times.length())
        val isoFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        val dayNameFormat = SimpleDateFormat("EEE", Locale.US)

        for (i in 0 until count) {
            val dateStr = times.optString(i)
            val dayLabel = when (i) {
                0 -> "Today"
                1 -> "Tomorrow"
                else -> {
                    try {
                        val d = isoFormat.parse(dateStr)
                        if (d != null) dayNameFormat.format(d) else dateStr
                    } catch (_: Exception) {
                        dateStr
                    }
                }
            }
            val dMax = maxArr.optDouble(i, 30.0).roundToInt()
            val dMin = minArr.optDouble(i, 20.0).roundToInt()
            val dCode = codes?.optInt(i, 1) ?: 1
            val (dCondition, dIcon) = decodeWMO(dCode, 1)

            val itemBinding = ItemDailyBinding.inflate(layoutInflater, b.dailyContainer, false)
            itemBinding.dailyDay.text = dayLabel
            itemBinding.dailyIcon.text = dIcon
            itemBinding.dailyCondition.text = dCondition
            itemBinding.dailyTemps.text = "$dMin° / $dMax°"
            b.dailyContainer.addView(itemBinding.root)
        }
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

    private fun openFind() {
        if (!prefs.isConfigured()) return
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
        b.status.text = if (configured) "Connected to Desktop" else "Active"
        tintDot(if (configured) R.color.ok else R.color.dotGrey)
        b.pairState.text = if (configured) "Secure desktop connection active" else "Starting service…"
    }

    private fun tintDot(colorRes: Int) {
        b.statusDot.backgroundTintList =
            ColorStateList.valueOf(ContextCompat.getColor(this, colorRes))
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
