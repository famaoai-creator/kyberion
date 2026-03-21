package com.example.mobile.handoff

import com.example.mobile.session.SessionRepository
import dev.kyberion.handoff.KyberionCookie
import dev.kyberion.handoff.WebViewSessionState
import dev.kyberion.handoff.WebViewStateReader

class AndroidWebViewStateReader(
    private val sessionRepository: SessionRepository
) : WebViewStateReader {
    override fun readCurrentState(): WebViewSessionState {
        return WebViewSessionState(
            url = sessionRepository.currentUrl,
            origin = sessionRepository.currentOrigin,
            cookies = sessionRepository.cookies.map { cookie ->
                KyberionCookie(
                    name = cookie.name,
                    value = cookie.value,
                    domain = cookie.domain,
                    secure = cookie.secure,
                    httpOnly = cookie.httpOnly
                )
            },
            localStorage = sessionRepository.localStorage,
            sessionStorage = sessionRepository.sessionStorage,
            headers = sessionRepository.headers
        )
    }
}
