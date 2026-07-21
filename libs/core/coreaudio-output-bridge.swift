import AudioToolbox
import CoreAudio
import Foundation

final class OutputState {
  private let lock = NSLock()
  private var data = Data()
  private var ended = false
  private(set) var stopped = false
  private(set) var underrunCount = 0
  private(set) var bytesConsumed = 0

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

func callback(_ userData: UnsafeMutableRawPointer?, _ queue: AudioQueueRef, _ buffer: AudioQueueBufferRef) {
  guard let userData else { return }
  let state = Unmanaged<OutputState>.fromOpaque(userData).takeUnretainedValue()
  let shouldStop = state.fill(buffer.pointee.mAudioData, capacity: Int(buffer.pointee.mAudioDataBytesCapacity))
  buffer.pointee.mAudioDataByteSize = buffer.pointee.mAudioDataBytesCapacity
  if shouldStop {
    state.markStopped()
    AudioQueueStop(queue, false)
    return
  }
  AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
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
  let state = OutputState()
  var queue: AudioQueueRef?
  let userData = Unmanaged.passUnretained(state).toOpaque()
  guard AudioQueueNewOutput(&format, callback, userData, nil, nil, 0, &queue) == noErr, let queue else {
    fputs("AudioQueueNewOutput failed\n", stderr)
    return 4
  }
  defer { AudioQueueDispose(queue, true) }
  var selectedDevice = device
  let deviceStatus = withUnsafePointer(to: &selectedDevice) { pointer in
    AudioQueueSetProperty(queue, kAudioQueueProperty_CurrentDevice, pointer, UInt32(MemoryLayout<AudioDeviceID>.size))
  }
  guard deviceStatus == noErr else {
    fputs("failed to select CoreAudio output device\n", stderr)
    return 5
  }

  let bufferSize = max(1024, Int(rate * Double(format.mBytesPerFrame) * 0.02))
  for _ in 0..<4 {
    var buffer: AudioQueueBufferRef?
    guard AudioQueueAllocateBuffer(queue, UInt32(bufferSize), &buffer) == noErr, let buffer else { return 6 }
    let shouldStop = state.fill(buffer.pointee.mAudioData, capacity: bufferSize)
    buffer.pointee.mAudioDataByteSize = UInt32(bufferSize)
    guard AudioQueueEnqueueBuffer(queue, buffer, 0, nil) == noErr else { return 7 }
    if shouldStop { break }
  }
  guard AudioQueueStart(queue, nil) == noErr else {
    fputs("AudioQueueStart failed\n", stderr)
    return 8
  }

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
