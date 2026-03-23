import Foundation
import AVFoundation
import Speech
import CoreAudio

struct STTResult: Codable {
  let ok: Bool
  let text: String?
  let error: String?
  let locale: String
  let isFinal: Bool
}

struct InputDeviceInfo: Codable {
  let id: UInt32
  let uid: String
  let name: String
  let isDefault: Bool
}

struct DeviceListResult: Codable {
  let ok: Bool
  let devices: [InputDeviceInfo]
  let defaultDeviceUID: String?
  let error: String?
}

struct MeterSample: Codable {
  let rms: Float
  let peak: Float
}

struct MeterResult: Codable {
  let ok: Bool
  let deviceUID: String?
  let locale: String
  let elapsedMs: Int
  let samples: [MeterSample]
  let error: String?
}

struct RecordResult: Codable {
  let ok: Bool
  let deviceUID: String?
  let locale: String
  let elapsedMs: Int
  let outputPath: String
  let error: String?
}

func emit(_ result: STTResult) -> Never {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  let data = try! encoder.encode(result)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(result.ok ? 0 : 1)
}

func parseArg(_ name: String, default fallback: String) -> String {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else {
    return fallback
  }
  return args[index + 1]
}

func hasFlag(_ name: String) -> Bool {
  CommandLine.arguments.contains(name)
}

func audioObjectString(_ objectID: AudioObjectID, selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: scope,
    mElement: kAudioObjectPropertyElementMain
  )
  var dataSize: UInt32 = 0
  var status = AudioObjectGetPropertyDataSize(objectID, &address, 0, nil, &dataSize)
  guard status == noErr else { return nil }
  var cfString: CFString = "" as CFString
  status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &dataSize, &cfString)
  guard status == noErr else { return nil }
  return cfString as String
}

func inputChannelCount(_ deviceID: AudioDeviceID) -> Int {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamConfiguration,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
  )
  var dataSize: UInt32 = 0
  var status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &dataSize)
  guard status == noErr else { return 0 }
  let bufferList = UnsafeMutableRawPointer.allocate(byteCount: Int(dataSize), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { bufferList.deallocate() }
  status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, bufferList)
  guard status == noErr else { return 0 }
  let audioBufferList = bufferList.assumingMemoryBound(to: AudioBufferList.self)
  let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
  return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func defaultInputDeviceID() -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var deviceID = AudioDeviceID(0)
  var dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &deviceID)
  return status == noErr ? deviceID : nil
}

func setDefaultInputDeviceID(_ deviceID: AudioDeviceID) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var mutableDeviceID = deviceID
  let dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, dataSize, &mutableDeviceID)
  return status == noErr
}

func listInputDevices() -> [InputDeviceInfo] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var dataSize: UInt32 = 0
  let sizeStatus = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize)
  guard sizeStatus == noErr else { return [] }
  let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
  var ids = Array(repeating: AudioDeviceID(0), count: count)
  let dataStatus = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids)
  guard dataStatus == noErr else { return [] }
  let defaultID = defaultInputDeviceID()
  return ids.compactMap { id in
    let channels = inputChannelCount(id)
    guard channels > 0 else { return nil }
    let name = audioObjectString(id, selector: kAudioObjectPropertyName) ?? "Unknown Input"
    let uid = audioObjectString(id, selector: kAudioDevicePropertyDeviceUID) ?? "\(id)"
    return InputDeviceInfo(id: id, uid: uid, name: name, isDefault: defaultID == id)
  }
}

func speechPermission() -> SFSpeechRecognizerAuthorizationStatus {
  let semaphore = DispatchSemaphore(value: 0)
  var status: SFSpeechRecognizerAuthorizationStatus = .notDetermined
  SFSpeechRecognizer.requestAuthorization {
    status = $0
    semaphore.signal()
  }
  _ = semaphore.wait(timeout: .now() + 10)
  return status
}

func microphonePermission() -> Bool {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized:
    return true
  case .notDetermined:
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) {
      granted = $0
      semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 10)
    return granted
  default:
    return false
  }
}

final class STTSession {
  private let locale: String
  private let timeoutSeconds: TimeInterval
  private let targetDeviceUID: String?
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var timer: DispatchSourceTimer?
  private let completion = DispatchSemaphore(value: 0)
  private var finished = false
  private var bestText = ""
  private var finalResult: STTResult?
  private var previousDefaultInputID: AudioDeviceID?

  init(locale: String, timeoutSeconds: TimeInterval, targetDeviceUID: String?) {
    self.locale = locale
    self.timeoutSeconds = timeoutSeconds
    self.targetDeviceUID = targetDeviceUID
  }

  func run() -> STTResult {
    let speechAuth = speechPermission()
    guard speechAuth == .authorized else {
      return STTResult(ok: false, text: nil, error: "speech_permission_\(speechAuth.rawValue)", locale: locale, isFinal: false)
    }

    guard microphonePermission() else {
      return STTResult(ok: false, text: nil, error: "microphone_permission_denied", locale: locale, isFinal: false)
    }

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) ?? SFSpeechRecognizer() else {
      return STTResult(ok: false, text: nil, error: "speech_recognizer_unavailable", locale: locale, isFinal: false)
    }
    guard recognizer.isAvailable else {
      return STTResult(ok: false, text: nil, error: "speech_recognizer_not_available", locale: locale, isFinal: false)
    }

    if let targetDeviceUID, !targetDeviceUID.isEmpty {
      let devices = listInputDevices()
      guard let target = devices.first(where: { $0.uid == targetDeviceUID || $0.name == targetDeviceUID }) else {
        return STTResult(ok: false, text: nil, error: "input_device_not_found", locale: locale, isFinal: false)
      }
      previousDefaultInputID = defaultInputDeviceID()
      guard setDefaultInputDeviceID(AudioDeviceID(target.id)) else {
        return STTResult(ok: false, text: nil, error: "failed_to_set_input_device", locale: locale, isFinal: false)
      }
    }

    do {
      request = SFSpeechAudioBufferRecognitionRequest()
      request?.shouldReportPartialResults = true

      let inputNode = engine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        self?.request?.append(buffer)
      }

      engine.prepare()
      try engine.start()
      scheduleTimeout()

      task = recognizer.recognitionTask(with: request!) { [weak self] result, error in
        guard let self else { return }
        if let result {
          let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
          if !text.isEmpty {
            self.bestText = text
          }
          if result.isFinal {
            self.finish(ok: true, text: self.bestText, error: nil, isFinal: true)
          }
        }

        if let error, !self.finished {
          if !self.bestText.isEmpty {
            self.finish(ok: true, text: self.bestText, error: nil, isFinal: false)
          } else {
            self.finish(ok: false, text: nil, error: error.localizedDescription, isFinal: false)
          }
        }
      }

      _ = completion.wait(timeout: .now() + timeoutSeconds + 5)
      return finalResult ?? STTResult(ok: false, text: nil, error: "stt_completion_timeout", locale: locale, isFinal: false)
    } catch {
      cleanup()
      return STTResult(ok: false, text: nil, error: error.localizedDescription, locale: locale, isFinal: false)
    }
  }

  private func scheduleTimeout() {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
    timer.schedule(deadline: .now() + timeoutSeconds)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      if !self.bestText.isEmpty {
        self.finish(ok: true, text: self.bestText, error: nil, isFinal: false)
      } else {
        self.finish(ok: false, text: nil, error: "timeout_no_speech", isFinal: false)
      }
    }
    self.timer = timer
    timer.resume()
  }

  private func cleanup() {
    timer?.cancel()
    timer = nil
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    if let previousDefaultInputID {
      _ = setDefaultInputDeviceID(previousDefaultInputID)
      self.previousDefaultInputID = nil
    }
  }

  private func finish(ok: Bool, text: String?, error: String?, isFinal: Bool) {
    if finished { return }
    finished = true
    cleanup()
    finalResult = STTResult(ok: ok, text: text, error: error, locale: locale, isFinal: isFinal)
    completion.signal()
  }
}

final class MeterSession {
  private let durationSeconds: TimeInterval
  private let targetDeviceUID: String?
  private let engine = AVAudioEngine()
  private var previousDefaultInputID: AudioDeviceID?
  private var samples: [MeterSample] = []

  init(durationSeconds: TimeInterval, targetDeviceUID: String?) {
    self.durationSeconds = durationSeconds
    self.targetDeviceUID = targetDeviceUID
  }

  func run(locale: String) -> MeterResult {
    guard microphonePermission() else {
      return MeterResult(ok: false, deviceUID: targetDeviceUID, locale: locale, elapsedMs: 0, samples: [], error: "microphone_permission_denied")
    }

    if let targetDeviceUID, !targetDeviceUID.isEmpty {
      let devices = listInputDevices()
      guard let target = devices.first(where: { $0.uid == targetDeviceUID || $0.name == targetDeviceUID }) else {
        return MeterResult(ok: false, deviceUID: targetDeviceUID, locale: locale, elapsedMs: 0, samples: [], error: "input_device_not_found")
      }
      previousDefaultInputID = defaultInputDeviceID()
      guard setDefaultInputDeviceID(AudioDeviceID(target.id)) else {
        return MeterResult(ok: false, deviceUID: targetDeviceUID, locale: locale, elapsedMs: 0, samples: [], error: "failed_to_set_input_device")
      }
    }

    let start = Date()
    do {
      let inputNode = engine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
        guard let self else { return }
        guard let channel = buffer.floatChannelData?[0] else { return }
        let frameCount = Int(buffer.frameLength)
        if frameCount == 0 { return }
        var sum: Float = 0
        var peak: Float = 0
        for index in 0..<frameCount {
          let sample = channel[index]
          let absSample = abs(sample)
          sum += sample * sample
          if absSample > peak { peak = absSample }
        }
        let rms = sqrt(sum / Float(frameCount))
        self.samples.append(MeterSample(rms: rms, peak: peak))
      }

      engine.prepare()
      try engine.start()
      RunLoop.current.run(until: Date().addingTimeInterval(durationSeconds))
      cleanup()
      return MeterResult(
        ok: true,
        deviceUID: targetDeviceUID,
        locale: locale,
        elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
        samples: samples.suffix(20),
        error: nil
      )
    } catch {
      cleanup()
      return MeterResult(
        ok: false,
        deviceUID: targetDeviceUID,
        locale: locale,
        elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
        samples: samples.suffix(20),
        error: error.localizedDescription
      )
    }
  }

  private func cleanup() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    if let previousDefaultInputID {
      _ = setDefaultInputDeviceID(previousDefaultInputID)
      self.previousDefaultInputID = nil
    }
  }
}

final class RecordSession {
  private let durationSeconds: TimeInterval
  private let targetDeviceUID: String?
  private let outputPath: String
  private let engine = AVAudioEngine()
  private var previousDefaultInputID: AudioDeviceID?

  init(durationSeconds: TimeInterval, targetDeviceUID: String?, outputPath: String) {
    self.durationSeconds = durationSeconds
    self.targetDeviceUID = targetDeviceUID
    self.outputPath = outputPath
  }

  func run(locale: String) -> RecordResult {
    guard microphonePermission() else {
      return RecordResult(ok: false, deviceUID: targetDeviceUID, locale: locale, elapsedMs: 0, outputPath: outputPath, error: "microphone_permission_denied")
    }

    if let targetDeviceUID, !targetDeviceUID.isEmpty {
      let devices = listInputDevices()
      guard let target = devices.first(where: { $0.uid == targetDeviceUID || $0.name == targetDeviceUID }) else {
        return RecordResult(ok: false, deviceUID: targetDeviceUID, locale: locale, elapsedMs: 0, outputPath: outputPath, error: "input_device_not_found")
      }
      previousDefaultInputID = defaultInputDeviceID()
      guard setDefaultInputDeviceID(AudioDeviceID(target.id)) else {
        return RecordResult(ok: false, deviceUID: targetDeviceUID, locale: locale, elapsedMs: 0, outputPath: outputPath, error: "failed_to_set_input_device")
      }
    }

    let start = Date()
    do {
      let inputNode = engine.inputNode
      let format = inputNode.outputFormat(forBus: 0)
      let outputURL = URL(fileURLWithPath: outputPath)
      try? FileManager.default.removeItem(at: outputURL)
      let audioFile = try AVAudioFile(forWriting: outputURL, settings: format.settings)

      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
        do {
          try audioFile.write(from: buffer)
        } catch {
          // ignore per-buffer write errors and let final result capture the file state
        }
      }

      engine.prepare()
      try engine.start()
      RunLoop.current.run(until: Date().addingTimeInterval(durationSeconds))
      cleanup()
      return RecordResult(
        ok: true,
        deviceUID: targetDeviceUID,
        locale: locale,
        elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
        outputPath: outputPath,
        error: nil
      )
    } catch {
      cleanup()
      return RecordResult(
        ok: false,
        deviceUID: targetDeviceUID,
        locale: locale,
        elapsedMs: Int(Date().timeIntervalSince(start) * 1000),
        outputPath: outputPath,
        error: error.localizedDescription
      )
    }
  }

  private func cleanup() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    if let previousDefaultInputID {
      _ = setDefaultInputDeviceID(previousDefaultInputID)
      self.previousDefaultInputID = nil
    }
  }
}

if hasFlag("--list-devices") {
  let devices = listInputDevices()
  let result = DeviceListResult(
    ok: true,
    devices: devices,
    defaultDeviceUID: devices.first(where: { $0.isDefault })?.uid,
    error: nil
  )
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  let data = try! encoder.encode(result)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

let locale = parseArg("--locale", default: Locale.current.identifier)
let timeout = Double(parseArg("--timeout", default: "8")) ?? 8
let deviceUID = parseArg("--device-id", default: "")
if hasFlag("--meter") {
  let meter = MeterSession(durationSeconds: timeout, targetDeviceUID: deviceUID.isEmpty ? nil : deviceUID)
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  let data = try! encoder.encode(meter.run(locale: locale))
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}
let outputPath = parseArg("--output", default: "")
if hasFlag("--record-wav") {
  if outputPath.isEmpty {
    let result = RecordResult(ok: false, deviceUID: deviceUID.isEmpty ? nil : deviceUID, locale: locale, elapsedMs: 0, outputPath: outputPath, error: "output_path_required")
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try! encoder.encode(result)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(1)
  }
  let recorder = RecordSession(durationSeconds: timeout, targetDeviceUID: deviceUID.isEmpty ? nil : deviceUID, outputPath: outputPath)
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  let data = try! encoder.encode(recorder.run(locale: locale))
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}
let session = STTSession(locale: locale, timeoutSeconds: timeout, targetDeviceUID: deviceUID.isEmpty ? nil : deviceUID)
emit(session.run())
