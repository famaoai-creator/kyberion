import Foundation
import Vision
import AppKit

// Check command line arguments
guard CommandLine.arguments.count > 1 else {
    let errJson = ["error": "Missing image path argument"]
    if let data = try? JSONSerialization.data(withJSONObject: errJson, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: fileURL),
      let tiffData = image.tiffRepresentation,
      let imageSource = CGImageSourceCreateWithData(tiffData as CFData, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
    let errJson = ["error": "Failed to load image or convert to CGImage"]
    if let data = try? JSONSerialization.data(withJSONObject: errJson, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(1)
}

let request = VNRecognizeTextRequest { (request, error) in
    if let error = error {
        let errJson = ["error": error.localizedDescription]
        if let data = try? JSONSerialization.data(withJSONObject: errJson, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(1)
    }
    
    guard let observations = request.results as? [VNRecognizedTextObservation] else {
        print("{\"status\":\"succeeded\",\"text\":\"\",\"confidence\":0,\"lines\":[]}")
        exit(0)
    }
    
    var fullText = ""
    var lines: [[String: Any]] = []
    
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        let confidence = Double(candidate.confidence * 100.0)
        
        let box = observation.boundingBox // Normalized coordinates (0.0 to 1.0), y-up
        let boxDict: [String: Any] = [
            "x": box.origin.x,
            "y": 1.0 - box.origin.y - box.size.height, // convert y-up to y-down
            "width": box.size.width,
            "height": box.size.height
        ]
        
        lines.append([
            "text": text,
            "confidence": confidence,
            "boundingBox": boxDict
        ])
        
        if !fullText.isEmpty {
            fullText += "\n"
        }
        fullText += text
    }
    
    let averageConfidence = lines.isEmpty ? 0.0 : lines.reduce(0.0) { $0 + ($1["confidence"] as? Double ?? 0.0) } / Double(lines.count)
    
    let result: [String: Any] = [
        "status": "succeeded",
        "text": fullText,
        "confidence": averageConfidence,
        "lines": lines
    ]
    
    if let data = try? JSONSerialization.data(withJSONObject: result, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(0)
}

// Swift's Vision handles language selection if requested
if CommandLine.arguments.count > 2 {
    let lang = CommandLine.arguments[2]
    // Translate common Tesseract-style language names while retaining both
    // Japanese and English for the document defaults (e.g. jpn+eng).
    var languages: [String] = []
    if lang.contains("jpn") || lang.contains("ja") || lang.contains("jp") {
        languages.append("ja-JP")
    }
    if lang.contains("eng") || lang.contains("en") {
        languages.append("en-US")
    }
    request.recognitionLanguages = languages.isEmpty ? ["en-US"] : languages
}

request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    let errJson = ["error": error.localizedDescription]
    if let data = try? JSONSerialization.data(withJSONObject: errJson, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(1)
}
