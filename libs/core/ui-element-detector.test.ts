import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrRequest, OcrResult } from './ocr-types.js';

// Real seam + real selection policy file; only the audit chain is mocked and
// MISSION_ID stays unset so no pin is written (mirrors ocr-provider-selection.test.ts).
const record = vi.fn();
vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));

const { OsAccessibilityDetector } = await import('./os-accessibility-detector.js');
const { PixelRegionDetector } = await import('./pixel-region-detector.js');
const {
  BrowserDomDetector,
  OcrTextDetector,
  detectUiElements,
  ensureBuiltinUiElementDetectors,
  listUiElementDetectors,
  registerUiElementDetector,
  resetUiElementDetectors,
} = await import('./ui-element-detector.js');
const { getSeamSelectionPolicy } = await import('./seam-provider-selection.js');

const IMAGE = { width: 1000, height: 500 };
const DOM = [{ ref: '@e1', name: 'Go', bbox: { x: 10, y: 10, width: 40, height: 20 } }];

function fakeOcr(lines: OcrResult['lines'] = []) {
  const calls: OcrRequest[] = [];
  const ocr = async (request: OcrRequest): Promise<OcrResult> => {
    calls.push(request);
    return {
      status: 'succeeded',
      provider: 'apple_vision',
      boundingBoxUnits: 'normalized',
      text: '',
      confidence: 90,
      elapsedMs: 1,
      lines,
    };
  };
  return { ocr, calls };
}

function useDetectors(ocr: ReturnType<typeof fakeOcr>['ocr']) {
  resetUiElementDetectors();
  registerUiElementDetector(new BrowserDomDetector());
  registerUiElementDetector(new OcrTextDetector(ocr));
}

beforeEach(() => {
  record.mockClear();
  vi.stubEnv('MISSION_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetUiElementDetectors();
});

describe('ui-element-detector seam', () => {
  it('registers the built-ins and the policy covers every built-in', () => {
    resetUiElementDetectors();
    ensureBuiltinUiElementDetectors();
    const ids = listUiElementDetectors().map((detector) => detector.id);
    expect(ids).toEqual(['browser_dom', 'ocr_text', 'os_accessibility', 'pixel_regions']);
    const policy = getSeamSelectionPolicy('ui-element-detector');
    expect(policy?.default_provider).toBe('browser_dom');
    expect(Object.keys(policy?.providers ?? {}).sort()).toEqual(ids);
  });

  it('prefers browser_dom when a snapshot is supplied and never calls OCR', async () => {
    const { ocr, calls } = fakeOcr([
      { text: 'x', confidence: 90, boundingBox: { x: 0, y: 0, width: 0.1, height: 0.1 } },
    ]);
    useDetectors(ocr);
    const result = await detectUiElements({
      image_path: 'screen.png',
      image_size: IMAGE,
      dom_elements: DOM,
      dom_scale: 2,
    });
    expect(result.detectors_run).toEqual(['browser_dom']);
    expect(result.decision?.strategy).toBe('default');
    expect(result.candidates).toEqual([
      expect.objectContaining({ ref: '@e1', box: { x: 20, y: 20, width: 80, height: 40 } }),
    ]);
    expect(calls).toHaveLength(0);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('falls back to ocr_text without a snapshot, local_only by default, converting units', async () => {
    const { ocr, calls } = fakeOcr([
      {
        text: 'Settings',
        confidence: 80,
        boundingBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
      },
    ]);
    useDetectors(ocr);
    const result = await detectUiElements({ image_path: 'screen.png', image_size: IMAGE });
    expect(result.detectors_run).toEqual(['ocr_text']);
    expect(result.decision?.strategy).toBe('fallback');
    expect(calls).toEqual([{ path: 'screen.png', mode: 'local_only' }]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        label: 'Settings',
        box: { x: 100, y: 100, width: 200, height: 50 },
      }),
    ]);
  });

  it('walks to the next ranked detector when the first finds nothing', async () => {
    const { ocr } = fakeOcr([
      { text: 'Only text', confidence: 80, boundingBox: { x: 0, y: 0, width: 0.1, height: 0.1 } },
    ]);
    useDetectors(ocr);
    const result = await detectUiElements({
      image_path: 'screen.png',
      image_size: IMAGE,
      dom_elements: [{ ref: '@e1', name: 'no bbox' }],
    });
    expect(result.detectors_run).toEqual(['browser_dom', 'ocr_text']);
    expect(result.candidates).toHaveLength(1);
  });

  it('runs every explicitly listed detector for fusion', async () => {
    const { ocr } = fakeOcr([
      { text: 'Go', confidence: 80, boundingBox: { x: 0.02, y: 0.05, width: 0.02, height: 0.02 } },
    ]);
    useDetectors(ocr);
    const result = await detectUiElements(
      { image_path: 'screen.png', image_size: IMAGE, dom_elements: DOM, ocr_mode: 'privacy_first' },
      { detectors: ['ocr_text', 'browser_dom'] }
    );
    expect(result.detectors_run).toEqual(['ocr_text', 'browser_dom']);
    expect(result.candidates.map((candidate) => candidate.source)).toEqual(['ocr', 'dom']);
    expect(result.decision).toBeUndefined();
  });

  it('rejects unknown or unavailable explicit detectors', async () => {
    useDetectors(fakeOcr().ocr);
    await expect(
      detectUiElements({ image_path: 's.png', image_size: IMAGE }, { detectors: ['yolo'] })
    ).rejects.toThrow(/UI_ELEMENT_DETECTOR_UNKNOWN/);
    await expect(
      detectUiElements({ image_path: 's.png', image_size: IMAGE }, { detectors: ['browser_dom'] })
    ).rejects.toThrow(/UI_ELEMENT_DETECTOR_UNAVAILABLE/);
  });

  it('ranks by purpose', async () => {
    useDetectors(fakeOcr().ocr);
    const result = await detectUiElements(
      { image_path: 's.png', image_size: IMAGE, dom_elements: DOM },
      { purpose: 'coverage' }
    );
    expect(result.decision?.ranked).toEqual(['ocr_text', 'browser_dom']);
    // OCR found nothing, so the DOM detector still supplied the marks.
    expect(result.detectors_run).toEqual(['ocr_text', 'browser_dom']);
  });

  describe('with the pixel and accessibility detectors', () => {
    const blank = { width: 200, height: 200, data: Buffer.alloc(200 * 200 * 4, 255) };
    const button = { width: 200, height: 200, data: Buffer.alloc(200 * 200 * 4, 255) };
    for (let y = 80; y < 104; y += 1) {
      for (let x = 80; x < 120; x += 1) {
        button.data.fill(0, (y * 200 + x) * 4, (y * 200 + x) * 4 + 3);
      }
    }
    const axSnapshot = JSON.stringify({
      screen: { width: 100, height: 100 },
      elements: [{ role: 'AXButton', title: 'Save', x: 6, y: 10, width: 20, height: 12 }],
    });
    const axRunner = (trusted: boolean) => async (_command: string, args: string[]) => ({
      stdout: args[3].includes('AXIsProcessTrusted') ? JSON.stringify({ trusted }) : axSnapshot,
      stderr: '',
      status: 0,
    });

    function useAll(options: {
      ocrLines?: OcrResult['lines'];
      trusted?: boolean;
      pixels?: typeof blank;
    }) {
      resetUiElementDetectors();
      registerUiElementDetector(new BrowserDomDetector());
      registerUiElementDetector(new OcrTextDetector(fakeOcr(options.ocrLines ?? []).ocr));
      registerUiElementDetector(
        new OsAccessibilityDetector({ run: axRunner(options.trusted ?? true), platform: 'darwin' })
      );
      registerUiElementDetector(
        new PixelRegionDetector({ readBitmap: async () => options.pixels ?? blank })
      );
    }

    const size = { width: 200, height: 200 };

    it('keeps OCR ahead of pixel regions by default and falls through to pixels when OCR is empty', async () => {
      useAll({ pixels: button });
      const result = await detectUiElements({ image_path: 's.png', image_size: size });
      expect(result.decision?.ranked).toEqual(['ocr_text', 'pixel_regions']);
      expect(result.detectors_run).toEqual(['ocr_text', 'pixel_regions']);
      expect(result.candidates).toEqual([
        expect.objectContaining({ source: 'detector', kind: 'control' }),
      ]);
    });

    it('ranks os_accessibility first for a declared live screen with the permission', async () => {
      useAll({});
      const result = await detectUiElements({
        image_path: 's.png',
        image_size: size,
        live_screen: true,
      });
      expect(result.decision?.ranked).toEqual(['os_accessibility', 'ocr_text', 'pixel_regions']);
      expect(result.detectors_run).toEqual(['os_accessibility']);
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: 'accessibility',
          label: 'Save',
          box: { x: 12, y: 20, width: 40, height: 24 },
        }),
      ]);
    });

    it('excludes os_accessibility without the permission', async () => {
      useAll({ trusted: false });
      const result = await detectUiElements({
        image_path: 's.png',
        image_size: size,
        live_screen: true,
      });
      expect(result.decision?.ranked).toEqual(['ocr_text', 'pixel_regions']);
    });

    it('ranks pixel regions first for the coverage purpose', async () => {
      useAll({ pixels: button });
      const result = await detectUiElements(
        { image_path: 's.png', image_size: size },
        { purpose: 'coverage' }
      );
      expect(result.decision?.ranked).toEqual(['pixel_regions', 'ocr_text']);
      expect(result.detectors_run).toEqual(['pixel_regions']);
    });

    it('runs an explicit list for fusion', async () => {
      useAll({ pixels: button });
      const result = await detectUiElements(
        { image_path: 's.png', image_size: size, live_screen: true },
        { detectors: ['os_accessibility', 'pixel_regions'] }
      );
      expect(result.candidates.map((candidate) => candidate.source)).toEqual([
        'accessibility',
        'detector',
      ]);
    });
  });
});
