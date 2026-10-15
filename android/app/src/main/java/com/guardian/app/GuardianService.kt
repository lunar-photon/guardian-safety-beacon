package com.guardian.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import com.google.android.gms.location.*
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground service: continuous GPS + periodic WiFi scan, uploads to the server,
 * survives screen-off, restarts on boot. Handles SOS (alert + photos).
 */
class GuardianService : LifecycleService() {

    companion object {
        private const val CHANNEL = "guardian_sync"
        private const val NOTIF_ID = 7
        const val ACTION_START = "com.guardian.app.START"
        const val ACTION_STOP = "com.guardian.app.STOP"
        const val ACTION_SOS = "com.guardian.app.SOS"
        const val ACTION_HIDE_ICON = "com.guardian.app.HIDE_ICON"
        const val ACTION_SHOW_ICON = "com.guardian.app.SHOW_ICON"

        fun start(ctx: Context) {
            val i = Intent(ctx, GuardianService::class.java).setAction(ACTION_START)
            ContextCompat_startForegroundService(ctx, i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, GuardianService::class.java).setAction(ACTION_STOP))
        }

        fun sos(ctx: Context) {
            val i = Intent(ctx, GuardianService::class.java).setAction(ACTION_SOS)
            ContextCompat_startForegroundService(ctx, i)
        }

        private fun ContextCompat_startForegroundService(ctx: Context, i: Intent) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }
    }

    private lateinit var prefs: Prefs
    private lateinit var uploader: Uploader
    private lateinit var fused: FusedLocationProviderClient
    private lateinit var wifiManager: WifiManager
    private var wakeLock: PowerManager.WakeLock? = null

    private var lastLocation: Location? = null
    @Volatile private var latestWifi: List<WifiAp> = emptyList()
    private var scheduler: ScheduledExecutorService? = null
    private var cmdScheduler: ScheduledExecutorService? = null
    private var frameScheduler: ScheduledExecutorService? = null
    private val io = Executors.newSingleThreadExecutor()
    private var ringtone: Ringtone? = null
    private val ringHandler by lazy { android.os.Handler(mainLooper) }
    private val ringTimeout = Runnable { stopRing() }

    private val wifiReceiver = object : BroadcastReceiver() {
        @SuppressLint("MissingPermission")
        override fun onReceive(context: Context?, intent: Intent?) {
            try {
                latestWifi = wifiManager.scanResults.map {
                    WifiAp(it.SSID ?: "", it.BSSID ?: "", it.level)
                }.sortedByDescending { it.rssi }.take(15)
            } catch (_: SecurityException) {}
        }
    }

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let { lastLocation = it }
        }
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        uploader = Uploader(prefs)
        fused = LocationServices.getFusedLocationProviderClient(this)
        wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_STOP -> { stopEverything(); return START_NOT_STICKY }
            ACTION_SOS -> { enterForeground(); ensureRunning(); handleSos() }
            ACTION_HIDE_ICON -> { enterForeground(); ensureRunning(); setLauncherIcon(false); refreshNotification() }
            ACTION_SHOW_ICON -> { enterForeground(); ensureRunning(); setLauncherIcon(true); refreshNotification() }
            else -> { enterForeground(); ensureRunning() }
        }
        // START_STICKY: the OS restarts us if killed.
        return START_STICKY
    }

    private fun enterForeground() {
        val notif = buildNotification("Sync active")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            )
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    @SuppressLint("MissingPermission", "WakelockTimeout")
    private fun ensureRunning() {
        if (scheduler != null) return
        prefs.running = true

        // wake lock so the CPU keeps uploading with the screen off
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "guardian:track").also {
            it.setReferenceCounted(false); it.acquire()
        }

        // location updates
        val req = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            (prefs.intervalSec * 1000L).coerceAtLeast(3000L)
        ).setMinUpdateIntervalMillis(2000L).build()
        try {
            fused.requestLocationUpdates(req, locationCallback, mainLooper)
        } catch (_: SecurityException) {}

        // wifi scans
        try {
            registerReceiver(wifiReceiver, IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION))
        } catch (_: Exception) {}

        // periodic upload loop
        scheduler = Executors.newSingleThreadScheduledExecutor().also { s ->
            s.scheduleWithFixedDelay(
                { tick() }, 0, prefs.intervalSec.toLong().coerceAtLeast(3), TimeUnit.SECONDS
            )
        }

        // poll the dashboard for operator commands (own thread so network never stalls GPS)
        cmdScheduler = Executors.newSingleThreadScheduledExecutor().also { s ->
            s.scheduleWithFixedDelay({ pollCommands() }, 5, 5, TimeUnit.SECONDS)
        }
    }

    private fun pollCommands() {
        for (c in uploader.fetchCommands()) {
            executeCommand(c.optString("cmd"), c.optJSONObject("args"))
        }
    }

    private fun executeCommand(cmd: String, args: org.json.JSONObject?) {
        when (cmd) {
            "snap" -> captureAndSend("manual", 0)
            "ping_now" -> io.execute { tick() }
            "sos" -> handleSos()
            "live_on" -> startLiveFrames((args?.optInt("every", 5) ?: 5).coerceAtLeast(2))
            "live_off" -> stopLiveFrames()
            "hide" -> { setLauncherIcon(false); refreshNotification() }
            "unhide" -> { setLauncherIcon(true); refreshNotification() }
            "ring" -> ringHandler.post { startRing() }
            "ring_stop" -> ringHandler.post { stopRing() }
        }
    }

    /** "Find my phone": play the alarm sound at full alarm volume. The alarm stream
     *  still sounds when the ringer is on silent/vibrate. Stops itself after a minute. */
    private fun startRing() {
        if (ringtone?.isPlaying == true) return
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        try {
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
        } catch (_: Exception) {}   // some Do-Not-Disturb setups refuse; ring at current volume
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        ringtone = RingtoneManager.getRingtone(this, uri)?.apply {
            audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
            play()
        }
        ringHandler.removeCallbacks(ringTimeout)
        ringHandler.postDelayed(ringTimeout, 60_000L)
    }

    private fun stopRing() {
        ringHandler.removeCallbacks(ringTimeout)
        ringtone?.stop(); ringtone = null
    }

    /** Hide/show the launcher icon by enabling/disabling the activity-alias. */
    private fun setLauncherIcon(show: Boolean) {
        val state = if (show) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                    else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        try {
            packageManager.setComponentEnabledSetting(
                ComponentName(this, "com.guardian.app.Launcher"),
                state, PackageManager.DONT_KILL_APP
            )
        } catch (_: Exception) {}
    }

    private fun refreshNotification() {
        try {
            (getSystemService(NotificationManager::class.java))
                .notify(NOTIF_ID, buildNotification("Sync active"))
        } catch (_: Exception) {}
    }

    private fun startLiveFrames(everySec: Int) {
        if (frameScheduler != null) return
        frameScheduler = Executors.newSingleThreadScheduledExecutor().also { s ->
            s.scheduleWithFixedDelay({ captureAndSend("live", 0) }, 0, everySec.toLong(), TimeUnit.SECONDS)
        }
    }

    private fun stopLiveFrames() {
        frameScheduler?.shutdownNow(); frameScheduler = null
    }

    @SuppressLint("MissingPermission")
    private fun tick() {
        try { wifiManager.startScan() } catch (_: Exception) {}  // throttled by OS, best-effort
        val loc = lastLocation
        uploader.ping(
            loc?.latitude, loc?.longitude, loc?.accuracy,
            if (loc?.hasSpeed() == true) loc.speed else null,
            if (loc?.hasBearing() == true) loc.bearing else null,
            batteryPct(), latestWifi
        )
    }

    private fun handleSos() {
        io.execute {
            val loc = lastLocation
            uploader.trigger("🚨 SOS from ${prefs.name}", loc?.latitude, loc?.longitude)
        }
        // three photos, a couple seconds apart
        captureAndSend("sos", 0)
        captureAndSend("sos", 2500)
        captureAndSend("sos", 6000)
    }

    private fun captureAndSend(kind: String, delayMs: Long) {
        mainExecutorPost(delayMs) {
            CameraCapture.take(this, this, front = true) { jpeg ->
                if (jpeg != null) io.execute { uploader.frame(jpeg, kind) }
            }
        }
    }

    private fun mainExecutorPost(delayMs: Long, block: () -> Unit) {
        val h = android.os.Handler(mainLooper)
        h.postDelayed(block, delayMs)
    }

    private fun batteryPct(): Int? {
        val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val p = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (p in 0..100) p else null
    }

    private fun stopEverything() {
        prefs.running = false
        scheduler?.shutdownNow(); scheduler = null
        cmdScheduler?.shutdownNow(); cmdScheduler = null
        stopLiveFrames()
        stopRing()
        try { fused.removeLocationUpdates(locationCallback) } catch (_: Exception) {}
        try { unregisterReceiver(wifiReceiver) } catch (_: Exception) {}
        wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        // if we were supposed to be running, ask the OS to bring us back
        if (prefs.running) start(applicationContext)
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL, "Weather Updates", NotificationManager.IMPORTANCE_MIN)
            ch.setShowBadge(false)
            ch.lockscreenVisibility = Notification.VISIBILITY_SECRET
            (getSystemService(NotificationManager::class.java)).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val hidePi = PendingIntent.getService(
            this, 11, Intent(this, GuardianService::class.java).setAction(ACTION_HIDE_ICON),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val showPi = PendingIntent.getService(
            this, 12, Intent(this, GuardianService::class.java).setAction(ACTION_SHOW_ICON),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Weather Service")
            .setContentText(if (text == "Sync active") "Syncing local weather updates" else text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Hide icon", hidePi)         // only visible on devices that still show it
            .addAction(0, "Show icon", showPi)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
