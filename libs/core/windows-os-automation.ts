import { safeExec, safeExecResult } from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import type { FocusedInputState } from './apple-event-bridge.js';
import { escapeXml } from './text-escaping.js';
import { powerShellStdinArgs, windowsPowerShellEnv } from './windows-powershell.js';

const PS = 'powershell.exe';
export const WINDOWS_APP_LAUNCH_ENV = 'KYBERION_WINDOWS_APP_LAUNCH';
export const WINDOWS_WINDOW_ACTION_ENV = 'KYBERION_WINDOWS_WINDOW_ACTION';

export const WINDOWS_APP_LAUNCH_SCRIPT = `$ErrorActionPreference = 'Stop'
$raw = [string]$env:${WINDOWS_APP_LAUNCH_ENV}
if (-not $raw) { throw 'Application launch options are missing' }
$options = ConvertFrom-Json -InputObject $raw
$requested = ([string]$options.application).Trim()
if (-not $requested) { throw 'Application name is required' }
$resolved = $null
if (Test-Path -LiteralPath $requested -PathType Leaf) {
  $resolved = (Resolve-Path -LiteralPath $requested).Path
} else {
  $normalized = ($requested -replace '[.]exe$', '' -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
  $aliases = @{ googlechrome = 'chrome.exe'; microsoftedge = 'msedge.exe'; fileexplorer = 'explorer.exe'; mozillafirefox = 'firefox.exe'; microsoftword = 'winword.exe'; microsoftexcel = 'excel.exe'; microsoftpowerpoint = 'powerpnt.exe' }
  $executable = if ($aliases.ContainsKey($normalized)) { $aliases[$normalized] } elseif ($requested -match '[.]exe$') { $requested } else { "$requested.exe" }
  $command = Get-Command -Name $executable -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $resolved = $command.Source }
  if (-not $resolved) {
    foreach ($registryPath in @("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$executable", "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$executable", "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$executable")) {
      $appPath = Get-Item -LiteralPath $registryPath -ErrorAction SilentlyContinue
      if ($appPath) {
        $candidate = [string]$appPath.GetValue('')
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $resolved = $candidate; break }
      }
    }
  }
  if (-not $resolved) { throw "Application could not be resolved to an executable: $requested" }
}
Start-Process -FilePath $resolved | Out-Null
[Console]::Out.WriteLine('true')`;

export const WINDOWS_WINDOW_ACTION_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$raw = [string]$env:${WINDOWS_WINDOW_ACTION_ENV}
if (-not $raw) { throw 'Window action options are missing' }
$options = ConvertFrom-Json -InputObject $raw
$app = ([string]$options.application -replace '[.]exe$', '' -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
$aliases = @{ googlechrome = 'chrome'; fileexplorer = 'explorer'; microsoftedge = 'msedge'; mozillafirefox = 'firefox'; microsoftword = 'winword'; microsoftexcel = 'excel'; microsoftpowerpoint = 'powerpnt' }
if ($aliases.ContainsKey($app)) { $app = $aliases[$app] }
$title = [string]$options.title
$policy = [string]$options.matchPolicy
$state = [string]$options.state
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$matches = @()
for ($i = 0; $i -lt $windows.Count; $i++) {
  $window = $windows.Item($i)
  $name = [string]$window.Current.Name
  $titleMatch = switch ($policy) {
    'strict' { [string]::Equals($name, $title, [StringComparison]::OrdinalIgnoreCase) }
    'prefix' { $name.StartsWith($title, [StringComparison]::OrdinalIgnoreCase) }
    default { $name.IndexOf($title, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  }
  if (-not $titleMatch) { continue }
  if ($app) {
    $process = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
    $processName = if ($process) { ($process.ProcessName -replace '[^a-zA-Z0-9]', '').ToLowerInvariant() } else { '' }
    if ($processName -and -not ($processName.Contains($app) -or $app.Contains($processName))) { continue }
  }
  $matches += $window
}
if ($matches.Count -ne 1) { [Console]::Out.WriteLine('false'); exit 0 }
$window = $matches[0]
try {
  $pattern = $null
  if (-not $window.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) { throw 'WindowPattern unavailable' }
  switch ($state) {
    'focus' {
      $processId = [int]$window.Current.ProcessId
      $shell = New-Object -ComObject WScript.Shell
      if (-not $shell.AppActivate($processId)) { throw 'Window activation failed' }
      $window.SetFocus()
    }
    'maximize' { $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Maximized) }
    'minimize' { $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Minimized) }
    'restore' { $pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal) }
    default { throw 'Unsupported window state' }
  }
  [Console]::Out.WriteLine('true')
} catch { [Console]::Out.WriteLine('false') }`;

function runWindowsAppScript(
  script: string,
  envName: string,
  value: Record<string, unknown>
): boolean {
  const result = safeExecResult(PS, powerShellStdinArgs(), {
    timeoutMs: 10_000,
    maxOutputMB: 1,
    env: { ...windowsPowerShellEnv(), [envName]: JSON.stringify(value) },
    input: script,
  });
  return result.status === 0 && result.stdout.trim().toLowerCase() === 'true';
}

function quote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const WINDOWS_APPLICATION_PROCESS_ALIASES: Record<string, string> = {
  googlechrome: 'chrome',
  fileexplorer: 'explorer',
  microsoftedge: 'msedge',
  mozillafirefox: 'firefox',
  microsoftword: 'winword',
  microsoftexcel: 'excel',
  microsoftpowerpoint: 'powerpnt',
};

function windowsApplicationProcessName(application: string): string {
  const normalized = application
    .trim()
    .replace(/\.exe$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
  return WINDOWS_APPLICATION_PROCESS_ALIASES[normalized] || normalized;
}

function run(script: string): string {
  return String(safeExec(PS, ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
}

function runResult(script: string): string {
  const result = safeExecResult(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 5_000,
    maxOutputMB: 2,
  });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

export function activateApplication(application: string): void {
  const target = application.trim();
  if (!target) return;
  const processName = windowsApplicationProcessName(target);
  run(
    `$processName = ${quote(processName)}; ` +
      '$process = Get-Process | Where-Object { ($_.ProcessName -replace "[^a-zA-Z0-9]", "").ToLowerInvariant() -eq $processName } | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ' +
      '$ws = New-Object -ComObject WScript.Shell; ' +
      `if ($process) { [void]$ws.AppActivate([int]$process.Id) } else { [void]$ws.AppActivate(${quote(target)}) }`
  );
}

export function launchApplication(application: string): boolean {
  const target = application.trim();
  if (!target) return false;
  return runWindowsAppScript(WINDOWS_APP_LAUNCH_SCRIPT, WINDOWS_APP_LAUNCH_ENV, {
    application: target,
  });
}

export function detectFocusedInput(): FocusedInputState {
  const output = runResult(
    [
      'Add-Type -AssemblyName UIAutomationClient',
      '$focused = [System.Windows.Automation.AutomationElement]::FocusedElement',
      '$application = ""; $windowTitle = ""; $role = ""; $description = ""; $editable = $false',
      'if ($null -ne $focused) {',
      '  $current = $focused.Current',
      '  $role = $current.ControlType.ProgrammaticName',
      '  $description = $current.Name',
      '  try {',
      '    $process = Get-Process -Id $current.ProcessId -ErrorAction Stop',
      '    $application = $process.ProcessName',
      '    $windowTitle = $process.MainWindowTitle',
      '  } catch {}',
      '  $isEdit = $current.ControlType -eq [System.Windows.Automation.ControlType]::Edit',
      '  $isComboBox = $current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox',
      '  if ($isEdit -or $isComboBox) {',
      '    $valuePattern = $null',
      '    $hasValue = $focused.TryGetCurrentPattern(',
      '      [System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)',
      '    if ($hasValue) {',
      '      $editable = -not $valuePattern.Current.IsReadOnly',
      '    }',
      '  }',
      '}',
      '$result = [pscustomobject]@{',
      '  application = $application; windowTitle = $windowTitle; role = $role',
      '  description = $description; editable = $editable',
      '}',
      '$result | ConvertTo-Json -Compress',
    ].join('\n')
  );
  try {
    const focused = parseSafeJsonInput(
      output,
      'Windows focused input state'
    ) as Partial<FocusedInputState>;
    return {
      application: typeof focused.application === 'string' ? focused.application : '',
      windowTitle: typeof focused.windowTitle === 'string' ? focused.windowTitle : '',
      role: typeof focused.role === 'string' ? focused.role : '',
      description: typeof focused.description === 'string' ? focused.description : '',
      editable: focused.editable === true,
    };
  } catch {
    return { application: '', windowTitle: '', role: '', description: '', editable: false };
  }
}

export function keystrokeText(text: string): void {
  run(`$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys(${quote(text)})`);
}

export function pasteText(text: string): void {
  run(
    `Set-Clipboard -Value ${quote(text)}; $ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^v')`
  );
}

export function pressKey(key: string): void {
  const map: Record<string, string> = {
    enter: '{ENTER}',
    return: '{ENTER}',
    tab: '{TAB}',
    escape: '{ESC}',
    space: ' ',
    backspace: '{BACKSPACE}',
    delete: '{DELETE}',
  };
  keystrokeText(map[key.trim().toLowerCase()] || key);
}

export function pressKeyCode(keyCode: number): void {
  if (!Number.isInteger(keyCode) || keyCode < 1 || keyCode > 255)
    throw new Error(`Invalid key code: ${keyCode}`);
  run(
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class K { [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); }'; [K]::keybd_event(${keyCode},0,0,[UIntPtr]::Zero); [K]::keybd_event(${keyCode},0,2,[UIntPtr]::Zero)`
  );
}

export function toggleDictation(): void {
  // Windows dictation shortcut (Win+H).
  run(`$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^{ESC}')`);
}

/**
 * Windows pointer path (clicks, moves, drags, wheel, screen size).
 *
 * Coordinate space: virtual-desktop PHYSICAL pixels, the primary monitor's
 * top-left is 0,0 (monitors left of / above it are negative). The script makes
 * its thread per-monitor DPI aware (SetThreadDpiAwarenessContext
 * PER_MONITOR_AWARE_V2, fallback SetProcessDPIAware) before SetCursorPos, so a
 * coordinate is never re-interpreted as a DPI-virtualised logical pixel on a
 * scaled display. This is the space the os_accessibility detector reports UIA
 * rects in and the space a full-desktop gdigrab / CopyFromScreen capture from a
 * DPI-aware process is in, so a Set-of-Marks mark on such a screenshot maps to
 * a click point by `image px / scale + display origin` with scale 1.
 *
 * Every pointer operation is one powershell.exe run of the fixed
 * WINDOWS_POINTER_SCRIPT, fed on stdin behind the shared bootstrap; the
 * actions travel as JSON in the WINDOWS_POINTER_OPTIONS_ENV child variable, so
 * no coordinate is ever part of the script text. The script prints what it
 * did: DPI awareness, the cursor position after the actions (in the same
 * physical space), the primary screen size and the virtual screen rect.
 */
export const WINDOWS_POINTER_OPTIONS_ENV = 'KYBERION_WIN_POINTER';
export const WINDOWS_POINTER_TIMEOUT_MS = 20_000;
/** Largest absolute coordinate accepted (well past any virtual desktop, well inside int32). */
export const WINDOWS_POINTER_MAX_COORDINATE = 1_000_000;

export const MOUSEEVENTF = {
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
} as const;
const MOUSE_FLAG_VALUES: ReadonlySet<number> = new Set(Object.values(MOUSEEVENTF));

export const WINDOWS_POINTER_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$raw = [string]$env:${WINDOWS_POINTER_OPTIONS_ENV}
if (-not $raw) { $raw = '{}' }
$opts = ConvertFrom-Json -InputObject $raw
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KyberionPointerNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
}
'@
$N = [KyberionPointerNative]
$dpi = 'unaware'
try { if ($N::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -ne [IntPtr]::Zero) { $dpi = 'per_monitor_v2' } } catch { }
if ($dpi -eq 'unaware') { try { if ($N::SetProcessDPIAware()) { $dpi = 'system' } } catch { } }
$performed = 0
$moveFailures = 0
foreach ($a in @($opts.actions)) {
  if ($null -eq $a) { continue }
  if ($null -ne $a.x -and $null -ne $a.y) {
    if (-not $N::SetCursorPos([int]$a.x, [int]$a.y)) { $moveFailures += 1; break }
  }
  if ($a.flags) { $N::mouse_event([uint32]$a.flags, 0, 0, [int]$a.data, [UIntPtr]::Zero) }
  $performed += 1
}
$p = New-Object KyberionPointerNative+POINT
[void]$N::GetCursorPos([ref]$p)
[Console]::Out.WriteLine('{"dpi_awareness":"' + $dpi + '","performed":' + $performed + ',"move_failures":' + $moveFailures + ',"cursor":{"x":' + $p.X + ',"y":' + $p.Y + '},"screen":{"width":' + $N::GetSystemMetrics(0) + ',"height":' + $N::GetSystemMetrics(1) + '},"virtual_screen":{"x":' + $N::GetSystemMetrics(76) + ',"y":' + $N::GetSystemMetrics(77) + ',"width":' + $N::GetSystemMetrics(78) + ',"height":' + $N::GetSystemMetrics(79) + '}}')
[Console]::Out.Flush()`;

/** One pointer step: move to x,y (physical pixels) when given, then send the mouse_event flags. */
export interface WindowsPointerAction {
  x?: number;
  y?: number;
  flags?: number;
  /** mouse_event data (wheel delta). */
  data?: number;
}

export interface WindowsPointerReport {
  dpi_awareness: string;
  performed: number;
  move_failures: number;
  /** Cursor after the actions, physical pixels. */
  cursor: { x: number; y: number };
  /** Primary monitor, physical pixels. */
  screen: { width: number; height: number };
  /** Bounding rect of all monitors, physical pixels. */
  virtual_screen: { x: number; y: number; width: number; height: number };
}

function pointerCoordinate(value: unknown, axis: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[WINDOWS_POINTER] ${axis} must be a finite number`);
  }
  const rounded = Math.round(value);
  if (Math.abs(rounded) > WINDOWS_POINTER_MAX_COORDINATE) {
    throw new Error(`[WINDOWS_POINTER] ${axis} ${rounded} is outside any virtual desktop`);
  }
  return rounded;
}

/** The child-environment JSON for the actions; validated, coordinates rounded to physical pixels. */
export function windowsPointerOptions(actions: readonly WindowsPointerAction[]): string {
  const normalised = actions.map((action) => {
    const step: Record<string, number> = {};
    if (action.x !== undefined || action.y !== undefined) {
      step.x = pointerCoordinate(action.x, 'x');
      step.y = pointerCoordinate(action.y, 'y');
    }
    if (action.flags !== undefined) {
      if (!MOUSE_FLAG_VALUES.has(action.flags)) {
        throw new Error(`[WINDOWS_POINTER] unsupported mouse_event flags ${action.flags}`);
      }
      step.flags = action.flags;
    }
    if (action.data !== undefined) {
      if (!Number.isInteger(action.data) || Math.abs(action.data) > 120 * 100) {
        throw new Error('[WINDOWS_POINTER] data must be an integer wheel delta');
      }
      step.data = action.data;
    }
    return step;
  });
  return JSON.stringify({ actions: normalised });
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  return line ? parseSafeJsonInput(line, 'Windows pointer report') : undefined;
}

/** Runs the actions in one DPI-aware powershell.exe; throws when it fails or a move is refused. */
export function runWindowsPointerActions(
  actions: readonly WindowsPointerAction[]
): WindowsPointerReport {
  const options = windowsPointerOptions(actions);
  const result = safeExecResult(PS, powerShellStdinArgs(), {
    timeoutMs: WINDOWS_POINTER_TIMEOUT_MS,
    maxOutputMB: 1,
    input: WINDOWS_POINTER_SCRIPT,
    env: { ...windowsPowerShellEnv(), [WINDOWS_POINTER_OPTIONS_ENV]: options },
  });
  let report: WindowsPointerReport | undefined;
  try {
    report = lastJsonLine(result.stdout) as WindowsPointerReport | undefined;
  } catch {
    report = undefined;
  }
  if (result.status !== 0 || !report || typeof report.performed !== 'number') {
    throw new Error(
      `[WINDOWS_POINTER] pointer script failed (exit ${result.status}): ${
        result.stderr.trim() || result.error?.message || 'no report'
      }`
    );
  }
  if (report.move_failures > 0) {
    throw new Error(
      '[WINDOWS_POINTER] SetCursorPos was refused (locked or secure desktop); the click was not sent'
    );
  }
  return report;
}

function pressActions(down: number, up: number, clickCount: number): WindowsPointerAction[] {
  const presses: WindowsPointerAction[] = [];
  for (let i = 0; i < Math.max(1, Math.floor(clickCount) || 1); i += 1) {
    presses.push({ flags: down }, { flags: up });
  }
  return presses;
}

/** Left click at x,y in virtual-desktop physical pixels. */
export function clickAt(x: number, y: number, clickCount = 1): void {
  runWindowsPointerActions([
    { x, y },
    ...pressActions(MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP, clickCount),
  ]);
}
export function rightClickAt(x: number, y: number, clickCount = 1): void {
  runWindowsPointerActions([
    { x, y },
    ...pressActions(MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP, clickCount),
  ]);
}
export function moveMouse(x: number, y: number): void {
  runWindowsPointerActions([{ x, y }]);
}
export function scrollAt(
  x: number,
  y: number,
  direction: 'up' | 'down' | 'left' | 'right',
  amount = 3
): void {
  const delta = direction === 'up' || direction === 'right' ? 120 : -120;
  const horizontal = direction === 'left' || direction === 'right';
  runWindowsPointerActions([
    { x, y },
    {
      flags: horizontal ? MOUSEEVENTF.HWHEEL : MOUSEEVENTF.WHEEL,
      data: delta * Math.max(1, Math.floor(amount) || 1),
    },
  ]);
}
export function dragFrom(x1: number, y1: number, x2: number, y2: number): void {
  runWindowsPointerActions([
    { x: x1, y: y1, flags: MOUSEEVENTF.LEFTDOWN },
    { x: x2, y: y2, flags: MOUSEEVENTF.LEFTUP },
  ]);
}
export function runAppleScript(_script: string): string {
  return '';
}

/** Primary monitor size in physical pixels (the pointer coordinate space). */
export function getScreenSize(): { width: number; height: number } {
  try {
    return runWindowsPointerActions([]).screen;
  } catch {
    return { width: 0, height: 0 };
  }
}
export function getWindowList(appName: string): string[] {
  // Prefer the Windows UI Automation tree.  Unlike MainWindowTitle, UIA also
  // sees modern WinUI/WPF controls and filters out background processes at the
  // accessibility boundary.  Keep the process query as a compatibility
  // fallback for restricted desktop sessions.
  const uiAutomationScript = [
    'Add-Type -AssemblyName UIAutomationClient',
    '$root = [System.Windows.Automation.AutomationElement]::RootElement',
    '$condition = New-Object System.Windows.Automation.PropertyCondition(',
    '  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,',
    '  [System.Windows.Automation.ControlType]::Window)',
    `$requestedApp = ${quote(windowsApplicationProcessName(appName))}`,
    '$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)',
    'for ($i = 0; $i -lt $windows.Count; $i++) {',
    '  $window = $windows.Item($i); $name = $window.Current.Name',
    '  if ($requestedApp) { $p = Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue; $pn = if ($p) { ($p.ProcessName -replace "[^a-zA-Z0-9]", "").ToLowerInvariant() } else { "" }; if ($pn -and -not ($pn.Contains($requestedApp) -or $requestedApp.Contains($pn))) { continue } }',
    '  if ($name) { $name }',
    '}',
  ].join('\n');
  const uiWindows = runResult(uiAutomationScript)
    .split(/\r?\n/)
    .map((title) => title.trim())
    .filter(Boolean);
  if (uiWindows.length > 0) return uiWindows;
  return runResult(
    'Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle'
  )
    .split(/\r?\n/)
    .filter(Boolean);
}
export function activateWindowByTitle(
  appName: string,
  windowTitle: string,
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'contains'
): boolean {
  return runWindowsAppScript(WINDOWS_WINDOW_ACTION_SCRIPT, WINDOWS_WINDOW_ACTION_ENV, {
    application: appName,
    title: windowTitle,
    matchPolicy,
    state: 'focus',
  });
}
export function setWindowState(
  appName: string,
  windowTitle: string,
  state: 'maximize' | 'minimize' | 'restore',
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'contains'
): boolean {
  return runWindowsAppScript(WINDOWS_WINDOW_ACTION_SCRIPT, WINDOWS_WINDOW_ACTION_ENV, {
    application: appName,
    title: windowTitle,
    matchPolicy,
    state,
  });
}
export function quitApplication(application: string): void {
  const name = windowsApplicationProcessName(application);
  if (!name) return;
  run(
    `$processes = @(Get-Process -Name ${quote(name)} -ErrorAction SilentlyContinue); ` +
      'foreach ($process in $processes) { if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() } }'
  );
}
export function systemNotify(title: string, message: string): void {
  try {
    const appId = String(getRegisteredEnvText('KYBERION_WINDOWS_AUMID') || '').trim();
    if (appId) {
      const xml = `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual></toast>`;
      const script = [
        'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
        `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml(${quote(xml)})`,
        `$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${quote(appId)}).Show($toast)`,
      ].join('; ');
      run(script);
      return;
    }
    safeExec('msg.exe', ['*', `${title}: ${message}`]);
  } catch {
    // Notifications are best-effort and must not block the automation flow.
  }
}

export function clipboardRead(): string {
  return runResult('Get-Clipboard -Raw');
}
export function clipboardWrite(text: string): void {
  run(`Set-Clipboard -Value ${quote(text)}`);
}
export function takeScreenshot(_path?: string): string {
  return '';
}
