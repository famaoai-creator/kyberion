import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';
import {
  generateOnboardingRunbookSkill,
  onboardingRunbookSkillPath,
} from './onboarding_runbook_skill.js';

const root = path.resolve('active/shared/tmp/tests/onboarding-runbook-skill');

afterEach(() => safeRmSync(root, { force: true, recursive: true }));

describe('onboarding runbook skill (QM-08)', () => {
  it('generates an executable runbook with provenance and no secret values', () => {
    const result = generateOnboardingRunbookSkill({
      profileRoot: root,
      identityName: 'Operator',
      agentId: 'AGENT-1',
      generatedAt: '2026-08-08T00:00:00.000Z',
    });
    expect(result.skillPath).toBe(onboardingRunbookSkillPath(root));
    expect(safeExistsSync(result.skillPath)).toBe(true);
    const skill = String(safeReadFile(result.skillPath, { encoding: 'utf8' }));
    expect(skill).toContain('pnpm vital --format=json');
    expect(skill).toContain('Human approval remains required');
    expect(skill).not.toMatch(/(?:api[_-]?key|token|password)\s*[:=]\s*\S+/iu);
    expect(
      JSON.parse(String(safeReadFile(result.provenancePath, { encoding: 'utf8' })))
    ).toMatchObject({
      generated_by: 'onboarding-wizard',
      secret_values: false,
    });
  });
});
