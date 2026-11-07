import path from 'node:path';
import { compileBrowserRecording } from '@agent/core/browser/browser-recording-compiler';
import {
  invalidateProcedureCache,
  readProcedureCatalog,
  resolveAllowlistedRecordingRef,
  validateProcedureCatalog,
} from '@agent/core/knowledge/procedure-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  goldenScenarioPathForCatalog,
  saveGoldenScenario,
} from '@agent/core/knowledge/golden-scenario-verdict';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { loadBrowserExtensionRecordingAtPath } from '@agent/core/browser/browser-extension-bridge';
import type { ProcedureCatalog, ProcedureEntry } from '@agent/core/knowledge/procedure-types';

const PROCEDURE_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;
const PERSONAL_CATALOG_PATH = pathResolver.knowledge('personal/browser-procedures.json');

export interface PromoteBrowserProcedureOptions {
  recordingRef: string;
  procedureId: string;
  intentPhrases: string[];
  status?: ProcedureEntry['status'];
  /** Personal is the only extension-facing scope; public is retained for the CLI. */
  catalogPath?: string;
}

export interface PromoteBrowserProcedureResult {
  procedureEntry: ProcedureEntry;
  catalogPath: string;
}

/**
 * Register an already reviewed recording as a reusable browser procedure.
 * The caller chooses the catalog path, while recording_ref is always checked
 * against the shared or personal recording stores by the core trust boundary.
 */
export function promoteBrowserProcedure(
  options: PromoteBrowserProcedureOptions
): PromoteBrowserProcedureResult {
  const procedureId = options.procedureId.trim();
  if (!PROCEDURE_ID_RE.test(procedureId)) {
    throw new Error(`procedure_id must match ${PROCEDURE_ID_RE}`);
  }
  const intentPhrases = options.intentPhrases.map((phrase) => phrase.trim()).filter(Boolean);
  if (intentPhrases.length === 0)
    throw new Error('intent_phrases must contain at least one phrase');

  const recordingAbs = resolveAllowlistedRecordingRef(options.recordingRef);
  if (!recordingAbs) throw new Error('recording_ref is outside the allowlisted recording stores');
  let recording: ReturnType<typeof loadBrowserExtensionRecordingAtPath>;
  try {
    recording = loadBrowserExtensionRecordingAtPath(recordingAbs);
  } catch (error) {
    throw new Error(
      `failed to read recording: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (recording.review?.status !== 'approved') {
    throw new Error('recording review must be approved before promotion');
  }

  const compiled = compileBrowserRecording(recording, {
    procedureId,
    intentPhrases,
    recordingRef: options.recordingRef,
    status: options.status ?? 'active',
  });
  const catalogPath = assertSafeRepositoryPath(options.catalogPath ?? PERSONAL_CATALOG_PATH, {
    allowMissingLeaf: true,
  });
  let catalog: ProcedureCatalog = { schema_version: 'procedures.v1', procedures: [] };
  try {
    catalog = readProcedureCatalog(catalogPath);
  } catch (error) {
    if (safeExistsSync(catalogPath)) {
      throw new Error(
        `failed to read procedure catalog: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // A personal catalog is created on first promotion.
  }
  if (!Array.isArray(catalog.procedures)) catalog.procedures = [];
  if (catalog.procedures.some((entry) => entry.procedure_id === procedureId)) {
    throw new Error(`procedure_id "${procedureId}" already exists in the selected catalog`);
  }

  // The golden scenario travels with the procedure, in the catalog's tier,
  // so each run can be checked against it (golden-scenario-verdict.ts).
  const goldenPath = goldenScenarioPathForCatalog(
    catalogPath,
    procedureId,
    compiled.procedureEntry.version
  );
  compiled.procedureEntry.golden_scenario_ref = pathResolver.toRepoRelative(goldenPath);
  catalog.procedures.push(compiled.procedureEntry);
  validateProcedureCatalog(catalog, catalogPath);
  saveGoldenScenario(compiled.goldenScenario, goldenPath);
  safeMkdir(path.dirname(catalogPath), { recursive: true });
  safeWriteFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  invalidateProcedureCache();
  return { procedureEntry: compiled.procedureEntry, catalogPath };
}
