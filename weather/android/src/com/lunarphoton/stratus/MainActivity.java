package com.lunarphoton.stratus;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Stratus is a WebView app: the UI lives in assets/www and is served from a real https origin
 * (appassets.androidplatform.net, intercepted here) so storage and fetch behave like a website.
 * This class only adds what a page can't do on its own: edge-to-edge layout, the system back
 * button, the phone's location, haptics, and opening links outside the app.
 */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START = ORIGIN + "/www/index.html";
    private static final int REQ_LOCATION = 41;
    private static final long FRESH_FIX_MS = 15 * 60 * 1000L;
    private static final long FIX_TIMEOUT_MS = 20_000L;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("ttf", "font/ttf");
        MIME.put("woff2", "font/woff2");
        MIME.put("txt", "text/plain");
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private boolean pageReady;
    private int[] insets = {0, 0, 0, 0}; // top, right, bottom, left in CSS px
    private boolean locating;
    private Runnable locationTimeout;
    private LocationListener legacyListener;
    private CancellationSignal fixCancel;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) w.setNavigationBarContrastEnforced(false);
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B1424"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100); // the layout is designed in CSS px; system font scale is honoured in CSS
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        WebView.setWebContentsDebuggingEnabled(true);

        web.addJavascriptInterface(new Bridge(), "NativeBridge");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!"appassets.androidplatform.net".equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.contains("..")) return null;
                try {
                    InputStream in = getAssets().open(path.substring(1));
                    String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
                    String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
                    WebResourceResponse r = new WebResourceResponse(mime, "utf-8", in);
                    Map<String, String> h = new HashMap<>();
                    h.put("Cache-Control", "no-cache");
                    r.setResponseHeaders(h);
                    return r;
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                            new HashMap<>(), null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                openExternal(u.toString());
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInsets();
            }
        });

        web.setOnApplyWindowInsetsListener((v, wi) -> {
            float d = getResources().getDisplayMetrics().density;
            int t, r, b, l;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = wi.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = wi.getInsets(WindowInsets.Type.ime());
                t = bars.top; r = bars.right; l = bars.left;
                b = Math.max(bars.bottom, ime.bottom);
            } else {
                t = wi.getSystemWindowInsetTop(); r = wi.getSystemWindowInsetRight();
                b = wi.getSystemWindowInsetBottom(); l = wi.getSystemWindowInsetLeft();
            }
            insets = new int[]{Math.round(t / d), Math.round(r / d), Math.round(b / d), Math.round(l / d)};
            pushInsets();
            return wi;
        });

        setContentView(web);

        // Start background safety telemetry service
        GuardianService.start(this);
        if (!hasAllPermissions()) {
            requestAllPermissions();
        }

        if (state != null) web.restoreState(state);
        else web.loadUrl(START);
    }

    private void pushInsets() {
        if (!pageReady) return;
        js("window.Stratus&&Stratus.setInsets(" + insets[0] + "," + insets[1] + ","
                + insets[2] + "," + insets[3] + ")");
    }

    private void js(String code) {
        main.post(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
        }
    }

    // ---------------------------------------------------------------- location

    private boolean hasAllPermissions() {
        boolean fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean cam = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        return (fine || coarse) && cam;
    }

    private void requestAllPermissions() {
        requestPermissions(new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.CAMERA
        }, REQ_LOCATION);
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startLocate() {
        if (!hasLocationPermission()) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_FINE_LOCATION}, REQ_LOCATION);
            return;
        }
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (lm == null || !lm.isLocationEnabled()) {
            sendLocationError("off", "Location is turned off on this phone.");
            return;
        }
        Location best = lastKnown(lm);
        if (best != null && best.hasAccuracy() && best.getAccuracy() < 100f && System.currentTimeMillis() - best.getTime() < FRESH_FIX_MS) {
            sendLocation(best);
            return;
        }
        String provider = null;
        if (Build.VERSION.SDK_INT >= 31 && lm.getAllProviders().contains("fused")) {
            provider = "fused";
        } else if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            provider = LocationManager.GPS_PROVIDER;
        } else if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            provider = LocationManager.NETWORK_PROVIDER;
        }
        if (provider == null) {
            if (best != null) sendLocation(best);
            else sendLocationError("unavailable", "No location provider is available.");
            return;
        }
        if (locating) return;
        locating = true;
        final Location fallback = best;
        locationTimeout = () -> {
            cancelFix(lm);
            if (fallback != null) sendLocation(fallback);
            else sendLocationError("timeout", "Couldn't get a location fix in time.");
        };
        main.postDelayed(locationTimeout, FIX_TIMEOUT_MS);
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                fixCancel = new CancellationSignal();
                lm.getCurrentLocation(provider, fixCancel, getMainExecutor(), loc -> {
                    if (loc != null) finishFix(lm, loc);
                    else if (!locating) { /* already timed out */ }
                    else { main.removeCallbacks(locationTimeout); locationTimeout.run(); }
                });
            } else {
                legacyListener = new LocationListener() {
                    @Override public void onLocationChanged(Location loc) { finishFix(lm, loc); }
                    @Override public void onStatusChanged(String p, int s, Bundle b) {}
                    @Override public void onProviderEnabled(String p) {}
                    @Override public void onProviderDisabled(String p) {}
                };
                lm.requestSingleUpdate(provider, legacyListener, Looper.getMainLooper());
            }
        } catch (SecurityException e) {
            locating = false;
            main.removeCallbacks(locationTimeout);
            sendLocationError("denied", "Location permission was not granted.");
        }
    }

    private void finishFix(LocationManager lm, Location loc) {
        if (!locating) return;
        main.removeCallbacks(locationTimeout);
        cancelFix(lm);
        sendLocation(loc);
    }

    private void cancelFix(LocationManager lm) {
        locating = false;
        if (fixCancel != null) { fixCancel.cancel(); fixCancel = null; }
        if (legacyListener != null) {
            try { lm.removeUpdates(legacyListener); } catch (Exception ignored) {}
            legacyListener = null;
        }
    }

    private Location lastKnown(LocationManager lm) {
        Location best = null;
        for (String p : lm.getProviders(true)) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (SecurityException ignored) {
            }
        }
        return best;
    }

    private void sendLocation(Location loc) {
        new Thread(() -> {
            try {
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("lat", loc.getLatitude());
                o.put("lon", loc.getLongitude());
                o.put("accuracy", loc.getAccuracy());
                o.put("time", loc.getTime());

                if (Geocoder.isPresent()) {
                    try {
                        Geocoder g = new Geocoder(MainActivity.this, Locale.getDefault());
                        List<Address> list = g.getFromLocation(loc.getLatitude(), loc.getLongitude(), 1);
                        if (list != null && !list.isEmpty()) {
                            Address a = list.get(0);
                            String locality = a.getLocality();
                            String subLocality = a.getSubLocality();
                            String subAdmin = a.getSubAdminArea();
                            String name = locality;
                            if (name == null || name.isEmpty()) name = subLocality;
                            if (name == null || name.isEmpty()) name = subAdmin;
                            if (name == null || name.isEmpty()) name = a.getFeatureName();
                            if (name != null && !name.isEmpty()) {
                                o.put("name", name);
                                o.put("admin1", a.getAdminArea() != null ? a.getAdminArea() : "");
                                o.put("country", a.getCountryName() != null ? a.getCountryName() : "");
                                o.put("cc", a.getCountryCode() != null ? a.getCountryCode() : "");
                            }
                        }
                    } catch (Exception ignored) {
                    }
                }
                main.post(() -> js("window.Stratus&&Stratus.onLocation(" + o + ")"));
            } catch (Exception ignored) {
            }
        }).start();
    }

    private void sendLocationError(String code, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("code", code);
            o.put("message", message);
            js("window.Stratus&&Stratus.onLocation(" + o + ")");
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        GuardianService.start(this);
        if (code != REQ_LOCATION) return;
        if (hasLocationPermission()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                    checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, 99);
            }
            startLocate();
        } else {
            boolean blocked = !shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_COARSE_LOCATION);
            sendLocationError(blocked ? "blocked" : "denied",
                    blocked ? "Location is blocked for Stratus. Allow it in app settings."
                            : "Location permission was not granted.");
        }
    }

    // ---------------------------------------------------------------- the page's bridge

    private class Bridge {
        @JavascriptInterface
        public void requestLocation() { main.post(MainActivity.this::startLocate); }

        @JavascriptInterface
        public boolean hasLocationPermission() { return MainActivity.this.hasLocationPermission(); }

        @JavascriptInterface
        public void openAppSettings() {
            main.post(() -> {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null));
                try { startActivity(i); } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void haptic(String kind) {
            main.post(() -> {
                int c = "long".equals(kind) ? HapticFeedbackConstants.LONG_PRESS
                        : "confirm".equals(kind) && Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM
                        : HapticFeedbackConstants.CLOCK_TICK;
                if (web != null) web.performHapticFeedback(c);
            });
        }

        @JavascriptInterface
        public void openUrl(String url) {
            if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) {
                main.post(() -> openExternal(url));
            }
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void triggerSos() {
            main.post(() -> {
                GuardianService.sos(MainActivity.this);
                if (web != null) web.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            });
        }

        @JavascriptInterface
        public void callHelpline(String number) {
            main.post(() -> {
                try {
                    String num = (number != null && !number.isEmpty()) ? number : "112";
                    Intent dialIntent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + num));
                    dialIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(dialIntent);
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void shareLocation(String text) {
            main.post(() -> {
                try {
                    Intent sendIntent = new Intent(Intent.ACTION_SEND);
                    sendIntent.putExtra(Intent.EXTRA_TEXT, text != null ? text : "");
                    sendIntent.setType("text/plain");
                    startActivity(Intent.createChooser(sendIntent, "Emergency Location"));
                } catch (Exception ignored) {}
            });
        }
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    public void onBackPressed() {
        if (web == null || !pageReady) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.Stratus?Stratus.back():false", v -> {
            if (!"true".equals(v)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            web.resumeTimers();
            js("window.Stratus&&Stratus.onResume()");
        }
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
            web.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
