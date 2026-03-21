import Foundation

struct KyberionCookie: Codable {
    let name: String
    let value: String
    let domain: String?
    let path: String?
    let expires: Int?
    let httpOnly: Bool?
    let secure: Bool?
    let sameSite: String?
}

struct KyberionWebviewSessionHandoff: Codable {
    let kind: String
    let target_url: String
    let origin: String?
    let cookies: [KyberionCookie]
    let local_storage: [String: String]
    let session_storage: [String: String]
    let headers: [String: String]
    let source: [String: String]

    init(
        targetURL: String,
        origin: String?,
        cookies: [KyberionCookie],
        localStorage: [String: String],
        sessionStorage: [String: String],
        headers: [String: String],
        appId: String = "example-ios-login-passkey"
    ) {
        self.kind = "webview-session-handoff"
        self.target_url = targetURL
        self.origin = origin
        self.cookies = cookies
        self.local_storage = localStorage
        self.session_storage = sessionStorage
        self.headers = headers
        self.source = [
            "platform": "ios",
            "app_id": appId
        ]
    }
}

struct WebViewSessionState {
    let url: URL
    let origin: String?
    let cookies: [KyberionCookie]
    let localStorage: [String: String]
    let sessionStorage: [String: String]
    let headers: [String: String]
}

protocol WebViewSessionReader {
    func readCurrentState() throws -> WebViewSessionState
}
