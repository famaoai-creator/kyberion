import CoreGraphics
import Foundation

// A listen-only Quartz event tap. It observes action boundaries without
// recording typed text, clipboard contents, or modifier state. Kyberion
// resolves the active AX target separately and keeps destructive replay behind
// its normal approval gate.
let mask = (CGEventMask(1) << CGEventType.leftMouseDown.rawValue)
  | (CGEventMask(1) << CGEventType.rightMouseDown.rawValue)
  | (CGEventMask(1) << CGEventType.keyDown.rawValue)

func emit(_ payload: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload),
        var line = String(data: data, encoding: .utf8) else { return }
  line.append("\n")
  FileHandle.standardOutput.write(Data(line.utf8))
  fflush(stdout)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
  switch type {
  case .leftMouseDown:
    let point = event.location
    emit(["op": "click_at", "x": point.x, "y": point.y, "click_count": 1])
  case .rightMouseDown:
    let point = event.location
    emit(["op": "right_click_at", "x": point.x, "y": point.y, "click_count": 1])
  case .keyDown:
    if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
      emit(["op": "press_key", "params": ["key_code": event.getIntegerValueField(.keyboardEventKeycode)]])
    }
  default:
    break
  }
  return Unmanaged.passUnretained(event)
}

guard let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: nil
) else {
  FileHandle.standardError.write(Data("desktop event tap unavailable\n".utf8))
  exit(2)
}

guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
  FileHandle.standardError.write(Data("desktop event tap run loop unavailable\n".utf8))
  exit(3)
}

let runLoop = CFRunLoopGetCurrent()
CFRunLoopAddSource(runLoop, source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
CFRunLoopRun()
