package com.example.mobile

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import com.example.mobile.session.SessionRepository

class WebViewLoginActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val webView = WebView(this)
        setContentView(webView)

        val repo = (application as ExampleApplication).sessionRepository
        webView.settings.javaScriptEnabled = true
        webView.loadUrl(repo.currentUrl)

        repo.rememberAuthenticatedState(
            targetUrl = "https://example.mobile.app/webview/home",
            origin = "https://example.mobile.app",
            cookies = listOf(
                SessionRepository.CookieRecord(
                    name = "session",
                    value = "debug-session-cookie",
                    domain = "example.mobile.app",
                    secure = true,
                    httpOnly = true
                )
            ),
            localStorage = mapOf("auth_state" to "signed_in"),
            sessionStorage = mapOf("handoff_ready" to "true"),
            headers = mapOf("authorization" to "Bearer debug-mobile-token")
        )
    }
}
