import type { ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import type { DesktopRecording, DesktopRecordingStep } from './desktop-recording.js';
import { chooseNativeOps } from './native-op-mapping.js';
import { compileSchema } from './foundation/ajv.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

export interface DesktopIntentStep {
  id: string;
  title: string;
  detail: string;
  evidence: string[];
  confidence: number;
  op: string;
  native_op?: string;
  repeat?: { over: string; source: 'observed_collection' };
}

export interface DesktopIntentDraft {
  schema_version: 'desktop-intent.v1';
  intent: string;
  steps: DesktopIntentStep[];
  source_recording_id: string;
  generated_at: string;
  review: {
    status: 'pending' | 'approved' | 'rejected';
    reviewer?: string;
    reviewed_at?: string;
    note?: string;
  };
}

let validateIntentFn: ValidateFunction | null = null;

function intentValidator(): ValidateFunction {
  if (!validateIntentFn)
    validateIntentFn = compileSchema(
      pathResolver.knowledge('product/schemas/desktop-intent.schema.json')
    );
  return validateIntentFn;
}

export function validateDesktopIntentDraft(input: unknown): DesktopIntentDraft {
  if (!intentValidator()(input)) {
    const errors = (intentValidator().errors || []).map(
      (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
    );
    throw new Error(`Invalid desktop intent: ${errors.join('; ')}`);
  }
  return input as DesktopIntentDraft;
}

/** Load one persisted intent review artifact through the regular-file contract boundary. */
export function loadDesktopIntentDraftAtPath(
  filePath: string,
  expectedSourceRecordingId?: string
): DesktopIntentDraft {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[DESKTOP_INTENT] intent draft must be a regular file: ${filePath}`);
  }
  const intent = defineCatalog<DesktopIntentDraft>({
    id: 'desktop-intent',
    path: safeFilePath,
    schema: pathResolver.knowledge('product/schemas/desktop-intent.schema.json'),
  }).load();
  validateDesktopIntentDraft(intent);
  if (
    expectedSourceRecordingId !== undefined &&
    intent.source_recording_id !== expectedSourceRecordingId
  ) {
    throw new Error(
      `[DESKTOP_INTENT_SCOPE_MISMATCH] intent artifact belongs to ${intent.source_recording_id}, expected ${expectedSourceRecordingId}`
    );
  }
  return intent;
}

function titleFor(step: DesktopRecordingStep): string {
  return step.summary.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** Deterministic/stub-safe baseline; a model may enrich it only before review. */
export function reconstructDesktopIntent(recording: DesktopRecording): DesktopIntentDraft {
  const meaningful = recording.steps.filter(
    (step) => !step.summary.toLowerCase().includes('recorder')
  );
  const repeated =
    meaningful.length >= 3 && new Set(meaningful.map((step) => step.op)).size < meaningful.length;
  const steps = meaningful.map((step, index) => {
    const nativeChoice = chooseNativeOps(
      [step.summary, step.selector?.app, step.selector?.window_title, step.selector?.description]
        .filter(Boolean)
        .join(' ')
    );
    return {
      id: step.step_id || `intent-step-${index + 1}`,
      title: titleFor(step),
      detail: `Perform ${step.op} against the reviewed desktop target; retain prerequisites and references needed by later steps.${nativeChoice.gui_fallback ? ' No governed native operation matched, so GUI replay remains the fallback.' : ` Prefer governed native operation ${nativeChoice.ops[0]}.`}`,
      evidence: step.evidence,
      confidence: step.needs_semantic_resolution ? 0.55 : 0.9,
      op: step.op,
      ...(!nativeChoice.gui_fallback && nativeChoice.ops[0]
        ? { native_op: nativeChoice.ops[0] }
        : {}),
      ...(repeated && index > 0
        ? { repeat: { over: 'observed collection', source: 'observed_collection' as const } }
        : {}),
    };
  });
  const intent =
    meaningful.length === 0
      ? 'Perform the reviewed desktop procedure'
      : `Complete the desktop workflow: ${meaningful
          .map((step) => step.op)
          .slice(0, 3)
          .join(' → ')}`;
  return validateDesktopIntentDraft({
    schema_version: 'desktop-intent.v1',
    intent,
    steps,
    source_recording_id: recording.recording_id,
    generated_at: nowIso(),
    review: { status: 'pending' },
  });
}

export function reviewDesktopIntent(
  draft: DesktopIntentDraft,
  decision: 'approved' | 'rejected',
  reviewer: string,
  note?: string
): DesktopIntentDraft {
  return validateDesktopIntentDraft({
    ...draft,
    review: {
      status: decision,
      reviewer,
      reviewed_at: nowIso(),
      ...(note ? { note } : {}),
    },
  });
}

export function intentDraftHash(draft: DesktopIntentDraft): string {
  const source = {
    schema_version: draft.schema_version,
    intent: draft.intent,
    steps: draft.steps,
    source_recording_id: draft.source_recording_id,
    generated_at: draft.generated_at,
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
