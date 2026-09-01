/**
 * Keep explanatory mission-gate documents aligned with the canonical policy.
 *
 * This deliberately checks a small, explicit document set. Improvement plans
 * may describe historical drift, while operator-facing guidance must not
 * reintroduce the retired Rule 7 / five-condition gate.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReadFile, safeReaddir } from '@agent/core/secure-io';
import * as path from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

// Do not traverse tenant/personal knowledge tiers: the checker is a public
// repository-governance lint and those paths are intentionally role-scoped.
export const MISSION_GATE_SCAN_ROOTS = ['docs', 'knowledge/product', 'knowledge/public'] as const;

/** Historical analysis, policy-source, and domain-specific documents may quote these terms. */
export const MISSION_GATE_DOCUMENT_EXCLUSIONS = new Set([
  'docs/developer/improvement-plans-2026-07/STATUS.ja.md',
  'docs/developer/improvement-plans-archive/2026-08/MISSION_GATE_COHERENCE_PLAN_2026-08-10.ja.md',
  'knowledge/product/architecture/mission-task-classification-roadmap-5.4-mini.md',
  'knowledge/product/architecture/agent-communication-layer-model.md',
  'knowledge/product/incidents/distill_msn-jgb-retrofit-20260422_2026_04_22.md',
  'knowledge/product/governance/working-philosophy.md',
  'knowledge/public/procedures/media/theme-and-design-system-reference.md',
]);

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

export function collectMissionGateDocumentPaths(): string[] {
  const documents: string[] = [];
  const visit = (relativePath: string): void => {
    if (
      MISSION_GATE_DOCUMENT_EXCLUSIONS.has(relativePath) ||
      [...MISSION_GATE_DOCUMENT_EXCLUSIONS].some((excluded) =>
        relativePath.startsWith(`${excluded}/`)
      )
    ) {
      return;
    }
    const absolutePath = pathResolver.rootResolve(relativePath);
    if (!safeExistsSync(absolutePath)) return;
    if (safeLstat(absolutePath).isDirectory()) {
      for (const entry of safeReaddir(absolutePath).sort()) {
        visit(path.join(relativePath, entry));
      }
      return;
    }
    if (relativePath.endsWith('.md')) documents.push(relativePath);
  };

  for (const root of MISSION_GATE_SCAN_ROOTS) visit(root);
  return documents.sort();
}

function loadMissionGateDocuments(): Record<string, string> {
  return Object.fromEntries(
    collectMissionGateDocumentPaths().map((relativePath) => [
      relativePath,
      String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || ''),
    ])
  );
}

export const runCheckMissionGateDocs = defineScript({
  name: 'check:mission-gate-docs',
  flags: [],
  run(context) {
    const violations = collectMissionGateDocViolations(loadMissionGateDocuments());
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...violations.map((violation) => `- ${violation}`)].join('\n')
      );
    }
    const documents = loadMissionGateDocuments();
    context.print(
      `[check:mission-gate-docs] OK — ${Object.keys(documents).length} documents checked`
    );
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_mission_gate_docs.ts') ||
  isDirectScript(import.meta.url, 'check_mission_gate_docs.js')
)
  void runCheckMissionGateDocs();
