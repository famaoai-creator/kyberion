import FluidAudio
import Foundation

struct BridgeResult: Codable {
    let status: String
    let text: String?
    let backend: String
    let language: String?
    let error: String?
}

func emit(_ result: BridgeResult, exitCode: Int32 = 0) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(result) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    Foundation.exit(exitCode)
}

func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

@main
struct FluidAudioBridge {
    static func main() async {
        let arguments = CommandLine.arguments.dropFirst()
        guard arguments.first == "transcribe", let audioPath = arguments.dropFirst().first else {
            emit(BridgeResult(status: "error", text: nil, backend: "fluid-audio-parakeet", language: nil, error: "usage: fluidaudio-bridge transcribe <audio-path> [--language <bcp47>]"), exitCode: 2)
        }

        let language = argument("--language")
        let url = URL(fileURLWithPath: String(audioPath))
        guard FileManager.default.fileExists(atPath: url.path) else {
            emit(BridgeResult(status: "error", text: nil, backend: "fluid-audio-parakeet", language: language, error: "audio file not found: \(url.path)"), exitCode: 2)
        }

        do {
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            var decoderState = try TdtDecoderState()
            let result = try await manager.transcribe(url, decoderState: &decoderState)
            emit(BridgeResult(status: "success", text: result.text, backend: "fluid-audio-parakeet", language: language, error: nil))
        } catch {
            emit(BridgeResult(status: "error", text: nil, backend: "fluid-audio-parakeet", language: language, error: String(describing: error)), exitCode: 1)
        }
    }
}
