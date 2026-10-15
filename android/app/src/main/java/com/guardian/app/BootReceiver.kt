package com.guardian.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts tracking after a reboot or app update, if it was running before. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = Prefs(context)
        if (prefs.running && prefs.isConfigured()) {
            GuardianService.start(context)
        }
    }
}
