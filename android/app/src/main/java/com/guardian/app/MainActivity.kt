package com.guardian.app

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contracts.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.guardian.app.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private lateinit var prefs: Prefs

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            // after basic grants, ask for background location separately (Android requirement)
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        prefs = Prefs(this)

        b.server.setText(prefs.server)
        b.token.setText(prefs.token)
        b.name.setText(prefs.name)
        b.interval.setText(prefs.intervalSec.toString())

        b.save.setOnClickListener {
            prefs.server = b.server.text.toString().trim()
            prefs.name = b.name.text.toString().trim().ifBlank { "my phone" }
            prefs.intervalSec = b.interval.text.toString().toIntOrNull()?.coerceAtLeast(3) ?: 10
            val code = b.code.text.toString().trim()
            if (code.isNotEmpty()) {
                if (prefs.server.isBlank()) { toast("Enter the server URL first"); return@setOnClickListener }
                toast("Pairing…")
                Thread {
                    val ok = Uploader(prefs).claim(code, prefs.name)
                    runOnUiThread {
                        if (ok) { toast("Paired ✓"); b.code.setText(""); refresh() }
                        else toast("Pairing failed — code wrong or expired")
                    }
                }.start()
            } else {
                prefs.token = b.token.text.toString().trim()
                toast("Saved"); refresh()
            }
        }

        b.grant.setOnClickListener { requestAllPermissions() }
        b.battery.setOnClickListener { requestIgnoreBattery() }

        b.start.setOnClickListener {
            if (!prefs.isConfigured()) { toast("Set server + token first"); return@setOnClickListener }
            if (!hasCore()) { toast("Grant permissions first"); requestAllPermissions(); return@setOnClickListener }
            GuardianService.start(this); refresh()
        }
        b.stop.setOnClickListener { GuardianService.stop(this); refresh() }
        b.sos.setOnClickListener { GuardianService.sos(this); toast("SOS sent") }

        b.hideIcon.setOnClickListener { confirmHideIcon() }

        refresh()
    }

    private fun requestAllPermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.CAMERA
        )
        // Note: POST_NOTIFICATIONS is intentionally never requested (privacy).
        // The foreground service runs without it; on Android 13+ its notification
        // simply stays hidden.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms += Manifest.permission.NEARBY_WIFI_DEVICES
        }
        permLauncher.launch(perms.toTypedArray())
    }

    private fun hasCore(): Boolean =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Ask Android to exempt the app from battery optimization so background GPS isn't throttled. */
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

    private fun confirmHideIcon() {
        AlertDialog.Builder(this)
            .setTitle("Hide app icon?")
            .setMessage(
                "The launcher icon disappears and tracking keeps running. " +
                    "You can bring it back anytime from the \"Show icon\" button on the " +
                    "ongoing notification, or with \"Unhide app\" on the dashboard. Continue?"
            )
            .setPositiveButton("Hide") { _, _ ->
                packageManager.setComponentEnabledSetting(
                    ComponentName(this, "com.guardian.app.Launcher"),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP
                )
                toast("Icon hidden")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun refresh() {
        val running = prefs.running
        b.status.text = if (running) "● Tracking active" else "○ Stopped"
        b.permStatus.text = if (hasCore()) "Permissions: granted" else "Permissions: needed"
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
