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

import { auditChain } from '@agent/core/audit-chain';
import { compileBrowserRecording } from '@agent/core/browser-recording-compiler';
import {
  invalidateProcedureCache,
  readProcedureCatalog,
  resolveAllowlistedRecordingRef,
  validateProcedureCatalog,
} from '@agent/core/procedure-registry';
import { loadBrowserExtensionRecordingAtPath } from '@agent/core/browser-extension-bridge';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
} from '@agent/core/secure-io';
import { getRegisteredEnvText, parseSafeJsonInput } from '@agent/core/foundation';
import type { ProcedureEntry } from '@agent/core/procedure-types';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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
  throw new ScriptExitError(1, '', true);
}

function printUsage(): void {
  process.stderr.write(
    '[promote-procedure] Usage: node dist/scripts/promote_procedure.js --recording <path> --procedure-id <id> --intent-phrases <json> [--status active|deprecated] [--mission-id <id>]\n'
  );
}

export function main(argv: string[] = []): void {
  const args = parseArgs(argv);
  if (args.help === 'true') {
    printUsage();
    return;
  }

  const recordingRef = args['recording'];
  const procedureId = args['procedure-id'];
  const intentPhrasesRaw = args['intent-phrases'];
  const status = (args['status'] as ProcedureEntry['status']) || 'active';
  // Mission attribution (CLAUDE.md §2: substantive/re-executable work is
  // mission-gated). Promotion is registration of a re-executable procedure, so
  // it should run within a mission. We don't hard-fail without one (to keep the
  // pipeline runnable in dev), but we warn and record what we got for audit.
  const missionId = args['mission-id'] || getRegisteredEnvText('MISSION_ID') || '';
  if (!missionId) {
    process.stderr.write(
      '[promote-procedure] WARNING: no --mission-id / MISSION_ID — promotion is not mission-attributed. ' +
        'Run within a mission for a governed audit trail.\n'
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
  if (!safeExistsSync(recordingAbs) || !safeLstat(recordingAbs).isFile()) {
    fail(`--recording "${recordingRef}" must be an existing regular file`);
  }

  let intentPhrases: string[];
  try {
    const parsed = parseSafeJsonInput(intentPhrasesRaw || '[]', '--intent-phrases');
    if (
      !Array.isArray(parsed) ||
      parsed.some((p) => typeof p !== 'string') ||
      parsed.length === 0
    ) {
      throw new Error('must be a non-empty JSON array of strings');
    }
    intentPhrases = parsed;
  } catch (err) {
    return fail(`--intent-phrases ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load + schema-validate the recording (data, never code).
  let recording: ReturnType<typeof loadBrowserExtensionRecordingAtPath>;
  try {
    recording = loadBrowserExtensionRecordingAtPath(recordingAbs);
  } catch (err) {
    return fail(`failed to read recording: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (recording.review?.status !== 'approved') {
    fail('recording review must be "approved" before promotion');
  }

  const compiled = compileBrowserRecording(recording, {
    procedureId,
    intentPhrases,
    recordingRef,
    status,
  });

  // Load the catalog through secure-io, dedupe by id, append, write back.
  const catalogAbs = assertSafeRepositoryPath(pathResolver.rootResolve(CATALOG_PATH), {
    allowMissingLeaf: true,
  });
  if (safeExistsSync(catalogAbs) && !safeLstat(catalogAbs).isFile()) {
    fail(`procedure catalog must be a regular file: ${catalogAbs}`);
  }
  let catalog = { schema_version: 'procedures.v1' as const, procedures: [] as ProcedureEntry[] };
  try {
    catalog = readProcedureCatalog(catalogAbs);
  } catch {
    // Preserve the promotion command's bootstrap behavior when the optional
    // public catalog has not been provisioned yet or is unreadable.
  }
  if (catalog.procedures.some((p) => p.procedure_id === procedureId)) {
    fail(`procedure_id "${procedureId}" already exists in the catalog`);
  }
  catalog.procedures.push(compiled.procedureEntry);

  const validatedCatalog = validateProcedureCatalog(catalog, catalogAbs);
  safeWriteFile(catalogAbs, `${JSON.stringify(validatedCatalog, null, 2)}\n`);
  invalidateProcedureCache();

  // Governed audit trail for the promotion.
  try {
    auditChain.record({
      agentId: 'promote-procedure',
      action: 'procedure_promote',
      operation: 'procedure:promote',
      result: 'allowed',
      reason: `Promoted procedure "${procedureId}" from recording`,
      metadata: {
        procedureId,
        recordingRef,
        missionId: missionId || null,
        riskClass: compiled.procedureEntry.risk_class,
      },
    });
  } catch {
    // audit is best-effort; never block promotion on audit failure
  }

  process.stdout.write(
    `[promote-procedure] registered "${procedureId}" (risk=${compiled.procedureEntry.risk_class}, ` +
      `status=${status}, mission=${missionId || 'none'})\n`
  );
}

export const runPromoteProcedure = defineScript({
  name: 'procedure:promote',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'promote_procedure.ts') ||
  isDirectScript(import.meta.url, 'promote_procedure.js')
)
  void runPromoteProcedure();
