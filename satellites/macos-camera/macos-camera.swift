import AVFoundation
import Foundation
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    print("Usage: swift macos-camera.swift <output_path>")
    exit(1)
}
let outputPath = args[1]

class CameraCapture: NSObject, AVCapturePhotoCaptureDelegate {
    let session = AVCaptureSession()
    let output = AVCapturePhotoOutput()
    var finished = false

    func start() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            print("Error: No camera found.")
            exit(1)
        }

        do {
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) && session.canAddOutput(output) {
                session.addInput(input)
                session.addOutput(output)
                session.sessionPreset = .photo
                session.startRunning()
                
                // Give it a moment to adjust exposure/focus
                Thread.sleep(forTimeInterval: 1.0)
                
                let settings = AVCapturePhotoSettings()
                output.capturePhoto(with: settings, delegate: self)
            }
        } catch {
            print("Error setting up camera: \(error)")
            exit(1)
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error = error {
            print("Error capturing photo: \(error)")
            exit(1)
        }

        if let data = photo.fileDataRepresentation(), let image = NSImage(data: data) {
            if let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) {
                let pngData = bitmap.representation(using: .png, properties: [:])
                try? pngData?.write(to: URL(fileURLWithPath: outputPath))
                print("Photo saved to \(outputPath)")
            }
        }
        finished = true
    }
}

let capture = CameraCapture()
capture.start()

// Keep the script alive until capture is finished
while !capture.finished {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
}
