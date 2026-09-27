import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  OS_ACCESSIBILITY_ENUMERATE_SCRIPT,
  OS_ACCESSIBILITY_MAX_DEPTH,
  OS_ACCESSIBILITY_MAX_ELEMENTS,
  OS_ACCESSIBILITY_MAX_SCAN,
  OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT,
  OS_ACCESSIBILITY_WINDOWS_OPTIONS_ENV,
  OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT,
  OS_ACCESSIBILITY_WINDOWS_WALK_BUDGET_MS,
  OsAccessibilityDetector,
  POWERSHELL_STDIN_BOOTSTRAP,
  UIA_TO_AX_ROLE,
  axRoleFromWin32Class,
  encodePowerShellCommand,
  powerShellStdinArgs,
  candidatesFromAccessibility,
  isEditableAccessibilityElement,
  normaliseUiaElement,
  parseAccessibilitySnapshot,
  type AccessibilityCommandRunner,
  type AccessibilityElement,
} from './os-accessibility-detector.js';
import { fuseSetOfMarks } from '../set-of-marks.js';

const IMAGE = { width: 2000, height: 1200 };

function element(
  role: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<AccessibilityElement> = {}
): AccessibilityElement {
  return { role, x, y, width, height, ...extra };
}

const SNAPSHOT = {
  screen: { width: 1000, height: 600 },
  application: 'Finder',
  elements: [
    element('AXButton', 10, 10, 16, 16, { subrole: 'AXCloseButton', description: 'close button' }),
    element('AXGroup', 0, 0, 1000, 600),
    element('AXButton', 100, 50, 80, 24, { title: 'Share' }),
    element('AXTextField', 300, 50, 200, 24, { title: 'typed value', subrole: 'AXSearchField' }),
    element('AXButton', 900, 700, 20, 20, { title: 'Off screen' }),
    element('AXButton', 400, 400, 0, 20, { title: 'No area' }),
    element('AXStaticText', 120, 80, 60, 14, { title: 'Label' }),
  ],
};

interface Call {
  command: string;
  args: string[];
  options: {
    timeoutMs: number;
    maxOutputMB: number;
    env?: Record<string, string>;
    input?: string;
  };
}

function fakeRunner(
  options: { trusted?: boolean; snapshot?: unknown; enumerateStatus?: number; noise?: string } = {}
) {
  const calls: Call[] = [];
  const run: AccessibilityCommandRunner = async (command, args, runOptions) => {
    calls.push({ command, args, options: runOptions });
    const script = args[3] ?? '';
    if (script.includes('AXIsProcessTrusted')) {
      return {
        stdout: JSON.stringify({ trusted: options.trusted ?? true }),
        stderr: '',
        status: 0,
      };
    }
    return {
      stdout: `${options.noise ?? ''}${JSON.stringify(options.snapshot ?? SNAPSHOT)}\n`,
      stderr: options.enumerateStatus ? 'not allowed assistive access' : '',
      status: options.enumerateStatus ?? 0,
    };
  };
  return { run, calls };
}

describe('candidatesFromAccessibility', () => {
  it('keeps interactive on-screen elements, maps points to pixels and never labels editable fields', () => {
    const candidates = candidatesFromAccessibility(SNAPSHOT.elements, {
      origin: { x: 0, y: 0 },
      scale: 2,
      image: IMAGE,
    });
    expect(candidates).toEqual([
      {
        box: { x: 20, y: 20, width: 32, height: 32 },
        source: 'accessibility',
        kind: 'control',
        label: 'close button',
        score: 1,
      },
      {
        box: { x: 200, y: 100, width: 160, height: 48 },
        source: 'accessibility',
        kind: 'control',
        label: 'Share',
        score: 1,
      },
      {
        box: { x: 600, y: 100, width: 400, height: 48 },
        source: 'accessibility',
        kind: 'control',
        score: 1,
        editable: true,
      },
    ]);
  });

  it('honours the screen origin of a secondary display and drops PII-shaped labels', () => {
    const candidates = candidatesFromAccessibility(
      [
        element('AXButton', 1100, 20, 10, 10, { title: 'jane.doe@example.com' }),
        element('AXLink', 1150, 40, 30, 10, { description: 'Docs' }),
      ],
      { origin: { x: 1000, y: 0 }, scale: 1, image: { width: 500, height: 500 } }
    );
    expect(candidates.map((candidate) => [candidate.box.x, candidate.label])).toEqual([
      [100, undefined],
      [150, 'Docs'],
    ]);
  });

  it('caps the element count', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      element('AXButton', (i % 50) * 20, Math.floor(i / 50) * 20, 10, 10)
    );
    expect(
      candidatesFromAccessibility(many, { origin: { x: 0, y: 0 }, scale: 1, image: IMAGE })
    ).toHaveLength(OS_ACCESSIBILITY_MAX_ELEMENTS);
  });
});

describe('parseAccessibilitySnapshot', () => {
  it('reads the last JSON line and drops malformed elements', () => {
    const parsed = parseAccessibilitySnapshot(
      `loader noise\n${JSON.stringify({
        screen: { width: 1000, height: 600 },
        elements: [
          { role: 'AXButton', x: 1, y: 2, width: 3, height: 4 },
          { role: 'AXButton' },
          null,
        ],
      })}\n`
    );
    expect(parsed?.elements).toHaveLength(1);
    expect(parsed?.screen).toEqual({ width: 1000, height: 600 });
    expect(parseAccessibilitySnapshot('no json here')).toBeUndefined();
  });
});

describe('OsAccessibilityDetector', () => {
  const live = { image_path: 'screen.png', image_size: IMAGE, live_screen: true };

  it('is unavailable without side effects off macOS/Windows or for an image that is not the live screen', async () => {
    const { run, calls } = fakeRunner();
    expect(await new OsAccessibilityDetector({ run, platform: 'linux' }).isAvailable(live)).toBe(
      false
    );
    const mac = new OsAccessibilityDetector({ run, platform: 'darwin' });
    expect(await mac.isAvailable({ image_path: 'screen.png', image_size: IMAGE })).toBe(false);
    expect(await mac.detect({ image_path: 'screen.png', image_size: IMAGE })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('requires the accessibility permission and caches granted probes longer than denials', async () => {
    let now = 0;
    const denied = fakeRunner({ trusted: false });
    const detector = new OsAccessibilityDetector({
      run: denied.run,
      platform: 'darwin',
      now: () => now,
    });
    expect(await detector.isAvailable(live)).toBe(false);
    now = 4_000;
    expect(await detector.isAvailable(live)).toBe(false);
    expect(denied.calls).toHaveLength(1);
    now = 6_000;
    expect(await detector.isAvailable(live)).toBe(false);
    expect(denied.calls).toHaveLength(2);

    now = 0;
    const granted = fakeRunner({ trusted: true });
    const cached = new OsAccessibilityDetector({
      run: granted.run,
      platform: 'darwin',
      now: () => now,
    });
    expect(await cached.isAvailable(live)).toBe(true);
    now = 10_000;
    expect(await cached.isAvailable(live)).toBe(true);
    expect(granted.calls).toHaveLength(1);
    expect(granted.calls[0].args.slice(0, 2)).toEqual(['-l', 'JavaScript']);
  });

  it('treats a failing probe as unavailable', async () => {
    const run: AccessibilityCommandRunner = async () => {
      throw new Error('spawn failed');
    };
    expect(await new OsAccessibilityDetector({ run, platform: 'darwin' }).isAvailable(live)).toBe(
      false
    );
  });

  it('derives the scale from the main display and passes the application as data', async () => {
    const { run, calls } = fakeRunner({ noise: 'framework noise\n' });
    const detector = new OsAccessibilityDetector({ run, platform: 'darwin' });
    const candidates = await detector.detect({ ...live, application: 'Finder "quoted"' });
    // 2000 px screenshot of a 1000 pt display: scale 2.
    expect(candidates[1].box).toEqual({ x: 200, y: 100, width: 160, height: 48 });
    const call = calls[0];
    expect(call.command).toBe('osascript');
    expect(JSON.parse(call.args[4])).toMatchObject({ application: 'Finder "quoted"' });
    expect(call.args[3]).not.toContain('Finder');
    expect(call.options.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('uses an explicit origin and scale', async () => {
    const { run } = fakeRunner();
    const candidates = await new OsAccessibilityDetector({ run, platform: 'darwin' }).detect({
      ...live,
      screen_origin: { x: 100, y: 50 },
      screen_scale: 1,
    });
    expect(candidates.find((candidate) => candidate.label === 'Share')?.box).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 24,
    });
  });

  it('is unavailable on a secondary display without an explicit scale', async () => {
    const { run, calls } = fakeRunner();
    const detector = new OsAccessibilityDetector({ run, platform: 'darwin' });
    const secondary = { ...live, screen_origin: { x: 1920, y: 0 } };
    expect(await detector.isAvailable(secondary)).toBe(false);
    expect(await detector.detect(secondary)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await detector.isAvailable({ ...secondary, screen_scale: 2 })).toBe(true);
    expect(await detector.isAvailable({ ...live, screen_origin: { x: 0, y: 0 } })).toBe(true);
  });

  it('fails with a coded error when enumeration fails', async () => {
    const { run } = fakeRunner({ enumerateStatus: 1 });
    await expect(
      new OsAccessibilityDetector({ run, platform: 'darwin' }).detect(live)
    ).rejects.toThrow(/UI_ELEMENT_DETECTOR_ACCESSIBILITY/);
  });
});

describe('fusion with accessibility, pixel and OCR candidates', () => {
  it('keeps the exact accessibility box and absorbs labels and provenance of the others', () => {
    const [share] = candidatesFromAccessibility([element('AXButton', 100, 50, 80, 24)], {
      origin: { x: 0, y: 0 },
      scale: 1,
      image: IMAGE,
    });
    const marks = fuseSetOfMarks(
      [
        {
          box: { x: 98, y: 49, width: 84, height: 27 },
          source: 'detector',
          kind: 'control',
          score: 0.6,
        },
        {
          box: { x: 118, y: 55, width: 44, height: 14 },
          source: 'ocr',
          kind: 'text',
          label: 'Share',
          score: 1,
        },
        share,
        {
          box: { x: 400, y: 50, width: 20, height: 20 },
          source: 'detector',
          kind: 'icon',
          score: 0.5,
        },
      ],
      { imageSize: IMAGE }
    );
    expect(marks).toEqual([
      expect.objectContaining({
        n: 1,
        box: { x: 100, y: 50, width: 80, height: 24 },
        label: 'Share',
        sources: ['accessibility', 'detector', 'ocr'],
      }),
      expect.objectContaining({ n: 2, kind: 'icon', sources: ['detector'] }),
    ]);
  });

  it('prefers a ref-carrying DOM box over an accessibility box of the same element', () => {
    const marks = fuseSetOfMarks([
      {
        box: { x: 0, y: 0, width: 50, height: 20 },
        source: 'accessibility',
        kind: 'control',
        score: 1,
        label: 'Go',
      },
      {
        box: { x: 1, y: 0, width: 50, height: 20 },
        source: 'dom',
        kind: 'control',
        score: 1,
        ref: '@e4',
      },
    ]);
    expect(marks).toEqual([
      expect.objectContaining({
        box: { x: 1, y: 0, width: 50, height: 20 },
        ref: '@e4',
        label: 'Go',
        sources: ['dom', 'accessibility'],
      }),
    ]);
  });
});

/**
 * Runs the real enumeration script against a fake System Events so its guard
 * logic is covered without osascript: `processes` stand in for application
 * processes, each with a front window holding one level of elements.
 */
function runEnumerateScript(
  processes: Array<{ name: string; frontmost: boolean }>,
  options: Record<string, unknown>
) {
  const level = {
    role: () => ['AXButton'],
    subrole: () => [null],
    name: () => ['Go'],
    description: () => [null],
    position: () => [[1, 2]],
    size: () => [[3, 4]],
    // Like a JXA specifier: the deeper level resolves lazily and fails on read.
    uiElements: {
      role: () => {
        throw new Error('no deeper level');
      },
    },
  };
  const toProcess = (entry: { name: string; frontmost: boolean }) => ({
    name: () => entry.name,
    frontmost: () => entry.frontmost,
    windows: Object.assign([{ uiElements: level }], {}),
  });
  const context = vm.createContext({
    ObjC: { import: () => undefined },
    $: { NSScreen: { mainScreen: { frame: { size: { width: 1000, height: 600 } } } } },
    Application: () => ({
      applicationProcesses: {
        whose: (query: { name?: string; frontmost?: boolean }) =>
          processes
            .filter((entry) =>
              query.name !== undefined ? entry.name === query.name : entry.frontmost
            )
            .map(toProcess),
      },
    }),
  });
  vm.runInContext(OS_ACCESSIBILITY_ENUMERATE_SCRIPT, context);
  const output = vm.runInContext(`run(${JSON.stringify([JSON.stringify(options)])})`, context);
  return parseAccessibilitySnapshot(String(output));
}

describe('enumeration script', () => {
  const base = { maxDepth: 3, maxScan: 10 };
  const apps = [
    { name: 'Terminal', frontmost: true },
    { name: 'Finder', frontmost: false },
  ];

  it('reads the frontmost application by default', () => {
    const snapshot = runEnumerateScript(apps, base);
    expect(snapshot?.application).toBe('Terminal');
    expect(snapshot?.elements).toEqual([
      expect.objectContaining({ role: 'AXButton', title: 'Go', x: 1, y: 2, width: 3, height: 4 }),
    ]);
  });

  it('returns no elements for a named application that is not frontmost', () => {
    const snapshot = runEnumerateScript(apps, { ...base, application: 'Finder' });
    expect(snapshot).toMatchObject({
      application: 'Finder',
      reason: 'not_frontmost',
      elements: [],
    });
    expect(runEnumerateScript(apps, { ...base, application: 'Terminal' })?.elements).toHaveLength(
      1
    );
  });

  it('turns a not_frontmost snapshot into no candidates', async () => {
    const run: AccessibilityCommandRunner = async () => ({
      stdout: JSON.stringify({
        screen: { width: 1000, height: 600 },
        elements: [],
        reason: 'not_frontmost',
      }),
      stderr: '',
      status: 0,
    });
    const detector = new OsAccessibilityDetector({ run, platform: 'darwin' });
    await expect(
      detector.detect({
        image_path: 's.png',
        image_size: IMAGE,
        live_screen: true,
        application: 'Finder',
      })
    ).resolves.toEqual([]);
  });
});

describe('OsAccessibilityDetector on Windows (UI Automation)', () => {
  const live = { image_path: 'screen.png', image_size: IMAGE, live_screen: true };
  // Primary monitor 1000x600 physical pixels: the 2000 px screenshot is scale 2.
  const UIA_SNAPSHOT = {
    screen: { width: 1000, height: 600 },
    dpi_awareness: 'per_monitor_v2',
    application: 'notepad',
    window: { x: 0, y: 0, width: 1000, height: 600 },
    elements: [
      { role: 'TitleBar', title: 'Untitled - Notepad', x: 0, y: 0, width: 1000, height: 30 },
      { role: 'Button', title: 'Close', description: null, x: 960, y: 0, width: 40, height: 30 },
      { role: 'MenuItem', title: 'File', x: 5, y: 30, width: 40, height: 20 },
      { role: 'Document', title: 'Text Editor', x: 0, y: 50, width: 1000, height: 500 },
      { role: 'Edit', title: 'Search', x: 600, y: 30, width: 100, height: 20 },
      {
        role: 'Edit',
        title: 'hunter2',
        password: true,
        x: 700,
        y: 30,
        width: 100,
        height: 20,
      },
      { role: 'Pane', title: 'Pane', x: 0, y: 0, width: 1000, height: 600 },
      {
        role: 'Hyperlink',
        title: 'Help',
        description: 'Opens help',
        x: 10,
        y: 560,
        width: 30,
        height: 12,
      },
    ],
  };

  interface WindowsCall extends Call {
    script: string;
  }

  function decode(args: string[]): string {
    const index = args.indexOf('-EncodedCommand');
    return index < 0 ? '' : Buffer.from(args[index + 1], 'base64').toString('utf16le');
  }

  function commandLine(command: string, args: string[]): string {
    return [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
  }

  function fakeWindowsRunner(
    options: { available?: boolean; snapshot?: unknown; enumerateStatus?: number } = {}
  ) {
    const calls: WindowsCall[] = [];
    const run: AccessibilityCommandRunner = async (command, args, runOptions) => {
      // The command line only carries the fixed stdin bootstrap; the script is the input.
      expect(decode(args)).toBe(POWERSHELL_STDIN_BOOTSTRAP);
      const script = runOptions.input ?? '';
      calls.push({ command, args, options: runOptions, script });
      if (script === OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT) {
        return {
          stdout: `${JSON.stringify({ available: options.available ?? true })}\r\n`,
          stderr: '',
          status: 0,
        };
      }
      return {
        stdout: `WARNING: noise\r\n${JSON.stringify(options.snapshot ?? UIA_SNAPSHOT)}\r\n`,
        stderr: options.enumerateStatus ? 'Exception calling "FromHandle"' : '',
        status: options.enumerateStatus ?? 0,
      };
    };
    return { run, calls };
  }

  it('keeps the command line small and feeds the scripts on stdin, whatever their size', async () => {
    const { run, calls } = fakeWindowsRunner();
    const detector = new OsAccessibilityDetector({ run, platform: 'win32' });
    await detector.isAvailable(live);
    await detector.detect({ ...live, application: 'x'.repeat(20_000) });
    expect(calls.map((call) => call.script)).toEqual([
      OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT,
      OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT,
    ]);
    // The enumeration script alone would exceed the 32 767-char limit once encoded.
    expect(
      encodePowerShellCommand(OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT).length
    ).toBeGreaterThan(8_000);
    for (const call of calls) {
      // cmd.exe-safe (8 191) with a wide margin; identical for both scripts.
      expect(commandLine(call.command, call.args).length).toBeLessThan(1_000);
      expect(call.args).toEqual(powerShellStdinArgs());
    }
    expect(powerShellStdinArgs().join(' ').length).toBeLessThan(8_000);
  });

  it('sends ASCII-only scripts (stdin is decoded with the console code page)', () => {
    for (const script of [
      OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT,
      OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT,
      POWERSHELL_STDIN_BOOTSTRAP,
    ]) {
      expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(script)).toBe(false);
    }
    expect(POWERSHELL_STDIN_BOOTSTRAP).toContain('[Console]::In.ReadToEnd()');
  });

  it('probes UI Automation once through an encoded powershell.exe and caches the result', async () => {
    let now = 0;
    const { run, calls } = fakeWindowsRunner();
    const detector = new OsAccessibilityDetector({ run, platform: 'win32', now: () => now });
    expect(await detector.isAvailable(live)).toBe(true);
    now = 10_000;
    expect(await detector.isAvailable(live)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('powershell.exe');
    expect(calls[0].args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    expect(calls[0].script).toBe(OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT);
  });

  it('is unavailable when UI Automation does not load, the probe fails, or the image is not the live screen', async () => {
    const missing = fakeWindowsRunner({ available: false });
    expect(
      await new OsAccessibilityDetector({ run: missing.run, platform: 'win32' }).isAvailable(live)
    ).toBe(false);
    const throwing: AccessibilityCommandRunner = async () => {
      throw new Error('spawn powershell.exe ENOENT');
    };
    expect(
      await new OsAccessibilityDetector({ run: throwing, platform: 'win32' }).isAvailable(live)
    ).toBe(false);
    const { run, calls } = fakeWindowsRunner();
    const detector = new OsAccessibilityDetector({ run, platform: 'win32' });
    expect(await detector.isAvailable({ image_path: 's.png', image_size: IMAGE })).toBe(false);
    expect(await detector.detect({ image_path: 's.png', image_size: IMAGE })).toEqual([]);
    const secondary = { ...live, screen_origin: { x: -1920, y: 0 } };
    expect(await detector.isAvailable(secondary)).toBe(false);
    expect(await detector.detect(secondary)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await detector.isAvailable({ ...secondary, screen_scale: 1 })).toBe(true);
  });

  it('maps UIA control types, keeps editable and password fields unlabelled and derives the scale from the physical screen', async () => {
    const { run } = fakeWindowsRunner();
    const candidates = await new OsAccessibilityDetector({ run, platform: 'win32' }).detect(live);
    expect(candidates).toEqual([
      {
        box: { x: 1920, y: 0, width: 80, height: 60 },
        source: 'accessibility',
        kind: 'control',
        label: 'Close',
        score: 1,
      },
      {
        box: { x: 10, y: 60, width: 80, height: 40 },
        source: 'accessibility',
        kind: 'control',
        label: 'File',
        score: 1,
      },
      {
        box: { x: 0, y: 100, width: 2000, height: 1000 },
        source: 'accessibility',
        kind: 'control',
        score: 1,
        editable: true,
      },
      {
        box: { x: 1200, y: 60, width: 200, height: 40 },
        source: 'accessibility',
        kind: 'control',
        score: 1,
        editable: true,
      },
      {
        box: { x: 1400, y: 60, width: 200, height: 40 },
        source: 'accessibility',
        kind: 'control',
        score: 1,
        editable: true,
      },
      {
        box: { x: 20, y: 1120, width: 60, height: 24 },
        source: 'accessibility',
        kind: 'control',
        label: 'Help',
        score: 1,
      },
    ]);
    // A screenshot at the physical size maps 1:1.
    const physical = await new OsAccessibilityDetector({ run, platform: 'win32' }).detect({
      ...live,
      image_size: { width: 1000, height: 600 },
    });
    expect(physical[0].box).toEqual({ x: 960, y: 0, width: 40, height: 30 });
  });

  it('normalises control types to the AX vocabulary', () => {
    const roles = [
      'Button',
      'SplitButton',
      'CheckBox',
      'RadioButton',
      'ComboBox',
      'Edit',
      'Document',
      'Hyperlink',
      'MenuItem',
      'TabItem',
      'ListItem',
      'DataItem',
      'TreeItem',
      'Slider',
      'Spinner',
      'Pane',
      'toString',
    ].map((role) => normaliseUiaElement(element(role, 0, 0, 1, 1)).role);
    expect(roles).toEqual([
      'AXButton',
      'AXMenuButton',
      'AXCheckBox',
      'AXRadioButton',
      'AXComboBox',
      'AXTextField',
      'AXTextArea',
      'AXLink',
      'AXMenuItem',
      'AXTab',
      'AXCell',
      'AXCell',
      'AXCell',
      'AXSlider',
      'AXIncrementor',
      'uia:Pane',
      'uia:toString',
    ]);
    const password = normaliseUiaElement(
      element('Custom', 0, 0, 1, 1, { title: 'secret', password: true })
    );
    expect(password).toMatchObject({ role: 'AXTextField', subrole: 'AXSecureTextField' });
    expect(isEditableAccessibilityElement(password)).toBe(true);
    expect(
      ['Edit', 'Document', 'ComboBox'].map((role) =>
        isEditableAccessibilityElement(normaliseUiaElement(element(role, 0, 0, 1, 1)))
      )
    ).toEqual([true, true, true]);
  });

  it('maps Win32 / WinForms window classes when UIA only reports a pane', () => {
    const win32 = (className: string, role = 'Pane', framework_id = 'Win32') =>
      normaliseUiaElement(element(role, 0, 0, 1, 1, { class_name: className, framework_id }));
    expect(
      [
        'Edit',
        'RichEdit20A',
        'RichEdit20W',
        'RICHEDIT50W',
        'RichEditD2DPT',
        'Button',
        'ComboBox',
        'ComboBoxEx32',
        'msctls_trackbar32',
        'msctls_updown32',
        'SysLink',
        'SysTabControl32',
      ].map((className) => win32(className).role)
    ).toEqual([
      'AXTextArea',
      'AXTextArea',
      'AXTextArea',
      'AXTextArea',
      'AXTextArea',
      'AXButton',
      'AXComboBox',
      'AXComboBox',
      'AXSlider',
      'AXIncrementor',
      'AXLink',
      'AXTab',
    ]);
    // WinForms: the token after WindowsForms10. is the Win32 class.
    expect(win32('WindowsForms10.EDIT.app.0.141b42a_r6_ad1', 'Pane', 'WinForm').role).toBe(
      'AXTextArea'
    );
    expect(win32('WindowsForms10.BUTTON.app.0.2bf8098_r6_ad1', 'Custom', 'WinForm').role).toBe(
      'AXButton'
    );
    expect(win32('WindowsForms10.Window.8.app.0.2bf8098', 'Pane', 'WinForm').role).toBe('uia:Pane');
    // Unknown control type ids fall back to the class as well.
    expect(win32('Edit', 'Id50099').role).toBe('AXTextArea');
    // Containers, status bars and unknown classes stay non-interactive.
    for (const className of [
      'msctls_statusbar32',
      'SysListView32',
      'SysTreeView32',
      'ListBox',
      'Foo',
    ]) {
      expect(win32(className).role).toBe('uia:Pane');
    }
    // Only Win32 / WinForms: a XAML or WPF pane is never guessed from its class.
    expect(win32('Edit', 'Pane', 'XAML').role).toBe('uia:Pane');
    expect(win32('Button', 'Pane', 'WPF').role).toBe('uia:Pane');
    // A real control type wins over the class.
    expect(win32('Edit', 'Button').role).toBe('AXButton');
    expect(axRoleFromWin32Class(undefined)).toBeUndefined();
  });

  it('marks the classic Notepad edit pane as editable and never labels it', async () => {
    const { run } = fakeWindowsRunner({
      snapshot: {
        screen: { width: 1000, height: 600 },
        application: 'notepad',
        window: { x: 50, y: 50, width: 800, height: 500 },
        elements: [
          {
            role: 'Pane',
            title: 'Text Editor',
            class_name: 'Edit',
            framework_id: 'Win32',
            x: 60,
            y: 103,
            width: 752,
            height: 437,
          },
          {
            role: 'Pane',
            title: 'Ln 1, Col 1',
            class_name: 'msctls_statusbar32',
            framework_id: 'Win32',
            x: 60,
            y: 540,
            width: 752,
            height: 20,
          },
        ],
      },
    });
    const detector = new OsAccessibilityDetector({ run, platform: 'win32' });
    const snapshot = await detector.readSnapshot(live);
    expect(snapshot.elements.map((entry) => entry.class_name)).toEqual([
      'Edit',
      'msctls_statusbar32',
    ]);
    expect(await detector.detect({ ...live, image_size: { width: 1000, height: 600 } })).toEqual([
      {
        box: { x: 60, y: 103, width: 752, height: 437 },
        source: 'accessibility',
        kind: 'control',
        score: 1,
        editable: true,
      },
    ]);
  });

  it('passes options through the child environment, never through the script text', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    try {
      const { run, calls } = fakeWindowsRunner();
      const application = "notepad'; Remove-Item C:\\ -Recurse; '";
      await new OsAccessibilityDetector({ run, platform: 'win32' }).detect({
        ...live,
        application,
      });
      const call = calls[0];
      expect(call.command).toBe('powershell.exe');
      expect(call.script).toBe(OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT);
      expect(call.args.join(' ')).not.toContain('notepad');
      expect(call.args.join(' ')).not.toContain('Remove-Item');
      expect(call.options).toMatchObject({ timeoutMs: 8_000, maxOutputMB: 4 });
      expect(call.options.env?.SystemRoot).toBe('C:\\Windows');
      expect(JSON.parse(call.options.env?.[OS_ACCESSIBILITY_WINDOWS_OPTIONS_ENV] ?? '')).toEqual({
        maxDepth: OS_ACCESSIBILITY_MAX_DEPTH,
        maxScan: OS_ACCESSIBILITY_MAX_SCAN,
        application,
        budgetMs: OS_ACCESSIBILITY_WINDOWS_WALK_BUDGET_MS,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('turns a not_frontmost snapshot into no candidates', async () => {
    const { run } = fakeWindowsRunner({
      snapshot: {
        screen: { width: 1000, height: 600 },
        application: 'notepad',
        elements: [],
        reason: 'not_frontmost',
      },
    });
    const detector = new OsAccessibilityDetector({ run, platform: 'win32' });
    await expect(detector.detect({ ...live, application: 'notepad' })).resolves.toEqual([]);
    await expect(detector.readSnapshot({ ...live, application: 'notepad' })).resolves.toMatchObject(
      { application: 'notepad', reason: 'not_frontmost', elements: [] }
    );
  });

  it('reads the window rect and DPI awareness and caps the candidates', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      role: 'Button',
      title: `B${i}`,
      x: (i % 50) * 20,
      y: Math.floor(i / 50) * 20,
      width: 10,
      height: 10,
    }));
    const { run } = fakeWindowsRunner({
      snapshot: { ...UIA_SNAPSHOT, elements: many, truncated: true },
    });
    const detector = new OsAccessibilityDetector({ run, platform: 'win32' });
    const snapshot = await detector.readSnapshot(live);
    expect(snapshot).toMatchObject({
      window: { x: 0, y: 0, width: 1000, height: 600 },
      dpi_awareness: 'per_monitor_v2',
      truncated: true,
    });
    expect(snapshot.elements[0].role).toBe('AXButton');
    expect(await detector.detect(live)).toHaveLength(OS_ACCESSIBILITY_MAX_ELEMENTS);
  });

  it('fails with a coded error when enumeration fails', async () => {
    const { run } = fakeWindowsRunner({ enumerateStatus: 1 });
    await expect(
      new OsAccessibilityDetector({ run, platform: 'win32' }).detect(live)
    ).rejects.toThrow(/UI_ELEMENT_DETECTOR_ACCESSIBILITY.*FromHandle/);
  });
});

describe('Windows enumeration script', () => {
  const script = OS_ACCESSIBILITY_WINDOWS_ENUMERATE_SCRIPT;

  it('reads only the foreground window and guards a named application', () => {
    expect(script).toContain('GetForegroundWindow()');
    expect(script).toContain('AutomationElement]');
    expect(script).toContain('$A::FromHandle($fg)');
    expect(script).toMatch(/\[string\]::Equals\(\$fgName, \$want/);
    expect(script).toContain("Finish 'not_frontmost' '[]'");
  });

  it('reads its options from the environment and interpolates nothing', () => {
    expect(script).toContain(`$env:${OS_ACCESSIBILITY_WINDOWS_OPTIONS_ENV}`);
    expect(script).toContain('ConvertFrom-Json -InputObject $raw');
    expect(script).not.toContain('${');
    expect(OS_ACCESSIBILITY_WINDOWS_PROBE_SCRIPT).not.toContain('${');
  });

  it('is DPI aware, bounded and escapes non-ASCII output', () => {
    expect(script).toContain('SetThreadDpiAwarenessContext([IntPtr]::new(-4))');
    expect(script).toContain('SetProcessDPIAware()');
    expect(script).toContain('GetSystemMetrics(0)');
    expect(script).toContain('ControlViewCondition');
    expect(script).toContain('IsPasswordProperty');
    expect(script).toContain('$node.Depth -ge $maxDepth');
    expect(script).toContain('$scanned -ge $maxScan');
    expect(script).toContain('$clock.ElapsedMilliseconds -ge $budget');
    expect(script).toContain("'[^\\x20-\\x7E]|[\"\\\\]'");
    expect(script).toContain("'\\u{0:x4}'");
  });

  it('falls back from the managed control view to the COM client, control then raw view', () => {
    const order = ['managed_control', 'com_control', 'com_raw'].map((name) =>
      name === 'managed_control' ? script.indexOf("'managed_control'") : script.indexOf(`"${name}"`)
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect(script).toContain('if ($chosenActionable -eq 0 -and $null -eq $comCompileError)');
    expect(script).toContain('foreach ($rawView in @($false, $true))');
    expect(script).toContain('automation.RawViewWalker : automation.ControlViewWalker');
    // IUIAutomation, IUIAutomationTreeWalker, IUIAutomationElement, CUIAutomation8 / CUIAutomation.
    for (const guid of [
      '30cbe57d-d9d0-452a-ab13-7ac5ac4825ee',
      '4042c624-389c-4afc-a630-9df854a541fc',
      'd22108aa-8ac5-49a5-837b-37bbb3d7591e',
      'e22ad333-b25f-460c-83d0-0581107395c9',
      'ff48dba4-60ef-4201-aa87-54103eef594e',
    ]) {
      expect(script).toContain(guid);
    }
    // A failed COM compile keeps the managed walk (native type compiled alone).
    expect(script).toContain('$comCompileError = $_.Exception.Message');
  });

  it('never prunes a skipped element and keeps the compiled C# on mscorlib only', () => {
    // Managed walk: the enqueue sits outside the per-element try, after the skip checks.
    const managed = script.slice(script.indexOf('$cache.Push()'), script.indexOf('$cache.Pop()'));
    expect(managed.lastIndexOf('$queue.Enqueue(')).toBeGreaterThan(
      managed.lastIndexOf('catch { $readErrors += 1 }')
    );
    // COM walk: every scanned child is queued whatever Record() decided.
    expect(script).toMatch(
      /Record\(walk, child, depth, actionableTypes\);\s*\/\/ Never prune[^\n]*\n\s*queue\.Add\(/
    );
    const csharp = script.slice(
      script.indexOf("$csUsing = @'"),
      script.indexOf('$comCompileError = $null')
    );
    expect(csharp).not.toMatch(/HashSet|System\.Linq|System\.Diagnostics|Queue</);
  });

  it('emits the class name and framework of every element from every walker', () => {
    expect(script).toContain(
      `',"class_name":' + (JS $c.ClassName) + ',"framework_id":' + (JS $c.FrameworkId)`
    );
    const csharp = script.slice(script.indexOf('static void Record('));
    expect(csharp).toContain(
      '@",""class_name"":" + KyberionUiaJson.Str(cls) + @",""framework_id"":" + KyberionUiaJson.Str(fw) + @",""x"":"'
    );
  });

  it('compiles the walker in memory only, the COM walker only when the managed walk finds no controls', () => {
    // Nothing compiled is ever written to or loaded from disk.
    expect(script).not.toMatch(
      /-OutputAssembly|Add-Type\s+-Path|Add-Type\s+-LiteralPath|LoadFrom|LoadFile/
    );
    expect(script).not.toContain('walkerCacheDir');
    const native = script.indexOf(
      'Add-Type -TypeDefinition ($csUsing + [Environment]::NewLine + $csNative)'
    );
    const managed = script.indexOf('$cache.Push()');
    const com = script.indexOf(
      'Add-Type -TypeDefinition ($csUsing + [Environment]::NewLine + $csCom)'
    );
    expect(native).toBeGreaterThan(0);
    expect(native).toBeLessThan(managed);
    expect(com).toBeGreaterThan(managed);
    expect(script.slice(script.lastIndexOf('if ($chosenActionable -eq 0) {', com), com)).toContain(
      '$comClock'
    );
    expect(script).toContain(
      `'{"cache":"off","cached":false,"compile_ms":' + $compileMs + ',"com_compile_ms":' + $comMsJson + '}'`
    );
  });

  it('lists exactly the mapped UIA control types as actionable', () => {
    const line = script.split('\n').find((entry) => entry.startsWith('$actionableTypes = '));
    const listed = [...(line ?? '').matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
    expect(listed.sort()).toEqual(Object.keys(UIA_TO_AX_ROLE).sort());
  });

  it('maps COM control type ids in UIA order', () => {
    const start = script.indexOf('static readonly string[] Types = new string[] {');
    const body = script.slice(start, script.indexOf('};', start));
    const types = [...body.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
    // UIA_<Type>ControlTypeId = 50000 + index.
    expect(types.indexOf('Button')).toBe(0);
    expect(types.indexOf('Edit')).toBe(4);
    expect(types.indexOf('MenuItem')).toBe(11);
    expect(types.indexOf('TabItem')).toBe(19);
    expect(types.indexOf('DataItem')).toBe(29);
    expect(types.indexOf('Document')).toBe(30);
    expect(types.indexOf('SplitButton')).toBe(31);
    expect(types.indexOf('Window')).toBe(32);
    expect(types.indexOf('Pane')).toBe(33);
    expect(types.indexOf('AppBar')).toBe(40);
    for (const type of Object.keys(UIA_TO_AX_ROLE)) expect(types).toContain(type);
  });

  it('reports the strategy and name-free diagnostics in the snapshot', async () => {
    const diagnostics = {
      com_compile_error: null,
      strategies: [
        {
          name: 'managed_control',
          scanned: 2,
          emitted: 2,
          actionable: 0,
          per_depth: [{ depth: 1, scanned: 2, emitted: 2 }],
          sample: [{ depth: 1, control_type: 'Pane', class_name: 'X', framework_id: 'Win32' }],
        },
        { name: 'com_control', scanned: 40, emitted: 30, actionable: 12 },
      ],
    };
    const run: AccessibilityCommandRunner = async () => ({
      stdout: JSON.stringify({
        screen: { width: 1000, height: 600 },
        application: 'notepad',
        strategy: 'com_control',
        diagnostics,
        elements: [{ role: 'Button', title: 'Close', x: 1, y: 1, width: 10, height: 10 }],
      }),
      stderr: '',
      status: 0,
    });
    const detector = new OsAccessibilityDetector({ run, platform: 'win32' });
    const request = { image_path: 's.png', image_size: IMAGE, live_screen: true };
    await expect(detector.readSnapshot(request)).resolves.toMatchObject({
      strategy: 'com_control',
      diagnostics,
    });
    await expect(detector.detect(request)).resolves.toHaveLength(1);
    expect(parseAccessibilitySnapshot(JSON.stringify({ elements: [], diagnostics: [1] }))).toEqual({
      elements: [],
    });
  });
});
