import SwiftUI
import WebKit

struct WebViewScreen: UIViewRepresentable {
    @ObservedObject var sessionRepository: SessionRepository

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.load(URLRequest(url: sessionRepository.currentURL))

        sessionRepository.rememberAuthenticatedState(
            url: URL(string: "https://example.mobile.app/webview/home")!,
            origin: "https://example.mobile.app",
            cookies: [
                KyberionCookie(
                    name: "session",
                    value: "debug-ios-session-cookie",
                    domain: "example.mobile.app",
                    path: "/",
                    expires: nil,
                    httpOnly: true,
                    secure: true,
                    sameSite: "Lax"
                )
            ],
            localStorage: ["auth_state": "signed_in"],
            sessionStorage: ["handoff_ready": "true"],
            headers: ["authorization": "Bearer debug-ios-token"]
        )

        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
