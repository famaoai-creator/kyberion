import CoreAudio
import Foundation

func parseArgs() -> (device: String, tonePath: String) {
  var device: String?
  var tonePath: String?
  let args = Array(CommandLine.arguments.dropFirst())
  var index = 0
  while index < args.count {
    let arg = args[index]
    if arg == "--device" {
      index += 1
      if index < args.count { device = args[index] }
    } else if arg == "--tone-path" {
      index += 1
      if index < args.count { tonePath = args[index] }
    }
    index += 1
  }
  guard let device, let tonePath else {
    fputs("missing --device or --tone-path\n", stderr)
    exit(2)
  }
  return (device: device, tonePath: tonePath)
}

func normalize(_ value: String) -> String {
  value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func listDevices() -> [AudioDeviceID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  let objectId = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(objectId, &address, 0, nil, &size) == noErr else {
    return []
  }
  let count = Int(size) / MemoryLayout<AudioDeviceID>.size
  guard count > 0 else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: count)
  guard AudioObjectGetPropertyData(objectId, &address, 0, nil, &size, &ids) == noErr else {
    return []
  }
  return ids
}

func deviceName(_ id: AudioDeviceID) -> String? {
  var name: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioObjectPropertyName,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr else {
    return nil
  }
  return name as String
}

func pickDevice(name: String) -> AudioDeviceID? {
  let devices = listDevices()
  let normalized = normalize(name)
  if let exact = devices.first(where: { deviceName($0).map { normalize($0) } == normalized }) {
    return exact
  }
  if let contains = devices.first(where: { deviceName($0).map { normalize($0).contains(normalized) } == true }) {
    return contains
  }
  return nil
}

func defaultOutputDevice() -> AudioDeviceID? {
  var device = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject),
    &address,
    0,
    nil,
    &size,
    &device
  )
  return status == noErr ? device : nil
}

func setDefaultOutputDevice(_ device: AudioDeviceID) -> OSStatus {
  var value = device
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  return AudioObjectSetPropertyData(
    AudioObjectID(kAudioObjectSystemObject),
    &address,
    0,
    nil,
    size,
    &value
  )
}

func playTone(path: String) -> Int32 {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
  process.arguments = [path]
  do {
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  } catch {
    fputs("afplay failed: \(error.localizedDescription)\n", stderr)
    return 1
  }
}

func run() -> Int32 {
  let parsed = parseArgs()
  guard let target = pickDevice(name: parsed.device) else {
    fputs("output device not found: \(parsed.device)\n", stderr)
    return 3
  }
  let previous = defaultOutputDevice()
  let previousName = previous.flatMap(deviceName)
  let targetName = deviceName(target) ?? parsed.device
  defer {
    if let previous {
      _ = setDefaultOutputDevice(previous)
      usleep(250_000)
    }
  }

  let status = setDefaultOutputDevice(target)
  if status != noErr {
    fputs("failed to set default output device (\(status))\n", stderr)
    return 4
  }

  usleep(350_000)
  let playStatus = playTone(path: parsed.tonePath)
  if playStatus != 0 {
    return playStatus
  }

  let payload: [String: Any] = [
    "status": "ok",
    "selected_device": targetName,
    "previous_device": previousName as Any,
    "tone_path": parsed.tonePath,
  ]
  if let json = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
     let text = String(data: json, encoding: .utf8) {
    print(text)
  }
  return 0
}

exit(run())
