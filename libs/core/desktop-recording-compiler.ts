import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  invalidateProcedureCache,
  readProcedureCatalog,
  resolveAllowlistedRecordingRef,
  validateProcedureCatalog,
} from './procedure-registry.js';
import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import type { ProcedureCatalog, ProcedureEntry, ProcedureRiskClass } from './procedure-types.js';
import {
  computeDesktopRecordingHash,
  validateDesktopRecording,
  type DesktopRecording,
} from './desktop-recording.js';
import { validateDesktopPipeline, type DesktopPipeline } from './desktop-pipeline.js';
import { intentDraftHash, validateDesktopIntentDraft } from './desktop-intent-reconstruction.js';
import {
  assertNoPendingDesktopPromotion,
  acquireDesktopPromotionLock,
  clearDesktopPromotionTransaction,
  releaseDesktopPromotionLock,
  writeDesktopPromotionTransaction,
} from './desktop-promotion-transaction.js';

const PROCEDURE_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;
const PERSONAL_CATALOG_PATH = pathResolver.knowledge('personal/procedures.json');

export interface CompileDesktopRecordingOptions {
  procedureId: string;
  intentPhrases: string[];
  recordingRef?: string;
  status?: ProcedureEntry['status'];
  targetName?: string;
}

export interface CompileDesktopRecordingResult {
  procedureEntry: ProcedureEntry;
  pipeline: DesktopPipeline;
  warnings: string[];
}

function riskClass(recording: DesktopRecording): ProcedureRiskClass {
  if (recording.steps.some((step) => step.risk_class === 'high')) return 'high';
  if (recording.steps.some((step) => step.risk_class === 'low')) return 'medium';
  return 'low';
}

export function compileDesktopRecording(
  recording: DesktopRecording,
  options: CompileDesktopRecordingOptions
): CompileDesktopRecordingResult {
  const recordingValidation = validateDesktopRecording(recording);
  if (!recordingValidation.value) {
    throw new Error(
      `desktop recording failed validation: ${recordingValidation.errors.join('; ')}`
    );
  }
  const procedureId = options.procedureId.trim();
  if (!PROCEDURE_ID_RE.test(procedureId)) {
    throw new Error(`procedure_id must match ${PROCEDURE_ID_RE}`);
  }
  const intentPhrases = options.intentPhrases.map((phrase) => phrase.trim()).filter(Boolean);
  if (intentPhrases.length === 0)
    throw new Error('intent_phrases must contain at least one phrase');
  if (recording.steps.length === 0) throw new Error('desktop recording has no executable steps');
  const unresolved = recording.steps.filter((step) => step.needs_semantic_resolution);
  if (unresolved.length > 0) {
    throw new Error(
      `desktop recording contains unresolved semantic targets: ${unresolved.map((step) => step.step_id).join(', ')}`
    );
  }
  const nativeBoundSteps = recording.steps.filter((step) => step.native_op);
  if (nativeBoundSteps.length > 0) {
    throw new Error(
      `desktop recording contains explicit native execution bindings (${nativeBoundSteps.map((step) => step.native_op).join(', ')}); no native executor is registered for promotion`
    );
  }
  if (recording.recording_hash !== computeDesktopRecordingHash(recording)) {
    throw new Error('desktop recording hash does not match the recording body');
  }
  const effectiveRecordingRef =
    options.recordingRef || `active/shared/runtime/recordings/${recording.recording_id}.json`;
  const warnings: string[] = [];

  const pipeline = {
    schema_version: 'desktop-pipeline.v1' as const,
    procedure_id: procedureId,
    executor: 'system' as const,
    recording_ref: effectiveRecordingRef,
    recording_hash: recording.recording_hash,
    steps: recording.steps.map((step) => ({
      step_id: step.step_id,
      op: `system:${step.op}`,
      // A semantic match is only a recommendation. Do not turn an observed
      // window title into an executable native operation; the recording has
      // no reviewed native parameters or executor binding for that claim.
      ...(step.native_op ? { native_op: step.native_op } : {}),
      risk_class: step.risk_class,
      ...(step.selector ? { selector: { ...step.selector } } : {}),
      ...(step.params ? { params: { ...step.params } } : {}),
      ...(step.variable ? { variable: { ...step.variable } } : {}),
    })),
  };
  const pipelineValidation = validateDesktopPipeline(pipeline);
  if (!pipelineValidation.value) {
    throw new Error(`desktop pipeline failed validation: ${pipelineValidation.errors.join('; ')}`);
  }
  if (recording.steps.some((step) => !step.native_op)) {
    warnings.push(
      'native operation suggestions remain in the intent review; GUI replay is selected because no native executor is registered'
    );
  }

  return {
    procedureEntry: {
      procedure_id: procedureId,
      substrate: 'desktop',
      adapter: {
        recorder: 'desktop-capture',
        executor: 'system',
        recording_ref: effectiveRecordingRef,
      },
      target: {
        name: options.targetName ?? recording.target.name,
        platform: recording.target.platform,
      },
      intent_phrases: intentPhrases,
      pipeline_ref: `pipelines/desktop/${procedureId}.json`,
      risk_class: riskClass(recording),
      version: '1.0.0',
      status: options.status ?? 'active',
    },
    pipeline,
    warnings,
  };
}

/** Promote an approved desktop recording into the same personal procedure catalog as browser flows. */
export function promoteDesktopProcedure(options: {
  recordingRef: string;
  procedureId: string;
  intentPhrases: string[];
  status?: ProcedureEntry['status'];
  catalogPath?: string;
  intentRef?: string;
}): {
  procedureEntry: ProcedureEntry;
  catalogPath: string;
  pipelinePath: string;
  warnings: string[];
} {
  const recordingAbs = resolveAllowlistedRecordingRef(options.recordingRef);
  if (!recordingAbs) throw new Error('recording_ref is outside the allowlisted recording stores');
  let raw: unknown;
  try {
    raw = readJson<unknown>(recordingAbs);
  } catch (error) {
    throw new Error(
      `failed to read recording: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const validation = validateDesktopRecording(raw);
  if (!validation.value)
    throw new Error(`recording failed validation: ${validation.errors.join('; ')}`);
  if (validation.value.review.status !== 'approved') {
    throw new Error('recording review must be approved before promotion');
  }
  if (!validation.value.intent_hash) {
    throw new Error(
      'intent review artifact is required before promotion; run recording review --approve-intent'
    );
  }
  const recordingFileName = path.basename(recordingAbs).replace(/\.json$/u, '');
  const intentCandidate = options.intentRef
    ? resolveAllowlistedRecordingRef(options.intentRef)
    : resolveAllowlistedRecordingRef(
        pathResolver.toRepoRelative(
          path.join(path.dirname(recordingAbs), `${recordingFileName}.intent.json`)
        )
      );
  if (!intentCandidate) throw new Error('intent_ref is outside the allowlisted recording stores');
  let intent: ReturnType<typeof validateDesktopIntentDraft>;
  try {
    intent = validateDesktopIntentDraft(readJson<unknown>(intentCandidate));
  } catch (error) {
    throw new Error(
      `failed to read intent review artifact: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (intent.source_recording_id !== validation.value.recording_id) {
    throw new Error('intent review artifact does not belong to the recording');
  }
  if (intent.review.status !== 'approved') {
    throw new Error('intent review must be approved before promotion');
  }
  if (intentDraftHash(intent) !== validation.value.intent_hash) {
    throw new Error('intent review artifact does not match the recorded intent source');
  }
  if (validation.value.steps.some((step) => step.needs_semantic_resolution)) {
    throw new Error(
      'desktop recording contains unresolved semantic targets; resolve them before promotion'
    );
  }

  const recordingRef = pathResolver.toRepoRelative(recordingAbs);
  if (
    validation.value.capture?.event_source !== 'native-cg-event-tap' ||
    validation.value.steps.length === 0
  ) {
    throw new Error('desktop recording must contain native OS events before promotion');
  }
  const screenArtifact = validation.value.artifacts?.screen_recording;
  if (screenArtifact?.status === 'succeeded' && screenArtifact.recording_ref) {
    const artifactAbs = resolveAllowlistedRecordingRef(screenArtifact.recording_ref);
    if (!artifactAbs)
      throw new Error('screen recording artifact is outside the allowlisted recording stores');
    const artifact = safeReadFile(artifactAbs, { encoding: null }) as Buffer;
    const digest = createHash('sha256').update(artifact).digest('hex');
    if (digest !== screenArtifact.sha256)
      throw new Error('screen recording artifact hash mismatch');
  }
  const compiled = compileDesktopRecording(validation.value, {
    procedureId: options.procedureId,
    intentPhrases: options.intentPhrases,
    recordingRef,
    status: options.status ?? 'active',
  });
  const catalogPath = assertSafeRepositoryPath(options.catalogPath ?? PERSONAL_CATALOG_PATH, {
    allowMissingLeaf: true,
  });
  if (path.resolve(catalogPath) !== path.resolve(PERSONAL_CATALOG_PATH)) {
    throw new Error('desktop promotion catalog must be the governed personal procedures catalog');
  }
  acquireDesktopPromotionLock();
  try {
    assertNoPendingDesktopPromotion(options.procedureId, { lockHeld: true });
    let catalog: ProcedureCatalog = { schema_version: 'procedures.v1', procedures: [] };
    try {
      catalog = readProcedureCatalog(catalogPath);
    } catch (error) {
      if (safeExistsSync(catalogPath)) {
        throw new Error(
          `failed to read procedure catalog: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (!Array.isArray(catalog.procedures)) catalog.procedures = [];
    if (catalog.procedures.some((entry) => entry.procedure_id === options.procedureId)) {
      throw new Error(
        `procedure_id "${options.procedureId}" already exists in the selected catalog`
      );
    }
    const pipelinePath = assertSafeRepositoryPath(
      pathResolver.rootResolve(compiled.procedureEntry.pipeline_ref),
      { allowMissingLeaf: true }
    );
    const previousPipeline = safeExistsSync(pipelinePath)
      ? (safeReadFile(pipelinePath, { encoding: 'utf8' }) as string)
      : null;
    const previousCatalog = safeExistsSync(catalogPath)
      ? (safeReadFile(catalogPath, { encoding: 'utf8' }) as string)
      : null;
    catalog.procedures.push(compiled.procedureEntry);
    validateProcedureCatalog(catalog, catalogPath);
    const nextPipelineText = `${JSON.stringify(compiled.pipeline, null, 2)}\n`;
    const nextCatalogText = `${JSON.stringify(catalog, null, 2)}\n`;
    const safeProcedureId = options.procedureId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const transactionDir = pathResolver.shared('runtime/state/desktop-promotion-transactions');
    const pipelineBackupPath = path.join(transactionDir, `${safeProcedureId}.pipeline.bak`);
    const catalogBackupPath = path.join(transactionDir, `${safeProcedureId}.catalog.bak`);
    if (previousPipeline !== null) safeWriteFile(pipelineBackupPath, previousPipeline);
    if (previousCatalog !== null) safeWriteFile(catalogBackupPath, previousCatalog);
    const transaction = {
      schema_version: 'desktop-promotion-transaction.v1' as const,
      status: 'prepared' as const,
      procedure_id: options.procedureId,
      pipeline_path: pipelinePath,
      catalog_path: catalogPath,
      pipeline_sha256: createHash('sha256').update(nextPipelineText).digest('hex'),
      catalog_sha256: createHash('sha256').update(nextCatalogText).digest('hex'),
      ...(previousPipeline !== null ? { pipeline_backup_path: pipelineBackupPath } : {}),
      ...(previousCatalog !== null ? { catalog_backup_path: catalogBackupPath } : {}),
      pipeline_existed: previousPipeline !== null,
      catalog_existed: previousCatalog !== null,
    };
    try {
      writeDesktopPromotionTransaction(transaction);
      safeMkdir(path.dirname(pipelinePath), { recursive: true });
      safeWriteFile(pipelinePath, nextPipelineText);
      safeMkdir(path.dirname(catalogPath), { recursive: true });
      safeWriteFile(catalogPath, nextCatalogText);
      writeDesktopPromotionTransaction({ ...transaction, status: 'committed' });
    } catch (error) {
      if (previousPipeline !== null) safeWriteFile(pipelinePath, previousPipeline);
      else if (safeExistsSync(pipelinePath)) safeRmSync(pipelinePath, { force: true });
      if (previousCatalog !== null) safeWriteFile(catalogPath, previousCatalog);
      else if (safeExistsSync(catalogPath)) safeRmSync(catalogPath, { force: true });
      clearDesktopPromotionTransaction(options.procedureId);
      throw error;
    }
    clearDesktopPromotionTransaction(options.procedureId);
    invalidateProcedureCache();
    return {
      procedureEntry: compiled.procedureEntry,
      pipelinePath,
      catalogPath,
      warnings: compiled.warnings,
    };
  } finally {
    releaseDesktopPromotionLock();
  }
}
