import AppKit
import ApplicationServices
import CoreGraphics
import CoreServices
func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) else { exit(1) }
  print(text)
}
// SDK AppleEvents.h: target must be running, askUserIfNeeded=false never prompts.
func automationPermission(_ bundle: String) -> String {
  guard #available(macOS 10.14, *) else { return "unsupported" }
  guard !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty else { return "unknown" }
  let target = NSAppleEventDescriptor(bundleIdentifier: bundle)
  guard let descriptor = target.aeDesc else { return "unknown" }
  let status = AEDeterminePermissionToAutomateTarget(descriptor, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
  switch status {
  case noErr: return "granted"
  case -1743: return "denied" // errAEEventNotPermitted
  default: return "unknown" // includes -1744 (consent undetermined), procNotFound
  }
}
func fail() -> Never { emit(["ok": false]); exit(1) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var result: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
  return result
}
func text(_ element: AXUIElement, _ name: String) -> String { attr(element,name) as? String ?? "" }
func ax(_ value: CFTypeRef?) -> AXUIElement? {
  guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}
func number(_ p: [String: Any], _ key: String) -> Double {
  guard let v = p[key] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.doubleValue.isFinite, abs(v.doubleValue) <= 100000 else { fail() }
  return v.doubleValue
}
func amount(_ p: [String: Any], _ key: String, _ fallback: Int, _ maximum: Int) -> Int {
  guard p[key] != nil else { return fallback }
  let v = number(p,key)
  guard v.rounded() == v, v >= 1, v <= Double(maximum) else { fail() }
  return Int(v)
}
func event(_ kind: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left) -> CGEvent {
  guard let e = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: point, mouseButton: button) else { fail() }
  return e
}
guard CommandLine.arguments.count == 3, let data = CommandLine.arguments[2].data(using: .utf8), let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { fail() }
switch CommandLine.arguments[1] {
case "probe":
  let screen: String
  if #available(macOS 10.15, *) { screen = CGPreflightScreenCaptureAccess() ? "granted" : "denied" } else { screen = "unsupported" }
  emit(["automation": automationPermission("com.apple.systemevents"), "browser_automation": automationPermission("com.google.Chrome"), "accessibility": AXIsProcessTrusted() ? "granted" : "denied", "screen_recording": screen])
case "screen":
  let bounds = CGDisplayBounds(CGMainDisplayID())
  emit(["width": bounds.width, "height": bounds.height])
case "windows":
  guard AXIsProcessTrusted(), let name = p["application"] as? String, !name.isEmpty, name.count <= 256 else { fail() }
  var titles: [String] = []
  for app in NSWorkspace.shared.runningApplications where app.localizedName == name || app.bundleIdentifier == name {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 1)
    guard let windows = attr(element,kAXWindowsAttribute) as? [AXUIElement], windows.count <= 1000 else { fail() }
    titles.append(contentsOf: windows.map { text($0,kAXTitleAttribute) })
  }
  emit(["windows": titles])
case "focused":
  guard AXIsProcessTrusted() else { fail() }
  guard let app = NSWorkspace.shared.frontmostApplication else {
    emit(["application":"", "windowTitle":"", "role":"", "description":"", "editable":false])
    exit(0)
  }
  let element = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(element,1)
  var focusedValue: CFTypeRef?
  let focusedStatus = AXUIElementCopyAttributeValue(element,kAXFocusedUIElementAttribute as CFString,&focusedValue)
  let window = ax(attr(element,kAXFocusedWindowAttribute))
  if focusedStatus == .noValue || focusedStatus == .attributeUnsupported {
    // Normal app focus without a focused control; preserve app/window metadata.
    emit(["application":app.localizedName ?? "", "windowTitle":window.map { text($0,kAXTitleAttribute) } ?? "", "role":"", "description":"", "editable":false])
    exit(0)
  }
  guard focusedStatus == .success, let focused = ax(focusedValue) else { fail() }
  let role = text(focused,kAXRoleAttribute)
  // Never request AXValue: focused text may contain credentials.
  emit(["application": app.localizedName ?? "", "windowTitle": window.map { text($0,kAXTitleAttribute) } ?? "", "role": role, "description": text(focused,kAXDescriptionAttribute), "editable": [kAXTextFieldRole,kAXTextAreaRole,kAXComboBoxRole].contains(role)])
case "mouse":
  guard AXIsProcessTrusted(), let type = p["type"] as? String else { fail() }
  var events: [CGEvent] = []
  switch type {
  case "move": events = [event(.mouseMoved,CGPoint(x:number(p,"x"),y:number(p,"y")))]
  case "click":
    let point = CGPoint(x:number(p,"x"),y:number(p,"y"))
    let name = p["button"] as? String ?? "left"
    guard ["left","right"].contains(name) else { fail() }
    let right = name == "right"
    for count in 1...amount(p,"count",1,10) {
      let down = event(right ? .rightMouseDown : .leftMouseDown,point,right ? .right : .left)
      let up = event(right ? .rightMouseUp : .leftMouseUp,point,right ? .right : .left)
      down.setIntegerValueField(.mouseEventClickState,value:Int64(count))
      up.setIntegerValueField(.mouseEventClickState,value:Int64(count))
      events.append(contentsOf:[down,up])
    }
  case "scroll":
    let point = CGPoint(x:number(p,"x"),y:number(p,"y"))
    guard let direction = p["direction"] as? String, ["up","down","left","right"].contains(direction) else { fail() }
    let delta = Int32(amount(p,"amount",3,1000))
    let vertical: Int32 = direction == "up" ? delta : direction == "down" ? -delta : 0
    let horizontal: Int32 = direction == "left" ? delta : direction == "right" ? -delta : 0
    guard let scroll = CGEvent(scrollWheelEvent2Source:nil,units:.line,wheelCount:2,wheel1:vertical,wheel2:horizontal,wheel3:0) else { fail() }
    scroll.location = point
    events = [event(.mouseMoved,point),scroll]
  case "drag":
    let start = CGPoint(x:number(p,"fromX"),y:number(p,"fromY"))
    let end = CGPoint(x:number(p,"toX"),y:number(p,"toY"))
    events = [event(.mouseMoved,start),event(.leftMouseDown,start)]
    for step in 1...20 {
      let t = Double(step)/20
      events.append(event(.leftMouseDragged,CGPoint(x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t)))
    }
    events.append(event(.leftMouseUp,end))
  default: fail()
  }
  // Construct the entire sequence first; recheck trust immediately before injection.
  guard AXIsProcessTrusted() else { fail() }
  for e in events { e.post(tap:.cghidEventTap); Thread.sleep(forTimeInterval:0.02) }
  emit(["ok":true])
default: fail()
}
