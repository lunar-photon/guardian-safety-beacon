package com.guardian.app

import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Posts JSON to the Guardian server. All calls are blocking; run off the main thread. */
class Uploader(private val prefs: Prefs) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun post(path: String, body: JSONObject): Boolean {
        val req = Request.Builder()
            .url(prefs.server + path)
            .addHeader("Authorization", "Bearer " + prefs.token)
            .post(body.toString().toRequestBody(JSON))
            .build()
        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            false
        }
    }

    fun ping(
        lat: Double?, lon: Double?, acc: Float?, speed: Float?, heading: Float?,
        battery: Int?, wifi: List<WifiAp>
    ): Boolean {
        val o = base()
        lat?.let { o.put("lat", it) }
        lon?.let { o.put("lon", it) }
        acc?.let { o.put("accuracy", it) }
        speed?.let { o.put("speed", it) }
        heading?.let { o.put("heading", it) }
        battery?.let { o.put("battery", it) }
        val arr = JSONArray()
        for (w in wifi) {
            arr.put(JSONObject().apply {
                put("ssid", w.ssid); put("bssid", w.bssid); put("rssi", w.rssi)
            })
        }
        o.put("wifi", arr)
        return post("/api/ping", o)
    }

    fun trigger(message: String, lat: Double?, lon: Double?): Boolean {
        val o = base()
        o.put("kind", "sos"); o.put("message", message)
        lat?.let { o.put("lat", it) }; lon?.let { o.put("lon", it) }
        return post("/api/trigger", o)
    }

    fun frame(jpeg: ByteArray, kind: String): Boolean {
        val o = base()
        o.put("kind", kind)
        o.put("image_b64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
        return post("/api/frame", o)
    }

    /** Exchange a pairing code for the token. Call after prefs.server is set.
     *  Returns true and stores token + server-assigned device id on success. */
    fun claim(code: String, name: String): Boolean {
        val body = JSONObject().apply {
            put("code", code.trim().uppercase()); put("name", name)
        }
        val req = Request.Builder()
            .url(prefs.server + "/api/pair/claim")       // no auth header for claim
            .post(body.toString().toRequestBody(JSON))
            .build()
        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return false
                val d = JSONObject(resp.body?.string() ?: "{}")
                prefs.token = d.optString("token")
                prefs.deviceId = d.optString("device_id", prefs.deviceId)
                prefs.name = d.optString("name", name)
                true
            }
        } catch (e: Exception) {
            false
        }
    }

    /** Poll the server for operator commands (snap / live_on / live_off / sos / ping_now). */
    fun fetchCommands(): List<JSONObject> {
        val url = prefs.server + "/api/commands?device_id=" + prefs.deviceId
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer " + prefs.token)
            .get()
            .build()
        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return emptyList()
                val arr = JSONObject(resp.body?.string() ?: "{}").optJSONArray("commands")
                    ?: return emptyList()
                (0 until arr.length()).map { arr.getJSONObject(it) }
            }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun base() = JSONObject().apply {
        put("device_id", prefs.deviceId)
        put("name", prefs.name)
        put("ts", System.currentTimeMillis() / 1000.0)
    }
}

data class WifiAp(val ssid: String, val bssid: String, val rssi: Int)
