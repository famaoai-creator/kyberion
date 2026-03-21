package com.example.mobile.session

class SessionRepository {
    data class CookieRecord(
        val name: String,
        val value: String,
        val domain: String,
        val secure: Boolean = true,
        val httpOnly: Boolean = true
    )

    var currentUrl: String = "https://example.mobile.app/webview/login"
        private set
    var currentOrigin: String? = "https://example.mobile.app"
        private set
    var cookies: List<CookieRecord> = emptyList()
        private set
    var localStorage: Map<String, String> = emptyMap()
        private set
    var sessionStorage: Map<String, String> = emptyMap()
        private set
    var headers: Map<String, String> = emptyMap()
        private set

    fun rememberAuthenticatedState(
        targetUrl: String,
        origin: String?,
        cookies: List<CookieRecord>,
        localStorage: Map<String, String>,
        sessionStorage: Map<String, String>,
        headers: Map<String, String>
    ) {
        this.currentUrl = targetUrl
        this.currentOrigin = origin
        this.cookies = cookies
        this.localStorage = localStorage
        this.sessionStorage = sessionStorage
        this.headers = headers
    }
}
