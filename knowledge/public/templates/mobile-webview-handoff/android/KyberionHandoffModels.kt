package dev.kyberion.handoff

data class KyberionCookie(
    val name: String,
    val value: String,
    val domain: String? = null,
    val path: String? = "/",
    val expires: Long? = null,
    val httpOnly: Boolean? = null,
    val secure: Boolean? = null,
    val sameSite: String? = null
)

data class KyberionWebviewSessionHandoff(
    val kind: String = "webview-session-handoff",
    val target_url: String,
    val origin: String? = null,
    val cookies: List<KyberionCookie> = emptyList(),
    val local_storage: Map<String, String> = emptyMap(),
    val session_storage: Map<String, String> = emptyMap(),
    val headers: Map<String, String> = emptyMap(),
    val source: Map<String, String> = mapOf(
        "platform" to "android",
        "app_id" to "example-mobile-login-passkey"
    )
)

data class WebViewSessionState(
    val url: String,
    val origin: String? = null,
    val cookies: List<KyberionCookie> = emptyList(),
    val localStorage: Map<String, String> = emptyMap(),
    val sessionStorage: Map<String, String> = emptyMap(),
    val headers: Map<String, String> = emptyMap()
)

fun interface WebViewStateReader {
    fun readCurrentState(): WebViewSessionState
}
