import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';
import { loadProductionEvidenceRegister } from '../scripts/check_production_evidence.js';

const rootDir = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) || '');
}

function markdownTableRow(markdown: string, id: string): string {
  const row = markdown
    .split('\n')
    .find((line) => line.startsWith(`| ${id} |`));
  if (!row) throw new Error(`Missing production evidence markdown row for ${id}`);
  return row;
}

describe('production evidence register contract', () => {
  it('keeps non-local production proof tracked explicitly', () => {
    const register = read('docs/developer/PRODUCTION_EVIDENCE_REGISTER.ja.md');
    const runbook = read('docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md');
    const opsTemplate = read('docs/operator/templates/production-evidence-30day-ops.md');
    const contribTemplate = read('docs/operator/templates/production-evidence-external-contribution.md');
    const fdeTemplate = read('docs/operator/templates/production-evidence-fde-deployment.md');
    const templateIndex = read('docs/operator/templates/README.md');
    const canonical = loadProductionEvidenceRegister();
    expect(register).toContain('pending_external_evidence');
    expect(register).toContain('EV-30DAY-OPS');
    expect(register).toContain('30 日連続稼働');
    expect(register).toContain('EV-EXT-CONTRIB');
    expect(register).toContain('good-first-issue');
    expect(register).toContain('EV-FDE-DEPLOY');
    expect(register).toContain('fork なし');
    expect(register).toContain('production-ready');
    expect(register).toContain('knowledge/public/governance/production-evidence-register.json');
    expect(read('knowledge/public/schemas/production-evidence-register.schema.json')).toContain('pending_external_evidence');
    expect(register).toContain('../operator/PRODUCTION_EVIDENCE_COLLECTION.md');
    expect(runbook).toContain('EV-30DAY-OPS');
    expect(runbook).toContain('EV-EXT-CONTRIB');
    expect(runbook).toContain('EV-FDE-DEPLOY');
    expect(runbook).toContain('pnpm run check:production-evidence-complete');
    expect(runbook).toContain('templates/production-evidence-30day-ops.md');
    expect(runbook).toContain('templates/production-evidence-external-contribution.md');
    expect(runbook).toContain('templates/production-evidence-fde-deployment.md');
    expect(runbook).toContain('repo-local path that exists at review time');
    expect(opsTemplate).toContain('EV-30DAY-OPS');
    expect(opsTemplate).toContain('Success rate');
    expect(contribTemplate).toContain('EV-EXT-CONTRIB');
    expect(contribTemplate).toContain('Days from contributor start to merge');
    expect(fdeTemplate).toContain('EV-FDE-DEPLOY');
    expect(fdeTemplate).toContain('Deployment completed without fork');
    expect(templateIndex).toContain('EV-30DAY-OPS');
    expect(templateIndex).toContain('EV-EXT-CONTRIB');
    expect(templateIndex).toContain('EV-FDE-DEPLOY');
    expect(canonical.items.map((item) => item.id)).toEqual(['EV-30DAY-OPS', 'EV-EXT-CONTRIB', 'EV-FDE-DEPLOY']);
    expect(canonical.items.map((item) => item.template_ref)).toEqual([
      'docs/operator/templates/production-evidence-30day-ops.md',
      'docs/operator/templates/production-evidence-external-contribution.md',
      'docs/operator/templates/production-evidence-fde-deployment.md',
    ]);
    expect(canonical.items.flatMap((item) => item.acceptance_criteria)).toEqual(
      expect.arrayContaining([
        'operation_window_days >= 30',
        'primary_scenario_success_rate >= 95%',
        'merge completed within 7 days of contributor start',
        'deployment required no Kyberion fork',
      ])
    );
    expect(canonical.items.every((item) => item.ref_requirements.length > 0)).toBe(true);
    expect(canonical.items.every((item) => item.verification_artifact.includes('PRODUCTION_EVIDENCE_COLLECTION.md'))).toBe(true);
    for (const item of canonical.items) {
      const row = markdownTableRow(register, item.id);
      expect(row).toContain(item.gate);
      expect(row).toContain(item.required_evidence);
      expect(row).toContain(`\`${item.status}\``);
      expect(row).toContain(item.owner);
      expect(row).toContain(`\`${item.template_ref}\``);
    }
  });

  it('links the evidence register from the release gate audit and developer index', () => {
    const audit = read('docs/developer/PRODUCTION_RELEASE_GATE_AUDIT.ja.md');
    const index = read('docs/developer/README.md');
    const operatorIndex = read('docs/operator/README.md');
    expect(audit).toContain('PRODUCTION_EVIDENCE_REGISTER.ja.md');
    expect(audit).toContain('check:production-evidence-complete');
    expect(audit).toContain('../operator/PRODUCTION_EVIDENCE_COLLECTION.md');
    expect(index).toContain('PRODUCTION_EVIDENCE_REGISTER.ja.md');
    expect(operatorIndex).toContain('PRODUCTION_EVIDENCE_COLLECTION.md');
    expect(operatorIndex).toContain('templates/');
  });
});
