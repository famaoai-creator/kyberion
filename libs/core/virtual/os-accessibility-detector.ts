import { logger } from '../core.js';
import { safeExecResultAsync } from '../secure-io.js';
import { safeMarkLabel, type SomBox, type SomCandidate } from '../set-of-marks.js';
import type {
  UiElementDetectionRequest,
  UiElementDetector,
} from '../surface/ui-element-detector.js';
import { powerShellStdinArgs, windowsPowerShellEnv } from '../windows-powershell.js';

/**
 * `os_accessibility` UI element detector: exact element rectangles of a native
 * app, read from the OS accessibility tree of this machine's live screen.
 *
 * macOS: a JXA script walks the frontmost window of the frontmost (or a
 * named) application through System Events, one level of the tree per round
 * trip (each property of a whole level is fetched in one Apple event), and
 * returns role / subrole / title / description / position / size.
 *
 * Windows: a PowerShell script walks the foreground window (GetForegroundWindow
 * -> AutomationElement.FromHandle; a named application only when it owns the
 * foreground window) breadth-first through .NET UI Automation, one cached
 * FindAll(Children) per node, with the same caps. UIA control types are
 * normalised to the AX role vocabulary (UIA_TO_AX_ROLE) so filtering, editable
 * handling and labelling are shared. The script makes its thread per-monitor
 * DPI aware, so element rects and the reported primary screen size are both
 * physical pixels and the default scale (image width / screen width) fits a
 * primary-monitor screenshot at any display scaling. Options travel in an
 * environment variable of the child process and the script is fed on stdin to a
 * fixed -EncodedCommand bootstrap (the command line stays small whatever the
 * script size), so no request value is ever part of the script text.
 *
 * The detector only ever runs when the request declares that the screenshot
 * IS this machine's live screen (`live_screen: true`): accessibility positions
 * describe the screen now, never an arbitrary image. It then maps global
 * logical points (Windows: physical pixels) to screenshot pixels with `screen_origin` (default 0,0: the
 * main display) and `screen_scale` (default: image width / main display width
 * in points). The default scale is only right for the main display, so a
 * screenshot with a non-zero `screen_origin` (another display) and no
 * `screen_scale` makes the detector unavailable. Availability also requires, on
 * macOS, the accessibility permission (`AXIsProcessTrusted`, which never
 * prompts) and, on Windows, a PowerShell that loads UI Automation (UIA needs
 * no permission); every check fails closed.
 *
 * Labels go through safeMarkLabel like every Set-of-Marks label, and editable
 * fields carry no label at all.
 */

export const OS_ACCESSIBILITY_TIMEOUT_MS = 8_000;
export const OS_ACCESSIBILITY_PROBE_TIMEOUT_MS = 3_000;
export const OS_ACCESSIBILITY_MAX_ELEMENTS = 200;
export const OS_ACCESSIBILITY_MAX_SCAN = 2_000;
export const OS_ACCESSIBILITY_MAX_DEPTH = 12;
const PERMISSION_CACHE_MS = 30_000;
// A denial is re-probed sooner so a newly granted permission takes effect quickly.
const PERMISSION_DENIED_CACHE_MS = 5_000;
/** Windows probe: a cold powershell.exe start alone can take a few seconds. */
export const OS_ACCESSIBILITY_WINDOWS_PROBE_TIMEOUT_MS = 6_000;
/**
 * Windows walk budget, measured from the start of the script: the walk stops
 * (truncated) in time to print its snapshot before the 8 s process timeout,
 * which also has to cover powershell.exe start-up and the P/Invoke compile.
 */
export const OS_ACCESSIBILITY_WINDOWS_WALK_BUDGET_MS = 5_000;
/** Child-process environment variable carrying the Windows script options (JSON). */
export const OS_ACCESSIBILITY_WINDOWS_OPTIONS_ENV = 'KYBERION_UIA_OPTIONS';
/**
 * Opt-in switch for the Windows live smoke test (os-accessibility-detector.live.test.ts):
 * '1' launches Notepad on this machine's desktop and runs the detector against it.
 */
export const OS_ACCESSIBILITY_LIVE_SMOKE_ENV = 'KYBERION_UIA_LIVE_SMOKE';
const POWERSHELL = 'powershell.exe';

/** Roles a user can click, type into or toggle. */
export const INTERACTIVE_AX_ROLES: ReadonlySet<string> = new Set([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXComboBox',
  'AXTextField',
  'AXTextArea',
  'AXSearchField',
  'AXSlider',
  'AXIncrementor',
  'AXStepper',
  'AXLink',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXDisclosureTriangle',
  'AXColorWell',
  'AXTab',
  'AXCell',
]);
const EDITABLE_AX_ROLES: ReadonlySet<string> = new Set(['AXTextField', 'AXTextArea', 'AXComboBox']);
const EDITABLE_AX_SUBROLES: ReadonlySet<string> = new Set(['AXSearchField', 'AXSecureTextField']);

/**
 * Windows UI Automation control types (ProgrammaticName without the
 * `ControlType.` prefix) mapped to the AX role vocabulary above. Edit and
 * Document are text inputs (editable), ComboBox is editable like AXComboBox,
 * list/data/tree items are cells. Unmapped types become `uia:<Type>` and are
 * dropped by the interactive filter.
 */
export const UIA_TO_AX_ROLE: Readonly<Record<string, string>> = {
  Button: 'AXButton',
  SplitButton: 'AXMenuButton',
  CheckBox: 'AXCheckBox',
  RadioButton: 'AXRadioButton',
  ComboBox: 'AXComboBox',
  Edit: 'AXTextField',
  Document: 'AXTextArea',
  Hyperlink: 'AXLink',
  MenuItem: 'AXMenuItem',
  TabItem: 'AXTab',
  ListItem: 'AXCell',
  DataItem: 'AXCell',
  TreeItem: 'AXCell',
  Slider: 'AXSlider',
  Spinner: 'AXIncrementor',
};

export interface AccessibilityCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export type AccessibilityCommandRunner = (
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxOutputMB: number;
    env?: Record<string, string>;
    /** Written to the child's stdin (the Windows scripts travel this way). */
    input?: string;
  }
) => Promise<AccessibilityCommandResult>;

export interface OsAccessibilityDetectorDeps {
  run?: AccessibilityCommandRunner;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** One accessibility element as the enumeration script reports it. */
export interface AccessibilityElement {
  role: string;
  subrole?: string | null;
  title?: string | null;
  description?: string | null;
  /** Windows: UIA IsPassword (the element is a password field). */
  password?: boolean;
  /** Windows: UIA ClassName (the Win32 window class for Win32 / WinForms controls). */
  class_name?: string;
  /** Windows: UIA FrameworkId ('Win32', 'WinForm', 'WPF', 'XAML', 'DirectUI', ...). */
  framework_id?: string;
  /**
   * Global logical points (top-left of the main display is 0,0); on Windows
   * physical pixels (top-left of the primary monitor is 0,0).
   */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AccessibilitySnapshot {
  /** Main display size in logical points (Windows: primary monitor in physical pixels). */
  screen?: { width: number; height: number };
  application?: string;
  /** Windows: rect of the enumerated foreground window, in element coordinates. */
  window?: { x: number; y: number; width: number; height: number };
  /** Windows: DPI awareness the script ran with ('per_monitor_v2', 'system' or 'unaware'). */
  dpi_awareness?: string;
  /** Windows: walk strategy whose elements were returned (managed_control, com_control, com_raw). */
  strategy?: string;
  /** Windows: per-strategy walk diagnostics (counts, skip reasons, a name-free raw sample). */
  diagnostics?: Record<string, unknown>;
  elements: AccessibilityElement[];
  truncated?: boolean;
  reason?: string;
}

const PERMISSION_SCRIPT =
  'ObjC.import("ApplicationServices"); JSON.stringify({ trusted: $.AXIsProcessTrusted() === true })';

// Walks one tree level per iteration: `spec.uiElements.<prop>()` returns the
// property of every element at that depth in a single Apple event, nested one
// array per level, so flattening each column the same way keeps them aligned.
// A named application must also be frontmost: its front window is only what
// the live screenshot shows when the app is in front, so a background app's
// rects would land on another app's pixels ('not_frontmost', no elements).
export const OS_ACCESSIBILITY_ENUMERATE_SCRIPT = `function run(argv) {
  var opts = JSON.parse(argv[0] || '{}');
  ObjC.import('AppKit');
  var frame = $.NSScreen.mainScreen.frame;
  var out = { screen: { width: frame.size.width, height: frame.size.height }, elements: [] };
  var se = Application('System Events');
  var procs = opts.application
    ? se.applicationProcesses.whose({ name: opts.application })
    : se.applicationProcesses.whose({ frontmost: true });
  if (procs.length === 0) { out.reason = 'no_process'; return JSON.stringify(out); }
  var proc = procs[0];
  out.application = proc.name();
  if (opts.application && proc.frontmost() !== true) { out.reason = 'not_frontmost'; return JSON.stringify(out); }
  if (proc.windows.length === 0) { out.reason = 'no_window'; return JSON.stringify(out); }
  var flat = function (value, depth) {
    var list = [value];
    for (var i = 0; i < depth; i += 1) {
      var next = [];
      for (var j = 0; j < list.length; j += 1) {
        if (Array.isArray(list[j])) { for (var k = 0; k < list[j].length; k += 1) next.push(list[j][k]); }
        else next.push(list[j]);
      }
      list = next;
    }
    return list;
  };
  var column = function (spec, name, depth, length) {
    try {
      var values = flat(spec[name](), depth);
      return values.length === length ? values : null;
    } catch (e) { return null; }
  };
  var spec = proc.windows[0];
  for (var depth = 1; depth <= opts.maxDepth; depth += 1) {
    spec = spec.uiElements;
    var roles;
    try { roles = flat(spec.role(), depth); } catch (e) { break; }
    if (roles.length === 0) break;
    var sub = column(spec, 'subrole', depth, roles.length);
    var name = column(spec, 'name', depth, roles.length);
    var desc = column(spec, 'description', depth, roles.length);
    var pos = column(spec, 'position', depth, roles.length);
    var size = column(spec, 'size', depth, roles.length);
    if (!pos || !size) continue;
    for (var i = 0; i < roles.length; i += 1) {
      if (out.elements.length >= opts.maxScan) { out.truncated = true; break; }
      if (!pos[i] || !size[i]) continue;
      out.elements.push({
        role: String(roles[i] || ''),
        subrole: sub ? sub[i] : null,
        title: name ? name[i] : null,
        description: desc ? desc[i] : null,
        x: pos[i][0], y: pos[i][1], width: size[i][0], height: size[i][1]
      });
    }
    if (out.truncated) break;
  }
  return JSON.stringify(out);
}`;

/**
 * Windows availability probe: UI Automation needs no permission, only a
 * powershell.exe that can load the UIA client assemblies.
 */
export const OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ok = $null -ne [System.Windows.Automation.AutomationElement]::RootElement
[Console]::Out.WriteLine('{"available":' + $(if ($ok) { 'true' } else { 'false' }) + '}')
[Console]::Out.Flush()`;

// Windows enumeration through .NET UI Automation. Options come from the child
// environment (never from the script text). The thread is made per-monitor DPI
// aware first (fallback: system aware), so BoundingRectangle and the primary
// screen size (GetSystemMetrics) are both physical pixels. The foreground
// window is the only window read: a named application must own it, otherwise
// 'not_frontmost' with no elements (its rects would land on another app's
// pixels). The walk is breadth-first and bounded by depth, scan count and a
// time budget; a skipped element (offscreen, empty rect) is still descended
// into. Strategies run in order until one finds an actionable control type:
// managed_control (managed UIA client, control view, one cached
// FindAll(Children) per node), then com_control and com_raw (the COM UIA
// client, which sees WinUI / XAML island content the managed client can miss,
// over the control and raw views; its C# is compiled in memory only when the
// managed walk found no controls). The snapshot names the chosen strategy and
// carries per-strategy diagnostics (per-depth scanned/emitted counts, skip
// reasons, the first 20 raw elements' control type / class / framework / rect,
// no names).
// JSON is written by hand with every non-ASCII character escaped, so stdout is
// plain ASCII whatever the console code page.
export const OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$raw = [string]$env:${OS_ACCESSIBILITY_WINDOWS_OPTIONS_ENV}
if (-not $raw) { $raw = '{}' }
$opts = ConvertFrom-Json -InputObject $raw
$maxDepth = 12
if ($opts.maxDepth) { $maxDepth = [int]$opts.maxDepth }
$maxScan = 2000
if ($opts.maxScan) { $maxScan = [int]$opts.maxScan }
$budget = 5000
if ($opts.budgetMs) { $budget = [int]$opts.budgetMs }
$app = ''
if ($opts.application) { $app = [string]$opts.application }
$esc = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) '\\u{0:x4}' -f [int][char]$m.Value }
function JS($s) {
  if ($null -eq $s) { return 'null' }
  return '"' + [regex]::Replace([string]$s, '[^\\x20-\\x7E]|["\\\\]', $esc) + '"'
}
function JN($n) {
  $d = [double]$n
  if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 'null' }
  return $d.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
}
function JR($r) {
  return '{"x":' + (JN $r.X) + ',"y":' + (JN $r.Y) + ',"width":' + (JN $r.Width) + ',"height":' + (JN $r.Height) + '}'
}
$csUsing = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
'@
$csNative = @'
public static class KyberionUiaNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$csCom = @'
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKyberionUiAutomation {
  void CompareElements();
  void CompareRuntimeIds();
  void GetRootElement();
  [return: MarshalAs(UnmanagedType.Interface)] IKyberionUiaElement ElementFromHandle(IntPtr hwnd);
  void ElementFromPoint();
  void GetFocusedElement();
  void GetRootElementBuildCache();
  void ElementFromHandleBuildCache();
  void ElementFromPointBuildCache();
  void GetFocusedElementBuildCache();
  void CreateTreeWalker();
  IKyberionUiaTreeWalker ControlViewWalker { [return: MarshalAs(UnmanagedType.Interface)] get; }
  IKyberionUiaTreeWalker ContentViewWalker { [return: MarshalAs(UnmanagedType.Interface)] get; }
  IKyberionUiaTreeWalker RawViewWalker { [return: MarshalAs(UnmanagedType.Interface)] get; }
}
[ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKyberionUiaTreeWalker {
  void GetParentElement();
  [return: MarshalAs(UnmanagedType.Interface)] IKyberionUiaElement GetFirstChildElement([MarshalAs(UnmanagedType.Interface)] IKyberionUiaElement element);
  void GetLastChildElement();
  [return: MarshalAs(UnmanagedType.Interface)] IKyberionUiaElement GetNextSiblingElement([MarshalAs(UnmanagedType.Interface)] IKyberionUiaElement element);
}
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IKyberionUiaElement {
  void SetFocus();
  void GetRuntimeId();
  void FindFirst();
  void FindAll();
  void FindFirstBuildCache();
  void FindAllBuildCache();
  void BuildUpdatedCache();
  [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int propertyId);
}
public static class KyberionUiaJson {
  public static string Str(string s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder();
    b.Append('"');
    foreach (char c in s) {
      if (c < (char)0x20 || c > (char)0x7E || c == '"' || c == (char)92) {
        b.Append((char)92).Append('u').Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      } else {
        b.Append(c);
      }
    }
    b.Append('"');
    return b.ToString();
  }
  public static string Num(double d) {
    if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
    return d.ToString("R", CultureInfo.InvariantCulture);
  }
}
public sealed class KyberionUiaWalk {
  public string Name;
  public List<string> Elements = new List<string>();
  public List<string> Sample = new List<string>();
  public int Scanned;
  public int Actionable;
  public bool Truncated;
  public string Error;
  public int SkippedOffscreen;
  public int SkippedEmpty;
  public int ReadErrors;
  public int ChildErrors;
  public int[] ScannedByDepth = new int[65];
  public int[] EmittedByDepth = new int[65];
  public string Diagnostics() {
    StringBuilder b = new StringBuilder();
    b.Append(@"{""name"":").Append(KyberionUiaJson.Str(Name));
    b.Append(@",""scanned"":").Append(Scanned);
    b.Append(@",""emitted"":").Append(Elements.Count);
    b.Append(@",""actionable"":").Append(Actionable);
    b.Append(@",""truncated"":").Append(Truncated ? "true" : "false");
    b.Append(@",""skipped"":{""offscreen"":").Append(SkippedOffscreen);
    b.Append(@",""empty_rect"":").Append(SkippedEmpty);
    b.Append(@",""read_error"":").Append(ReadErrors).Append('}');
    b.Append(@",""child_errors"":").Append(ChildErrors);
    b.Append(@",""per_depth"":[");
    bool first = true;
    for (int d = 0; d < ScannedByDepth.Length; d++) {
      if (ScannedByDepth[d] == 0) continue;
      if (!first) b.Append(',');
      first = false;
      b.Append(@"{""depth"":").Append(d).Append(@",""scanned"":").Append(ScannedByDepth[d]).Append(@",""emitted"":").Append(EmittedByDepth[d]).Append('}');
    }
    b.Append(@"],""error"":").Append(KyberionUiaJson.Str(Error));
    b.Append(@",""sample"":[").Append(string.Join(",", Sample.ToArray())).Append("]}");
    return b.ToString();
  }
}
public static class KyberionUiaComWalker {
  static readonly string[] Types = new string[] {
    "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu",
    "MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem",
    "Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid", "DataItem",
    "Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom",
    "AppBar"
  };
  static IKyberionUiAutomation Create() {
    Exception last = null;
    foreach (string clsid in new string[] { "e22ad333-b25f-460c-83d0-0581107395c9", "ff48dba4-60ef-4201-aa87-54103eef594e" }) {
      try {
        return (IKyberionUiAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid)));
      } catch (Exception e) {
        last = e;
      }
    }
    throw last;
  }
  static string Rect(double[] r) {
    if (r == null || r.Length < 4) return "null";
    return "[" + KyberionUiaJson.Num(r[0]) + "," + KyberionUiaJson.Num(r[1]) + "," + KyberionUiaJson.Num(r[2]) + "," + KyberionUiaJson.Num(r[3]) + "]";
  }
  static void Record(KyberionUiaWalk walk, IKyberionUiaElement e, int depth, string[] actionable) {
    int d = Math.Min(depth, walk.ScannedByDepth.Length - 1);
    walk.ScannedByDepth[d]++;
    string type;
    double[] rect;
    bool offscreen;
    bool password;
    string name;
    string help;
    try {
      object ct = e.GetCurrentPropertyValue(30003);
      int id = ct is int ? (int)ct : -1;
      type = id >= 50000 && id - 50000 < Types.Length ? Types[id - 50000] : "Id" + id.ToString(CultureInfo.InvariantCulture);
      rect = e.GetCurrentPropertyValue(30001) as double[];
      object off = e.GetCurrentPropertyValue(30022);
      offscreen = off is bool && (bool)off;
      object pw = e.GetCurrentPropertyValue(30019);
      password = pw is bool && (bool)pw;
      name = e.GetCurrentPropertyValue(30005) as string;
      help = e.GetCurrentPropertyValue(30013) as string;
    } catch (Exception) {
      walk.ReadErrors++;
      return;
    }
    string cls = null;
    string fw = null;
    try {
      cls = e.GetCurrentPropertyValue(30012) as string;
      fw = e.GetCurrentPropertyValue(30024) as string;
    } catch (Exception) { }
    if (walk.Sample.Count < 20) {
      walk.Sample.Add(@"{""depth"":" + depth.ToString(CultureInfo.InvariantCulture) + @",""control_type"":" + KyberionUiaJson.Str(type) + @",""class_name"":" + KyberionUiaJson.Str(cls) + @",""framework_id"":" + KyberionUiaJson.Str(fw) + @",""offscreen"":" + (offscreen ? "true" : "false") + @",""rect"":" + Rect(rect) + "}");
    }
    if (offscreen) { walk.SkippedOffscreen++; return; }
    if (rect == null || rect.Length < 4 || !(rect[2] > 0) || !(rect[3] > 0)) { walk.SkippedEmpty++; return; }
    walk.EmittedByDepth[d]++;
    if (password || Array.IndexOf(actionable, type) >= 0) walk.Actionable++;
    walk.Elements.Add(@"{""role"":" + KyberionUiaJson.Str(type) + @",""title"":" + KyberionUiaJson.Str(name) + @",""description"":" + KyberionUiaJson.Str(help) + (password ? @",""password"":true" : "") + @",""class_name"":" + KyberionUiaJson.Str(cls) + @",""framework_id"":" + KyberionUiaJson.Str(fw) + @",""x"":" + KyberionUiaJson.Num(rect[0]) + @",""y"":" + KyberionUiaJson.Num(rect[1]) + @",""width"":" + KyberionUiaJson.Num(rect[2]) + @",""height"":" + KyberionUiaJson.Num(rect[3]) + "}");
  }
  public static KyberionUiaWalk Walk(IntPtr hwnd, bool raw, int maxDepth, int maxScan, int remainingMs, string[] actionableTypes) {
    int deadline = unchecked(Environment.TickCount + remainingMs);
    KyberionUiaWalk walk = new KyberionUiaWalk();
    walk.Name = raw ? "com_raw" : "com_control";
    try {
      IKyberionUiAutomation automation = Create();
      IKyberionUiaElement root = automation.ElementFromHandle(hwnd);
      IKyberionUiaTreeWalker walker = raw ? automation.RawViewWalker : automation.ControlViewWalker;
      List<KeyValuePair<IKyberionUiaElement, int>> queue = new List<KeyValuePair<IKyberionUiaElement, int>>();
      queue.Add(new KeyValuePair<IKyberionUiaElement, int>(root, 0));
      for (int head = 0; head < queue.Count; head++) {
        if (Environment.TickCount - deadline >= 0) { walk.Truncated = true; break; }
        KeyValuePair<IKyberionUiaElement, int> node = queue[head];
        queue[head] = new KeyValuePair<IKyberionUiaElement, int>(null, 0);
        if (node.Value >= maxDepth) continue;
        IKyberionUiaElement child = null;
        try {
          child = walker.GetFirstChildElement(node.Key);
        } catch (Exception) {
          walk.ChildErrors++;
          continue;
        }
        while (child != null) {
          if (walk.Scanned >= maxScan || Environment.TickCount - deadline >= 0) { walk.Truncated = true; return walk; }
          walk.Scanned++;
          int depth = node.Value + 1;
          Record(walk, child, depth, actionableTypes);
          // Never prune: a skipped element (offscreen, empty rect) is still descended into.
          queue.Add(new KeyValuePair<IKyberionUiaElement, int>(child, depth));
          try {
            child = walker.GetNextSiblingElement(child);
          } catch (Exception) {
            walk.ChildErrors++;
            child = null;
          }
        }
      }
    } catch (Exception e) {
      walk.Error = e.GetType().Name + ": " + e.Message;
    }
    return walk;
  }
}
'@
$comCompileError = $null
# Compiled in memory only (never loaded from or written to disk): the small
# P/Invoke type now, the COM walker only when the managed walk finds no controls.
$compileClock = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition ($csUsing + [Environment]::NewLine + $csNative)
$compileMs = $compileClock.ElapsedMilliseconds
$comCompileMs = $null
$dpi = 'unaware'
try { if ([KyberionUiaNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -ne [IntPtr]::Zero) { $dpi = 'per_monitor_v2' } } catch { }
if ($dpi -eq 'unaware') { try { if ([KyberionUiaNative]::SetProcessDPIAware()) { $dpi = 'system' } } catch { } }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$parts = New-Object 'System.Collections.Generic.List[string]'
$parts.Add('"screen":{"width":' + (JN ([KyberionUiaNative]::GetSystemMetrics(0))) + ',"height":' + (JN ([KyberionUiaNative]::GetSystemMetrics(1))) + '}')
$parts.Add('"dpi_awareness":' + (JS $dpi))
function Finish([string]$reason, [string]$elements) {
  $parts.Add('"elements":' + $elements)
  if ($reason) { $parts.Add('"reason":' + (JS $reason)) }
  [Console]::Out.WriteLine('{' + ($parts -join ',') + '}')
  [Console]::Out.Flush()
}
function JB($b) { if ($b) { return 'true' } else { return 'false' } }
$fg = [KyberionUiaNative]::GetForegroundWindow()
if ($fg -eq [IntPtr]::Zero) { Finish 'no_window' '[]'; exit 0 }
[uint32]$fgPid = 0
[void][KyberionUiaNative]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$fgName = ''
try { $fgName = [string](Get-Process -Id ([int]$fgPid) -ErrorAction Stop).ProcessName } catch { }
if ($app) {
  $want = $app
  if ($want.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) { $want = $want.Substring(0, $want.Length - 4) }
  if (-not [string]::Equals($fgName, $want, [System.StringComparison]::OrdinalIgnoreCase)) {
    $named = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { [string]::Equals($_.ProcessName, $want, [System.StringComparison]::OrdinalIgnoreCase) })
    if ($named.Count -eq 0) { Finish 'no_process' '[]'; exit 0 }
    $parts.Add('"application":' + (JS ($named[0].ProcessName)))
    Finish 'not_frontmost' '[]'
    exit 0
  }
}
$parts.Add('"application":' + (JS $fgName))
$A = [System.Windows.Automation.AutomationElement]
$root = $null
try { $root = $A::FromHandle($fg) } catch { }
if ($null -eq $root) { Finish 'no_window' '[]'; exit 0 }
$parts.Add('"window":' + (JR $root.Current.BoundingRectangle))
# UIA control types that map to an interactive AX role (UIA_TO_AX_ROLE); a walk
# that finds none of them falls through to the next strategy.
$actionableTypes = [string[]]@('Button', 'SplitButton', 'CheckBox', 'RadioButton', 'ComboBox', 'Edit', 'Document', 'Hyperlink', 'MenuItem', 'TabItem', 'ListItem', 'DataItem', 'TreeItem', 'Slider', 'Spinner')
# Strategy 1 (managed_control): managed UIA client, control view, one cached
# FindAll(Children) per node. Never prunes: a skipped element is still descended into.
$cond = [System.Windows.Automation.Automation]::ControlViewCondition
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.TreeFilter = $cond
foreach ($property in @($A::ControlTypeProperty, $A::NameProperty, $A::HelpTextProperty, $A::BoundingRectangleProperty, $A::IsOffscreenProperty, $A::IsPasswordProperty, $A::ClassNameProperty, $A::FrameworkIdProperty)) { $cache.Add($property) }
$items = New-Object 'System.Collections.Generic.List[string]'
$sample = New-Object 'System.Collections.Generic.List[string]'
$scannedByDepth = @{}
$emittedByDepth = @{}
$skipOffscreen = 0
$skipEmpty = 0
$readErrors = 0
$childErrors = 0
$actionable = 0
$queue = New-Object 'System.Collections.Generic.Queue[object]'
$queue.Enqueue([pscustomobject]@{ Element = $root; Depth = 0 })
$scanned = 0
$truncated = $false
$cache.Push()
try {
  :walk while ($queue.Count -gt 0) {
    if ($clock.ElapsedMilliseconds -ge $budget) { $truncated = $true; break }
    $node = $queue.Dequeue()
    if ($node.Depth -ge $maxDepth) { continue }
    $children = $null
    try { $children = $node.Element.FindAll([System.Windows.Automation.TreeScope]::Children, $cond) } catch { $childErrors += 1; continue }
    foreach ($child in $children) {
      if ($scanned -ge $maxScan) { $truncated = $true; break walk }
      $scanned += 1
      $depth = $node.Depth + 1
      $scannedByDepth[$depth] = 1 + [int]$scannedByDepth[$depth]
      try {
        $c = $child.Cached
        $r = $c.BoundingRectangle
        $type = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\\.', ''
        if ($sample.Count -lt 20) { $sample.Add('{"depth":' + $depth + ',"control_type":' + (JS $type) + ',"class_name":' + (JS $c.ClassName) + ',"framework_id":' + (JS $c.FrameworkId) + ',"offscreen":' + (JB $c.IsOffscreen) + ',"rect":' + (JR $r) + '}') }
        if ($c.IsOffscreen) { $skipOffscreen += 1 } elseif ($r.IsEmpty -or -not ($r.Width -gt 0) -or -not ($r.Height -gt 0)) { $skipEmpty += 1 } else {
          $emittedByDepth[$depth] = 1 + [int]$emittedByDepth[$depth]
          if ($c.IsPassword -or ($actionableTypes -contains $type)) { $actionable += 1 }
          $pw = ''
          if ($c.IsPassword) { $pw = ',"password":true' }
          $items.Add('{"role":' + (JS $type) + ',"title":' + (JS $c.Name) + ',"description":' + (JS $c.HelpText) + $pw + ',"class_name":' + (JS $c.ClassName) + ',"framework_id":' + (JS $c.FrameworkId) + ',"x":' + (JN $r.X) + ',"y":' + (JN $r.Y) + ',"width":' + (JN $r.Width) + ',"height":' + (JN $r.Height) + '}')
        }
      } catch { $readErrors += 1 }
      $queue.Enqueue([pscustomobject]@{ Element = $child; Depth = $depth })
    }
  }
} finally { $cache.Pop() }
$perDepth = New-Object 'System.Collections.Generic.List[string]'
foreach ($key in ($scannedByDepth.Keys | Sort-Object)) { $perDepth.Add('{"depth":' + $key + ',"scanned":' + $scannedByDepth[$key] + ',"emitted":' + [int]$emittedByDepth[$key] + '}') }
$diagnostics = New-Object 'System.Collections.Generic.List[string]'
$diagnostics.Add('{"name":"managed_control","scanned":' + $scanned + ',"emitted":' + $items.Count + ',"actionable":' + $actionable + ',"truncated":' + (JB $truncated) + ',"skipped":{"offscreen":' + $skipOffscreen + ',"empty_rect":' + $skipEmpty + ',"read_error":' + $readErrors + '},"child_errors":' + $childErrors + ',"per_depth":[' + ($perDepth -join ',') + '],"error":null,"sample":[' + ($sample -join ',') + ']}')
$strategy = 'managed_control'
$chosen = $items
$chosenTruncated = $truncated
$chosenActionable = $actionable
# Strategies 2 and 3 (com_control, com_raw): the COM UIA client (UIA3) sees
# XAML island / WinUI content the managed client (UIA2) can miss.
if ($chosenActionable -eq 0) {
  $comClock = [System.Diagnostics.Stopwatch]::StartNew()
  try { Add-Type -TypeDefinition ($csUsing + [Environment]::NewLine + $csCom) } catch { $comCompileError = $_.Exception.Message }
  $comCompileMs = $comClock.ElapsedMilliseconds
}
if ($chosenActionable -eq 0 -and $null -eq $comCompileError) {
  foreach ($rawView in @($false, $true)) {
    $remaining = [int][Math]::Max(0, $budget - $clock.ElapsedMilliseconds)
    $walk = [KyberionUiaComWalker]::Walk($fg, $rawView, $maxDepth, $maxScan, $remaining, $actionableTypes)
    $diagnostics.Add($walk.Diagnostics())
    if ($walk.Actionable -gt $chosenActionable) {
      $strategy = $walk.Name
      $chosen = $walk.Elements
      $chosenTruncated = $walk.Truncated
      $chosenActionable = $walk.Actionable
      break
    }
  }
}
$parts.Add('"strategy":' + (JS $strategy))
$comMsJson = 'null'
if ($null -ne $comCompileMs) { $comMsJson = [string]$comCompileMs }
$walkerDiag = '{"cache":"off","cached":false,"compile_ms":' + $compileMs + ',"com_compile_ms":' + $comMsJson + '}'
$parts.Add('"diagnostics":{"com_compile_error":' + (JS $comCompileError) + ',"walker":' + $walkerDiag + ',"strategies":[' + ($diagnostics -join ',') + ']}')
if ($chosenTruncated) { $parts.Add('"truncated":true') }
Finish '' ('[' + ($chosen -join ',') + ']')`;

export {
  encodePowerShellCommand,
  POWERSHELL_STDIN_BOOTSTRAP,
  powerShellStdinArgs,
  windowsPowerShellEnv,
} from '../windows-powershell.js';

const defaultRunner: AccessibilityCommandRunner = (command, args, options) =>
  safeExecResultAsync(command, args, options);

/** Last JSON line of stdout (macOS frameworks may print loader noise first). */
function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.split('\n').map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseAccessibilitySnapshot(stdout: string): AccessibilitySnapshot | undefined {
  const raw = parseLastJsonLine(stdout) as Record<string, unknown> | undefined;
  if (!raw || !Array.isArray(raw.elements)) return undefined;
  const screen = raw.screen as { width?: unknown; height?: unknown } | undefined;
  const windowRect = raw.window as Record<'x' | 'y' | 'width' | 'height', unknown> | undefined;
  const elements: AccessibilityElement[] = [];
  for (const entry of raw.elements as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.role !== 'string') continue;
    if (![entry.x, entry.y, entry.width, entry.height].every(finite)) continue;
    elements.push({
      role: entry.role,
      subrole: text(entry.subrole),
      title: text(entry.title),
      description: text(entry.description),
      ...(entry.password === true ? { password: true } : {}),
      ...(typeof entry.class_name === 'string' && entry.class_name
        ? { class_name: entry.class_name }
        : {}),
      ...(typeof entry.framework_id === 'string' && entry.framework_id
        ? { framework_id: entry.framework_id }
        : {}),
      x: entry.x as number,
      y: entry.y as number,
      width: entry.width as number,
      height: entry.height as number,
    });
  }
  return {
    ...(screen && finite(screen.width) && finite(screen.height) && screen.width > 0
      ? { screen: { width: screen.width, height: screen.height } }
      : {}),
    ...(typeof raw.application === 'string' ? { application: raw.application } : {}),
    ...(windowRect &&
    [windowRect.x, windowRect.y, windowRect.width, windowRect.height].every(finite)
      ? {
          window: {
            x: windowRect.x as number,
            y: windowRect.y as number,
            width: windowRect.width as number,
            height: windowRect.height as number,
          },
        }
      : {}),
    ...(typeof raw.dpi_awareness === 'string' ? { dpi_awareness: raw.dpi_awareness } : {}),
    ...(typeof raw.strategy === 'string' ? { strategy: raw.strategy } : {}),
    ...(raw.diagnostics && typeof raw.diagnostics === 'object' && !Array.isArray(raw.diagnostics)
      ? { diagnostics: raw.diagnostics as Record<string, unknown> }
      : {}),
    elements,
    ...(raw.truncated === true ? { truncated: true } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

/**
 * Win32 window classes (compared case-insensitively) for controls that UI
 * Automation reports only as Pane / Custom when the Win32 client-side proxies
 * are not active (seen on GitHub's Windows Server 2025 runners). Edit and rich
 * edit controls are editable text; list and tree views are containers, not
 * click targets, so they are left unmapped, as are status bars.
 */
export const WIN32_CLASS_TO_AX_ROLE: Readonly<Record<string, string>> = {
  edit: 'AXTextArea',
  richedit: 'AXTextArea',
  richedit20a: 'AXTextArea',
  richedit20w: 'AXTextArea',
  richedit50w: 'AXTextArea',
  richeditd2dpt: 'AXTextArea',
  button: 'AXButton',
  combobox: 'AXComboBox',
  comboboxex32: 'AXComboBox',
  msctls_trackbar32: 'AXSlider',
  msctls_updown32: 'AXIncrementor',
  syslink: 'AXLink',
  systabcontrol32: 'AXTab',
};
const WIN32_FRAMEWORKS: ReadonlySet<string> = new Set(['win32', 'winform']);
// Control types UIA falls back to when it cannot tell what a Win32 window is.
const UIA_FALLBACK_TYPES: ReadonlySet<string> = new Set(['Pane', 'Custom']);

/**
 * AX role for a Win32 / WinForms window class, or undefined. WinForms classes
 * look like `WindowsForms10.EDIT.app.0.141b42a_r6_ad1`: the token after
 * `WindowsForms10.` is the underlying Win32 class.
 */
export function axRoleFromWin32Class(className: string | undefined): string | undefined {
  if (!className) return undefined;
  let key = className.toLowerCase();
  const winForms = /^windowsforms10\.([^.]+)\./.exec(key);
  if (winForms) key = winForms[1];
  return Object.hasOwn(WIN32_CLASS_TO_AX_ROLE, key) ? WIN32_CLASS_TO_AX_ROLE[key] : undefined;
}

/**
 * A Windows UIA element in the AX vocabulary: the control type becomes its AX
 * role (UIA_TO_AX_ROLE, else `uia:<Type>`), and a password field of any control
 * type becomes an AXTextField with subrole AXSecureTextField, so it is editable
 * and never labelled. A Win32 / WinForms element that UIA could only report as
 * Pane / Custom / an unknown type is mapped by its window class instead
 * (WIN32_CLASS_TO_AX_ROLE).
 */
export function normaliseUiaElement(element: AccessibilityElement): AccessibilityElement {
  if (element.password === true) {
    return { ...element, role: 'AXTextField', subrole: 'AXSecureTextField' };
  }
  const mapped = Object.hasOwn(UIA_TO_AX_ROLE, element.role)
    ? UIA_TO_AX_ROLE[element.role]
    : undefined;
  if (!mapped || UIA_FALLBACK_TYPES.has(element.role)) {
    const framework = element.framework_id?.toLowerCase();
    const byClass =
      framework && WIN32_FRAMEWORKS.has(framework)
        ? axRoleFromWin32Class(element.class_name)
        : undefined;
    if (byClass) return { ...element, role: byClass, subrole: null };
  }
  return { ...element, role: mapped ?? `uia:${element.role}`, subrole: null };
}

export function isEditableAccessibilityElement(element: AccessibilityElement): boolean {
  return (
    EDITABLE_AX_ROLES.has(element.role) ||
    (typeof element.subrole === 'string' && EDITABLE_AX_SUBROLES.has(element.subrole))
  );
}

export interface AccessibilityMapping {
  /** Top-left of the screenshot in global logical points. */
  origin: { x: number; y: number };
  /** Screenshot pixels per logical point. */
  scale: number;
  image: { width: number; height: number };
  maxElements?: number;
}

/**
 * Interactive accessibility elements as Set-of-Marks candidates in screenshot
 * pixels. Elements with no area or wholly outside the screenshot are dropped
 * before the cap, so the cap counts only what can be marked.
 */
export function candidatesFromAccessibility(
  elements: readonly AccessibilityElement[],
  mapping: AccessibilityMapping
): SomCandidate[] {
  const max = mapping.maxElements ?? OS_ACCESSIBILITY_MAX_ELEMENTS;
  const candidates: SomCandidate[] = [];
  for (const element of elements) {
    if (candidates.length >= max) break;
    if (!INTERACTIVE_AX_ROLES.has(element.role) && element.subrole !== 'AXSearchField') continue;
    if (element.width <= 0 || element.height <= 0) continue;
    const box: SomBox = {
      x: (element.x - mapping.origin.x) * mapping.scale,
      y: (element.y - mapping.origin.y) * mapping.scale,
      width: element.width * mapping.scale,
      height: element.height * mapping.scale,
    };
    const outside =
      box.x >= mapping.image.width ||
      box.y >= mapping.image.height ||
      box.x + box.width <= 0 ||
      box.y + box.height <= 0;
    if (outside) continue;
    const editable = isEditableAccessibilityElement(element);
    const label = editable
      ? undefined
      : (safeMarkLabel(element.title) ?? safeMarkLabel(element.description));
    candidates.push({
      box,
      source: 'accessibility',
      kind: 'control',
      ...(label ? { label } : {}),
      score: 1,
      ...(editable ? { editable: true } : {}),
    });
  }
  return candidates;
}

/**
 * A screenshot away from the main display's origin (a secondary display) needs
 * an explicit screen_scale: the default is derived from the main display.
 */
function needsExplicitScale(request: UiElementDetectionRequest): boolean {
  const origin = request.screen_origin;
  const offMain = !!origin && (origin.x !== 0 || origin.y !== 0);
  const hasScale =
    typeof request.screen_scale === 'number' &&
    Number.isFinite(request.screen_scale) &&
    request.screen_scale > 0;
  return offMain && !hasScale;
}

export class OsAccessibilityDetector implements UiElementDetector {
  readonly id = 'os_accessibility';
  readonly kind = 'accessibility' as const;
  private permission: { trusted: boolean; at: number } | undefined;

  constructor(private readonly deps: OsAccessibilityDetectorDeps = {}) {}

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private get run(): AccessibilityCommandRunner {
    return this.deps.run ?? defaultRunner;
  }

  /** macOS: AXIsProcessTrusted. Windows: powershell.exe loads UI Automation. */
  private async permissionGranted(): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    if (this.permission) {
      const ttl = this.permission.trusted ? PERMISSION_CACHE_MS : PERMISSION_DENIED_CACHE_MS;
      if (now - this.permission.at < ttl) return this.permission.trusted;
    }
    let trusted = false;
    try {
      const windows = this.platform === 'win32';
      const result = windows
        ? await this.run(POWERSHELL, powerShellStdinArgs(), {
            timeoutMs: OS_ACCESSIBILITY_WINDOWS_PROBE_TIMEOUT_MS,
            maxOutputMB: 1,
            env: windowsPowerShellEnv(),
            input: OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT,
          })
        : await this.run('osascript', ['-l', 'JavaScript', '-e', PERMISSION_SCRIPT], {
            timeoutMs: OS_ACCESSIBILITY_PROBE_TIMEOUT_MS,
            maxOutputMB: 1,
          });
      const parsed = (result.status === 0 ? parseLastJsonLine(result.stdout) : undefined) as
        { trusted?: unknown; available?: unknown } | undefined;
      trusted = windows ? parsed?.available === true : parsed?.trusted === true;
    } catch {
      trusted = false;
    }
    this.permission = { trusted, at: now };
    return trusted;
  }

  /** Platform, live-screen and mapping checks that need no command. */
  private canMap(request: UiElementDetectionRequest): boolean {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return false;
    if (request.live_screen !== true) return false;
    return !needsExplicitScale(request);
  }

  /** Runs the platform's enumeration script; Windows elements come back in the AX vocabulary. */
  private async enumerate(application: string | undefined): Promise<AccessibilitySnapshot> {
    const options = {
      maxDepth: OS_ACCESSIBILITY_MAX_DEPTH,
      maxScan: OS_ACCESSIBILITY_MAX_SCAN,
      ...(application ? { application } : {}),
    };
    const windows = this.platform === 'win32';
    const result = windows
      ? await this.run(POWERSHELL, powerShellStdinArgs(), {
          timeoutMs: OS_ACCESSIBILITY_TIMEOUT_MS,
          maxOutputMB: 4,
          input: OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT,
          env: {
            ...windowsPowerShellEnv(),
            [OS_ACCESSIBILITY_WINDOWS_OPTIONS_ENV]: JSON.stringify({
              ...options,
              budgetMs: OS_ACCESSIBILITY_WINDOWS_WALK_BUDGET_MS,
            }),
          },
        })
      : await this.run(
          'osascript',
          ['-l', 'JavaScript', '-e', OS_ACCESSIBILITY_ENUMERATE_SCRIPT, JSON.stringify(options)],
          { timeoutMs: OS_ACCESSIBILITY_TIMEOUT_MS, maxOutputMB: 4 }
        );
    if (result.status !== 0) {
      throw new Error(
        `[UI_ELEMENT_DETECTOR_ACCESSIBILITY] enumeration failed: ${
          result.stderr.trim() || result.error?.message || `exit ${result.status}`
        }`
      );
    }
    const snapshot = parseAccessibilitySnapshot(result.stdout);
    if (!snapshot) {
      throw new Error('[UI_ELEMENT_DETECTOR_ACCESSIBILITY] enumeration returned no snapshot');
    }
    return windows
      ? { ...snapshot, elements: snapshot.elements.map(normaliseUiaElement) }
      : snapshot;
  }

  /**
   * The raw snapshot behind detect() (element coordinates, before mapping), for
   * diagnostics and live smoke tests. Empty when the request cannot be mapped.
   */
  async readSnapshot(request: UiElementDetectionRequest): Promise<AccessibilitySnapshot> {
    if (!this.canMap(request)) return { elements: [] };
    return this.enumerate(request.application ? String(request.application) : undefined);
  }

  async isAvailable(request: UiElementDetectionRequest): Promise<boolean> {
    if (!this.canMap(request)) return false;
    return this.permissionGranted();
  }

  async detect(request: UiElementDetectionRequest): Promise<SomCandidate[]> {
    if (!this.canMap(request)) return [];
    const snapshot = await this.enumerate(
      request.application ? String(request.application) : undefined
    );
    if (snapshot.reason) {
      logger.info(`[ui-element-detector] os_accessibility: ${snapshot.reason}`);
    }
    const scale =
      request.screen_scale && request.screen_scale > 0
        ? request.screen_scale
        : snapshot.screen
          ? request.image_size.width / snapshot.screen.width
          : 1;
    return candidatesFromAccessibility(snapshot.elements, {
      origin: request.screen_origin ?? { x: 0, y: 0 },
      scale,
      image: request.image_size,
    });
  }
}
