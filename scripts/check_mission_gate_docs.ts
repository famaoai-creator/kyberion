/**
 * Keep explanatory mission-gate documents aligned with the canonical policy.
 *
 * This deliberately checks a small, explicit document set. Improvement plans
 * may describe historical drift, while operator-facing guidance must not
 * reintroduce the retired Rule 7 / five-condition gate.
 */
import { pathResolver, safeReadFile } from '@agent/core';

export const MISSION_GATE_DOCUMENTS = [
  'AGENTS.md',
  'knowledge/product/governance/phases/alignment.md',
  'knowledge/product/architecture/kyberion-intent-catalog.md',
  'knowledge/public/procedures/system/developer-onboarding.md',
  'docs/developer/PRODUCTION_GOAL_INSTRUCTIONS.ja.md',
  'docs/PRODUCTIZATION_ROADMAP.md',
  'knowledge/product/governance/multi-agent-development-sop.md',
  'knowledge/product/orchestration/adf-pipeline-validation-plan.md',
  'docs/OPERATOR_UX_GUIDE.md',
] as const;

const RETIRED_GATE_MARKERS = [
  /\bRule\s*7\b/i,
  /5\+\s*artifacts/i,
  /5\+\s*成果物/i,
  /5-condition/i,
  /5条件/i,
  /same pattern(?: will)? recur.*5/i,
  /multiple legitimate viewpoints/i,
  /any\s+2\s+of the following/i,
];

export function collectMissionGateDocViolations(documents: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const [relativePath, source] of Object.entries(documents)) {
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!RETIRED_GATE_MARKERS.some((marker) => marker.test(line))) return;
      violations.push(
        `${relativePath}:${index + 1}: retired mission-gate wording; use work-scope-policy.json`
      );
    });
  }
  return violations;
}

function loadMissionGateDocuments(): Record<string, string> {
  return Object.fromEntries(
    MISSION_GATE_DOCUMENTS.map((relativePath) => [
      relativePath,
      String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || ''),
    ])
  );
}

export function main(): void {
  const violations = collectMissionGateDocViolations(loadMissionGateDocuments());
  if (violations.length > 0) {
    for (const violation of violations) console.error(`[check:mission-gate-docs] ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[check:mission-gate-docs] OK — ${MISSION_GATE_DOCUMENTS.length} canonical documents checked`
  );
}

if (process.argv[1]?.endsWith('check_mission_gate_docs.ts')) main();
