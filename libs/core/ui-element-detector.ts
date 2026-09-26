import { logger } from './core.js';
import { ocrImage } from './ocr-bridge.js';
import type { OcrRequest, OcrResult, OcrRoutingMode } from './ocr-types.js';
import { OsAccessibilityDetector } from './os-accessibility-detector.js';
import { PixelRegionDetector } from './pixel-region-detector.js';
import { coreSeamCatalog, createSeam } from './seam.js';
import {
  resolveSeamProviderDecision,
  type SeamProviderCandidate,
  type SeamProviderDecision,
} from './seam-provider-selection.js';
import {
  candidatesFromDomSnapshot,
  candidatesFromOcr,
  type SomCandidate,
  type SomDomElement,
  type SomImageSize,
} from './set-of-marks.js';

/**
 * `ui-element-detector` seam: sources of Set-of-Marks candidate boxes.
 *
 * Built-ins are `browser_dom` (rects of the browser snapshot, exact and
 * ref-carrying), `os_accessibility` (rects of the OS accessibility tree, exact,
 * only for this machine's live screen), `ocr_text` (text lines of any
 * screenshot) and `pixel_regions` (edge-based control/icon regions of any
 * screenshot, unlabelled). A model detector (YOLO / OmniParser style tool
 * runtime) registers here as another provider with kind 'model'; nothing else
 * changes.
 *
 * Without an explicit detector list the governed selection policy ranks the
 * available detectors and the first one that finds anything wins; a detector
 * that throws is logged, reported in `detectors_failed` and skipped. With an
 * explicit list every listed detector runs and the caller fuses the union; a
 * failure there still fails the call, because the caller asked for exactly
 * those sources and a silently missing one would change the fused marks.
 */

export type UiElementDetectorKind = 'dom' | 'ocr' | 'pixels' | 'accessibility' | 'model';

export interface UiElementDetectionRequest {
  image_path: string;
  image_size: SomImageSize;
  /** Browser snapshot elements for the same viewport (enables browser_dom). */
  dom_elements?: readonly SomDomElement[];
  /** Screenshot pixels per CSS pixel for dom_elements. Default 1. */
  dom_scale?: number;
  language?: string;
  /** OCR routing mode for ocr_text. Default 'local_only': screenshots stay on this machine. */
  ocr_mode?: OcrRoutingMode;
  /**
   * The screenshot is a capture of this machine's live screen, taken just now.
   * Enables os_accessibility; never set it for an arbitrary or stored image.
   */
  live_screen?: boolean;
  /** Top-left of the screenshot in global logical screen points. Default {x: 0, y: 0} (main display). */
  screen_origin?: { x: number; y: number };
  /** Screenshot pixels per logical screen point. Default: image width / main display width in points. */
  screen_scale?: number;
  /** Application whose front window os_accessibility reads. Default: the frontmost application. */
  application?: string;
}

export interface UiElementDetector {
  readonly id: string;
  readonly kind: UiElementDetectorKind;
  isAvailable(request: UiElementDetectionRequest): Promise<boolean>;
  detect(request: UiElementDetectionRequest): Promise<SomCandidate[]>;
}

export interface DetectUiElementsOptions {
  /** Run exactly these detectors (all of them) instead of policy selection. */
  detectors?: readonly string[];
  /** Governed selection purpose (see seam-provider-selection/ui-element-detector.json). */
  purpose?: string;
}

export interface UiElementDetectionResult {
  candidates: SomCandidate[];
  detectors_run: string[];
  /** Ranked detectors that threw and were skipped (policy selection only). */
  detectors_failed?: string[];
  decision?: Pick<SeamProviderDecision, 'strategy' | 'ranked' | 'rationale'>;
}

const uiElementDetectorSeam = createSeam<UiElementDetector>({
  key: 'ui-element-detector',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const detectorDisposers = new Map<string, () => void>();
let builtinsRegistered = false;

export function registerUiElementDetector(detector: UiElementDetector): () => void {
  const id = String(detector.id || '').trim();
  if (!id) throw new Error('UiElementDetector.id is required');
  detectorDisposers.get(id)?.();
  const disposer = uiElementDetectorSeam.register(id, detector, {
    provenance: 'builtin',
    source: 'ui-element-detector',
  });
  detectorDisposers.set(id, disposer);
  return disposer;
}

export function listUiElementDetectors(): UiElementDetector[] {
  return uiElementDetectorSeam.list().map((entry) => entry.implementation);
}

export function resetUiElementDetectors(): void {
  for (const dispose of detectorDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  detectorDisposers.clear();
  builtinsRegistered = false;
}

export class BrowserDomDetector implements UiElementDetector {
  readonly id = 'browser_dom';
  readonly kind = 'dom' as const;

  async isAvailable(request: UiElementDetectionRequest): Promise<boolean> {
    return Array.isArray(request.dom_elements) && request.dom_elements.length > 0;
  }

  async detect(request: UiElementDetectionRequest): Promise<SomCandidate[]> {
    return candidatesFromDomSnapshot(request.dom_elements ?? [], { scale: request.dom_scale });
  }
}

export type OcrFn = (request: OcrRequest) => Promise<OcrResult>;

export class OcrTextDetector implements UiElementDetector {
  readonly id = 'ocr_text';
  readonly kind = 'ocr' as const;

  constructor(private readonly ocr: OcrFn = ocrImage) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async detect(request: UiElementDetectionRequest): Promise<SomCandidate[]> {
    const result = await this.ocr({
      path: request.image_path,
      mode: request.ocr_mode ?? 'local_only',
      ...(request.language ? { language: request.language } : {}),
    });
    return candidatesFromOcr(result, request.image_size);
  }
}

/** Register the built-in detectors that are not already registered (idempotent). */
export function ensureBuiltinUiElementDetectors(): void {
  if (builtinsRegistered) return;
  const registered = new Set(listUiElementDetectors().map((detector) => detector.id));
  for (const detector of [
    new BrowserDomDetector(),
    new OcrTextDetector(),
    new OsAccessibilityDetector(),
    new PixelRegionDetector(),
  ]) {
    if (!registered.has(detector.id)) registerUiElementDetector(detector);
  }
  builtinsRegistered = true;
}

function detectorById(id: string): UiElementDetector {
  const detector = uiElementDetectorSeam.getOptional(id);
  if (!detector) {
    throw new Error(
      `[UI_ELEMENT_DETECTOR_UNKNOWN] '${id}' is not registered; known: ${listUiElementDetectors()
        .map((entry) => entry.id)
        .join(', ')}`
    );
  }
  return detector;
}

export async function detectUiElements(
  request: UiElementDetectionRequest,
  options: DetectUiElementsOptions = {}
): Promise<UiElementDetectionResult> {
  ensureBuiltinUiElementDetectors();

  if (options.detectors && options.detectors.length > 0) {
    const ids = [...new Set(options.detectors.map((id) => String(id).trim()))];
    const detectors = ids.map(detectorById);
    const candidates: SomCandidate[] = [];
    const run: string[] = [];
    for (const detector of detectors) {
      if (!(await detector.isAvailable(request))) {
        throw new Error(
          `[UI_ELEMENT_DETECTOR_UNAVAILABLE] '${detector.id}' cannot run for this request`
        );
      }
      candidates.push(...(await detector.detect(request)));
      run.push(detector.id);
    }
    return { candidates, detectors_run: run };
  }

  const candidates: SeamProviderCandidate[] = [];
  for (const detector of listUiElementDetectors()) {
    candidates.push(
      (await detector.isAvailable(request))
        ? { id: detector.id, eligible: true }
        : { id: detector.id, eligible: false, unmet: ['detector input not available'] }
    );
  }
  const decision = resolveSeamProviderDecision({
    seam: uiElementDetectorSeam.key,
    candidates,
    ...(options.purpose ? { purpose: options.purpose } : {}),
    decisionKey: options.purpose || 'default',
  });
  if (decision.strategy === 'unresolved') {
    throw new Error(`[UI_ELEMENT_DETECTOR_SELECTION] ${decision.rationale}`);
  }
  const summary = {
    strategy: decision.strategy,
    ranked: decision.ranked,
    rationale: decision.rationale,
  };
  const run: string[] = [];
  const failed: string[] = [];
  const done = (candidates: SomCandidate[]): UiElementDetectionResult => ({
    candidates,
    detectors_run: run,
    ...(failed.length > 0 ? { detectors_failed: failed } : {}),
    decision: summary,
  });
  for (const id of decision.ranked) {
    // A ranked detector is one option among several: if it fails, the next
    // one still gets its turn instead of the whole call failing.
    let found: SomCandidate[];
    try {
      found = await detectorById(id).detect(request);
    } catch (error) {
      failed.push(id);
      logger.warn(
        `[ui-element-detector] ${id} failed (${error instanceof Error ? error.message : String(error)}); trying the next detector`
      );
      continue;
    }
    run.push(id);
    if (found.length > 0) return done(found);
    logger.info(`[ui-element-detector] ${id} found no elements; trying the next detector`);
  }
  return done([]);
}
