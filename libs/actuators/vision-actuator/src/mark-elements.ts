import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { fuseSetOfMarks, type SomDomElement, type SomMark } from '@agent/core/set-of-marks';
import {
  detectUiElements,
  type DetectUiElementsOptions,
  type UiElementDetectionRequest,
  type UiElementDetectionResult,
} from '@agent/core/ui-element-detector';
import { inspectSomImage, renderSomOverlay, type SomRedactFn } from '@agent/core/som-overlay';
import { saveMarks } from '@agent/core/mark-target-resolver';
import type { OcrRoutingMode } from '@agent/core/ocr-types';

/**
 * vision:mark_elements — Set-of-Marks for a screenshot.
 *
 * Detects candidate UI elements, fuses them into numbered marks, draws them on
 * a redacted copy of the screenshot and stores the marks for the session so a
 * later click can target `mark:<n>` (system-actuator target_mark,
 * browser-actuator click_ref) until they go stale.
 */

export interface MarkElementsParams {
  path: string;
  session_id: string;
  detectors?: string[];
  purpose?: string;
  /** Browser snapshot elements of the same viewport (browser-actuator snapshot output). */
  dom_elements?: SomDomElement[];
  /** Screenshot pixels per CSS pixel for dom_elements. */
  dom_scale?: number;
  /** Screenshot pixels per logical click point. Defaults to dom_scale, else 1. */
  scale?: number;
  language?: string;
  ocr_mode?: OcrRoutingMode;
  /** Annotated PNG destination; defaults to the session's volatile dir. */
  output_path?: string;
  max_marks?: number;
}

export interface MarkElementsResult {
  marks: SomMark[];
  marks_id: string;
  annotated_path: string;
  svg_path: string;
  image_dhash: string;
  image: { width: number; height: number };
  scale: number;
  expires_at: number;
  detectors_run: string[];
}

export interface MarkElementsDeps {
  detect?: (
    request: UiElementDetectionRequest,
    options: DetectUiElementsOptions
  ) => Promise<UiElementDetectionResult>;
  redact?: SomRedactFn;
  now?: () => number;
}

function resolveRepositoryPath(logicalPath: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(logicalPath), {
    allowMissingLeaf: true,
  });
}

function positiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`[VISION_MARK_INVALID] ${label} must be a positive number`);
  }
  return number;
}

export async function handleMarkElements(
  params: MarkElementsParams,
  deps: MarkElementsDeps = {}
): Promise<MarkElementsResult> {
  const logicalPath = String(params?.path || '').trim();
  if (!logicalPath) throw new Error('[VISION_MARK_INVALID] mark_elements requires params.path');
  const sessionId = String(params.session_id || '').trim();
  if (!sessionId) throw new Error('[VISION_MARK_INVALID] mark_elements requires params.session_id');
  const imagePath = resolveRepositoryPath(logicalPath);
  if (!safeExistsSync(imagePath) || !safeLstat(imagePath).isFile()) {
    throw new Error(`[VISION_RESOURCE_FILE] image path must be a regular file: ${logicalPath}`);
  }
  const domScale = positiveNumber(params.dom_scale, 'dom_scale');
  const scale = positiveNumber(params.scale, 'scale') ?? domScale ?? 1;

  const { image, dhash: imageDhash } = await inspectSomImage(imagePath);

  const detection = await (deps.detect ?? detectUiElements)(
    {
      image_path: imagePath,
      image_size: image,
      ...(params.dom_elements ? { dom_elements: params.dom_elements } : {}),
      ...(domScale ? { dom_scale: domScale } : {}),
      ...(params.language ? { language: params.language } : {}),
      ...(params.ocr_mode ? { ocr_mode: params.ocr_mode } : {}),
    },
    {
      ...(params.detectors?.length ? { detectors: params.detectors } : {}),
      ...(params.purpose ? { purpose: params.purpose } : {}),
    }
  );
  const marks = fuseSetOfMarks(detection.candidates, {
    imageSize: image,
    ...(params.max_marks ? { maxMarks: params.max_marks } : {}),
  });

  const marksId = randomUUID();
  const outputPath = params.output_path
    ? resolveRepositoryPath(params.output_path)
    : path.join(pathResolver.volatile('session', sessionId), 'vision-marks', `${marksId}.png`);
  const overlay = await renderSomOverlay(
    { image_path: imagePath, marks, output_path: outputPath },
    deps.redact ? { redact: deps.redact } : {}
  );
  const record = saveMarks({
    session_id: sessionId,
    marks,
    image,
    image_dhash: imageDhash,
    scale,
    marks_id: marksId,
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    marks,
    marks_id: record.marks_id,
    annotated_path: overlay.annotated_path,
    svg_path: overlay.svg_path,
    image_dhash: imageDhash,
    image,
    scale,
    expires_at: record.expires_at,
    detectors_run: detection.detectors_run,
  };
}
