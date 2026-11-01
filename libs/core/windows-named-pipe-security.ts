import { safeExecResultAsync } from './secure-io.js';
import { powerShellStdinArgs, windowsPowerShellEnv } from './windows-powershell.js';
import { isWindowsNamedPipeAddress } from './local-ipc.js';

const PIPE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$pipe = '__PIPE_ENDPOINT__'
if ($pipe -notmatch '^\\\\\.\\pipe\\kyberion-[a-f0-9]{40}$') { throw 'unexpected Kyberion pipe name' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$sid)"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KyberionPipeAcl {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
 [DllImport("advapi32.dll", SetLastError=true)]
 public static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
 [DllImport("advapi32.dll", SetLastError=true)]
 public static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
 [DllImport("advapi32.dll", SetLastError=true)]
 public static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint info, IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr sddl, out uint length);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
}
'@
$handle = [KyberionPipeAcl]::CreateFile($pipe, 0x00060000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($handle -eq [IntPtr](-1)) { throw "Cannot open named pipe for ACL update: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$descriptor = [IntPtr]::Zero
try {
  if (-not [KyberionPipeAcl]::ConvertStringSecurityDescriptorToSecurityDescriptor($sddl, 1, [ref]$descriptor, [IntPtr]::Zero)) { throw 'Cannot create named pipe security descriptor' }
  $present = $false; $defaulted = $false; $dacl = [IntPtr]::Zero
  if (-not [KyberionPipeAcl]::GetSecurityDescriptorDacl($descriptor, [ref]$present, [ref]$dacl, [ref]$defaulted) -or -not $present) { throw 'Cannot read named pipe DACL' }
  $result = [KyberionPipeAcl]::SetSecurityInfo($handle, 6, 4, [IntPtr]::Zero, [IntPtr]::Zero, $dacl, [IntPtr]::Zero)
  if ($result -ne 0) { throw "Cannot restrict named pipe DACL: $result" }
  $actualDacl = [IntPtr]::Zero; $actualDescriptor = [IntPtr]::Zero; $actualSddl = [IntPtr]::Zero; $length = 0
  $result = [KyberionPipeAcl]::GetSecurityInfo($handle, 6, 4, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$actualDacl, [IntPtr]::Zero, [ref]$actualDescriptor)
  if ($result -ne 0) { throw "Cannot verify named pipe DACL: $result" }
  try {
    if (-not [KyberionPipeAcl]::ConvertSecurityDescriptorToStringSecurityDescriptor($actualDescriptor, 1, 4, [ref]$actualSddl, [ref]$length)) { throw 'Cannot serialize updated named pipe DACL' }
    $verifiedSddl = [Runtime.InteropServices.Marshal]::PtrToStringUni($actualSddl)
    if ($verifiedSddl -notmatch [regex]::Escape($sid) -or $verifiedSddl -match '\(A;;[^;]*;;;(?:WD|AN)\)') { throw "Named pipe DACL verification failed: $verifiedSddl" }
  } finally {
    if ($actualSddl -ne [IntPtr]::Zero) { [void][KyberionPipeAcl]::LocalFree($actualSddl) }
    if ($actualDescriptor -ne [IntPtr]::Zero) { [void][KyberionPipeAcl]::LocalFree($actualDescriptor) }
  }
} finally {
  if ($descriptor -ne [IntPtr]::Zero) { [void][KyberionPipeAcl]::LocalFree($descriptor) }
  [void][KyberionPipeAcl]::CloseHandle($handle)
}
`;

/** Replace the default Windows named-pipe DACL with user, SYSTEM, and Administrators only. */
export async function restrictWindowsNamedPipeAcl(address: string): Promise<void> {
  if (!isWindowsNamedPipeAddress(address)) return;
  // isWindowsNamedPipeAddress restricts this to the canonical ASCII pipe
  // format, and PowerShell single-quote escaping keeps the value literal.
  const script = PIPE_ACL_SCRIPT.replace('__PIPE_ENDPOINT__', address.replaceAll("'", "''"));
  const result = await safeExecResultAsync('powershell.exe', powerShellStdinArgs(), {
    input: script,
    env: windowsPowerShellEnv(),
    timeoutMs: 15_000,
    maxOutputMB: 1,
  });
  if (result.status !== 0) {
    throw new Error(
      `Windows named-pipe ACL hardening failed: ${result.stderr.trim() || result.error?.message || `exit ${result.status}`}`
    );
  }
}
