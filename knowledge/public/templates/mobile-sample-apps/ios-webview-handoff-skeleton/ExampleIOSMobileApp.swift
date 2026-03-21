import SwiftUI

@main
struct ExampleIOSMobileApp: App {
    @StateObject private var sessionRepository = SessionRepository()

    var body: some Scene {
        WindowGroup {
            RootView(sessionRepository: sessionRepository)
                .task {
                    let exporter = DefaultKyberionHandoffExporter(
                        handoffEnabled: { DebugFeatureFlags.kyberionHandoffEnabled },
                        sessionReader: IOSWebViewSessionReader(sessionRepository: sessionRepository),
                        storage: KyberionHandoffStorage()
                    )
                    let coordinator = KyberionHandoffCoordinator(exporter: exporter)
                    coordinator.handleLaunchArguments()
                }
        }
    }
}
