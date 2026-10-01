import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRegisteredEnvText } from '../foundation/env.js';
import {
  OS_ACCESSIBILITY_LIVE_SMOKE_ENV,
  OsAccessibilityDetector,
  type AccessibilityElement,
  type AccessibilitySnapshot,
  powerShellStdinArgs,
  windowsPowerShellEnv,
} from './os-accessibility-detector.js';
import { dhashFile } from '../media/image-dhash.js';
import { clearMarks, resolveMarkTarget, saveMarks } from '../mark-target-resolver.js';
import { clickAt } from './os-automation.js';
import { pathResolver } from '../path-resolver.js';
import { createScreenCaptureBridge } from './screen-capture-bridge.js';
import { safeExecResult, safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { fuseSetOfMarks, type SomBox, type SomCandidate } from '../set-of-marks.js';
import { inspectSomImage } from '../som-overlay.js';
import { runWindowsPointerActions } from '../windows-os-automation.js';

/**
 * Live smoke of the Windows UI Automation path. Two targets, each brought to the
 * foreground and captured from the primary screen: classic Notepad (a Win32 Edit,
 * which the runner's UIA may only report as a Pane: at least one unlabelled
 * editable element inside the window) and a WPF window with native UIA
 * providers (a labelled Button, a CheckBox and an unlabelled editable TextBox).
 * The third case clicks the WPF window's OK button through its Set-of-Marks mark
 * (detector -> fuseSetOfMarks -> saveMarks -> resolveMarkTarget -> the
 * os-automation clickAt of the platform, i.e. the DPI-aware Windows pointer
 * script) and checks the button handler ran (it renames the window).
 * Runs only on Windows with KYBERION_UIA_LIVE_SMOKE=1 (the
 * windows-latest job of cross-os.yml); GitHub's Windows runners have an
 * interactive desktop session.
 *
 * Display scaling: hosted runners run at 100 % (96 DPI, logged by the click
 * case), where logical and physical pixels coincide, so the live run cannot tell
 * a DPI-unaware click from a DPI-aware one. The scaled-display mapping is
 * covered by the hermetic tests in windows-os-automation.test.ts; this smoke
 * proves the real click path lands on a mark end to end.
 */
const LIVE =
  process.platform === 'win32' && getRegisteredEnvText(OS_ACCESSIBILITY_LIVE_SMOKE_ENV) === '1';

const WIN32_TYPE = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KyberionUiaSmoke {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
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

// Opens a WPF window titled UIA_SMOKE_TITLE (Button "OK", CheckBox, TextBox) in
// a separate STA powershell.exe that stays open until killed; WPF has native UIA
// providers, so this exercises real control types independent of Win32 proxies.
const WPF_LAUNCH_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${WIN32_TYPE}
$wpf = @'
Add-Type -AssemblyName PresentationFramework
$window = New-Object System.Windows.Window
$window.Title = $env:UIA_SMOKE_TITLE
$window.Width = 420
$window.Height = 260
$window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterScreen
$panel = New-Object System.Windows.Controls.StackPanel
$button = New-Object System.Windows.Controls.Button
$button.Content = 'OK'
$button.Margin = New-Object System.Windows.Thickness(8)
$button.Add_Click({ $window.Title = $env:UIA_SMOKE_TITLE + ' clicked' })
$check = New-Object System.Windows.Controls.CheckBox
$check.Content = 'Remember me'
$check.Margin = New-Object System.Windows.Thickness(8)
$text = New-Object System.Windows.Controls.TextBox
$text.Text = 'typed value'
$text.Margin = New-Object System.Windows.Thickness(8)
[void]$panel.Children.Add($button)
[void]$panel.Children.Add($check)
[void]$panel.Children.Add($text)
$window.Content = $panel
[void]$window.ShowDialog()
'@
$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($wpf))
$process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', $encoded) -PassThru
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 150 -and $hwnd -eq [IntPtr]::Zero -and -not $process.HasExited; $i++) {
  Start-Sleep -Milliseconds 200
  $hwnd = [KyberionUiaSmoke]::FindWindow([NullString]::Value, $env:UIA_SMOKE_TITLE)
}
[uint32]$ownerPid = 0
if ($hwnd -ne [IntPtr]::Zero) { [void][KyberionUiaSmoke]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid) }
$childExited = $process.HasExited
$childExitCode = if ($childExited) { $process.ExitCode } else { $null }
[Console]::Out.WriteLine((@{ pids = @($process.Id, [int]$ownerPid); hwnd = $hwnd.ToInt64(); child_exited = $childExited; child_exit_code = $childExitCode } | ConvertTo-Json -Compress))`;

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

// Waits up to 5 s for a top-level window titled UIA_SMOKE_TITLE and reports the
// DPI of the window handle in UIA_SMOKE_HWND and of the system.
const WAIT_TITLE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${WIN32_TYPE}
$found = [IntPtr]::Zero
for ($i = 0; $i -lt 25 -and $found -eq [IntPtr]::Zero; $i++) {
  $found = [KyberionUiaSmoke]::FindWindow([NullString]::Value, $env:UIA_SMOKE_TITLE)
  if ($found -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
$windowDpi = 0
$systemDpi = 0
try { $windowDpi = [int][KyberionUiaSmoke]::GetDpiForWindow([IntPtr]::new([long]$env:UIA_SMOKE_HWND)) } catch { }
try { $systemDpi = [int][KyberionUiaSmoke]::GetDpiForSystem() } catch { }
[Console]::Out.WriteLine((@{ found = ($found -ne [IntPtr]::Zero); window_dpi = $windowDpi; system_dpi = $systemDpi } | ConvertTo-Json -Compress))`;

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

interface LiveTarget {
  label: string;
  hwnd: number;
  application: string;
  shotPath: string;
}

interface LiveResult {
  snapshot: AccessibilitySnapshot;
  within: SomCandidate[];
  windowElements: AccessibilityElement[];
  image: { width: number; height: number };
}

/**
 * Focuses the target window, captures the primary screen and runs the detector;
 * retries up to three times when the window is not frontmost or yields no
 * candidates, printing diagnostics every round.
 */
async function detectLive(target: LiveTarget): Promise<LiveResult> {
  const detector = new OsAccessibilityDetector();
  let outcome = 'not run';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const focus = runPowerShell(FOCUS_SCRIPT, { UIA_SMOKE_HWND: String(target.hwnd) });
    console.log(`[uia-smoke:${target.label}] focus attempt ${attempt}`, JSON.stringify(focus));
    const shot = runPowerShell(SCREENSHOT_SCRIPT, { UIA_SMOKE_SHOT_PATH: target.shotPath });
    console.log(`[uia-smoke:${target.label}] screenshot`, JSON.stringify(shot));
    const request = {
      image_path: target.shotPath,
      image_size: { width: Number(shot.width), height: Number(shot.height) },
      live_screen: true,
      application: target.application,
    };
    if (!(await detector.isAvailable(request))) {
      outcome = 'os_accessibility detector unavailable';
      continue;
    }
    const started = Date.now();
    const snapshot = await detector.readSnapshot(request);
    const roles = new Map<string, number>();
    for (const element of snapshot.elements) {
      roles.set(element.role, (roles.get(element.role) ?? 0) + 1);
    }
    console.log(
      `[uia-smoke:${target.label}] snapshot`,
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
    console.log(
      `[uia-smoke:${target.label}] diagnostics`,
      JSON.stringify(snapshot.diagnostics ?? null)
    );
    if (snapshot.reason) {
      outcome = `reason ${snapshot.reason} (foreground ${String(focus.foreground_name)})`;
      continue;
    }
    expect(snapshot.application?.toLowerCase()).toBe(target.application);
    expect(snapshot.screen?.width).toBeGreaterThan(0);
    const frame = snapshot.window;
    if (!frame) {
      outcome = 'snapshot has no window frame';
      continue;
    }
    const scale = request.image_size.width / (snapshot.screen?.width ?? 1);
    const windowBox: SomBox = {
      x: frame!.x * scale,
      y: frame!.y * scale,
      width: frame!.width * scale,
      height: frame!.height * scale,
    };
    const candidates = await detector.detect(request);
    const within = candidates.filter((candidate) => inside(candidate.box, windowBox));
    const windowElements = snapshot.elements.filter((element) =>
      inside({ x: element.x, y: element.y, width: element.width, height: element.height }, frame!)
    );
    console.log(
      `[uia-smoke:${target.label}] candidates`,
      JSON.stringify({
        total: candidates.length,
        within: within.length,
        sample: within.slice(0, 12),
      })
    );
    if (within.length === 0) {
      outcome = `no candidates inside the ${target.label} window`;
      continue;
    }
    if (windowElements.length === 0) {
      outcome = `UIA returned no elements inside the ${target.label} window`;
      continue;
    }
    return { snapshot, within, windowElements, image: request.image_size };
  }
  throw new Error(`[uia-smoke:${target.label}] ${outcome}`);
}

function killAll(pids: number[]): void {
  for (const pid of new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))) {
    safeExecResult('taskkill', ['/PID', String(pid), '/F', '/T'], { timeoutMs: 10_000 });
  }
}

function pidsOf(launch: Record<string, unknown>): number[] {
  return (Array.isArray(launch.pids) ? launch.pids : [launch.pids]).map(Number);
}

/**
 * Runs a launch script until it reports a real window handle, retrying on a
 * fresh process when the window never appears (slow STA/WPF startup on loaded
 * runners is the dominant flake mode). All spawned pids are returned so the
 * caller can clean up every attempt, including failed ones.
 */
function launchWithRetry(
  script: string,
  env: Record<string, string>,
  label: string,
  attempts = 3
): { launch: Record<string, unknown>; pids: number[] } {
  const pids: number[] = [];
  let launch: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    launch = runPowerShell(script, env);
    const attemptPids = pidsOf(launch);
    pids.push(...attemptPids);
    console.log(`[uia-smoke:${label}] launch attempt ${attempt}`, JSON.stringify(launch));
    if (Number(launch.hwnd) > 0) break;
    killAll(attemptPids);
  }
  return { launch, pids };
}

describe.skipIf(!LIVE)('os_accessibility live smoke on Windows (UI Automation)', () => {
  const shotDir = pathResolver.sharedTmp('uia-live-smoke');

  it('finds the Notepad editor as an unlabelled editable element', async () => {
    safeMkdir(shotDir, { recursive: true });
    let pids: number[] = [];
    try {
      const launched = launchWithRetry(LAUNCH_SCRIPT, {}, 'notepad');
      const launch = launched.launch;
      pids = launched.pids;
      expect(Number(launch.hwnd), 'Notepad main window did not appear').toBeGreaterThan(0);
      const { within } = await detectLive({
        label: 'notepad',
        hwnd: Number(launch.hwnd),
        application: 'notepad',
        shotPath: path.join(shotDir, `notepad-${process.pid}.png`),
      });
      // Classic Notepad on the runner exposes its editor (a Win32 Edit, possibly only
      // as a Pane) but no menu or title-bar buttons, so only the editor is required.
      const editable = within.filter((candidate) => candidate.editable);
      expect(editable.length).toBeGreaterThanOrEqual(1);
      expect(editable.filter((candidate) => candidate.label)).toEqual([]);
    } finally {
      killAll(pids);
      if (safeExistsSync(shotDir)) safeRmSync(shotDir);
    }
  }, 180_000);

  it('finds the button, checkbox and text box of a WPF window', async () => {
    safeMkdir(shotDir, { recursive: true });
    const title = `Kyberion UIA smoke ${process.pid}`;
    let pids: number[] = [];
    try {
      const launched = launchWithRetry(WPF_LAUNCH_SCRIPT, { UIA_SMOKE_TITLE: title }, 'wpf');
      const launch = launched.launch;
      pids = launched.pids;
      expect(Number(launch.hwnd), 'WPF window did not appear').toBeGreaterThan(0);
      const { within, windowElements } = await detectLive({
        label: 'wpf',
        hwnd: Number(launch.hwnd),
        application: 'powershell',
        shotPath: path.join(shotDir, `wpf-${process.pid}.png`),
      });
      expect(windowElements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'AXButton', title: 'OK' }),
          expect.objectContaining({ role: 'AXCheckBox', title: 'Remember me' }),
          expect.objectContaining({ role: 'AXTextField' }),
        ])
      );
      const labels = within.map((candidate) => candidate.label);
      expect(labels).toContain('OK');
      expect(labels).toContain('Remember me');
      const editable = within.filter((candidate) => candidate.editable);
      expect(editable.length).toBeGreaterThanOrEqual(1);
      expect(editable.filter((candidate) => candidate.label)).toEqual([]);
      // The typed text never becomes a label.
      expect(labels.filter((label) => label?.includes('typed value'))).toEqual([]);
    } finally {
      killAll(pids);
      if (safeExistsSync(shotDir)) safeRmSync(shotDir);
    }
  }, 180_000);
  it('clicks the WPF OK button through its mark with the DPI-aware pointer path', async () => {
    safeMkdir(shotDir, { recursive: true });
    const title = `Kyberion UIA click smoke ${process.pid}`;
    const session = `uia-click-smoke-${process.pid}`;
    const shotPath = path.join(shotDir, `wpf-click-${process.pid}.png`);
    let pids: number[] = [];
    try {
      const launched = launchWithRetry(WPF_LAUNCH_SCRIPT, { UIA_SMOKE_TITLE: title }, 'click');
      const launch = launched.launch;
      pids = launched.pids;
      expect(Number(launch.hwnd), 'WPF window did not appear').toBeGreaterThan(0);
      const { within, windowElements, image, snapshot } = await detectLive({
        label: 'click',
        hwnd: Number(launch.hwnd),
        application: 'powershell',
        shotPath,
      });
      const walker = (snapshot.diagnostics as { walker?: unknown } | undefined)?.walker;
      console.log('[uia-smoke:click] walker', JSON.stringify(walker ?? null));

      // Detector candidates -> numbered marks -> stored for the session.
      const marks = fuseSetOfMarks(within, { imageSize: image });
      const ok = marks.find((mark) => mark.label === 'OK');
      expect(ok, 'no mark labelled OK').toBeDefined();
      const scale = image.width / (snapshot.screen?.width ?? image.width);
      clearMarks(session);
      saveMarks({
        session_id: session,
        marks,
        image,
        image_dhash: await dhashFile(shotPath),
        scale,
      });

      // The real resolver checks the screen is unchanged, then the platform click path runs.
      const currentPath = path.join(shotDir, `wpf-click-current-${process.pid}.png`);
      runPowerShell(SCREENSHOT_SCRIPT, { UIA_SMOKE_SHOT_PATH: currentPath });
      const point = await resolveMarkTarget(`mark:${ok!.n}`, {
        session_id: session,
        current_image_path: currentPath,
      });
      console.log('[uia-smoke:click] target', JSON.stringify({ mark: ok, scale, point }));
      clickAt(point.x, point.y);

      const pointer = runWindowsPointerActions([]);
      const wait = runPowerShell(WAIT_TITLE_SCRIPT, {
        UIA_SMOKE_TITLE: `${title} clicked`,
        UIA_SMOKE_HWND: String(launch.hwnd),
      });
      console.log('[uia-smoke:click] after click', JSON.stringify({ pointer, wait }));

      // The cursor (read per-monitor DPI aware) sits inside the button's UIA rect: the
      // click and the detector share one physical coordinate space.
      const button = windowElements.find(
        (element) => element.role === 'AXButton' && element.title === 'OK'
      );
      expect(button).toBeDefined();
      expect(pointer.dpi_awareness).toBe('per_monitor_v2');
      expect(
        inside(
          { x: pointer.cursor.x, y: pointer.cursor.y, width: 1, height: 1 },
          { x: button!.x, y: button!.y, width: button!.width, height: button!.height },
          0
        )
      ).toBe(true);
      expect(wait.found, 'the OK button handler did not run').toBe(true);

      // The governed Windows screen capture (ffmpeg gdigrab) must be physical pixels
      // for marks on it to map with scale 1; checked when ffmpeg is installed.
      const bridgeShot = path.join(shotDir, `gdigrab-${process.pid}.png`);
      try {
        await createScreenCaptureBridge({ preferred_backend: 'platform' }).captureScreenshot({
          save_path: bridgeShot,
        });
      } catch (error) {
        console.log('[uia-smoke:click] gdigrab capture skipped', (error as Error).message);
      }
      if (safeExistsSync(bridgeShot)) {
        const captured = (await inspectSomImage(bridgeShot)).image;
        console.log(
          '[uia-smoke:click] gdigrab capture',
          JSON.stringify({ captured, virtual_screen: pointer.virtual_screen })
        );
        expect(captured).toEqual({
          width: pointer.virtual_screen.width,
          height: pointer.virtual_screen.height,
        });
      }
    } finally {
      clearMarks(session);
      killAll(pids);
      if (safeExistsSync(shotDir)) safeRmSync(shotDir);
    }
  }, 180_000);
});
