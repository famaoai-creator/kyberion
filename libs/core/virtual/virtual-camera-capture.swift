import AVFoundation
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

final class FrameCaptureDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private let outputURL: URL
  private let semaphore: DispatchSemaphore
  private let context = CIContext(options: nil)
  private var didFinish = false
  private var frameCount = 0
  private(set) var lastError: Error?

  init(outputURL: URL, semaphore: DispatchSemaphore) {
    self.outputURL = outputURL
    self.semaphore = semaphore
    super.init()
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection,
  ) {
    guard !didFinish else { return }

    frameCount += 1
    if frameCount < 15 {
      return
    }

    didFinish = true

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      lastError = NSError(
        domain: "virtual-camera-capture",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "missing pixel buffer"],
      )
      semaphore.signal()
      return
    }

    let image = CIImage(cvPixelBuffer: pixelBuffer).oriented(.up)
    guard let colorSpace = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB) else {
      lastError = NSError(
        domain: "virtual-camera-capture",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "missing color space"],
      )
      semaphore.signal()
      return
    }

    guard let cgImage = context.createCGImage(image, from: image.extent) else {
      lastError = NSError(
        domain: "virtual-camera-capture",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "failed to create CGImage"],
      )
      semaphore.signal()
      return
    }

    guard let destination = CGImageDestinationCreateWithURL(
      outputURL as CFURL,
      UTType.jpeg.identifier as CFString,
      1,
      nil,
    ) else {
      lastError = NSError(
        domain: "virtual-camera-capture",
        code: 4,
        userInfo: [NSLocalizedDescriptionKey: "failed to create image destination"],
      )
      semaphore.signal()
      return
    }

    let options: [CFString: Any] = [
      kCGImageDestinationLossyCompressionQuality: 0.92,
      kCGImagePropertyOrientation: 1,
    ]
    CGImageDestinationAddImage(destination, cgImage, options as CFDictionary)
    if !CGImageDestinationFinalize(destination) {
      lastError = NSError(
        domain: "virtual-camera-capture",
        code: 5,
        userInfo: [NSLocalizedDescriptionKey: "failed to finalize image destination"],
      )
    }
    semaphore.signal()
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didDrop sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection,
  ) {
    if didFinish { return }
    didFinish = true
    lastError = NSError(
      domain: "virtual-camera-capture",
      code: 6,
      userInfo: [NSLocalizedDescriptionKey: "video frame dropped"],
    )
    semaphore.signal()
  }
}

func parseArgs() -> (device: String?, output: String) {
  var device: String?
  var output: String?
  let args = Array(CommandLine.arguments.dropFirst())
  var index = 0
  while index < args.count {
    let arg = args[index]
    if arg == "--device" {
      index += 1
      if index < args.count { device = args[index] }
    } else if arg == "--output" {
      index += 1
      if index < args.count { output = args[index] }
    }
    index += 1
  }
  guard let output else {
    fputs("missing --output\n", stderr)
    exit(2)
  }
  return (device: device, output: output)
}

func normalize(_ value: String) -> String {
  value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func pickDevice(preference: String?) -> AVCaptureDevice? {
  let discovery = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
    mediaType: .video,
    position: .unspecified
  )
  let devices = discovery.devices
  if let preference {
    let normalized = normalize(preference)
    if let exact = devices.first(where: { normalize($0.localizedName) == normalized }) {
      return exact
    }
    if let contains = devices.first(where: { normalize($0.localizedName).contains(normalized) }) {
      return contains
    }
  }
  if let defaultDevice = AVCaptureDevice.default(for: .video) {
    return defaultDevice
  }
  return devices.first
}

func run() -> Int32 {
  let parsed = parseArgs()
  let outputURL = URL(fileURLWithPath: parsed.output)
  let device = pickDevice(preference: parsed.device)
  guard let device else {
    fputs("no video device available\n", stderr)
    return 3
  }

  do {
    let input = try AVCaptureDeviceInput(device: device)
    let session = AVCaptureSession()
    session.beginConfiguration()
    if session.canAddInput(input) {
      session.addInput(input)
    } else {
      throw NSError(domain: "virtual-camera-capture", code: 4, userInfo: [NSLocalizedDescriptionKey: "cannot add device input"])
    }

    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    if session.canAddOutput(output) {
      session.addOutput(output)
    } else {
      throw NSError(domain: "virtual-camera-capture", code: 5, userInfo: [NSLocalizedDescriptionKey: "cannot add video output"])
    }

    session.commitConfiguration()

    let semaphore = DispatchSemaphore(value: 0)
    let delegate = FrameCaptureDelegate(outputURL: outputURL, semaphore: semaphore)
    let queue = DispatchQueue(label: "virtual-camera-capture.frames")
    output.setSampleBufferDelegate(delegate, queue: queue)
    session.startRunning()

    if semaphore.wait(timeout: .now() + 30) == .timedOut {
      session.stopRunning()
      throw NSError(domain: "virtual-camera-capture", code: 6, userInfo: [NSLocalizedDescriptionKey: "camera capture timed out"])
    }
    session.stopRunning()

    if let error = delegate.lastError {
      throw error
    }

    return 0
  } catch {
    fputs("\(error.localizedDescription)\n", stderr)
    return 1
  }
}

exit(run())
