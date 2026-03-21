package dev.kyberion.handoff

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class KyberionHandoffTriggerReceiver(
    private val resolveExporter: (Context) -> KyberionHandoffExporter
) : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_EXPORT_WEBVIEW_SESSION) return

        val reason = intent.getStringExtra(EXTRA_REASON) ?: "adb_broadcast"
        resolveExporter(context).exportWebViewSession(reason = reason)
    }

    companion object {
        const val ACTION_EXPORT_WEBVIEW_SESSION = "com.kyberion.debug.EXPORT_WEBVIEW_SESSION"
        const val EXTRA_REASON = "reason"
    }
}
