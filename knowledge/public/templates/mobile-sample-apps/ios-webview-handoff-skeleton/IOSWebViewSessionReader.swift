import Foundation

final class IOSWebViewSessionReader: WebViewSessionReader {
    private let sessionRepository: SessionRepository

    init(sessionRepository: SessionRepository) {
        self.sessionRepository = sessionRepository
    }

    func readCurrentState() throws -> WebViewSessionState {
        WebViewSessionState(
            url: sessionRepository.currentURL,
            origin: sessionRepository.currentOrigin,
            cookies: sessionRepository.cookies,
            localStorage: sessionRepository.localStorage,
            sessionStorage: sessionRepository.sessionStorage,
            headers: sessionRepository.headers
        )
    }
}
