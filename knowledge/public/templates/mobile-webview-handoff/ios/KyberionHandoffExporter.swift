import Foundation

enum KyberionHandoffError: Error {
    case disabled
}

protocol KyberionHandoffExporter {
    func exportWebViewSession(reason: String) throws -> URL
}

final class DefaultKyberionHandoffExporter: KyberionHandoffExporter {
    private let handoffEnabled: () -> Bool
    private let sessionReader: WebViewSessionReader
    private let storage: KyberionHandoffStorage
    private let appId: String

    init(
        handoffEnabled: @escaping () -> Bool,
        sessionReader: WebViewSessionReader,
        storage: KyberionHandoffStorage,
        appId: String = "example-ios-login-passkey"
    ) {
        self.handoffEnabled = handoffEnabled
        self.sessionReader = sessionReader
        self.storage = storage
        self.appId = appId
    }

    func exportWebViewSession(reason: String) throws -> URL {
        guard handoffEnabled() else {
            throw KyberionHandoffError.disabled
        }

        let state = try sessionReader.readCurrentState()
        let payload = KyberionWebviewSessionHandoff(
            targetURL: state.url.absoluteString,
            origin: state.origin,
            cookies: state.cookies,
            localStorage: state.localStorage,
            sessionStorage: state.sessionStorage,
            headers: state.headers.merging(["x-kyberion-reason": reason]) { _, new in new },
            appId: appId
        )
        return try storage.write(payload)
    }
}
