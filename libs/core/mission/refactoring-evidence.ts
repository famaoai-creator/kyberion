/**
 * Structural proof for refactoring workflow gates.
 * Empty evidence files must not pass — audit JSON and pin/equivalence reports
 * need the fields / section markers the playbook requires.
 */
import * as path from 'node:path';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { findMissionPath } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeStat } from '../secure-io.js';

export const REFACTORING_EVIDENCE_STAGES = ['audit', 'pin', 'reshape', 'equivalence'] as const;
export type RefactoringEvidenceStage = (typeof REFACTORING_EVIDENCE_STAGES)[number];

const STAGE_FILES: Record<RefactoringEvidenceStage, string> = {
  audit: 'evidence/refactor-audit.json',
  pin: 'evidence/behavior-pin-report.md',
  reshape: 'evidence/refactor-report.md',
  equivalence: 'evidence/equivalence-report.md',
};

function readMissionEvidence(
  missionId: string,
  relative: string
): {
  abs: string;
  text: string;
} {
  const dir = findMissionPath(missionId);
  if (!dir) throw new Error(`[REFACTOR_EVIDENCE] Mission directory not found for ${missionId}`);
  const abs = path.join(dir, relative);
  if (!safeExistsSync(abs) || !safeStat(abs).isFile())
    throw new Error(`[REFACTOR_EVIDENCE] Missing ${relative}`);
  const text = String(safeReadFile(abs, { encoding: 'utf8' }));
  if (text.trim().length < 40)
    throw new Error(`[REFACTOR_EVIDENCE] ${relative} is empty or too short to be proof`);
  return { abs, text };
}

function assertAudit(text: string): void {
  const audit = parseSafeJsonObjectInput(text, 'refactor-audit');
  const smells = audit.smells;
  const budgets = audit.budgets;
  if (typeof audit.target !== 'string' || !audit.target.trim())
    throw new Error('[REFACTOR_EVIDENCE] audit.target required');
  if (!Array.isArray(smells) || smells.length < 1)
    throw new Error('[REFACTOR_EVIDENCE] audit.smells must be a non-empty array');
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets))
    throw new Error('[REFACTOR_EVIDENCE] audit.budgets required');
  const budget = budgets as Record<string, unknown>;
  for (const key of ['max_files', 'max_loc', 'max_runs'] as const) {
    if (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]))
      throw new Error(`[REFACTOR_EVIDENCE] audit.budgets.${key} must be a finite number`);
  }
  if (!Array.isArray(audit.exclusions))
    throw new Error('[REFACTOR_EVIDENCE] audit.exclusions must be an array (may be empty)');
  if (typeof audit.public_api_changes !== 'boolean')
    throw new Error('[REFACTOR_EVIDENCE] audit.public_api_changes must be boolean');
}

function assertMarkdownMarkers(text: string, markers: string[], label: string): void {
  const lower = text.toLowerCase();
  const missing = markers.filter((marker) => !lower.includes(marker.toLowerCase()));
  if (missing.length)
    throw new Error(`[REFACTOR_EVIDENCE] ${label} missing required markers: ${missing.join(', ')}`);
}

/** Validate one refactoring evidence stage for a mission; throws on failure. */
export function assertRefactoringEvidence(
  missionId: string,
  stage: RefactoringEvidenceStage
): { stage: RefactoringEvidenceStage; path: string; ok: true } {
  if (!(REFACTORING_EVIDENCE_STAGES as readonly string[]).includes(stage))
    throw new Error(`[REFACTOR_EVIDENCE] Unknown stage ${stage}`);
  const relative = STAGE_FILES[stage];
  const { abs, text } = readMissionEvidence(missionId, relative);
  switch (stage) {
    case 'audit':
      assertAudit(text);
      break;
    case 'pin':
      assertMarkdownMarkers(text, ['characterization', 'green', 'pin'], 'behavior-pin-report.md');
      break;
    case 'reshape':
      assertMarkdownMarkers(text, ['smell', 'atomic', 'green'], 'refactor-report.md');
      break;
    case 'equivalence':
      assertMarkdownMarkers(
        text,
        ['characterization', 'test-diff', 'equivalence'],
        'equivalence-report.md'
      );
      break;
  }
  return { stage, path: abs, ok: true };
}
