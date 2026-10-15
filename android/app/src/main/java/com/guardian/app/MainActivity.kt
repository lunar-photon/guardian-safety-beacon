package com.guardian.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.guardian.app.databinding.ActivityMainBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs

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
                toast("Saved"); refresh()
            }
        }

        b.grant.setOnClickListener { requestAllPermissions() }
        b.battery.setOnClickListener { requestIgnoreBattery() }
        b.start.setOnClickListener {
            if (!prefs.isConfigured()) { toast("Pair first (scan a QR)"); return@setOnClickListener }
            if (!hasCore()) { requestAllPermissions(); return@setOnClickListener }
            GuardianService.start(this); refresh()
        }
        b.stop.setOnClickListener { GuardianService.stop(this); refresh() }
        b.sos.setOnClickListener { GuardianService.sos(this); toast("SOS sent") }

        refresh()
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
        prefs.server = "$scheme://$authority"       // e.g. http://192.168.1.5:8000
        b.server.setText(prefs.server)
        b.name.text?.toString()?.trim()?.takeIf { it.isNotBlank() }?.let { prefs.name = it }
        pairWithCode(code)
    }

    private fun pairWithCode(code: String) {
        toast("Pairing…")
        Thread {
            val ok = Uploader(prefs).claim(code, prefs.name)
            runOnUiThread {
                if (ok) { toast("Paired ✓"); b.code.setText(""); refresh() }
                else toast("Pairing failed — code wrong or expired")
            }
        }.start()
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
