package dev.kyberion.handoff

import java.io.File

interface KyberionHandoffExporter {
    fun exportWebViewSession(reason: String = "manual"): File
}

class DefaultKyberionHandoffExporter(
    private val handoffEnabled: () -> Boolean,
    private val stateReader: WebViewStateReader,
    private val storage: KyberionHandoffStorage,
    private val appId: String = "example-mobile-login-passkey"
) : KyberionHandoffExporter {

    override fun exportWebViewSession(reason: String): File {
        check(handoffEnabled()) { "Kyberion handoff is disabled" }

        val state = stateReader.readCurrentState()
        val payload = KyberionWebviewSessionHandoff(
            target_url = state.url,
            origin = state.origin,
            cookies = state.cookies,
            local_storage = state.localStorage,
            session_storage = state.sessionStorage,
            headers = state.headers + mapOf("x-kyberion-reason" to reason),
            source = mapOf(
                "platform" to "android",
                "app_id" to appId
            )
        )

        return storage.write(payload)
    }
}
