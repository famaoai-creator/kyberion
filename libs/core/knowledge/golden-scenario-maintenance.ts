/**
 * Keeping procedures checkable: backfill golden scenarios for procedures
 * promoted before they were stored, and report each procedure's check state
 * for the knowledge_steward.
 *
 * Backfill recompiles the procedure's own reviewed recording only to take the
 * success conditions; the catalog entry and its pipeline are left as they
 * are apart from the new `golden_scenario_ref`.
 *
 * The status report reads the knowledge-verification ledger for each
 * procedure's recording (or pipeline) and says what needs a person: no golden
 * scenario, one that can never pass, a failed check, or a change no run has
 * confirmed yet. It is printed for the operator, not written to the public
 * curation report, because most procedures live in personal catalogs.
 */

import { compileBrowserRecording } from '../browser/browser-recording-compiler.js';
import { loadBrowserExtensionRecordingAtPath } from '../browser/browser-extension-bridge.js';
import { compileServiceRecording } from '../service/service-recording-compiler.js';
import { loadServiceRecordingAtPath } from '../service/service-recording.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeWriteFile } from '../secure-io.js';
import type { ScopeContext } from '../scope-context.js';
import {
  goldenConditionStrength,
  goldenScenarioPathForCatalog,
  loadGoldenScenario,
  procedureVerificationDocument,
  saveGoldenScenario,
} from './golden-scenario-verdict.js';
import { resolveKnowledgeVerification } from './knowledge-verification.js';
import {
  loadProcedures,
  readProcedureCatalog,
  resolveAllowlistedRecordingRef,
  validateProcedureCatalog,
} from './procedure-registry.js';
import type { GoldenScenario, ProcedureEntry } from './procedure-types.js';

/** True when no run can ever pass this scenario (it has no strong condition). */
export function goldenScenarioIsWeakOnly(scenario: GoldenScenario): boolean {
  return !scenario.success_conditions.some(
    (condition) => goldenConditionStrength(condition) === 'strong'
  );
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface GoldenBackfillResult {
  procedure_id: string;
  action: 'created' | 'would_create' | 'skipped';
  reason?: string;
  golden_scenario_ref?: string;
  weak_only?: boolean;
}

function compileGoldenFor(entry: ProcedureEntry): GoldenScenario {
  const recordingAbs = resolveAllowlistedRecordingRef(entry.adapter.recording_ref);
  if (!recordingAbs) throw new Error('no allowlisted recording_ref');
  const options = {
    procedureId: entry.procedure_id,
    intentPhrases: entry.intent_phrases,
    recordingRef: entry.adapter.recording_ref,
  };
  const compiled =
    entry.substrate === 'browser'
      ? compileBrowserRecording(loadBrowserExtensionRecordingAtPath(recordingAbs), options)
      : compileServiceRecording(loadServiceRecordingAtPath(recordingAbs), options);
  return {
    ...compiled.goldenScenario,
    procedure_id: entry.procedure_id,
    version: entry.version,
  };
}

/**
 * Create the missing golden scenarios in one catalog. With `dryRun`, reports
 * what would be created and writes nothing.
 */
export function backfillGoldenScenarios(input: {
  catalogPath: string;
  dryRun?: boolean;
}): GoldenBackfillResult[] {
  if (!safeExistsSync(input.catalogPath)) return [];
  const catalog = readProcedureCatalog(input.catalogPath);
  const entries = Array.isArray(catalog.procedures) ? catalog.procedures : [];
  const results: GoldenBackfillResult[] = [];
  const pending: Array<{ scenario: GoldenScenario; path: string }> = [];
  for (const entry of entries) {
    if (entry.golden_scenario_ref && loadGoldenScenario(entry)) continue;
    if (entry.substrate !== 'browser' && entry.substrate !== 'service') {
      results.push({
        procedure_id: entry.procedure_id,
        action: 'skipped',
        reason: `no golden compiler for the ${entry.substrate} substrate`,
      });
      continue;
    }
    let scenario: GoldenScenario;
    try {
      scenario = compileGoldenFor(entry);
    } catch (error) {
      results.push({
        procedure_id: entry.procedure_id,
        action: 'skipped',
        reason: `recording could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const goldenPath = goldenScenarioPathForCatalog(
      input.catalogPath,
      entry.procedure_id,
      entry.version
    );
    const ref = pathResolver.toRepoRelative(goldenPath);
    entry.golden_scenario_ref = ref;
    pending.push({ scenario, path: goldenPath });
    results.push({
      procedure_id: entry.procedure_id,
      action: input.dryRun ? 'would_create' : 'created',
      golden_scenario_ref: ref,
      weak_only: goldenScenarioIsWeakOnly(scenario),
    });
  }
  if (input.dryRun || pending.length === 0) return results;
  validateProcedureCatalog(catalog, input.catalogPath);
  for (const item of pending) saveGoldenScenario(item.scenario, item.path);
  safeWriteFile(input.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return results;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type ProcedureCheckAttention =
  | 'no_golden_scenario'
  | 'weak_only'
  | 'failed_check'
  | 'reported_problem'
  | 'changed_since_verified'
  | 'never_passed';

export interface ProcedureCheckStatus {
  procedure_id: string;
  substrate: string;
  status: ProcedureEntry['status'];
  golden: 'present' | 'missing' | 'weak_only';
  /** Ledger state of the procedure's recording/pipeline text. */
  verification:
    | 'passed_check'
    | 'verified'
    | 'changed_since_verified'
    | 'failed_check'
    | 'reported_problem'
    | 'none';
  last_success_at?: string;
  last_problem_at?: string;
  /** What a person should do about it; empty when nothing. */
  attention: ProcedureCheckAttention[];
}

/** Per-procedure check state, most urgent first. */
export function procedureCheckStatus(
  options: { procedures?: ProcedureEntry[]; scope?: ScopeContext } = {}
): ProcedureCheckStatus[] {
  const procedures = options.procedures ?? loadProcedures(true);
  const documents = procedures
    .map(procedureVerificationDocument)
    .filter((doc): doc is string => Boolean(doc));
  const ledger = resolveKnowledgeVerification(documents, options.scope);
  const rows = procedures.map((procedure): ProcedureCheckStatus => {
    const scenario = loadGoldenScenario(procedure);
    const golden = !scenario
      ? 'missing'
      : goldenScenarioIsWeakOnly(scenario)
        ? 'weak_only'
        : 'present';
    const document = procedureVerificationDocument(procedure);
    const entry = document ? ledger.get(document) : undefined;
    const verification: ProcedureCheckStatus['verification'] = !entry
      ? 'none'
      : entry.state === 'reported_problem'
        ? entry.last_problem_kind === 'failed_check'
          ? 'failed_check'
          : 'reported_problem'
        : entry.state === 'verified'
          ? entry.evidence === 'golden'
            ? 'passed_check'
            : 'verified'
          : 'changed_since_verified';
    const attention: ProcedureCheckAttention[] = [];
    if (golden === 'missing') attention.push('no_golden_scenario');
    if (golden === 'weak_only') attention.push('weak_only');
    if (verification === 'failed_check') attention.push('failed_check');
    if (verification === 'reported_problem') attention.push('reported_problem');
    if (verification === 'changed_since_verified') attention.push('changed_since_verified');
    if (verification === 'none' && golden === 'present') attention.push('never_passed');
    return {
      procedure_id: procedure.procedure_id,
      substrate: procedure.substrate,
      status: procedure.status,
      golden,
      verification,
      ...(entry?.last_success_at ? { last_success_at: entry.last_success_at } : {}),
      ...(entry?.last_problem_at ? { last_problem_at: entry.last_problem_at } : {}),
      attention,
    };
  });
  const urgency = (row: ProcedureCheckStatus) =>
    row.verification === 'failed_check' || row.verification === 'reported_problem'
      ? 0
      : row.attention.length > 0
        ? 1
        : 2;
  return rows.sort(
    (a, b) => urgency(a) - urgency(b) || a.procedure_id.localeCompare(b.procedure_id)
  );
}
