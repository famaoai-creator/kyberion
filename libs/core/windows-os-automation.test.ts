import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidatesFromAccessibility } from './virtual/os-accessibility-detector.js';
import { clearMarks, resolveMarkTarget, saveMarks } from './mark-target-resolver.js';
import { fuseSetOfMarks } from './set-of-marks.js';
import { POWERSHELL_STDIN_BOOTSTRAP, powerShellStdinArgs } from './windows-powershell.js';

const mocks = vi.hoisted(() => ({ safeExecResult: vi.fn() }));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return { ...actual, safeExecResult: mocks.safeExecResult };
});

const {
  MOUSEEVENTF,
  WINDOWS_POINTER_OPTIONS_ENV,
  WINDOWS_POINTER_SCRIPT,
  clickAt,
  dragFrom,
  getScreenSize,
  moveMouse,
  rightClickAt,
  runWindowsPointerActions,
  scrollAt,
  windowsPointerOptions,
} = await import('./windows-os-automation.js');

interface PointerCall {
  command: string;
  args: string[];
  options: { input?: string; env?: Record<string, string>; timeoutMs?: number };
}

const REPORT = {
  dpi_awareness: 'per_monitor_v2',
  performed: 1,
  move_failures: 0,
  cursor: { x: 0, y: 0 },
  screen: { width: 3840, height: 2160 },
  virtual_screen: { x: 0, y: 0, width: 3840, height: 2160 },
};

function reply(report: Record<string, unknown> = REPORT, status = 0) {
  mocks.safeExecResult.mockImplementation(() => ({
    stdout: `WARNING: noise\r\n${JSON.stringify(report)}\r\n`,
    stderr: status ? 'boom' : '',
    status,
  }));
}

function calls(): PointerCall[] {
  return mocks.safeExecResult.mock.calls.map(([command, args, options]) => ({
    command,
    args,
    options,
  }));
}

function actionsOf(call: PointerCall): unknown[] {
  return JSON.parse(call.options.env?.[WINDOWS_POINTER_OPTIONS_ENV] ?? '{}').actions;
}

beforeEach(() => {
  mocks.safeExecResult.mockReset();
  reply();
});

describe('Windows pointer script', () => {
  it('is per-monitor DPI aware before it moves the cursor', () => {
    const script = WINDOWS_POINTER_SCRIPT;
    const aware = script.indexOf('SetThreadDpiAwarenessContext([IntPtr]::new(-4))');
    expect(aware).toBeGreaterThan(0);
    expect(script).toContain('SetProcessDPIAware()');
    expect(script.indexOf('$N::SetCursorPos(')).toBeGreaterThan(aware);
    expect(script).toContain('GetCursorPos([ref]$p)');
    // Virtual screen rect: SM_XVIRTUALSCREEN .. SM_CYVIRTUALSCREEN.
    for (const index of [76, 77, 78, 79]) expect(script).toContain(`GetSystemMetrics(${index})`);
  });

  it('reads the actions from the environment and interpolates nothing', () => {
    expect(WINDOWS_POINTER_SCRIPT).toContain(`$env:${WINDOWS_POINTER_OPTIONS_ENV}`);
    expect(WINDOWS_POINTER_SCRIPT).toContain('ConvertFrom-Json -InputObject $raw');
    expect(WINDOWS_POINTER_SCRIPT).not.toContain('${');
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(WINDOWS_POINTER_SCRIPT)).toBe(false);
  });

  it('stops before clicking when a move is refused', () => {
    expect(WINDOWS_POINTER_SCRIPT).toMatch(
      /if \(-not \$N::SetCursorPos\(\[int\]\$a\.x, \[int\]\$a\.y\)\) \{ \$moveFailures \+= 1; break \}/
    );
  });
});

describe('Windows pointer actions', () => {
  it('clicks in one stdin-fed powershell.exe with the coordinates only in the environment', () => {
    clickAt(1575.4, 922.6, 2);
    expect(calls()).toHaveLength(1);
    const [call] = calls();
    expect(call.command).toBe('powershell.exe');
    expect(call.args).toEqual(powerShellStdinArgs());
    expect(Buffer.from(call.args[4], 'base64').toString('utf16le')).toBe(
      POWERSHELL_STDIN_BOOTSTRAP
    );
    expect(call.options.input).toBe(WINDOWS_POINTER_SCRIPT);
    expect(call.args.join(' ')).not.toContain('1575');
    expect(actionsOf(call)).toEqual([
      { x: 1575, y: 923 },
      { flags: MOUSEEVENTF.LEFTDOWN },
      { flags: MOUSEEVENTF.LEFTUP },
      { flags: MOUSEEVENTF.LEFTDOWN },
      { flags: MOUSEEVENTF.LEFTUP },
    ]);
  });

  it('maps right click, move, drag and wheel to single runs', () => {
    rightClickAt(-1900, 10);
    moveMouse(5, 6);
    dragFrom(1, 2, 3, 4);
    scrollAt(7, 8, 'down', 2);
    scrollAt(7, 8, 'right');
    expect(calls().map(actionsOf)).toEqual([
      [{ x: -1900, y: 10 }, { flags: MOUSEEVENTF.RIGHTDOWN }, { flags: MOUSEEVENTF.RIGHTUP }],
      [{ x: 5, y: 6 }],
      [
        { x: 1, y: 2, flags: MOUSEEVENTF.LEFTDOWN },
        { x: 3, y: 4, flags: MOUSEEVENTF.LEFTUP },
      ],
      [
        { x: 7, y: 8 },
        { flags: MOUSEEVENTF.WHEEL, data: -240 },
      ],
      [
        { x: 7, y: 8 },
        { flags: MOUSEEVENTF.HWHEEL, data: 360 },
      ],
    ]);
  });

  it('refuses non-finite or absurd coordinates and unknown flags before spawning', () => {
    expect(() => clickAt(Number.NaN, 1)).toThrow(/\[WINDOWS_POINTER\] x must be a finite number/);
    expect(() => moveMouse(1, 5_000_000)).toThrow(/outside any virtual desktop/);
    expect(() => windowsPointerOptions([{ flags: 0x8000 }])).toThrow(/unsupported mouse_event/);
    expect(() => windowsPointerOptions([{ x: 1 }])).toThrow(/y must be a finite number/);
    expect(mocks.safeExecResult).not.toHaveBeenCalled();
  });

  it('throws when the script fails or SetCursorPos is refused, and reports what it did', () => {
    reply({ ...REPORT, cursor: { x: 10, y: 20 } });
    expect(runWindowsPointerActions([{ x: 10, y: 20 }])).toMatchObject({
      dpi_awareness: 'per_monitor_v2',
      cursor: { x: 10, y: 20 },
    });
    reply(REPORT, 1);
    expect(() => clickAt(1, 1)).toThrow(/pointer script failed \(exit 1\): boom/);
    reply({ ...REPORT, move_failures: 1 });
    expect(() => clickAt(1, 1)).toThrow(/SetCursorPos was refused/);
  });

  it('reports the primary screen in physical pixels, or 0x0 when PowerShell fails', () => {
    expect(getScreenSize()).toEqual({ width: 3840, height: 2160 });
    expect(actionsOf(calls()[0])).toEqual([]);
    reply(REPORT, 1);
    expect(getScreenSize()).toEqual({ width: 0, height: 0 });
  });
});

describe('Set-of-Marks to Windows click mapping (150 % display scaling)', () => {
  const session = `windows-click-mapping-${process.pid}`;
  const HASH = '0f0f0f0f0f0f0f0f';
  // UIA rect of an OK button, physical pixels (the detector runs per-monitor DPI aware).
  const OK = { role: 'AXButton', title: 'OK', x: 1500, y: 900, width: 150, height: 45 };

  afterEach(() => clearMarks(session));

  async function clickMark(image: { width: number; height: number }, scale: number) {
    const marks = fuseSetOfMarks(
      candidatesFromAccessibility([OK], { origin: { x: 0, y: 0 }, scale, image }),
      { imageSize: image }
    );
    saveMarks({ session_id: session, marks, image, image_dhash: HASH, scale });
    const point = await resolveMarkTarget('mark:1', { session_id: session, current_dhash: HASH });
    clickAt(point.x, point.y);
    return actionsOf(calls()[calls().length - 1])[0];
  }

  it('clicks the physical center of a mark on a physical-pixel screenshot (scale 1)', async () => {
    await expect(clickMark({ width: 3840, height: 2160 }, 1)).resolves.toEqual({
      x: 1575,
      y: 923,
    });
  });

  it('clicks the same physical point from a screenshot downscaled to logical size', async () => {
    // 2560x1440 image of a 3840x2160 physical screen: 2/3 image px per physical px.
    await expect(clickMark({ width: 2560, height: 1440 }, 2560 / 3840)).resolves.toEqual({
      x: 1575,
      y: 923,
    });
  });
});
