package com.guardian.app

import android.content.Context
import java.util.UUID

/** Simple persistent settings with support for pre-paired install configuration. */
class Prefs(private val ctx: Context) {
    private val sp = ctx.getSharedPreferences("guardian", Context.MODE_PRIVATE)

    private fun getResString(name: String): String {
        val id = ctx.resources.getIdentifier(name, "string", ctx.packageName)
        return if (id != 0) ctx.getString(id).trim() else ""
    }

    var server: String
        get() {
            val s = sp.getString("server", "") ?: ""
            if (s.isNotBlank()) return s
            return getResString("default_server_url")
        }
        set(v) = sp.edit().putString("server", v.trimEnd('/')).apply()

    var token: String
        get() {
            val t = sp.getString("token", "") ?: ""
            if (t.isNotBlank()) return t
            return getResString("default_device_token")
        }
        set(v) = sp.edit().putString("token", v).apply()

    var name: String
        get() {
            val n = sp.getString("name", "") ?: ""
            if (n.isNotBlank()) return n
            val defName = getResString("default_device_name")
            return defName.ifBlank { "my phone" }
        }
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
            if (id.isNullOrBlank()) {
                val defId = getResString("default_device_id")
                id = if (defId.isNotBlank()) defId else "and-" + UUID.randomUUID().toString().take(8)
                sp.edit().putString("device_id", id).apply()
            }
            return id
        }
        set(v) = sp.edit().putString("device_id", v).apply()

    fun isConfigured() = server.isNotBlank() && token.isNotBlank()
}
