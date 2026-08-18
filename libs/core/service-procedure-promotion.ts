import path from 'node:path';
import { compileServiceRecording } from './service-recording-compiler.js';
import { invalidateProcedureCache, resolveAllowlistedRecordingRef } from './procedure-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { validatePipelineAdf, type PipelineAdf } from './pipeline-contract.js';
import { validatePipelineGuardrails } from './adf-guardrails.js';
import { validateServiceRecording } from './service-recording.js';
import type { ProcedureCatalog, ProcedureEntry } from './procedure-types.js';

const PROCEDURE_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;
const PERSONAL_CATALOG_PATH = pathResolver.knowledge('personal/procedures.json');

export interface PromoteServiceProcedureOptions {
  recordingRef: string;
  procedureId: string;
  intentPhrases: string[];
  status?: ProcedureEntry['status'];
  catalogPath?: string;
}

export interface PromoteServiceProcedureResult {
  procedureEntry: ProcedureEntry;
  catalogPath: string;
  pipelinePath: string;
  pipeline: PipelineAdf;
  warnings: string[];
}

/**
 * Promote an approved service recording to a runnable service:preset ADF and
 * the personal substrate-neutral procedure catalog. No external service is
 * contacted by this function; approval is checked before any catalog write.
 */
export function promoteServiceProcedure(
  options: PromoteServiceProcedureOptions
): PromoteServiceProcedureResult {
  const procedureId = options.procedureId.trim();
  if (!PROCEDURE_ID_RE.test(procedureId)) {
    throw new Error(`procedure_id must match ${PROCEDURE_ID_RE}`);
  }
  const intentPhrases = options.intentPhrases.map((phrase) => phrase.trim()).filter(Boolean);
  if (intentPhrases.length === 0)
    throw new Error('intent_phrases must contain at least one phrase');

  const recordingAbs = resolveAllowlistedRecordingRef(options.recordingRef);
  if (!recordingAbs) throw new Error('recording_ref is outside the allowlisted recording stores');
  const raw = JSON.parse(safeReadFile(recordingAbs, { encoding: 'utf8' }) as string) as unknown;
  const validation = validateServiceRecording(raw);
  if (!validation.value) {
    throw new Error(`recording failed validation: ${validation.errors.join('; ')}`);
  }
  if (validation.value.review?.status !== 'approved') {
    throw new Error('recording review must be approved before promotion');
  }

  const compiled = compileServiceRecording(validation.value, {
    procedureId,
    intentPhrases,
    recordingRef: pathResolver.toRepoRelative(recordingAbs),
    status: options.status ?? 'active',
  });
  const blockingWarnings = compiled.warnings.filter(
    (warning) => !warning.includes('external-effect step(s) require approval before execution')
  );
  if (blockingWarnings.length > 0) {
    throw new Error(`recording has unresolved promotion warnings: ${blockingWarnings.join('; ')}`);
  }
  const { _draft: _draftMarker, ...promotedDraft } = compiled.pipeline;
  const pipeline = validatePipelineAdf(promotedDraft);
  const guardrails = validatePipelineGuardrails(pipeline, `service:${procedureId}`);
  if (!guardrails.ok) {
    throw new Error(
      `compiled service pipeline failed guardrails: ${guardrails.findings
        .map((finding) => `${finding.code}:${finding.message}`)
        .join('; ')}`
    );
  }

  const catalogPath = options.catalogPath ?? PERSONAL_CATALOG_PATH;
  let catalog: ProcedureCatalog = { schema_version: 'procedures.v1', procedures: [] };
  if (safeExistsSync(catalogPath)) {
    catalog = JSON.parse(
      safeReadFile(catalogPath, { encoding: 'utf8' }) as string
    ) as ProcedureCatalog;
  }
  if (!Array.isArray(catalog.procedures)) catalog.procedures = [];
  if (catalog.procedures.some((entry) => entry.procedure_id === procedureId)) {
    throw new Error(`procedure_id "${procedureId}" already exists in the selected catalog`);
  }

  const pipelinePath = pathResolver.rootResolve(compiled.procedureEntry.pipeline_ref);
  safeMkdir(path.dirname(pipelinePath), { recursive: true });
  safeWriteFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
  catalog.procedures.push(compiled.procedureEntry);
  safeMkdir(path.dirname(catalogPath), { recursive: true });
  safeWriteFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  invalidateProcedureCache();

  return {
    procedureEntry: compiled.procedureEntry,
    catalogPath,
    pipelinePath,
    pipeline,
    warnings: compiled.warnings,
  };
}
