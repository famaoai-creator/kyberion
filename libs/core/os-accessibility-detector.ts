import { logger } from './core.js';
import { safeExecResultAsync } from './secure-io.js';
import { safeMarkLabel, type SomBox, type SomCandidate } from './set-of-marks.js';
import type { UiElementDetectionRequest, UiElementDetector } from './ui-element-detector.js';

/**
 * `os_accessibility` UI element detector: exact element rectangles of a native
 * app, read from the OS accessibility tree of this machine's live screen.
 *
 * macOS only: a JXA script walks the frontmost window of the frontmost (or a
 * named) application through System Events, one level of the tree per round
 * trip (each property of a whole level is fetched in one Apple event), and
 * returns role / subrole / title / description / position / size. Windows UI
 * Automation is not wired: the Windows bridge only lists window titles, so the
 * detector reports itself unavailable there.
 *
 * The detector only ever runs when the request declares that the screenshot
 * IS this machine's live screen (`live_screen: true`): accessibility positions
 * describe the screen now, never an arbitrary image. It then maps global
 * logical points to screenshot pixels with `screen_origin` (default 0,0: the
 * main display) and `screen_scale` (default: image width / main display width
 * in points). Availability also requires the accessibility permission
 * (`AXIsProcessTrusted`, which never prompts); every check fails closed.
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

export interface AccessibilityCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export type AccessibilityCommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputMB: number }
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
  /** Global logical points (top-left of the main display is 0,0). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AccessibilitySnapshot {
  /** Main display size in logical points. */
  screen?: { width: number; height: number };
  application?: string;
  elements: AccessibilityElement[];
  truncated?: boolean;
  reason?: string;
}

const PERMISSION_SCRIPT =
  'ObjC.import("ApplicationServices"); JSON.stringify({ trusted: $.AXIsProcessTrusted() === true })';

// Walks one tree level per iteration: `spec.uiElements.<prop>()` returns the
// property of every element at that depth in a single Apple event, nested one
// array per level, so flattening each column the same way keeps them aligned.
const ENUMERATE_SCRIPT = `function run(argv) {
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
  const elements: AccessibilityElement[] = [];
  for (const entry of raw.elements as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.role !== 'string') continue;
    if (![entry.x, entry.y, entry.width, entry.height].every(finite)) continue;
    elements.push({
      role: entry.role,
      subrole: text(entry.subrole),
      title: text(entry.title),
      description: text(entry.description),
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
    elements,
    ...(raw.truncated === true ? { truncated: true } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
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

  private async permissionGranted(): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    if (this.permission) {
      const ttl = this.permission.trusted ? PERMISSION_CACHE_MS : PERMISSION_DENIED_CACHE_MS;
      if (now - this.permission.at < ttl) return this.permission.trusted;
    }
    let trusted = false;
    try {
      const result = await this.run('osascript', ['-l', 'JavaScript', '-e', PERMISSION_SCRIPT], {
        timeoutMs: OS_ACCESSIBILITY_PROBE_TIMEOUT_MS,
        maxOutputMB: 1,
      });
      const parsed = result.status === 0 ? parseLastJsonLine(result.stdout) : undefined;
      trusted = (parsed as { trusted?: unknown } | undefined)?.trusted === true;
    } catch {
      trusted = false;
    }
    this.permission = { trusted, at: now };
    return trusted;
  }

  async isAvailable(request: UiElementDetectionRequest): Promise<boolean> {
    if (this.platform !== 'darwin') return false;
    if (request.live_screen !== true) return false;
    return this.permissionGranted();
  }

  async detect(request: UiElementDetectionRequest): Promise<SomCandidate[]> {
    if (this.platform !== 'darwin' || request.live_screen !== true) return [];
    const options = {
      maxDepth: OS_ACCESSIBILITY_MAX_DEPTH,
      maxScan: OS_ACCESSIBILITY_MAX_SCAN,
      ...(request.application ? { application: String(request.application) } : {}),
    };
    const result = await this.run(
      'osascript',
      ['-l', 'JavaScript', '-e', ENUMERATE_SCRIPT, JSON.stringify(options)],
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
