import CoreAudio
import Foundation

struct DeviceRecord: Codable {
  let uid: String
  let display_name: String
  let direction: String
  let channel_count: Int?
  let supported_sample_rates: [Double]?
  let is_virtual: Bool
  let transport: String?
  let avfoundation_unique_id: String?
}

func propertySize(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope) -> UInt32 {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr else { return 0 }
  return size
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
  let result = value as String
  return result.isEmpty ? nil : result
}

func uint32Property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
  return value
}

func channelCount(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int? {
  let size = propertySize(id, kAudioDevicePropertyStreamConfiguration, scope)
  guard size > 0 else { return nil }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var mutableSize = size
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &mutableSize, list) == noErr else { return nil }
  let buffers = UnsafeMutableAudioBufferListPointer(list)
  return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func sampleRates(_ id: AudioObjectID) -> [Double]? {
  let size = propertySize(id, kAudioDevicePropertyAvailableNominalSampleRates, kAudioObjectPropertyScopeGlobal)
  guard size >= UInt32(MemoryLayout<AudioValueRange>.size) else { return nil }
  let count = Int(size) / MemoryLayout<AudioValueRange>.size
  var ranges = [AudioValueRange](repeating: AudioValueRange(mMinimum: 0, mMaximum: 0), count: count)
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyAvailableNominalSampleRates, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var mutableSize = size
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &mutableSize, &ranges) == noErr else { return nil }
  let common = [16000.0, 24000.0, 44100.0, 48000.0]
  var values = Set<Double>()
  for range in ranges {
    values.insert(range.mMinimum)
    values.insert(range.mMaximum)
    for rate in common where rate >= range.mMinimum && rate <= range.mMaximum { values.insert(rate) }
  }
  return values.sorted()
}

func transportName(_ raw: UInt32?) -> String? {
  guard let raw else { return nil }
  let bytes = [
    UInt8((raw >> 24) & 0xff), UInt8((raw >> 16) & 0xff),
    UInt8((raw >> 8) & 0xff), UInt8(raw & 0xff),
  ]
  let value = String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespacesAndNewlines)
  return value?.isEmpty == false ? value : String(raw)
}

func deviceIDs() -> [AudioDeviceID] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func hasStreams(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Bool {
  propertySize(id, kAudioDevicePropertyStreams, scope) > 0
}

var records: [DeviceRecord] = []
for id in deviceIDs() {
  guard let uid = stringProperty(id, kAudioDevicePropertyDeviceUID),
        let name = stringProperty(id, kAudioObjectPropertyName) else { continue }
  let hasInput = hasStreams(id, kAudioObjectPropertyScopeInput)
  let hasOutput = hasStreams(id, kAudioObjectPropertyScopeOutput)
  guard hasInput || hasOutput else { continue }
  let direction = hasInput && hasOutput ? "duplex" : hasInput ? "input" : "output"
  let channels = max(channelCount(id, kAudioObjectPropertyScopeInput) ?? 0, channelCount(id, kAudioObjectPropertyScopeOutput) ?? 0)
  let transport = transportName(uint32Property(id, kAudioDevicePropertyTransportType))
  let normalizedTransport = transport?.lowercased()
  let virtual = name.range(of: "blackhole|loopback|virtual|null sink", options: .regularExpression) != nil || normalizedTransport == "virt" || normalizedTransport?.contains("virtual") == true
  records.append(DeviceRecord(
    uid: uid,
    display_name: name,
    direction: direction,
    channel_count: channels > 0 ? channels : nil,
    supported_sample_rates: sampleRates(id),
    is_virtual: virtual,
    transport: transport,
    avfoundation_unique_id: uid
  ))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let data = try? encoder.encode(["devices": records]),
   let text = String(data: data, encoding: .utf8) {
  print(text)
}
