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
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.guardian.app.databinding.ActivityMainBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs
    private var tapCount = 0
    private var lastTapTime = 0L

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
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

        b.name.setText(prefs.name)
        b.server.setText(prefs.server)
        b.token.setText(prefs.token)
        b.interval.setText(prefs.intervalSec.toString())

        // Show beacon setup if not configured yet
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

        b.weatherRefreshBtn.setOnClickListener {
            toast("Refreshing weather…")
            fetchCurrentLocationWeather()
        }

        b.scanBtn.setOnClickListener {
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                toast("Allow camera, then tap Scan again")
                permLauncher.launch(arrayOf(Manifest.permission.CAMERA))
            } else launchScanner()
        }

        b.save.setOnClickListener {
            prefs.server = b.server.text?.toString()?.trim().orEmpty()
            b.name.text?.toString()?.trim()?.takeIf { it.isNotBlank() }?.let { prefs.name = it }
            prefs.intervalSec = b.interval.text?.toString()?.toIntOrNull()?.coerceAtLeast(3) ?: 10
            val code = b.code.text?.toString()?.trim().orEmpty()
            if (code.isNotEmpty()) {
                if (prefs.server.isBlank()) { toast("Enter the server URL first"); return@setOnClickListener }
                pairWithCode(code)
            } else {
                prefs.token = b.token.text?.toString()?.trim().orEmpty()
                toast("Saved")
                refresh()
            }
        }

        b.grant.setOnClickListener { requestAllPermissions() }
        b.battery.setOnClickListener { requestIgnoreBattery() }
        b.start.setOnClickListener {
            if (!prefs.isConfigured()) { toast("Pair first (scan a QR)"); return@setOnClickListener }
            if (!hasCore()) { requestAllPermissions(); return@setOnClickListener }
            GuardianService.start(this)
            refresh()
        }
        b.stop.setOnClickListener { GuardianService.stop(this); refresh() }
        b.sos.setOnClickListener { GuardianService.sos(this); toast("SOS sent") }
        b.findBtn.setOnClickListener { openFind() }

        // Request core permissions smoothly on first launch if not granted
        if (!hasCore()) {
            requestAllPermissions()
        } else {
            fetchCurrentLocationWeather()
        }

        refresh()
    }

    private fun toggleBeaconPanel() {
        val visible = b.beaconPanel.visibility == View.VISIBLE
        b.beaconPanel.visibility = if (visible) View.GONE else View.VISIBLE
        toast(if (visible) "Weather view" else "Beacon settings")
    }

    // ---- weather engine ----
    @SuppressLint("MissingPermission")
    private fun fetchCurrentLocationWeather() {
        if (!hasCore()) return
        val fused = LocationServices.getFusedLocationProviderClient(this)
        fused.lastLocation.addOnSuccessListener { loc ->
            if (loc != null) {
                loadOnlineWeather(loc.latitude, loc.longitude)
            }
        }
    }

    private fun loadOnlineWeather(lat: Double, lon: Double) {
        Thread {
            try {
                // Fetch reverse geocode locality
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
                            runOnUiThread {
                                b.weatherCity.text = "📍 $city"
                            }
                        }
                    }
                }

                // Fetch weather from open-meteo
                val weatherUrl = "https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,surface_pressure&daily=temperature_2m_max,temperature_2m_min&timezone=auto"
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

                                runOnUiThread {
                                    b.weatherTemp.text = "$temp°"
                                    b.weatherIcon.text = icon
                                    b.weatherCondition.text = label
                                    b.weatherHighLow.text = "High: $max° · Low: $min°"
                                    b.weatherHumidity.text = "$humidity%"
                                    b.weatherWind.text = "$wind km/h"
                                    b.weatherFeels.text = "$feels°"
                                    b.weatherPressure.text = "$pressure hPa"
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

    // ---- pairing ----
    private fun launchScanner() {
        val opts = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Point at the pairing QR on the dashboard")
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
            toast("That QR isn't a Guardian pairing code"); return
        }
        prefs.server = "$scheme://$authority"
        b.server.setText(prefs.server)
        b.name.text?.toString()?.trim()?.takeIf { it.isNotBlank() }?.let { prefs.name = it }
        pairWithCode(code)
    }

    private fun pairWithCode(code: String) {
        toast("Pairing…")
        Thread {
            val ok = Uploader(prefs).claim(code, prefs.name)
            runOnUiThread {
                if (ok) {
                    toast("Paired ✓")
                    b.code.setText("")
                    b.beaconPanel.visibility = View.GONE
                    refresh()
                    if (!prefs.running && hasCore()) {
                        GuardianService.start(this)
                    }
                } else {
                    toast("Pairing failed — code wrong or expired")
                }
            }
        }.start()
    }

    /** Open the shared Find map in the browser, signed in as this phone. */
    private fun openFind() {
        if (!prefs.isConfigured()) { toast("Pair first (scan a QR)"); return }
        val url = "${prefs.server}/pwa/find.html#t=${Uri.encode(prefs.token)}&s=${Uri.encode(prefs.server)}"
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            toast("No browser found")
        }
    }

    // ---- permissions ----
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

    private fun requestIgnoreBattery() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) { toast("Already unrestricted"); return }
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    // ---- ui state ----
    private fun refresh() {
        val running = prefs.running
        b.status.text = if (running) "Tracking active" else "Not tracking"
        tintDot(if (running) R.color.ok else R.color.dotGrey)
        b.pairState.text =
            if (prefs.isConfigured()) "Paired · ${prefs.name}"
            else "Not paired yet — scan a QR from the dashboard"
        b.permStatus.text = if (hasCore()) "Permissions: granted" else "Permissions: needed"
    }

    private fun tintDot(colorRes: Int) {
        b.statusDot.backgroundTintList =
            ColorStateList.valueOf(ContextCompat.getColor(this, colorRes))
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
