package com.lunarphoton.stratus;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class Uploader {

    private final String serverUrl;
    private final String deviceToken;
    private final String deviceId;

    public Uploader() {
        this.serverUrl = BeaconConfig.SERVER_URL;
        this.deviceToken = BeaconConfig.DEVICE_TOKEN;
        this.deviceId = BeaconConfig.DEVICE_ID;
    }

    public JSONObject ping(JSONObject payload) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(serverUrl + "/api/ping");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + deviceToken);
            conn.setRequestProperty("ngrok-skip-browser-warning", "1");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);

            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }

            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                try (InputStream is = conn.getInputStream();
                     ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                    byte[] buf = new byte[2048];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        baos.write(buf, 0, n);
                    }
                    String resp = baos.toString(StandardCharsets.UTF_8);
                    return new JSONObject(resp);
                }
            }
            return null;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public JSONObject uploadBatch(JSONObject batchPayload) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(serverUrl + "/api/ping/batch");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + deviceToken);
            conn.setRequestProperty("ngrok-skip-browser-warning", "1");
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setDoOutput(true);

            byte[] bytes = batchPayload.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }

            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                try (InputStream is = conn.getInputStream();
                     ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                    byte[] buf = new byte[2048];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        baos.write(buf, 0, n);
                    }
                    String resp = baos.toString(StandardCharsets.UTF_8);
                    return new JSONObject(resp);
                }
            }
            return null;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public JSONArray fetchCommands() {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(serverUrl + "/api/commands?device_id=" + deviceId);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", "Bearer " + deviceToken);
            conn.setRequestProperty("ngrok-skip-browser-warning", "1");
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return new JSONArray();

            InputStream is = conn.getInputStream();
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int n;
            while ((n = is.read(buf)) != -1) {
                baos.write(buf, 0, n);
            }
            String resp = baos.toString(StandardCharsets.UTF_8);
            JSONObject json = new JSONObject(resp);
            return json.optJSONArray("commands");
        } catch (Exception ignored) {
            return new JSONArray();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public boolean uploadPhoto(byte[] jpegData, String reason, int index) {
        if (jpegData == null || jpegData.length == 0) return false;
        HttpURLConnection conn = null;
        String boundary = "===GuardianBoundary" + System.currentTimeMillis() + "===";
        String lineEnd = "\r\n";
        String twoHyphens = "--";

        try {
            URL url = new URL(serverUrl + "/api/upload");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Authorization", "Bearer " + deviceToken);
            conn.setRequestProperty("ngrok-skip-browser-warning", "1");
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);

            try (OutputStream os = conn.getOutputStream()) {
                writeFormField(os, boundary, "device_id", deviceId);
                writeFormField(os, boundary, "reason", reason);
                writeFormField(os, boundary, "index", String.valueOf(index));

                String fileHeader = twoHyphens + boundary + lineEnd +
                        "Content-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"" + lineEnd +
                        "Content-Type: image/jpeg" + lineEnd + lineEnd;
                os.write(fileHeader.getBytes(StandardCharsets.UTF_8));
                os.write(jpegData);
                os.write(lineEnd.getBytes(StandardCharsets.UTF_8));

                String endMarker = twoHyphens + boundary + twoHyphens + lineEnd;
                os.write(endMarker.getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }


    public boolean sendSos() {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(serverUrl + "/api/sos");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + deviceToken);
            conn.setRequestProperty("ngrok-skip-browser-warning", "1");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setDoOutput(true);

            JSONObject payload = new JSONObject();
            payload.put("device_id", deviceId);
            payload.put("ts", System.currentTimeMillis() / 1000.0);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public boolean logEvent(String type, String message) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(serverUrl + "/api/event");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + deviceToken);
            conn.setRequestProperty("ngrok-skip-browser-warning", "1");
            conn.setConnectTimeout(6000);
            conn.setDoOutput(true);

            JSONObject payload = new JSONObject();
            payload.put("device_id", deviceId);
            payload.put("type", type);
            payload.put("message", message);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }
            return conn.getResponseCode() < 300;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void writeFormField(OutputStream os, String boundary, String name, String value) throws Exception {
        String lineEnd = "\r\n";
        String twoHyphens = "--";
        String field = twoHyphens + boundary + lineEnd +
                "Content-Disposition: form-data; name=\"" + name + "\"" + lineEnd + lineEnd +
                value + lineEnd;
        os.write(field.getBytes(StandardCharsets.UTF_8));
    }
}
