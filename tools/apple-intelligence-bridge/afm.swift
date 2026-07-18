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
//   afm transcribe --audio <path> [--locale ja-JP] [--timeout <seconds>]
//     → single-line JSON {"text":"<transcript>"} via the on-device
//       SpeechAnalyzer/SpeechTranscriber stack (macOS 26+).
//   afm imagine --prompt <text> --out <path> [--style <id>]
//     → generates one image via Image Playground (ImageCreator) and writes
//       PNG to <path>; prints {"path":"...","style":"..."}. Exits 1 with
//       ERROR: notSupported when Image Playground is unavailable.
//   afm imagine-availability
//     → probes Image Playground without generating an image and prints
//       {"available":true} or {"available":false,"reason":"..."}.
//
// Keep this file dependency-free (no SwiftPM) so it compiles with a single
// `swiftc -O afm.swift -o afm` and stays trivially auditable.

import AVFoundation
import CoreGraphics
import Foundation
import FoundationModels
import ImageIO
import ImagePlayground
import Speech
import UniformTypeIdentifiers
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

func runTranscribe(audioPath: String, localeId: String, timeoutSeconds: Double) {
    guard FileManager.default.fileExists(atPath: audioPath) else {
        FileHandle.standardError.write("ERROR: audio not found: \(audioPath)\n".data(using: .utf8)!)
        exit(1)
    }
    let semaphore = DispatchSemaphore(value: 0)
    var transcript = ""
    var failure: String?
    Task {
        do {
            let locale = Locale(identifier: localeId)
            let transcriber = SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: [],
                attributeOptions: []
            )
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: audioPath))
            async let results: Void = {
                for try await result in transcriber.results {
                    transcript += String(result.text.characters)
                }
            }()
            if let lastSample = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            try await results
        } catch {
            failure = String(describing: error)
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        FileHandle.standardError.write("ERROR: transcription timed out after \(timeoutSeconds)s\n".data(using: .utf8)!)
        exit(1)
    }
    if let failure {
        FileHandle.standardError.write("ERROR: \(failure)\n".data(using: .utf8)!)
        exit(1)
    }
    print("{\"text\":\"\(jsonEscape(transcript.trimmingCharacters(in: .whitespacesAndNewlines)))\"}")
}

func writeCgImageAsPng(_ image: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        return false
    }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination)
}

func runImagine(prompt: String, outPath: String, styleId: String?, timeoutSeconds: Double) {
    let semaphore = DispatchSemaphore(value: 0)
    var failure: String?
    var usedStyle = ""
    Task {
        do {
            let creator = try await ImageCreator()
            let styles = creator.availableStyles
            guard let style = styleId
                .flatMap({ wanted in styles.first { String(describing: $0.id).lowercased().contains(wanted.lowercased()) } })
                ?? styles.first
            else {
                failure = "no Image Playground styles available"
                semaphore.signal()
                return
            }
            usedStyle = String(describing: style.id)
            var wrote = false
            for try await created in creator.images(for: [.text(prompt)], style: style, limit: 1) {
                if writeCgImageAsPng(created.cgImage, to: outPath) { wrote = true }
                break
            }
            if !wrote { failure = "image generation produced no writable frame" }
        } catch {
            failure = String(describing: error)
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        FileHandle.standardError.write("ERROR: image generation timed out after \(timeoutSeconds)s\n".data(using: .utf8)!)
        exit(1)
    }
    if let failure {
        FileHandle.standardError.write("ERROR: \(failure)\n".data(using: .utf8)!)
        exit(1)
    }
    print("{\"path\":\"\(jsonEscape(outPath))\",\"style\":\"\(jsonEscape(usedStyle))\"}")
}

func runImagineAvailability(timeoutSeconds: Double) {
    let semaphore = DispatchSemaphore(value: 0)
    var available = false
    var reason = "Image Playground unavailable"
    Task {
        do {
            let creator = try await ImageCreator()
            if creator.availableStyles.isEmpty {
                reason = "no Image Playground styles available"
            } else {
                available = true
                reason = ""
            }
        } catch {
            reason = String(describing: error)
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        FileHandle.standardError.write("ERROR: image generation availability timed out\n".data(using: .utf8)!)
        exit(1)
    }
    if available {
        print("{\"available\":true}")
    } else {
        print("{\"available\":false,\"reason\":\"\(jsonEscape(reason))\"}")
    }
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
var audioPath: String? = nil
var localeId = "ja-JP"
var promptArg: String? = nil
var outPath: String? = nil
var styleId: String? = nil
var index = 0
while index < args.count {
    switch args[index] {
    case "--instructions":
        if index + 1 < args.count { instructions = args[index + 1]; index += 1 }
    case "--timeout":
        if index + 1 < args.count { timeoutSeconds = Double(args[index + 1]) ?? timeoutSeconds; index += 1 }
    case "--image":
        if index + 1 < args.count { imagePath = args[index + 1]; index += 1 }
    case "--audio":
        if index + 1 < args.count { audioPath = args[index + 1]; index += 1 }
    case "--locale":
        if index + 1 < args.count { localeId = args[index + 1]; index += 1 }
    case "--prompt":
        if index + 1 < args.count { promptArg = args[index + 1]; index += 1 }
    case "--out":
        if index + 1 < args.count { outPath = args[index + 1]; index += 1 }
    case "--style":
        if index + 1 < args.count { styleId = args[index + 1]; index += 1 }
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
case "transcribe":
    guard let audioPath else {
        FileHandle.standardError.write("ERROR: transcribe requires --audio <path>\n".data(using: .utf8)!)
        exit(2)
    }
    runTranscribe(audioPath: audioPath, localeId: localeId, timeoutSeconds: timeoutSeconds == 60.0 ? 300.0 : timeoutSeconds)
case "imagine":
    guard let promptArg, let outPath else {
        FileHandle.standardError.write("ERROR: imagine requires --prompt <text> --out <path>\n".data(using: .utf8)!)
        exit(2)
    }
    runImagine(prompt: promptArg, outPath: outPath, styleId: styleId, timeoutSeconds: timeoutSeconds == 60.0 ? 300.0 : timeoutSeconds)
case "imagine-availability":
    runImagineAvailability(timeoutSeconds: timeoutSeconds)
default:
    FileHandle.standardError.write("ERROR: unknown command \(command)\n".data(using: .utf8)!)
    exit(2)
}
