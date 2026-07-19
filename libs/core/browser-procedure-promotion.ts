import path from 'node:path';
import { compileBrowserRecording } from './browser-recording-compiler.js';
import { invalidateProcedureCache, resolveAllowlistedRecordingRef } from './procedure-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { validateBrowserExtensionRecording } from './browser-extension-bridge.js';
import type { ProcedureCatalog, ProcedureEntry } from './procedure-types.js';

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
  let raw: unknown;
  try {
    raw = JSON.parse(safeReadFile(recordingAbs, { encoding: 'utf8' }) as string);
  } catch (error) {
    throw new Error(
      `failed to read recording: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const recording = validateBrowserExtensionRecording(raw);
  if (!recording.value)
    throw new Error(`recording failed validation: ${recording.errors.join('; ')}`);
  if (recording.value.review?.status !== 'approved') {
    throw new Error('recording review must be approved before promotion');
  }

  const compiled = compileBrowserRecording(recording.value, {
    procedureId,
    intentPhrases,
    recordingRef: options.recordingRef,
    status: options.status ?? 'active',
  });
  const catalogPath = options.catalogPath ?? PERSONAL_CATALOG_PATH;
  let catalog: ProcedureCatalog = { schema_version: 'procedures.v1', procedures: [] };
  try {
    catalog = JSON.parse(
      safeReadFile(catalogPath, { encoding: 'utf8' }) as string
    ) as ProcedureCatalog;
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

  catalog.procedures.push(compiled.procedureEntry);
  safeMkdir(path.dirname(catalogPath), { recursive: true });
  safeWriteFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  invalidateProcedureCache();
  return { procedureEntry: compiled.procedureEntry, catalogPath };
}
