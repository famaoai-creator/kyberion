import path from 'node:path';
import type {
  ContinuousOwnerChildProcess,
  ContinuousOwnerPlatformAdapter,
} from './continuous_owner_platform.js';

/** Run the requested command inside a kill-on-close Windows Job Object. */
function windowsJobRunner(): { command: string; args: string[] } {
  const powershell = path.win32.join(
    process.env.SystemRoot?.trim() || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadText.Trim())) | ConvertFrom-Json
$jobSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class KyberionContinuousJob {
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimitInformation {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation; public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    public static IntPtr CreateKillOnCloseJob() {
        IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateJobObject failed");
        ExtendedLimitInformation info=new ExtendedLimitInformation(); info.BasicLimitInformation.LimitFlags=0x00002000;
        int size=Marshal.SizeOf(typeof(ExtendedLimitInformation)); IntPtr buffer=Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(info,buffer,false); if(!SetInformationJobObject(job,9,buffer,(uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error(),"SetInformationJobObject failed"); }
        finally { Marshal.FreeHGlobal(buffer); }
        if(!AssignProcessToJobObject(job,GetCurrentProcess())) throw new Win32Exception(Marshal.GetLastWin32Error(),"AssignProcessToJobObject failed; refusing unsupervised execution");
        return job;
    }
}
'@
Add-Type -TypeDefinition $jobSource -ErrorAction Stop
$job = [KyberionContinuousJob]::CreateKillOnCloseJob()
function Quote-WindowsArgument([string] $value) {
  if ($value.Length -gt 0 -and $value -notmatch '[\s"]') { return $value }
  $builder = New-Object System.Text.StringBuilder; [void]$builder.Append('"'); $slashes = 0
  foreach ($character in $value.ToCharArray()) {
    if ($character -eq '\') { $slashes++; continue }
    if ($character -eq '"') { [void]$builder.Append(('\' * (2 * $slashes + 1))); [void]$builder.Append('"') }
    else { [void]$builder.Append(('\' * $slashes)); [void]$builder.Append($character) }
    $slashes = 0
  }
  [void]$builder.Append(('\' * (2 * $slashes))); [void]$builder.Append('"'); return $builder.ToString()
}
$start=New-Object System.Diagnostics.ProcessStartInfo; $start.FileName=[string]$payload.command
$start.Arguments=(@($payload.args | ForEach-Object { Quote-WindowsArgument ([string]$_) }) -join ' ')
$start.WorkingDirectory=[string]$payload.cwd; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
$process=New-Object System.Diagnostics.Process; $process.StartInfo=$start
if (-not $process.Start()) { exit 126 }
$stderrTask=$process.StandardError.ReadToEndAsync()
while ($null -ne ($stdoutLine=$process.StandardOutput.ReadLine())) { [Console]::Out.WriteLine($stdoutLine) }
$process.WaitForExit(); [Console]::Error.Write($stderrTask.Result)
$exitCode=$process.ExitCode
exit $exitCode
`;
  return {
    command: powershell,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  };
}

function terminateWindowsWrapper(child: ContinuousOwnerChildProcess): void {
  if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
}

export const windowsContinuousOwnerPlatform: ContinuousOwnerPlatformAdapter = {
  createInvocation(command, args, cwd) {
    const wrapper = windowsJobRunner();
    return {
      ...wrapper,
      detached: false,
      stdin: 'pipe',
      writeInput(child, onError) {
        const payload = Buffer.from(JSON.stringify({ command, args, cwd }), 'utf8').toString(
          'base64'
        );
        child.stdin?.on('error', onError);
        child.stdin?.end(payload);
      },
      terminate: (child, _onError) => terminateWindowsWrapper(child),
    };
  },
};
