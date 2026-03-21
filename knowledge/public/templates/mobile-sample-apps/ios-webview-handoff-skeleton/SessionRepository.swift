import Foundation

final class SessionRepository: ObservableObject {
    @Published private(set) var currentURL = URL(string: "https://example.mobile.app/webview/login")!
    @Published private(set) var currentOrigin: String? = "https://example.mobile.app"
    @Published private(set) var cookies: [KyberionCookie] = []
    @Published private(set) var localStorage: [String: String] = [:]
    @Published private(set) var sessionStorage: [String: String] = [:]
    @Published private(set) var headers: [String: String] = [:]

    func rememberAuthenticatedState(
        url: URL,
        origin: String?,
        cookies: [KyberionCookie],
        localStorage: [String: String],
        sessionStorage: [String: String],
        headers: [String: String]
    ) {
        currentURL = url
        currentOrigin = origin
        self.cookies = cookies
        self.localStorage = localStorage
        self.sessionStorage = sessionStorage
        self.headers = headers
    }
}
