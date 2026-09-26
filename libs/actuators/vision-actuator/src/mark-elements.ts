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
import { saveMarks, type MarksDisplay } from '@agent/core/mark-target-resolver';
import type { OcrRoutingMode } from '@agent/core/ocr-types';
import type { PayloadTier } from '@agent/core/image-description-bridge';
import {
  isInsideDir,
  requireVisionSessionId,
  resolveVisionScope,
  type MissionPathResolver,
} from './vision-scope.js';

/**
 * vision:mark_elements — Set-of-Marks for a screenshot.
 *
 * Detects candidate UI elements, fuses them into numbered marks, draws them on
 * a redacted copy of the screenshot and stores the marks for the session so a
 * later click can target `mark:<n>` (system-actuator target_mark,
 * browser-actuator click_ref) until they go stale.
 *
 * Scope follows describe_screen_delta: a non-public screenshot (declared, by
 * path, or by mission) needs an existing mission, and the overlay PNG, SVG,
 * marks and the transient raw copy all stay inside that mission's directory.
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
  /** Annotated PNG destination; defaults to the session's (or mission's) vision-marks dir. */
  output_path?: string;
  max_marks?: number;
  tier?: PayloadTier;
  mission_id?: string;
  /** Browser snapshot id (browser-actuator `last_snapshot_id`) dom_elements came from. */
  dom_snapshot_id?: string;
  /** Display the screenshot was captured on (system clicks). */
  display_index?: number;
  /** Top-left of that display in global logical points, for multi-display clicks. */
  display_origin?: { x: number; y: number };
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
  tier: PayloadTier;
}

export interface MarkElementsDeps {
  detect?: (
    request: UiElementDetectionRequest,
    options: DetectUiElementsOptions
  ) => Promise<UiElementDetectionResult>;
  redact?: SomRedactFn;
  now?: () => number;
  resolveMissionPath?: MissionPathResolver;
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

function displayOf(params: MarkElementsParams): MarksDisplay | undefined {
  const index = params.display_index;
  if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
    throw new Error('[VISION_MARK_INVALID] display_index must be a non-negative integer');
  }
  const origin = params.display_origin;
  if (origin !== undefined && !(Number.isFinite(origin?.x) && Number.isFinite(origin?.y))) {
    throw new Error('[VISION_MARK_INVALID] display_origin needs finite x and y');
  }
  if (index === undefined && origin === undefined) return undefined;
  return {
    ...(index !== undefined ? { index } : {}),
    ...(origin ? { origin: { x: origin.x, y: origin.y } } : {}),
  };
}

export async function handleMarkElements(
  params: MarkElementsParams,
  deps: MarkElementsDeps = {}
): Promise<MarkElementsResult> {
  const logicalPath = String(params?.path || '').trim();
  if (!logicalPath) throw new Error('[VISION_MARK_INVALID] mark_elements requires params.path');
  const sessionId = requireVisionSessionId(
    params.session_id,
    'VISION_MARK_INVALID',
    'mark_elements'
  );
  const imagePath = resolveRepositoryPath(logicalPath);
  if (!safeExistsSync(imagePath) || !safeLstat(imagePath).isFile()) {
    throw new Error(`[VISION_RESOURCE_FILE] image path must be a regular file: ${logicalPath}`);
  }
  const domScale = positiveNumber(params.dom_scale, 'dom_scale');
  const scale = positiveNumber(params.scale, 'scale') ?? domScale ?? 1;
  const display = displayOf(params);
  const scope = resolveVisionScope(
    {
      image_path: imagePath,
      tier: params.tier,
      mission_id: params.mission_id,
      subject: 'mark_elements screenshot',
      invalid_code: 'VISION_MARK_INVALID',
    },
    deps.resolveMissionPath
  );
  const outputDir = scope.mission_path
    ? path.join(scope.mission_path, 'tmp', 'vision-marks', sessionId)
    : path.join(pathResolver.volatile('session', sessionId), 'vision-marks');

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
    : path.join(outputDir, `${marksId}.png`);
  if (path.resolve(outputPath) === path.resolve(imagePath)) {
    throw new Error('[VISION_MARK_INVALID] output_path must not overwrite the screenshot');
  }
  if (scope.mission_path && !isInsideDir(outputPath, scope.mission_path)) {
    throw new Error(
      `[VISION_TIER_SCOPE] output_path must stay inside mission ${scope.mission_id} for a ${scope.tier} screenshot`
    );
  }
  const overlay = await renderSomOverlay(
    { image_path: imagePath, marks, output_path: outputPath, work_dir: outputDir },
    deps.redact ? { redact: deps.redact } : {}
  );
  const record = saveMarks({
    session_id: sessionId,
    marks,
    image,
    image_dhash: imageDhash,
    scale,
    marks_id: marksId,
    tier: scope.tier,
    ...(scope.mission_id ? { mission_id: scope.mission_id } : {}),
    ...(params.dom_snapshot_id ? { dom_snapshot_id: String(params.dom_snapshot_id) } : {}),
    ...(display ? { display } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    marks: record.marks,
    marks_id: record.marks_id,
    annotated_path: overlay.annotated_path,
    svg_path: overlay.svg_path,
    image_dhash: imageDhash,
    image,
    scale,
    expires_at: record.expires_at,
    detectors_run: detection.detectors_run,
    tier: scope.tier,
  };
}
