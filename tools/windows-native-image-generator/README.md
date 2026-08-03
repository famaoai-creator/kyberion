# Kyberion Windows Native Image Generator

This is the packaged WinAppSDK helper used by `windows-native-image-generation-bridge.ts`.

Requirements:

- Visual Studio Community with Windows App SDK / WinUI workload
- Windows 11 24H2 (build 26100+) and a Copilot+ NPU
- Windows App SDK 2.0 Experimental3
- MSIX package identity and the `systemAIModels` capability

Build from a Visual Studio Developer PowerShell:

```powershell
dotnet restore
dotnet build -c Release -p:Platform=x64
```

After installing the MSIX, point Kyberion at the helper executable:

```powershell
$env:KYBERION_WINDOWS_IMAGE_GENERATOR = "C:\path\to\WindowsNativeImageGenerator.exe"
```

The helper also hosts native OCR and image description:

```powershell
& $env:KYBERION_WINDOWS_IMAGE_GENERATOR --probe-recognition
& $env:KYBERION_WINDOWS_IMAGE_GENERATOR --ocr --input C:\path\image.png
& $env:KYBERION_WINDOWS_IMAGE_GENERATOR --describe --input C:\path\image.png
```

Kyberion automatically selects `windows_native` in its OCR router when the
Windows AI model is ready. Image captions are available through the exported
`describeImageWithWindowsNativeApi` bridge.
