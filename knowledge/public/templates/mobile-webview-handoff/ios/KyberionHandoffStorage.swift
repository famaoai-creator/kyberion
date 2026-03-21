import Foundation

final class KyberionHandoffStorage {
    func write(_ payload: KyberionWebviewSessionHandoff) throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let dir = base.appendingPathComponent("kyberion", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let file = dir.appendingPathComponent("webview-session.json")
        let data = try JSONEncoder().encode(payload)
        try data.write(to: file, options: .atomic)
        return file
    }
}
