import AudioToolbox
import CoreAudio
import Foundation

final class OutputState {
  private let lock = NSLock()
  let bytesPerFrame: Int
  private var data = Data()
  private var ended = false
  private(set) var stopped = false
  private(set) var underrunCount = 0
  private(set) var bytesConsumed = 0

  init(bytesPerFrame: Int) {
    self.bytesPerFrame = bytesPerFrame
  }

  func append(_ chunk: Data) {
    lock.lock(); defer { lock.unlock() }
    data.append(chunk)
  }

  func end() {
    lock.lock(); ended = true; lock.unlock()
  }

  func markStopped() {
    lock.lock(); stopped = true; lock.unlock()
  }

  func fill(_ destination: UnsafeMutableRawPointer, capacity: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    let count = min(capacity, data.count)
    if count > 0 {
      data.copyBytes(to: destination.assumingMemoryBound(to: UInt8.self), count: count)
      data.removeFirst(count)
      bytesConsumed += count
    }
    if count < capacity {
      memset(destination.advanced(by: count), 0, capacity - count)
      if !ended { underrunCount += 1 }
    }
    return ended && data.isEmpty
  }
}

func arg(_ name: String) -> String? {
  let args = Array(CommandLine.arguments.dropFirst())
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func findDevice(uid: String?, label: String?) -> AudioDeviceID? {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return nil }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return nil }
  for id in ids {
    var uidValue: CFString = "" as CFString
    var uidSize = UInt32(MemoryLayout<CFString>.size)
    var uidAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let matchesUid = uid.map { AudioObjectGetPropertyData(id, &uidAddress, 0, nil, &uidSize, &uidValue) == noErr && (uidValue as String) == $0 } ?? false
    var nameValue: CFString = "" as CFString
    var nameSize = UInt32(MemoryLayout<CFString>.size)
    var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let matchesLabel = label.map { AudioObjectGetPropertyData(id, &nameAddress, 0, nil, &nameSize, &nameValue) == noErr && (nameValue as String) == $0 } ?? false
    if matchesUid || matchesLabel {
      return id
    }
  }
  return nil
}

func renderCallback(
  _ userData: UnsafeMutableRawPointer,
  _ actionFlags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
  _ timeStamp: UnsafePointer<AudioTimeStamp>,
  _ busNumber: UInt32,
  _ numberFrames: UInt32,
  _ data: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
  let state = Unmanaged<OutputState>.fromOpaque(userData).takeUnretainedValue()
  guard let data else { return noErr }
  let buffers = UnsafeMutableAudioBufferListPointer(data)
  var shouldStop = false
  for index in 0..<buffers.count {
    guard let destination = buffers[index].mData else { continue }
    let capacity = Int(numberFrames) * state.bytesPerFrame
    shouldStop = state.fill(destination, capacity: capacity) || shouldStop
    buffers[index].mDataByteSize = UInt32(capacity)
  }
  if shouldStop { state.markStopped() }
  return noErr
}

func run() -> Int32 {
  guard let uid = arg("--uid") ?? arg("--label"), let rateText = arg("--sample-rate"), let channelsText = arg("--channels"),
        let rate = Double(rateText), let channels = UInt32(channelsText), channels > 0 else {
    fputs("missing or invalid --uid/--sample-rate/--channels\n", stderr)
    return 2
  }
  guard let device = findDevice(uid: arg("--uid"), label: arg("--label")) else {
    fputs("CoreAudio device UID not found: \(uid)\n", stderr)
    return 3
  }

  var format = AudioStreamBasicDescription(
    mSampleRate: rate,
    mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked,
    mBytesPerPacket: channels * 2,
    mFramesPerPacket: 1,
    mBytesPerFrame: channels * 2,
    mChannelsPerFrame: channels,
    mBitsPerChannel: 16,
    mReserved: 0
  )
  let state = OutputState(bytesPerFrame: Int(format.mBytesPerFrame))
  var audioUnit: AudioUnit?
  let userData = Unmanaged.passUnretained(state).toOpaque()
  var componentDescription = AudioComponentDescription(
    componentType: kAudioUnitType_Output,
    componentSubType: kAudioUnitSubType_HALOutput,
    componentManufacturer: kAudioUnitManufacturer_Apple,
    componentFlags: 0,
    componentFlagsMask: 0
  )
  guard let component = AudioComponentFindNext(nil, &componentDescription) else {
    fputs("HALOutput AudioComponent not found\n", stderr)
    return 4
  }
  guard AudioComponentInstanceNew(component, &audioUnit) == noErr, let audioUnit else {
    fputs("AudioComponentInstanceNew failed\n", stderr)
    return 5
  }
  defer { AudioComponentInstanceDispose(audioUnit) }

  var enabled: UInt32 = 1
  var disabled: UInt32 = 0
  let enableOutputStatus = AudioUnitSetProperty(
    audioUnit,
    kAudioOutputUnitProperty_EnableIO,
    kAudioUnitScope_Output,
    0,
    &enabled,
    UInt32(MemoryLayout<UInt32>.size)
  )
  guard enableOutputStatus == noErr else {
    fputs("HALOutput enable output failed: \(enableOutputStatus)\n", stderr)
    return 6
  }
  let disableInputStatus = AudioUnitSetProperty(
    audioUnit,
    kAudioOutputUnitProperty_EnableIO,
    kAudioUnitScope_Input,
    1,
    &disabled,
    UInt32(MemoryLayout<UInt32>.size)
  )
  guard disableInputStatus == noErr else {
    fputs("HALOutput disable input failed: \(disableInputStatus)\n", stderr)
    return 7
  }

  var selectedDevice = device
  let deviceStatus = withUnsafePointer(to: &selectedDevice) { pointer in
    AudioUnitSetProperty(
      audioUnit,
      kAudioOutputUnitProperty_CurrentDevice,
      kAudioUnitScope_Global,
      0,
      pointer,
      UInt32(MemoryLayout<AudioDeviceID>.size)
    )
  }
  guard deviceStatus == noErr else {
    fputs("HALOutput select CoreAudio output device failed: \(deviceStatus)\n", stderr)
    return 8
  }

  let formatStatus = withUnsafePointer(to: &format) { pointer in
    AudioUnitSetProperty(
      audioUnit,
      kAudioUnitProperty_StreamFormat,
      kAudioUnitScope_Input,
      0,
      pointer,
      UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    )
  }
  guard formatStatus == noErr else {
    fputs("HALOutput set stream format failed: \(formatStatus)\n", stderr)
    return 9
  }

  var callbackStruct = AURenderCallbackStruct(inputProc: renderCallback, inputProcRefCon: userData)
  let callbackStatus = AudioUnitSetProperty(
    audioUnit,
    kAudioUnitProperty_SetRenderCallback,
    kAudioUnitScope_Input,
    0,
    &callbackStruct,
    UInt32(MemoryLayout<AURenderCallbackStruct>.size)
  )
  guard callbackStatus == noErr else {
    fputs("HALOutput set render callback failed: \(callbackStatus)\n", stderr)
    return 10
  }

  let initializeStatus = AudioUnitInitialize(audioUnit)
  guard initializeStatus == noErr else {
    fputs("HALOutput initialize failed: \(initializeStatus)\n", stderr)
    return 11
  }
  defer { AudioUnitUninitialize(audioUnit) }

  let startStatus = AudioOutputUnitStart(audioUnit)
  guard startStatus == noErr else {
    fputs("HALOutput start failed: \(startStatus)\n", stderr)
    return 12
  }
  defer { AudioOutputUnitStop(audioUnit) }

  while true {
    let chunk = FileHandle.standardInput.readData(ofLength: 64 * 1024)
    if chunk.isEmpty { break }
    state.append(chunk)
  }
  state.end()
  while !state.stopped { usleep(10_000) }
  let payload: [String: Any] = [
    "status": "ok",
    "device_uid": uid,
    "sample_rate_hz": rate,
    "channels": channels,
    "underrun_count": state.underrunCount,
    "bytes_consumed": state.bytesConsumed,
  ]
  if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
     let output = String(data: data, encoding: .utf8) { print(output) }
  return 0
}

exit(run())
