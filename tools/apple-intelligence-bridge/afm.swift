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
//
// Keep this file dependency-free (no SwiftPM) so it compiles with a single
// `swiftc -O afm.swift -o afm` and stays trivially auditable.

import Foundation
import FoundationModels

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

// ---- arg parsing ----

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    FileHandle.standardError.write("usage: afm <availability|prompt> [--instructions <text>] [--timeout <seconds>]\n".data(using: .utf8)!)
    exit(2)
}
args.removeFirst()

var instructions: String? = nil
var timeoutSeconds = 60.0
var index = 0
while index < args.count {
    switch args[index] {
    case "--instructions":
        if index + 1 < args.count { instructions = args[index + 1]; index += 1 }
    case "--timeout":
        if index + 1 < args.count { timeoutSeconds = Double(args[index + 1]) ?? timeoutSeconds; index += 1 }
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
default:
    FileHandle.standardError.write("ERROR: unknown command \(command)\n".data(using: .utf8)!)
    exit(2)
}
