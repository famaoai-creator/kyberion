import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  collectMissionGateDocViolations,
  collectMissionGateDocumentPaths,
  MISSION_GATE_DOCUMENT_EXCLUSIONS,
} from './check_mission_gate_docs.js';

describe('check_mission_gate_docs', () => {
  it('uses the foundation text reader for mission-gate documents', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_mission_gate_docs.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('accepts current operator-facing guidance', () => {
    expect(
      collectMissionGateDocViolations({
        'example.md': 'Use work-scope-policy.json for mandatory and accumulation triggers.',
      })
    ).toEqual([]);
  });

  it('detects retired Rule 7 and five-condition wording', () => {
    expect(
      collectMissionGateDocViolations({
        'fixture.md':
          'Per AGENTS.md Rule 7, mission when any 2 of the following hold: 5+ artifacts.',
      })
    ).toEqual(['fixture.md:1: retired mission-gate wording; use work-scope-policy.json']);
  });

  it('scans current docs and excludes historical policy evidence', () => {
    const paths = collectMissionGateDocumentPaths();
    expect(paths).toContain('docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md');
    expect(paths).toContain(
      'docs/developer/improvement-plans-archive/2026-08/CLOUDFLARE_OS_ADOPTION_PLAN_2026-08-09.ja.md'
    );
    expect(paths).not.toContain(
      'docs/developer/improvement-plans-archive/2026-08/MISSION_GATE_COHERENCE_PLAN_2026-08-10.ja.md'
    );
    expect(
      MISSION_GATE_DOCUMENT_EXCLUSIONS.has(
        'knowledge/product/incidents/distill_msn-jgb-retrofit-20260422_2026_04_22.md'
      )
    ).toBe(true);
  });
});
