/**
 * Promote a reviewed BrowserExtensionRecording into the ProcedureCatalog
 * (Pattern A → B). Replaces the previous `node -e`-based pipeline steps, which
 * interpolated untrusted values directly into shell strings (RCE) and wrote the
 * catalog with raw `node:fs` (secure-io violation). See review findings CR-3.
 *
 * ALL inputs are treated as untrusted:
 *   - recording_ref must resolve inside the allowlisted recordings store.
 *   - the recording is schema-validated before compilation.
 *   - procedure_id is format-checked; intent_phrases is parsed as DATA (JSON),
 *     never evaluated.
 *   - File I/O goes exclusively through @agent/core/secure-io.
 *
 * Usage:
 *   node dist/scripts/promote_procedure.js \
 *     --recording active/shared/runtime/recordings/<file>.json \
 *     --procedure-id <id> \
 *     --intent-phrases '["勤怠の承認","approve attendance"]' \
 *     [--status active]
 */

import {
  auditChain,
  compileBrowserRecording,
  invalidateProcedureCache,
  resolveAllowlistedRecordingRef,
  safeReadFile,
  safeWriteFile,
  validateBrowserExtensionRecording,
  pathResolver,
} from '@agent/core';
import type { ProcedureCatalog, ProcedureEntry } from '@agent/core';

const CATALOG_PATH = 'knowledge/product/orchestration/procedures.json';
const PROCEDURE_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(message: string): never {
  process.stderr.write(`[promote-procedure] ${message}\n`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const recordingRef = args['recording'];
  const procedureId = args['procedure-id'];
  const intentPhrasesRaw = args['intent-phrases'];
  const status = (args['status'] as ProcedureEntry['status']) || 'active';
  // Mission attribution (CLAUDE.md §2: substantive/re-executable work is
  // mission-gated). Promotion is registration of a re-executable procedure, so
  // it should run within a mission. We don't hard-fail without one (to keep the
  // pipeline runnable in dev), but we warn and record what we got for audit.
  const missionId = args['mission-id'] || process.env.MISSION_ID || '';
  if (!missionId) {
    process.stderr.write(
      '[promote-procedure] WARNING: no --mission-id / MISSION_ID — promotion is not mission-attributed. ' +
        'Run within a mission for a governed audit trail.\n',
    );
  }

  if (!recordingRef) fail('--recording is required');
  if (!procedureId || !PROCEDURE_ID_RE.test(procedureId)) {
    fail(`--procedure-id is required and must match ${PROCEDURE_ID_RE}`);
  }
  if (status !== 'active' && status !== 'deprecated') {
    fail('--status must be "active" or "deprecated"');
  }

  // recording_ref allowlist guard — refuse anything outside the recordings store.
  const recordingAbs = resolveAllowlistedRecordingRef(recordingRef);
  if (!recordingAbs) {
    fail(`--recording "${recordingRef}" is not inside the allowlisted recordings store`);
  }

  let intentPhrases: string[];
  try {
    const parsed = intentPhrasesRaw ? JSON.parse(intentPhrasesRaw) : [];
    if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string') || parsed.length === 0) {
      throw new Error('must be a non-empty JSON array of strings');
    }
    intentPhrases = parsed;
  } catch (err) {
    return fail(`--intent-phrases ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load + schema-validate the recording (data, never code).
  let rawRecording: unknown;
  try {
    rawRecording = JSON.parse(safeReadFile(recordingAbs, { encoding: 'utf8' }) as string);
  } catch (err) {
    return fail(`failed to read recording: ${err instanceof Error ? err.message : String(err)}`);
  }
  const recording = validateBrowserExtensionRecording(rawRecording);
  if (!recording.value) fail(`recording failed validation: ${recording.errors.join('; ')}`);
  if (recording.value.review?.status !== 'approved') {
    fail('recording review must be "approved" before promotion');
  }

  const compiled = compileBrowserRecording(recording.value, {
    procedureId,
    intentPhrases,
    recordingRef,
    status,
  });

  // Load the catalog through secure-io, dedupe by id, append, write back.
  const catalogAbs = pathResolver.rootResolve(CATALOG_PATH);
  let catalog: ProcedureCatalog;
  try {
    catalog = JSON.parse(safeReadFile(catalogAbs, { encoding: 'utf8' }) as string) as ProcedureCatalog;
  } catch {
    catalog = { schema_version: 'procedures.v1', procedures: [] };
  }
  if (!Array.isArray(catalog.procedures)) catalog.procedures = [];
  if (catalog.procedures.some((p) => p.procedure_id === procedureId)) {
    fail(`procedure_id "${procedureId}" already exists in the catalog`);
  }
  catalog.procedures.push(compiled.procedureEntry);

  safeWriteFile(catalogAbs, `${JSON.stringify(catalog, null, 2)}\n`);
  invalidateProcedureCache();

  // Governed audit trail for the promotion.
  try {
    auditChain.record({
      agentId: 'promote-procedure',
      action: 'procedure_promote',
      operation: 'procedure:promote',
      result: 'allowed',
      reason: `Promoted procedure "${procedureId}" from recording`,
      metadata: { procedureId, recordingRef, missionId: missionId || null, riskClass: compiled.procedureEntry.risk_class },
    });
  } catch {
    // audit is best-effort; never block promotion on audit failure
  }

  process.stdout.write(
    `[promote-procedure] registered "${procedureId}" (risk=${compiled.procedureEntry.risk_class}, ` +
      `status=${status}, mission=${missionId || 'none'})\n`,
  );
}

main();
