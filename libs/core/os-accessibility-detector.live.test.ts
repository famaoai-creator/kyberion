import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  OS_ACCESSIBILITY_LIVE_SMOKE_ENV,
  OsAccessibilityDetector,
  powerShellStdinArgs,
  windowsPowerShellEnv,
} from './os-accessibility-detector.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeMkdir, safeRmSync } from './secure-io.js';
import type { SomBox } from './set-of-marks.js';

/**
 * Live smoke of the Windows UI Automation path: launches Notepad, brings it to
 * the foreground, captures the primary screen and checks that os_accessibility
 * finds Notepad's editor and several of its buttons / menu items inside the
 * Notepad window. Runs only on Windows with KYBERION_UIA_LIVE_SMOKE=1 (the
 * windows-latest job of cross-os.yml); GitHub's Windows runners have an
 * interactive desktop session.
 */
const LIVE =
  process.platform === 'win32' && getRegisteredEnvText(OS_ACCESSIBILITY_LIVE_SMOKE_ENV) === '1';

const WIN32_TYPE = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KyberionUiaSmoke {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@`;

// Starts a new Notepad and prints its pid and main window handle.
const LAUNCH_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$before = @(Get-Process -Name notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$started = Start-Process -FilePath notepad.exe -PassThru
$target = $null
for ($i = 0; $i -lt 75 -and $null -eq $target; $i++) {
  Start-Sleep -Milliseconds 200
  $target = Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
}
$pids = @($started.Id)
$hwnd = 0
if ($null -ne $target) { $pids += $target.Id; $hwnd = $target.MainWindowHandle.ToInt64() }
[Console]::Out.WriteLine((@{ pids = $pids; hwnd = $hwnd } | ConvertTo-Json -Compress))`;

// Brings the window (handle in UIA_SMOKE_HWND) to the foreground; the ALT tap
// lifts the foreground lock when a plain SetForegroundWindow is refused.
const FOCUS_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${WIN32_TYPE}
$h = [IntPtr]::new([long]$env:UIA_SMOKE_HWND)
$focused = $false
$attempts = 0
for ($i = 0; $i -lt 10 -and -not $focused; $i++) {
  $attempts++
  if ($i -gt 0) { [KyberionUiaSmoke]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero) }
  [void][KyberionUiaSmoke]::ShowWindow($h, 9)
  [void][KyberionUiaSmoke]::BringWindowToTop($h)
  [void][KyberionUiaSmoke]::SetForegroundWindow($h)
  if ($i -gt 0) { [KyberionUiaSmoke]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 300
  $focused = [KyberionUiaSmoke]::GetForegroundWindow() -eq $h
}
[uint32]$fgPid = 0
[void][KyberionUiaSmoke]::GetWindowThreadProcessId([KyberionUiaSmoke]::GetForegroundWindow(), [ref]$fgPid)
$fgName = ''
try { $fgName = (Get-Process -Id ([int]$fgPid) -ErrorAction Stop).ProcessName } catch { }
[Console]::Out.WriteLine((@{ focused = $focused; attempts = $attempts; foreground_pid = [int]$fgPid; foreground_name = $fgName } | ConvertTo-Json -Compress))`;

// Captures the primary screen (physical pixels) to UIA_SMOKE_SHOT_PATH.
const SCREENSHOT_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${WIN32_TYPE}
try { [void][KyberionUiaSmoke]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) } catch { [void][KyberionUiaSmoke]::SetProcessDPIAware() }
$w = [KyberionUiaSmoke]::GetSystemMetrics(0)
$h = [KyberionUiaSmoke]::GetSystemMetrics(1)
$saved = $false
$failure = ''
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $bmp.Save($env:UIA_SMOKE_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $saved = $true
} catch { $failure = $_.Exception.Message }
[Console]::Out.WriteLine((@{ width = $w; height = $h; saved = $saved; error = $failure } | ConvertTo-Json -Compress))`;

function runPowerShell(script: string, env: Record<string, string> = {}) {
  const result = safeExecResult('powershell.exe', powerShellStdinArgs(), {
    timeoutMs: 60_000,
    maxOutputMB: 1,
    env: { ...windowsPowerShellEnv(), ...env },
    input: script,
  });
  const line = String(result.stdout)
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  if (result.status !== 0 || !line) {
    throw new Error(
      `powershell.exe failed (exit ${result.status}): ${String(result.stderr).trim() || result.error?.message || String(result.stdout).trim()}`
    );
  }
  return JSON.parse(line) as Record<string, unknown>;
}

function inside(box: SomBox, frame: SomBox, tolerance = 2): boolean {
  return (
    box.x >= frame.x - tolerance &&
    box.y >= frame.y - tolerance &&
    box.x + box.width <= frame.x + frame.width + tolerance &&
    box.y + box.height <= frame.y + frame.height + tolerance
  );
}

describe.skipIf(!LIVE)('os_accessibility live smoke on Windows (UI Automation)', () => {
  it('finds the Notepad editor and its controls in the foreground window', async () => {
    const shotDir = pathResolver.sharedTmp('uia-live-smoke');
    safeMkdir(shotDir, { recursive: true });
    const shotPath = path.join(shotDir, `screen-${process.pid}.png`);
    let pids: number[] = [];
    try {
      const launch = runPowerShell(LAUNCH_SCRIPT);
      console.log('[uia-smoke] launch', JSON.stringify(launch));
      pids = (Array.isArray(launch.pids) ? launch.pids : [launch.pids]).map(Number);
      expect(Number(launch.hwnd), 'Notepad main window did not appear').toBeGreaterThan(0);

      const detector = new OsAccessibilityDetector();
      let outcome: string | undefined;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const focus = runPowerShell(FOCUS_SCRIPT, { UIA_SMOKE_HWND: String(launch.hwnd) });
        console.log(`[uia-smoke] focus attempt ${attempt}`, JSON.stringify(focus));
        const shot = runPowerShell(SCREENSHOT_SCRIPT, { UIA_SMOKE_SHOT_PATH: shotPath });
        console.log('[uia-smoke] screenshot', JSON.stringify(shot));
        const request = {
          image_path: shotPath,
          image_size: { width: Number(shot.width), height: Number(shot.height) },
          live_screen: true,
          application: 'notepad',
        };
        expect(await detector.isAvailable(request)).toBe(true);
        const started = Date.now();
        const snapshot = await detector.readSnapshot(request);
        const roles = new Map<string, number>();
        for (const element of snapshot.elements) {
          roles.set(element.role, (roles.get(element.role) ?? 0) + 1);
        }
        console.log(
          '[uia-smoke] snapshot',
          JSON.stringify({
            ms: Date.now() - started,
            application: snapshot.application,
            reason: snapshot.reason,
            screen: snapshot.screen,
            window: snapshot.window,
            dpi_awareness: snapshot.dpi_awareness,
            truncated: snapshot.truncated,
            strategy: snapshot.strategy,
            roles: Object.fromEntries(roles),
          })
        );
        console.log('[uia-smoke] diagnostics', JSON.stringify(snapshot.diagnostics ?? null));
        if (snapshot.reason) {
          outcome = `reason ${snapshot.reason} (foreground ${String(focus.foreground_name)})`;
          continue;
        }
        expect(snapshot.application?.toLowerCase()).toBe('notepad');
        expect(snapshot.screen?.width).toBeGreaterThan(0);
        const frame = snapshot.window;
        expect(frame).toBeDefined();
        const scale = request.image_size.width / (snapshot.screen?.width ?? 1);
        const windowBox: SomBox = {
          x: frame!.x * scale,
          y: frame!.y * scale,
          width: frame!.width * scale,
          height: frame!.height * scale,
        };
        const candidates = await detector.detect(request);
        const within = candidates.filter((candidate) => inside(candidate.box, windowBox));
        console.log(
          '[uia-smoke] candidates',
          JSON.stringify({
            total: candidates.length,
            within: within.length,
            sample: within.slice(0, 12),
          })
        );
        if (within.length === 0) {
          outcome = 'no candidates inside the Notepad window';
          continue;
        }
        expect(within.filter((candidate) => candidate.editable).length).toBeGreaterThanOrEqual(1);
        expect(within.filter((candidate) => !candidate.editable).length).toBeGreaterThanOrEqual(3);
        // Editable elements never carry a label.
        expect(within.filter((candidate) => candidate.editable && candidate.label)).toEqual([]);
        outcome = 'ok';
        break;
      }
      expect(outcome).toBe('ok');
    } finally {
      for (const pid of new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))) {
        safeExecResult('taskkill', ['/PID', String(pid), '/F'], { timeoutMs: 10_000 });
      }
      if (safeExistsSync(shotDir)) safeRmSync(shotDir);
    }
  }, 180_000);
});
