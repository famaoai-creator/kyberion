// afm — Apple Foundation Models bridge CLI for Kyberion.
//
// Kyberion's Node runtime shells out to this tiny Swift CLI to reach the
// on-device Apple Intelligence language model (FoundationModels framework,
// macOS 26+) and the macOS 27 Apple Intelligence developer surfaces.
// Design contract with libs/core/apple-intelligence-bridge.ts:
//
//   afm availability
//     → single-line JSON {"available":true} | {"available":false,"reason":"..."}
//   afm capabilities
//     → single-line JSON {"os":{"major":27,"minor":2,"patch":0},
//        "model":{"available":true,"reason":""},
//        "lanes":{"text":true,"vision_ocr":true,"speech":true,
//                 "imagine":null,"multimodal":true,"dynamic_profiles":true,
//                 "pcc":null,"coreai":true,"shortcuts":true}}
//       (null lane = needs a live probe: pcc → pcc-availability, imagine →
//        imagine-availability; evaluations is probed by the TS side via a
//        compile check — the module is not in every Xcode toolchain.)
//   afm prompt [--instructions <text>] [--timeout <seconds>] [--image <path>]
//     → reads the prompt from stdin, writes the raw response text to stdout,
//       exit 0. On failure writes ERROR: <detail> to stderr, exit 1.
//       --image attaches one image (macOS 27+ multimodal prompt).
//   afm vision --image <path> [--language jpn+eng]
//     → single-line JSON {"text":"<recognized text>","labels":[{"label":..,"confidence":..}]}
//       (Vision framework OCR + classification; no LLM involved).
//   afm speech-availability [--locale ja-JP]
//     → locale and installed asset readiness, without downloading assets.
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
//   afm pcc-availability
//     → probes the Private Cloud Compute (AFM 3 Cloud) lane and prints
//       {"available":bool,"class":"available|device_not_eligible|system_not_ready|...","reason":"...",
//        "quota":{"limit_reached":bool,"approaching":bool|null,"reset_date":string|null}}
//   afm session [--timeout <seconds>]
//     → reads JSONL requests from stdin, one per line:
//         {"prompt":"...","instructions":"...","tools":["ocr","barcode"]}
//       One session with dynamic instructions/tools is kept across requests
//       (macOS 27+ DynamicInstructions). Prints one JSONL response per line:
//         {"index":0,"content":"..."}  |  {"index":n,"error":"..."}
//   afm coreai-availability
//     → {"available":bool,"reason":"..."} for the Core AI lane (macOS 27+).
//   afm coreai run --asset <path> --function <name> --inputs <json> --output <name>
//     → loads a user-supplied .aimodel asset, runs one inference function
//       (float32 NDArray inputs: {"<input>":{"shape":[..],"values":[..]}}),
//       prints {"<output>":[floats]}.
//
// Keep this file dependency-free (no SwiftPM) so it compiles with a single
// `swiftc -O afm.swift -o afm` and stays trivially auditable.

import AVFoundation
#if canImport(CoreAI)
import CoreAI
#endif
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

func runPrompt(instructions: String?, timeoutSeconds: Double, imagePath: String?) {
    let promptText = readStdin().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !promptText.isEmpty else {
        FileHandle.standardError.write("ERROR: empty prompt on stdin\n".data(using: .utf8)!)
        exit(1)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var output: String?
    var failure: String?

    Task {
        do {
            let session: LanguageModelSession
            if let instructions, !instructions.isEmpty {
                session = LanguageModelSession(instructions: instructions)
            } else {
                session = LanguageModelSession()
            }
            if let imagePath {
                #if compiler(>=6.4)
                guard #available(macOS 27.0, *) else {
                    throw BridgeError.requiresMacOS27(feature: "multimodal prompt")
                }
                let url = URL(fileURLWithPath: imagePath)
                guard FileManager.default.fileExists(atPath: imagePath) else {
                    throw BridgeError.fileNotFound(imagePath)
                }
                let attachment = Attachment(imageURL: url)
                let response = try await session.respond {
                    promptText
                    attachment.label("input-image")
                }
                output = response.content
                #else
                throw BridgeError.unsupportedInput("multimodal prompt requires a macOS 27 SDK")
                #endif
            } else {
                let response = try await session.respond(to: promptText)
                output = response.content
            }
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

enum BridgeError: Error {
    case requiresMacOS27(feature: String)
    case fileNotFound(String)
    case unsupportedInput(String)
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

func runVision(imagePath: String, language: String?) {
    let url = URL(fileURLWithPath: imagePath)
    guard FileManager.default.fileExists(atPath: imagePath) else {
        FileHandle.standardError.write("ERROR: image not found: \(imagePath)\n".data(using: .utf8)!)
        exit(1)
    }
    let handler = VNImageRequestHandler(url: url)
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    textRequest.usesLanguageCorrection = true
    if let language, !language.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        let aliases = [
            "jpn": "ja-JP", "ja": "ja-JP", "jp": "ja-JP",
            "eng": "en-US", "en": "en-US", "kor": "ko-KR", "ko": "ko-KR",
            "fra": "fr-FR", "fre": "fr-FR", "fr": "fr-FR",
            "deu": "de-DE", "ger": "de-DE", "de": "de-DE",
            "spa": "es-ES", "es": "es-ES", "ita": "it-IT", "it": "it-IT",
            "por": "pt-PT", "pt": "pt-PT", "rus": "ru-RU", "ru": "ru-RU",
            "chi_sim": "zh-Hans", "chi_tra": "zh-Hant",
        ]
        textRequest.recognitionLanguages = language.split(whereSeparator: { $0 == "+" || $0 == "," }).map {
            let token = String($0).trimmingCharacters(in: .whitespacesAndNewlines)
            return aliases[token.lowercased()] ?? token.replacingOccurrences(of: "_", with: "-")
        }
    } else {
        textRequest.recognitionLanguages = ["ja-JP", "en-US"]
    }
    let classifyRequest = VNClassifyImageRequest()
    do {
        try handler.perform([textRequest, classifyRequest])
    } catch {
        FileHandle.standardError.write("ERROR: vision failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    let lines: [[String: Any]] = (textRequest.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return [
            "text": candidate.string,
            "confidence": Double(candidate.confidence) * 100.0,
            "boundingBox": [
                "x": box.origin.x, "y": 1.0 - box.origin.y - box.size.height,
                "width": box.size.width, "height": box.size.height,
            ],
        ]
    }
    let text = lines.compactMap { $0["text"] as? String }.joined(separator: "\n")
    let confidence = lines.isEmpty ? 0.0 :
        lines.reduce(0.0) { $0 + ($1["confidence"] as? Double ?? 0.0) } / Double(lines.count)
    guard let linesData = try? JSONSerialization.data(withJSONObject: lines, options: [.sortedKeys]),
          let linesJSON = String(data: linesData, encoding: .utf8) else {
        FileHandle.standardError.write("ERROR: Vision line geometry could not be serialized\n".data(using: .utf8)!)
        exit(1)
    }
    let labels: [String] = (classifyRequest.results ?? [])
        .filter { $0.confidence > 0.3 }
        .prefix(8)
        .map { "{\"label\":\"\(jsonEscape($0.identifier))\",\"confidence\":\(String(format: "%.2f", $0.confidence))}" }
    print("{\"text\":\"\(jsonEscape(text))\",\"labels\":[\(labels.joined(separator: ","))],\"confidence\":\(confidence),\"lines\":\(linesJSON)}")
}

func runSpeechAvailability(localeId: String, timeoutSeconds: Double) {
    let semaphore = DispatchSemaphore(value: 0)
    var resultJSON = ""
    func response(available: Bool, locale: String, assetStatus: String, reason: String = "") -> String {
        return "{\"available\":\(available),\"locale\":\"\(jsonEscape(locale))\",\"asset_status\":\"\(assetStatus)\",\"reason\":\"\(jsonEscape(reason))\"}"
    }
    Task {
        defer { semaphore.signal() }
        guard SpeechTranscriber.isAvailable else {
            resultJSON = response(available: false, locale: localeId, assetStatus: "unsupported", reason: "SpeechTranscriber unavailable on this device")
            return
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
            resultJSON = response(available: false, locale: localeId, assetStatus: "unsupported", reason: "SpeechTranscriber does not support the requested locale")
            return
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        // Readiness only: never reserve a locale or request/download assets.
        switch await AssetInventory.status(forModules: [transcriber]) {
        case .installed:
            resultJSON = response(available: true, locale: locale.identifier, assetStatus: "installed")
        case .supported:
            resultJSON = response(available: false, locale: locale.identifier, assetStatus: "supported", reason: "Speech assets are not installed for this locale")
        case .downloading:
            resultJSON = response(available: false, locale: locale.identifier, assetStatus: "downloading", reason: "Speech assets are still downloading for this locale")
        case .unsupported:
            resultJSON = response(available: false, locale: locale.identifier, assetStatus: "unsupported", reason: "Speech assets are unsupported for this locale")
        @unknown default:
            resultJSON = response(available: false, locale: locale.identifier, assetStatus: "unknown", reason: "Unknown speech asset readiness")
        }
    }
    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        print(response(available: false, locale: localeId, assetStatus: "unknown", reason: "Speech readiness probe timed out"))
        return
    }
    print(resultJSON)
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

// ---- capabilities (version-gated lane matrix) ----

func printCapabilities() {
    let osVersion = ProcessInfo.processInfo.operatingSystemVersion
    #if compiler(>=6.4)
    let is27OrLater = osVersion.majorVersion >= 27
    #else
    let is27OrLater = false
    #endif
    #if canImport(CoreAI)
    let coreAiAvailable = is27OrLater
    #else
    let coreAiAvailable = false
    #endif
    let model = SystemLanguageModel.default
    var modelAvailable = false
    var modelReason = ""
    switch model.availability {
    case .available:
        modelAvailable = true
    case .unavailable(let reason):
        modelReason = String(describing: reason)
    }
    // imagine and pcc need live probes (imagine-availability / pcc-availability).
    let lanesJSON = [
        "\"text\":\(modelAvailable)",
        "\"vision_ocr\":true",
        "\"speech\":true",
        "\"imagine\":null",
        "\"multimodal\":\(modelAvailable && is27OrLater)",
        "\"dynamic_profiles\":\(modelAvailable && is27OrLater)",
        "\"pcc\":\(is27OrLater ? "null" : "false")",
        "\"coreai\":\(coreAiAvailable)",
        "\"shortcuts\":true",
    ].joined(separator: ",")
    print("{\"os\":{\"major\":\(osVersion.majorVersion),\"minor\":\(osVersion.minorVersion),\"patch\":\(osVersion.patchVersion)},\"model\":{\"available\":\(modelAvailable),\"reason\":\"\(jsonEscape(modelReason))\"},\"lanes\":{\(lanesJSON)}}")
}

// ---- PCC (AFM 3 Cloud) availability probe ----

func runPccAvailability(timeoutSeconds: Double) {
    #if compiler(>=6.4)
    guard #available(macOS 27.0, *) else {
        print("{\"available\":false,\"class\":\"os_too_old\",\"reason\":\"requires macOS 27+\",\"quota\":null}")
        return
    }
    let semaphore = DispatchSemaphore(value: 0)
    var resultJSON = "{\"available\":false,\"class\":\"unknown\",\"reason\":\"probe did not complete\",\"quota\":null}"
    Task {
        defer { semaphore.signal() }
        let model = PrivateCloudComputeLanguageModel()
        switch model.availability {
        case .available:
            var quotaLimitReached = false
            var quotaApproaching: Bool? = nil
            var resetDate: String? = nil
            if #available(macOS 27.0, *) {
                quotaLimitReached = model.quotaUsage.isLimitReached
                if case .belowLimit(let info) = model.quotaUsage.status {
                    quotaApproaching = info.isApproachingLimit
                }
                if let reset = model.quotaUsage.resetDate {
                    resetDate = String(describing: reset)
                }
            }
            let quotaJSON = "{\"limit_reached\":\(quotaLimitReached),\"approaching\":\(quotaApproaching.map(String.init) ?? "null"),\"reset_date\":\(resetDate.map { "\"\(jsonEscape($0))\"" } ?? "null")}"
            resultJSON = "{\"available\":true,\"class\":\"available\",\"reason\":\"\",\"quota\":\(quotaJSON)}"
        case .unavailable(let reason):
            let className: String
            switch reason {
            case .deviceNotEligible: className = "device_not_eligible"
            case .systemNotReady: className = "system_not_ready"
            default: className = "unavailable_other"
            }
            resultJSON = "{\"available\":false,\"class\":\"\(className)\",\"reason\":\"\(jsonEscape(String(describing: reason)))\",\"quota\":null}"
        }
    }
    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        FileHandle.standardError.write("ERROR: pcc availability timed out\n".data(using: .utf8)!)
        exit(1)
    }
    print(resultJSON)
    #else
    print("{\"available\":false,\"class\":\"os_too_old\",\"reason\":\"requires macOS 27 SDK\"}")
    #endif
}

// ---- dynamic session (macOS 27+ DynamicInstructions) ----

#if compiler(>=6.4)
@available(macOS 27.0, *)
final class SessionState {
    var instructions = ""
    var tools: Set<String> = []
}

@available(macOS 27.0, *)
struct DynamicSessionInstructions: DynamicInstructions {
    let state: SessionState

    var body: some DynamicInstructions {
        Instructions {
            state.instructions.isEmpty ? "You are a helpful assistant." : state.instructions
        }
        if state.tools.contains("ocr") {
            OCRTool()
        }
        if state.tools.contains("barcode") {
            BarcodeReaderTool()
        }
    }
}

@available(macOS 27.0, *)
func runSession(timeoutSeconds: Double) {
    let input = readStdin()
    let lines = input.split(separator: "\n", omittingEmptySubsequences: true)
    guard !lines.isEmpty else {
        FileHandle.standardError.write("ERROR: no session requests on stdin\n".data(using: .utf8)!)
        exit(1)
    }

    var requests: [(Int, [String: Any])] = []
    for (index, rawLine) in lines.enumerated() {
        guard let data = rawLine.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              obj["prompt"] is String
        else {
            print("{\"index\":\(index),\"error\":\"unparseable request line\"}")
            continue
        }
        requests.append((index, obj))
    }

    let state = SessionState()
    let session = LanguageModelSession(dynamicInstructions: DynamicSessionInstructions(state: state))

    let semaphore = DispatchSemaphore(value: 0)
    var failure: String?
    Task {
        do {
            for (index, request) in requests {
                state.instructions = request["instructions"] as? String ?? ""
                if let tools = request["tools"] as? [String] {
                    state.tools = Set(tools)
                } else {
                    state.tools = []
                }
                guard let prompt = request["prompt"] as? String else { continue }
                let response = try await session.respond(to: prompt)
                print("{\"index\":\(index),\"content\":\"\(jsonEscape(response.content))\"}")
                // stdout may be a pipe; FileHandle.synchronizeFile() raises
                // NSException there — plain C fflush is safe and immediate.
                fflush(stdout)
            }
        } catch {
            failure = String(describing: error)
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        FileHandle.standardError.write("ERROR: session timed out after \(timeoutSeconds)s\n".data(using: .utf8)!)
        exit(1)
    }
    if let failure {
        FileHandle.standardError.write("ERROR: \(failure)\n".data(using: .utf8)!)
        exit(1)
    }
}

#endif

// ---- Core AI lane (macOS 27+) ----

func runCoreAiAvailability() {
    let osVersion = ProcessInfo.processInfo.operatingSystemVersion
    let is27OrLater = osVersion.majorVersion >= 27
    if !is27OrLater {
        print("{\"available\":false,\"reason\":\"requires macOS 27+\"}")
        return
    }
    #if canImport(CoreAI)
    guard let framework = dlopen("/System/Library/Frameworks/CoreAI.framework/CoreAI", RTLD_LAZY) else {
        print("{\"available\":false,\"reason\":\"CoreAI framework not loadable at runtime\"}")
        return
    }
    dlclose(framework)
    print("{\"available\":true}")
    #else
    print("{\"available\":false,\"reason\":\"CoreAI unavailable in this SDK\"}")
    #endif
}

func runCoreAi(assetPath: String, functionName: String, inputsJSON: String, outputName: String, timeoutSeconds: Double) {
    #if canImport(CoreAI)
    guard #available(macOS 27.0, *) else {
        FileHandle.standardError.write("ERROR: coreai requires macOS 27+\n".data(using: .utf8)!)
        exit(2)
    }
    guard FileManager.default.fileExists(atPath: assetPath) else {
        FileHandle.standardError.write("ERROR: model asset not found: \(assetPath)\n".data(using: .utf8)!)
        exit(1)
    }
    guard let inputsData = inputsJSON.data(using: .utf8),
          let parsedInputs = (try? JSONSerialization.jsonObject(with: inputsData)) as? [String: Any]
    else {
        FileHandle.standardError.write("ERROR: --inputs must be a JSON object\n".data(using: .utf8)!)
        exit(2)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var outputJSON = ""
    var failure: String?
    Task {
        do {
            let model = try await AIModel(contentsOf: URL(fileURLWithPath: assetPath))
            guard let function = try model.loadFunction(named: functionName) else {
                throw BridgeError.unsupportedInput("function not found: \(functionName) (available: \(model.functionNames.joined(separator: ",")))")
            }
            var inputs: [String: NDArray] = [:]
            for (name, spec) in parsedInputs {
                guard let specDict = spec as? [String: Any],
                      let shape = specDict["shape"] as? [Int],
                      let values = specDict["values"] as? [Double] else {
                    throw BridgeError.unsupportedInput("input \(name) must be {\"shape\":[...],\"values\":[floats]}")
                }
                var array = NDArray(shape: shape, scalarType: .float32)
                let mutable = array.mutableView(as: Float.self)
                if var elements = mutable.contiguousElements {
                    for (i, value) in values.enumerated() where i < elements.count {
                        elements[i] = Float(value)
                    }
                } else {
                    throw BridgeError.unsupportedInput("input \(name) has non-contiguous layout")
                }
                inputs[name] = array
            }
            var outputs = try await function.run(inputs: inputs)
            guard let outValue = outputs.remove(outputName), let outArray = outValue.ndArray else {
                throw BridgeError.unsupportedInput("output \(outputName) not found or not an NDArray")
            }
            let view = outArray.view(as: Float.self)
            var values: [String] = []
            // Read scalar-by-scalar through the typed view when contiguous.
            if let contiguous = view.contiguousElements {
                var parts: [String] = []
                parts.reserveCapacity(contiguous.count)
                for i in 0..<contiguous.count {
                    parts.append(String(format: "%.6g", contiguous[i]))
                }
                values = parts
            } else {
                throw BridgeError.unsupportedInput("output \(outputName) has non-contiguous layout")
            }
            outputJSON = "{\"\(jsonEscape(outputName))\":[\(values.joined(separator: ","))]}"
        } catch {
            failure = String(describing: error)
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        FileHandle.standardError.write("ERROR: coreai inference timed out after \(timeoutSeconds)s\n".data(using: .utf8)!)
        exit(1)
    }
    if let failure {
        FileHandle.standardError.write("ERROR: \(failure)\n".data(using: .utf8)!)
        exit(1)
    }
    print(outputJSON)
    #else
    FileHandle.standardError.write("ERROR: CoreAI unavailable in this SDK\n".data(using: .utf8)!)
    exit(2)
    #endif
}

// ---- arg parsing ----

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    FileHandle.standardError.write("usage: afm <availability|capabilities|prompt|vision|transcribe|imagine|imagine-availability|pcc-availability|session|coreai-availability|coreai> [options]\n".data(using: .utf8)!)
    exit(2)
}
args.removeFirst()

var instructions: String? = nil
var timeoutSeconds = 60.0
var imagePath: String? = nil
var audioPath: String? = nil
var localeId = "ja-JP"
var visionLanguage: String? = nil
var promptArg: String? = nil
var outPath: String? = nil
var styleId: String? = nil
var assetPath: String? = nil
var functionName = "main"
var inputsJSON = "{}"
var outputName = "output"
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
    case "--language":
        if index + 1 < args.count { visionLanguage = args[index + 1]; index += 1 }
    case "--locale":
        if index + 1 < args.count { localeId = args[index + 1]; index += 1 }
    case "--prompt":
        if index + 1 < args.count { promptArg = args[index + 1]; index += 1 }
    case "--out":
        if index + 1 < args.count { outPath = args[index + 1]; index += 1 }
    case "--style":
        if index + 1 < args.count { styleId = args[index + 1]; index += 1 }
    case "--asset":
        if index + 1 < args.count { assetPath = args[index + 1]; index += 1 }
    case "--function":
        if index + 1 < args.count { functionName = args[index + 1]; index += 1 }
    case "--inputs":
        if index + 1 < args.count { inputsJSON = args[index + 1]; index += 1 }
    case "--output":
        if index + 1 < args.count { outputName = args[index + 1]; index += 1 }
    default:
        break
    }
    index += 1
}

switch command {
case "availability":
    printAvailability()
case "capabilities":
    printCapabilities()
case "prompt":
    runPrompt(instructions: instructions, timeoutSeconds: timeoutSeconds, imagePath: imagePath)
case "vision":
    guard let imagePath else {
        FileHandle.standardError.write("ERROR: vision requires --image <path>\n".data(using: .utf8)!)
        exit(2)
    }
    runVision(imagePath: imagePath, language: visionLanguage)
case "speech-availability":
    runSpeechAvailability(localeId: localeId, timeoutSeconds: min(timeoutSeconds, 30.0))
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
case "pcc-availability":
    runPccAvailability(timeoutSeconds: min(timeoutSeconds, 45.0))
case "session":
    #if compiler(>=6.4)
    if #available(macOS 27.0, *) {
        runSession(timeoutSeconds: timeoutSeconds == 60.0 ? 300.0 : timeoutSeconds)
    } else {
        FileHandle.standardError.write("ERROR: dynamic sessions require macOS 27+\n".data(using: .utf8)!)
        exit(2)
    }
    #else
    FileHandle.standardError.write("ERROR: dynamic sessions require macOS 27 SDK\n".data(using: .utf8)!)
    exit(2)
    #endif
case "coreai-availability":
    runCoreAiAvailability()
case "coreai":
    guard args.count > 0, args.first == "run", let assetPath else {
        FileHandle.standardError.write("ERROR: usage: afm coreai run --asset <path> --function <name> --inputs <json> --output <name>\n".data(using: .utf8)!)
        exit(2)
    }
    runCoreAi(assetPath: assetPath, functionName: functionName, inputsJSON: inputsJSON, outputName: outputName, timeoutSeconds: timeoutSeconds == 60.0 ? 300.0 : timeoutSeconds)
default:
    FileHandle.standardError.write("ERROR: unknown command \(command)\n".data(using: .utf8)!)
    exit(2)
}
