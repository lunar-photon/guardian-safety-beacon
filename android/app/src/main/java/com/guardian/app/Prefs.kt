package com.guardian.app

import android.content.Context
import java.util.UUID

/** Simple persistent settings. */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("guardian", Context.MODE_PRIVATE)

    var server: String
        get() = sp.getString("server", "") ?: ""
        set(v) = sp.edit().putString("server", v.trimEnd('/')).apply()

    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) = sp.edit().putString("token", v).apply()

    var name: String
        get() = sp.getString("name", "my phone") ?: "my phone"
        set(v) = sp.edit().putString("name", v).apply()

    var intervalSec: Int
        get() = sp.getInt("interval", 10)
        set(v) = sp.edit().putInt("interval", v).apply()

    var running: Boolean
        get() = sp.getBoolean("running", false)
        set(v) = sp.edit().putBoolean("running", v).apply()

    var deviceId: String
        get() {
            var id = sp.getString("device_id", null)
            if (id == null) {
                id = "and-" + UUID.randomUUID().toString().take(8)
                sp.edit().putString("device_id", id).apply()
            }
            return id
        }
        set(v) = sp.edit().putString("device_id", v).apply()

    fun isConfigured() = server.isNotBlank() && token.isNotBlank()
}
