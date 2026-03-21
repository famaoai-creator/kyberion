package com.example.mobile.handoff

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.example.mobile.ExampleApplication

class DebugHandoffReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_EXPORT_WEBVIEW_SESSION) return

        val app = context.applicationContext as ExampleApplication
        val reason = intent.getStringExtra(EXTRA_REASON) ?: "adb_broadcast"
        app.handoffExporter.exportWebViewSession(reason)
    }

    companion object {
        const val ACTION_EXPORT_WEBVIEW_SESSION = "com.kyberion.debug.EXPORT_WEBVIEW_SESSION"
        const val EXTRA_REASON = "reason"
    }
}
