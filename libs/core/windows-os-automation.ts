import { safeExec, safeExecResult } from './secure-io.js';
import type { FocusedInputState } from './apple-event-bridge.js';
import { escapeXml } from './text-escaping.js';

const PS = 'powershell.exe';

function quote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
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
  run(`$ws = New-Object -ComObject WScript.Shell; [void]$ws.AppActivate(${quote(application)})`);
}

export function detectFocusedInput(): FocusedInputState {
  const title = runResult(
    '(Get-Process | Where-Object {$_.MainWindowHandle -eq (Get-Process -Id $PID).MainWindowHandle} | Select-Object -First 1 -ExpandProperty MainWindowTitle)'
  );
  return { application: '', windowTitle: title, role: '', description: '', editable: false };
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

function mouse(x: number, y: number, flags: number): void {
  run(
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e); }'; [M]::SetCursorPos(${Math.round(x)},${Math.round(y)}); [M]::mouse_event(${flags},0,0,0,[UIntPtr]::Zero)`
  );
}

export function clickAt(x: number, y: number, clickCount = 1): void {
  for (let i = 0; i < clickCount; i += 1) {
    mouse(x, y, 0x0002);
    mouse(x, y, 0x0004);
  }
}
export function rightClickAt(x: number, y: number, clickCount = 1): void {
  for (let i = 0; i < clickCount; i += 1) {
    mouse(x, y, 0x0008);
    mouse(x, y, 0x0010);
  }
}
export function moveMouse(x: number, y: number): void {
  mouse(x, y, 0);
}
export function scrollAt(
  _x: number,
  _y: number,
  direction: 'up' | 'down' | 'left' | 'right',
  amount = 3
): void {
  const delta = direction === 'up' || direction === 'right' ? 120 : -120;
  run(
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class S { [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e); }'; [S]::mouse_event(0x0800,0,0,${delta * Math.max(1, amount)},[UIntPtr]::Zero)`
  );
}
export function dragFrom(x1: number, y1: number, x2: number, y2: number): void {
  mouse(x1, y1, 0x0002);
  mouse(x2, y2, 0x0004);
}
export function runAppleScript(_script: string): string {
  return '';
}

export function getScreenSize(): { width: number; height: number } {
  try {
    return JSON.parse(
      runResult(
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds | ConvertTo-Json -Compress'
      )
    );
  } catch {
    return { width: 0, height: 0 };
  }
}
export function getWindowList(_appName: string): string[] {
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
    '$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)',
    'for ($i = 0; $i -lt $windows.Count; $i++) {',
    '  $name = $windows.Item($i).Current.Name',
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
export function activateWindowByTitle(_appName: string, windowTitle: string): boolean {
  activateApplication(windowTitle);
  return true;
}
export function quitApplication(application: string): void {
  run(`Get-Process -Name ${quote(application)} -ErrorAction SilentlyContinue | Stop-Process`);
}
export function systemNotify(title: string, message: string): void {
  try {
    const appId = String(process.env.KYBERION_WINDOWS_AUMID || '').trim();
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
