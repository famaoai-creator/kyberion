import { safeExec, safeExecResult } from '../secure-io.js';
import { activateApplication, toAppleScriptString } from '../apple-event-bridge.js';
import { terminalBridge } from '../shell/terminal-bridge.js';
import { powerShellStdinArgs, windowsPowerShellEnv } from '../windows-powershell.js';

export interface KnownAppCapability {
  application: string;
  adapter: 'browser_tabs' | 'terminal' | 'file_manager';
  capabilities: string[];
}

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
}

/** OS-specific file manager boundary; callers depend on intent, not Finder/Explorer APIs. */
export interface FileManagerPlatformAdapter {
  readonly application: string;
  emptyTrash(): void;
  revealPath(path: string): void;
  openPath(path: string): void;
}

export const WINDOWS_CHROME_TAB_ACTION_ENV = 'KYBERION_WINDOWS_CHROME_TAB_ACTION';
export const WINDOWS_FILE_MANAGER_ACTION_ENV = 'KYBERION_WINDOWS_FILE_MANAGER_ACTION';

export const WINDOWS_FILE_MANAGER_ACTION_SCRIPT = `$ErrorActionPreference = 'Stop'
$raw = [string]$env:${WINDOWS_FILE_MANAGER_ACTION_ENV}
if (-not $raw) { throw 'File manager action options are missing' }
$options = ConvertFrom-Json -InputObject $raw
switch ([string]$options.operation) {
  'reveal' { Start-Process -FilePath 'explorer.exe' -ArgumentList @('/select,' + [string]$options.path) }
  'open' { Start-Process -FilePath ([string]$options.path) }
  'empty_trash' { Clear-RecycleBin -Force -ErrorAction Stop }
  default { throw 'Unsupported file manager action' }
}`;

/** Windows Chrome UIA action script; request data is passed separately as JSON in the child env. */
export const WINDOWS_CHROME_TAB_ACTION_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$raw = [string]$env:${WINDOWS_CHROME_TAB_ACTION_ENV}
if (-not $raw) { throw 'Chrome tab action options are missing' }
$options = ConvertFrom-Json -InputObject $raw
$targetTitle = [string]$options.title
$operation = [string]$options.operation
if ([string]::IsNullOrWhiteSpace($targetTitle)) { throw 'Chrome tab title is required' }
if ($operation -notin @('activate', 'close')) { throw 'Unsupported Chrome tab action' }
$process = Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $process) { [Console]::Out.WriteLine('{"matched":false,"reason":"no_window"}'); exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$tabs = @()
for ($i = 0; $i -lt $all.Count; $i++) {
  $element = $all.Item($i)
  if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem) {
    $tabs += $element
  }
}
$exactMatches = @($tabs | Where-Object { [string]::Equals($_.Current.Name, $targetTitle, [StringComparison]::OrdinalIgnoreCase) })
$matchedTabs = $exactMatches
if ($matchedTabs.Count -eq 0) {
  $matchedTabs = @($tabs | Where-Object { $_.Current.Name.IndexOf($targetTitle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
if ($matchedTabs.Count -ne 1) {
  $reason = if ($matchedTabs.Count -gt 1) { 'ambiguous' } else { 'not_found' }
  [Console]::Out.WriteLine((@{ matched = $false; reason = $reason } | ConvertTo-Json -Compress))
  exit 0
}
$tab = $matchedTabs[0]
$selectedTitle = [string]$tab.Current.Name
$selection = $null
if (-not $tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
  [Console]::Out.WriteLine('{"matched":false,"reason":"selection_unavailable"}')
  exit 0
}
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate([int]$process.Id)) {
  [Console]::Out.WriteLine('{"matched":false,"reason":"window_activation_failed"}')
  exit 0
}
[void]$selection.Select()
$tab.SetFocus()
$selected = $false
try { $selected = $selection.Current.IsSelected } catch { }
if (-not $selected) {
  [Console]::Out.WriteLine('{"matched":false,"reason":"selection_failed"}')
  exit 0
}
if ($operation -eq 'activate') {
  [Console]::Out.WriteLine('{"matched":true,"reason":"selected"}')
  exit 0
}
[void]$shell.SendKeys('^w')
$deadline = [DateTime]::UtcNow.AddSeconds(2)
$stillPresent = $true
while ($stillPresent -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 100
  $currentProcess = Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if (-not $currentProcess) { $stillPresent = $false; break }
  $currentRoot = [System.Windows.Automation.AutomationElement]::FromHandle($currentProcess.MainWindowHandle)
  $currentTabs = $currentRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $stillPresent = $false
  for ($i = 0; $i -lt $currentTabs.Count; $i++) {
    $element = $currentTabs.Item($i)
    if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and [string]::Equals($element.Current.Name, $selectedTitle, [StringComparison]::OrdinalIgnoreCase)) { $stillPresent = $true; break }
  }
}
[Console]::Out.WriteLine((@{ matched = -not $stillPresent; reason = $(if ($stillPresent) { 'close_not_verified' } else { 'closed' }) } | ConvertTo-Json -Compress))`;

export interface TerminalTargetInfo {
  application: string;
  supported: boolean;
  preferred: boolean;
  adapter: 'terminal' | 'iterm2';
  canInject: boolean;
  sessionCount: number;
  sessions?: Array<{
    winId: string;
    sessionId: string;
    type: string;
    status?: string;
    pid?: number;
  }>;
  idleSession?: {
    winId: string;
    sessionId: string;
    type: string;
  } | null;
}

const KNOWN_APP_CAPABILITIES: KnownAppCapability[] = [
  {
    application: 'Google Chrome',
    adapter: 'browser_tabs',
    capabilities: [
      'list_tabs',
      'activate_tab_by_title',
      'activate_tab_by_url',
      'close_tab_by_title',
      'close_tab_by_url',
    ],
  },
  {
    application: 'Finder',
    adapter: 'file_manager' as const,
    capabilities: ['empty_trash', 'reveal_path', 'open_path'],
  },
  {
    application: 'Terminal',
    adapter: 'terminal',
    capabilities: ['activate_application', 'list_terminal_targets'],
  },
  {
    application: 'iTerm2',
    adapter: 'terminal',
    capabilities: ['activate_application', 'list_terminal_targets'],
  },
];

function isDarwin() {
  return process.platform === 'darwin';
}

export function listKnownAppCapabilities(): KnownAppCapability[] {
  if (process.platform === 'win32') {
    const chrome = KNOWN_APP_CAPABILITIES.find((entry) => entry.application === 'Google Chrome');
    const fileManager = resolveFileManagerPlatform();
    const capabilities: KnownAppCapability[] = [];
    if (chrome) {
      capabilities.push({
        ...chrome,
        capabilities: ['list_tabs', 'activate_tab_by_title', 'close_tab_by_title'],
      });
    }
    if (fileManager) {
      capabilities.push({
        application: fileManager.application,
        adapter: 'file_manager',
        capabilities: ['empty_trash', 'reveal_path', 'open_path'],
      });
    }
    return capabilities;
  }
  if (!isDarwin()) return [];
  return KNOWN_APP_CAPABILITIES.map((entry) => ({
    ...entry,
    capabilities: [...entry.capabilities],
  }));
}

export function listChromeTabs(application = 'Google Chrome'): BrowserTabInfo[] {
  if (process.platform === 'win32') {
    if (!isWindowsChrome(application)) return [];
    return listWindowsChromeTabs();
  }
  if (!isDarwin()) {
    return [];
  }
  activateApplication(application);
  const script = [
    `tell application "${toAppleScriptString(application)}"`,
    'set outLines to {}',
    'repeat with w in windows',
    'set ti to 0',
    'repeat with t in tabs of w',
    'set ti to ti + 1',
    'set end of outLines to ((ti as string) & linefeed & (title of t as string) & linefeed & (URL of t as string))',
    'end repeat',
    'end repeat',
    'return outLines as string',
    'end tell',
  ].join('\n');
  const output = String(safeExec('osascript', ['-e', script])).trim();
  if (!output) {
    return [];
  }
  const lines = output.split('\n').map((line) => line.trim());
  const tabs: BrowserTabInfo[] = [];
  for (let index = 0; index < lines.length; index += 3) {
    tabs.push({
      index: Number(lines[index] || tabs.length + 1),
      title: lines[index + 1] || '',
      url: lines[index + 2] || '',
    });
  }
  return tabs;
}

function isWindowsChrome(application: string): boolean {
  const normalized = application.trim().toLowerCase();
  return normalized === 'google chrome' || normalized === 'chrome';
}

function runWindowsChromeTabAction(
  operation: 'activate' | 'close',
  title: string
): { matched: boolean } {
  if (!title.trim() || title.length > 512) return { matched: false };
  const result = safeExecResult('powershell.exe', powerShellStdinArgs(), {
    timeoutMs: operation === 'close' ? 10_000 : 8_000,
    maxOutputMB: 1,
    env: {
      ...windowsPowerShellEnv(),
      [WINDOWS_CHROME_TAB_ACTION_ENV]: JSON.stringify({ operation, title }),
    },
    input: WINDOWS_CHROME_TAB_ACTION_SCRIPT,
  });
  if (result.status !== 0) return { matched: false };
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { matched?: unknown };
    return { matched: parsed.matched === true };
  } catch {
    return { matched: false };
  }
}

/** Read visible Chrome tab names and the active address through Windows UI Automation. */
function listWindowsChromeTabs(): BrowserTabInfo[] {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$tabs = @()
foreach ($p in (Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $candidateTabs = @()
    $activeUrl = ''
    $activeIndex = 0
    for ($i = 0; $i -lt $all.Count; $i++) {
      $e = $all.Item($i)
      if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
        try {
          $value = [string]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
          if ($value -match '^[^\s]+\.[^\s]+$') { $activeUrl = $value }
        } catch { }
      }
      if ($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem) {
        $candidateTabs += [pscustomobject]@{ index = $candidateTabs.Count + 1; title = [string]$e.Current.Name; url = '' }
        try { if ($e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $activeIndex = $candidateTabs.Count } } catch { }
      }
    }
    if ($candidateTabs.Count -gt $tabs.Count) {
      $tabs = @($candidateTabs)
      if ($activeIndex -gt 0 -and $activeUrl) { $tabs[$activeIndex - 1].url = $(if ($activeUrl -match '^https?://') { $activeUrl } else { 'https://' + $activeUrl }) }
    }
  } catch { }
}
ConvertTo-Json -InputObject @($tabs) -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }`;
  const result = safeExecResult(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: 8_000, maxOutputMB: 1 }
  );
  if (result.status !== 0) return [];
  const output = result.stdout.trim();
  if (!output) return [];
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as Record<string, unknown>;
      return [
        {
          index: Number.isInteger(row.index) ? Number(row.index) : index + 1,
          title: typeof row.title === 'string' ? row.title : '',
          url: typeof row.url === 'string' ? row.url : '',
        },
      ];
    });
  } catch {
    return [];
  }
}

export function activateChromeTabByTitle(title: string, application = 'Google Chrome') {
  if (process.platform === 'win32') {
    if (!isWindowsChrome(application)) return { matched: false };
    return runWindowsChromeTabAction('activate', title);
  }
  if (!isDarwin()) {
    return { matched: false };
  }
  activateApplication(application);
  const script = [
    `tell application "${toAppleScriptString(application)}"`,
    `set targetTitle to "${toAppleScriptString(title)}"`,
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if (title of t as string) contains targetTitle then',
    'set active tab index of w to (index of t)',
    'set index of w to 1',
    'return "matched"',
    'end if',
    'end repeat',
    'end repeat',
    'return "not_matched"',
    'end tell',
  ].join('\n');
  const output = String(safeExec('osascript', ['-e', script])).trim();
  return { matched: output === 'matched' };
}

export function activateChromeTabByUrl(urlFragment: string, application = 'Google Chrome') {
  if (!isDarwin()) {
    return { matched: false };
  }
  activateApplication(application);
  const script = [
    `tell application "${toAppleScriptString(application)}"`,
    `set targetUrl to "${toAppleScriptString(urlFragment)}"`,
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if (URL of t as string) contains targetUrl then',
    'set active tab index of w to (index of t)',
    'set index of w to 1',
    'return "matched"',
    'end if',
    'end repeat',
    'end repeat',
    'return "not_matched"',
    'end tell',
  ].join('\n');
  const output = String(safeExec('osascript', ['-e', script])).trim();
  return { matched: output === 'matched' };
}

export function closeChromeTabByTitle(title: string, application = 'Google Chrome') {
  if (process.platform === 'win32') {
    if (!isWindowsChrome(application)) return { matched: false };
    return runWindowsChromeTabAction('close', title);
  }
  if (!isDarwin()) {
    return { matched: false };
  }
  activateApplication(application);
  const script = [
    `tell application "${toAppleScriptString(application)}"`,
    `set targetTitle to "${toAppleScriptString(title)}"`,
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if (title of t as string) contains targetTitle then',
    'close t',
    'return "matched"',
    'end if',
    'end repeat',
    'end repeat',
    'return "not_matched"',
    'end tell',
  ].join('\n');
  const output = String(safeExec('osascript', ['-e', script])).trim();
  return { matched: output === 'matched' };
}

export function closeChromeTabByUrl(urlFragment: string, application = 'Google Chrome') {
  if (!isDarwin()) {
    return { matched: false };
  }
  activateApplication(application);
  const script = [
    `tell application "${toAppleScriptString(application)}"`,
    `set targetUrl to "${toAppleScriptString(urlFragment)}"`,
    'repeat with w in windows',
    'repeat with t in tabs of w',
    'if (URL of t as string) contains targetUrl then',
    'close t',
    'return "matched"',
    'end if',
    'end repeat',
    'end repeat',
    'return "not_matched"',
    'end tell',
  ].join('\n');
  const output = String(safeExec('osascript', ['-e', script])).trim();
  return { matched: output === 'matched' };
}

export function emptyFinderTrash() {
  resolveFileManagerPlatform()?.emptyTrash();
}

export function revealFinderPath(targetPath: string) {
  resolveFileManagerPlatform()?.revealPath(targetPath);
}

export function openFinderPath(targetPath: string) {
  resolveFileManagerPlatform()?.openPath(targetPath);
}

const macFileManagerAdapter: FileManagerPlatformAdapter = {
  application: 'Finder',
  emptyTrash() {
    safeExec('osascript', ['-e', 'tell application "Finder" to empty the trash']);
  },
  revealPath(targetPath) {
    const script = [
      'set targetPath to POSIX file "' + toAppleScriptString(targetPath) + '"',
      'tell application "Finder"',
      'activate',
      'reveal targetPath',
      'end tell',
    ].join('\n');
    safeExec('osascript', ['-e', script]);
  },
  openPath(targetPath) {
    const script = [
      'set targetPath to POSIX file "' + toAppleScriptString(targetPath) + '"',
      'tell application "Finder"',
      'activate',
      'open targetPath',
      'end tell',
    ].join('\n');
    safeExec('osascript', ['-e', script]);
  },
};

const windowsFileManagerAdapter: FileManagerPlatformAdapter = {
  application: 'File Explorer',
  emptyTrash() {
    runWindowsFileManagerAction('empty_trash');
  },
  revealPath(path) {
    runWindowsFileManagerAction('reveal', path);
  },
  openPath(path) {
    runWindowsFileManagerAction('open', path);
  },
};

/** Resolve the OS implementation at the boundary; callers can test/inspect this without OS I/O. */
export function resolveFileManagerPlatform(
  platform: NodeJS.Platform = process.platform
): FileManagerPlatformAdapter | undefined {
  if (platform === 'win32') return windowsFileManagerAdapter;
  if (platform === 'darwin') return macFileManagerAdapter;
  return undefined;
}

function runWindowsFileManagerAction(operation: 'reveal' | 'open' | 'empty_trash', path?: string) {
  if ((operation === 'reveal' || operation === 'open') && (!path || path.length > 32_000)) return;
  safeExecResult('powershell.exe', powerShellStdinArgs(), {
    timeoutMs: 10_000,
    maxOutputMB: 1,
    env: {
      ...windowsPowerShellEnv(),
      [WINDOWS_FILE_MANAGER_ACTION_ENV]: JSON.stringify({ operation, path }),
    },
    input: WINDOWS_FILE_MANAGER_ACTION_SCRIPT,
  });
}

export function listTerminalTargets(): TerminalTargetInfo[] {
  const targets = terminalBridge.listTargets();
  return targets.map((target) => ({
    application: target.application,
    supported: true,
    preferred: Boolean(target.idleSession),
    adapter: target.adapter === 'iterm2' ? 'iterm2' : 'terminal',
    canInject: true,
    sessionCount: target.sessions.length,
    sessions: target.sessions,
    idleSession: target.idleSession,
  }));
}
