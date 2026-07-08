// afm — Apple Foundation Models bridge CLI for Kyberion.
//
// Kyberion's Node runtime shells out to this tiny Swift CLI to reach the
// on-device Apple Intelligence language model (FoundationModels framework,
// macOS 26+). Design contract with libs/core/apple-intelligence-bridge.ts:
//
//   afm availability
//     → single-line JSON {"available":true} | {"available":false,"reason":"..."}
//   afm prompt [--instructions <text>] [--timeout <seconds>]
//     → reads the prompt from stdin, writes the raw response text to stdout,
//       exit 0. On failure writes ERROR: <detail> to stderr, exit 1.
//   afm vision --image <path>
//     → single-line JSON {"text":"<recognized text>","labels":[{"label":..,"confidence":..}]}
//       (Vision framework OCR + classification; no LLM involved).
//
// Keep this file dependency-free (no SwiftPM) so it compiles with a single
// `swiftc -O afm.swift -o afm` and stays trivially auditable.

import Foundation
import FoundationModels
import Vision

func printAvailability() {
    let model = SystemLanguageModel.default
    switch model.availability {
    case .available:
        print("{\"available\":true}")
    case .unavailable(let reason):
        let detail = String(describing: reason)
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        print("{\"available\":false,\"reason\":\"\(detail)\"}")
    }
}

func readStdin() -> String {
    var data = Data()
    while let line = readLine(strippingNewline: false) {
        data.append(line.data(using: .utf8) ?? Data())
    }
    return String(data: data, encoding: .utf8) ?? ""
}

func runPrompt(instructions: String?, timeoutSeconds: Double) {
    let promptText = readStdin().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !promptText.isEmpty else {
        FileHandle.standardError.write("ERROR: empty prompt on stdin\n".data(using: .utf8)!)
        exit(1)
    }

    let session: LanguageModelSession
    if let instructions, !instructions.isEmpty {
        session = LanguageModelSession(instructions: instructions)
    } else {
        session = LanguageModelSession()
    }

    let semaphore = DispatchSemaphore(value: 0)
    var output: String?
    var failure: String?

    Task {
        do {
            let response = try await session.respond(to: promptText)
            output = response.content
        } catch {
            failure = String(describing: error)
        }
        semaphore.signal()
    }

    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        FileHandle.standardError.write("ERROR: timed out after \(timeoutSeconds)s\n".data(using: .utf8)!)
        exit(1)
    }
    if let failure {
        FileHandle.standardError.write("ERROR: \(failure)\n".data(using: .utf8)!)
        exit(1)
    }
    print(output ?? "")
}

func jsonEscape(_ value: String) -> String {
    var out = ""
    for ch in value.unicodeScalars {
        switch ch {
        case "\\": out += "\\\\"
        case "\"": out += "\\\""
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    return out
}

func runVision(imagePath: String) {
    let url = URL(fileURLWithPath: imagePath)
    guard FileManager.default.fileExists(atPath: imagePath) else {
        FileHandle.standardError.write("ERROR: image not found: \(imagePath)\n".data(using: .utf8)!)
        exit(1)
    }
    let handler = VNImageRequestHandler(url: url)
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    textRequest.recognitionLanguages = ["ja-JP", "en-US"]
    let classifyRequest = VNClassifyImageRequest()
    do {
        try handler.perform([textRequest, classifyRequest])
    } catch {
        FileHandle.standardError.write("ERROR: vision failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    let lines: [String] = (textRequest.results ?? []).compactMap { observation in
        observation.topCandidates(1).first?.string
    }
    let labels: [String] = (classifyRequest.results ?? [])
        .filter { $0.confidence > 0.3 }
        .prefix(8)
        .map { "{\"label\":\"\(jsonEscape($0.identifier))\",\"confidence\":\(String(format: "%.2f", $0.confidence))}" }
    print("{\"text\":\"\(jsonEscape(lines.joined(separator: "\n")))\",\"labels\":[\(labels.joined(separator: ","))]}")
}

// ---- arg parsing ----

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    FileHandle.standardError.write("usage: afm <availability|prompt> [--instructions <text>] [--timeout <seconds>]\n".data(using: .utf8)!)
    exit(2)
}
args.removeFirst()

var instructions: String? = nil
var timeoutSeconds = 60.0
var imagePath: String? = nil
var index = 0
while index < args.count {
    switch args[index] {
    case "--instructions":
        if index + 1 < args.count { instructions = args[index + 1]; index += 1 }
    case "--timeout":
        if index + 1 < args.count { timeoutSeconds = Double(args[index + 1]) ?? timeoutSeconds; index += 1 }
    case "--image":
        if index + 1 < args.count { imagePath = args[index + 1]; index += 1 }
    default:
        break
    }
    index += 1
}

switch command {
case "availability":
    printAvailability()
case "prompt":
    runPrompt(instructions: instructions, timeoutSeconds: timeoutSeconds)
case "vision":
    guard let imagePath else {
        FileHandle.standardError.write("ERROR: vision requires --image <path>\n".data(using: .utf8)!)
        exit(2)
    }
    runVision(imagePath: imagePath)
default:
    FileHandle.standardError.write("ERROR: unknown command \(command)\n".data(using: .utf8)!)
    exit(2)
}
