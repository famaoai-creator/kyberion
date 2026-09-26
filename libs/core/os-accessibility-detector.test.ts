import { describe, expect, it } from 'vitest';
import {
  OS_ACCESSIBILITY_MAX_ELEMENTS,
  OsAccessibilityDetector,
  candidatesFromAccessibility,
  parseAccessibilitySnapshot,
  type AccessibilityCommandRunner,
  type AccessibilityElement,
} from './os-accessibility-detector.js';
import { fuseSetOfMarks } from './set-of-marks.js';

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
  options: { timeoutMs: number; maxOutputMB: number };
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

  it('is unavailable without side effects off macOS or for an image that is not the live screen', async () => {
    const { run, calls } = fakeRunner();
    expect(await new OsAccessibilityDetector({ run, platform: 'linux' }).isAvailable(live)).toBe(
      false
    );
    expect(await new OsAccessibilityDetector({ run, platform: 'win32' }).isAvailable(live)).toBe(
      false
    );
    const mac = new OsAccessibilityDetector({ run, platform: 'darwin' });
    expect(await mac.isAvailable({ image_path: 'screen.png', image_size: IMAGE })).toBe(false);
    expect(await mac.detect({ image_path: 'screen.png', image_size: IMAGE })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('requires the accessibility permission and caches only a granted probe', async () => {
    const denied = fakeRunner({ trusted: false });
    const detector = new OsAccessibilityDetector({ run: denied.run, platform: 'darwin' });
    expect(await detector.isAvailable(live)).toBe(false);
    expect(await detector.isAvailable(live)).toBe(false);
    expect(denied.calls).toHaveLength(2);

    let now = 0;
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
