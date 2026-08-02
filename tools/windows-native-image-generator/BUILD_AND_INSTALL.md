# Windows Native Image Generator: build and install

この手順は、Windows Native Image Generator をビルドし、テスト用MSIXへ署名して現在のWindowsユーザーへインストールするためのものです。

## 前提条件

- Windows 11 24H2（ビルド 26100 以降）
- Visual Studio Community 2022 以降の Windows App SDK / WinUI ワークロード
- .NET SDK 8 以降
- Windows App SDK 2.0 Experimental3（`WindowsNativeImageGenerator.csproj` の参照バージョン）

## ビルド

リポジトリルートで実行します。

```powershell
dotnet restore tools/windows-native-image-generator/WindowsNativeImageGenerator.csproj
dotnet build tools/windows-native-image-generator/WindowsNativeImageGenerator.csproj `
  -c Release -p:Platform=x64
```

MSIXを生成するには、`GenerateAppxPackageOnBuild` を指定します。

```powershell
dotnet msbuild tools/windows-native-image-generator/WindowsNativeImageGenerator.csproj `
  /t:Build /p:Configuration=Release /p:Platform=x64 `
  /p:GenerateAppxPackageOnBuild=true
```

生成先は `AppPackages/WindowsNativeImageGenerator_0.1.0.0_x64_Test/` です。

## 開発用証明書で署名

テストMSIXは署名が必要です。開発用証明書はリポジトリ外の一時ディレクトリへ保存してください。

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject 'CN=Kyberion Development' `
  -FriendlyName 'Kyberion Development MSIX' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears(2)

$pfx = Join-Path $env:TEMP 'KyberionDevelopment.pfx'
$password = Read-Host 'PFX password' -AsSecureString
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password

dotnet msbuild tools/windows-native-image-generator/WindowsNativeImageGenerator.csproj `
  /t:Build /p:Configuration=Release /p:Platform=x64 `
  /p:GenerateAppxPackageOnBuild=true `
  /p:PackageCertificateKeyFile="$pfx" `
  /p:PackageCertificatePassword="<PFX password>"
```

`Package.appxmanifest` の `Publisher`（現在は `CN=Kyberion Development`）と、証明書のSubjectを一致させてください。

## インストール

自己署名証明書を信頼済みルートへ登録する操作とMSIXの登録には、管理者PowerShellが必要になる場合があります。

```powershell
$cer = Join-Path $env:TEMP 'KyberionDevelopment.cer'
Export-Certificate -Cert $cert -FilePath $cer
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root

$package = Resolve-Path `
  'tools/windows-native-image-generator/AppPackages/WindowsNativeImageGenerator_0.1.0.0_x64_Test/*.msix'
Add-AppxPackage -Path $package -ForceApplicationShutdown
```

`0x800B0100` は未署名、`0x800B0109` は証明書チェーンが信頼されていない場合のエラーです。後者の場合は、証明書を管理者権限で `Cert:\LocalMachine\Root` に登録してから再実行します。

インストール確認：

```powershell
Get-AppxPackage -Name Kyberion.WindowsNativeImageGenerator |
  Select-Object Name, Version, Status
```

アンインストール：

```powershell
Get-AppxPackage -Name Kyberion.WindowsNativeImageGenerator |
  Remove-AppxPackage
```

## Kyberionからの利用

インストール後、アプリ実行ファイルのパスを指定します。

```powershell
$env:KYBERION_WINDOWS_IMAGE_GENERATOR = 'C:\path\to\WindowsNativeImageGenerator.exe'
```

動作確認：

```powershell
& $env:KYBERION_WINDOWS_IMAGE_GENERATOR --probe-recognition
```

MSIX、`bin/`、`obj/`、証明書ファイルは生成物・秘密情報のため、Gitへ追加しないでください。
