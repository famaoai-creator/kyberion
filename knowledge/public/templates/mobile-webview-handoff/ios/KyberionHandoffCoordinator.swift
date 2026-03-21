import Foundation

final class KyberionHandoffCoordinator {
    private let exporter: KyberionHandoffExporter

    init(exporter: KyberionHandoffExporter) {
        self.exporter = exporter
    }

    func handleLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-kyberion-handoff") else { return }

        let reasonIndex = args.firstIndex(of: "-kyberion-handoff-reason")
        let reason = reasonIndex.flatMap { index in
            args.indices.contains(index + 1) ? args[index + 1] : nil
        } ?? "launch_argument"

        try? exporter.exportWebViewSession(reason: reason)
    }
}
