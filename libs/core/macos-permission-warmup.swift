import AppKit
import AVFoundation
import CoreGraphics
// Explicit, operator-invoked permission warm-up. Kept apart from
// macos-native-automation.swift so that probe never requests anything.
// Only kinds that are still undetermined are requested; granted/denied are left alone.
func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) else { exit(1) }
  print(text)
}
func captureState(_ type: AVMediaType) -> String {
  switch AVCaptureDevice.authorizationStatus(for: type) {
  case .authorized: return "granted"
  case .denied, .restricted: return "denied"
  case .notDetermined: return "not_determined"
  @unknown default: return "unsupported"
  }
}
func warmCapture(_ type: AVMediaType) -> [String: String] {
  let before = captureState(type)
  if before == "not_determined" {
    let semaphore = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: type) { _ in semaphore.signal() }
    _ = semaphore.wait(timeout: .now() + 60)
  }
  return ["before": before, "after": captureState(type)]
}
func warmScreen() -> [String: String] {
  guard #available(macOS 10.15, *) else { return ["before": "unsupported", "after": "unsupported"] }
  let before = CGPreflightScreenCaptureAccess() ? "granted" : "denied"
  if before == "granted" { return ["before": before, "after": before] }
  _ = CGRequestScreenCaptureAccess()
  return ["before": before, "after": CGPreflightScreenCaptureAccess() ? "granted" : "denied"]
}
guard CommandLine.arguments.count == 2, let data = CommandLine.arguments[1].data(using: .utf8), let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let kinds = p["kinds"] as? [String] else { emit(["ok": false]); exit(1) }
var result: [String: Any] = [:]
for kind in kinds {
  switch kind {
  case "microphone": result[kind] = warmCapture(.audio)
  case "camera": result[kind] = warmCapture(.video)
  case "screen_recording": result[kind] = warmScreen()
  default: break
  }
}
emit(result)
