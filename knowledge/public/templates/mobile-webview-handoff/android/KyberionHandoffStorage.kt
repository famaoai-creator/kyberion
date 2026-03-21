package dev.kyberion.handoff

import android.content.Context
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class KyberionHandoffStorage(
    private val context: Context,
    private val json: Json,
    private val mirrorPath: String? = "/sdcard/kyberion/example-mobile-login-passkey/webview-session.json"
) {
    fun write(payload: KyberionWebviewSessionHandoff): File {
        val baseDir = File(context.filesDir, "kyberion").apply { mkdirs() }
        val output = File(baseDir, "webview-session.json")
        output.writeText(json.encodeToString(payload))

        mirrorPath?.let { path ->
            val mirror = File(path)
            mirror.parentFile?.mkdirs()
            mirror.writeText(json.encodeToString(payload))
        }

        return output
    }
}
