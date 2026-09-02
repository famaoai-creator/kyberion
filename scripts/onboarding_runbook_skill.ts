import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { nowIso } from '@agent/core/foundation';

export interface OnboardingRunbookSkillResult {
  skillPath: string;
  provenancePath: string;
}

export function onboardingRunbookSkillPath(
  profileRoot = pathResolver.rootResolve('active/personal')
): string {
  return path.join(profileRoot, 'onboarding', 'skills', 'kyberion-onboarding-runbook', 'SKILL.md');
}

export function generateOnboardingRunbookSkill(
  input: {
    profileRoot?: string;
    identityName?: string;
    agentId?: string;
    generatedAt?: string;
  } = {}
): OnboardingRunbookSkillResult {
  const skillPath = onboardingRunbookSkillPath(input.profileRoot);
  const skillDir = path.dirname(skillPath);
  const provenancePath = path.join(skillDir, 'provenance.json');
  const generatedAt = input.generatedAt || nowIso();
  const identityName = input.identityName?.trim() || 'the operator';
  const agentId = input.agentId?.trim() || 'KYBERION-PRIME';
  const skill = [
    '---',
    'name: kyberion-onboarding-runbook',
    'description: Execute the safe post-onboarding readiness and first-mission handoff.',
    'status: generated',
    'category: Operations',
    'tags:',
    '  - onboarding',
    '  - runbook',
    '  - readiness',
    '---',
    '',
    '# Kyberion Onboarding Runbook',
    '',
    `This runbook was generated for ${identityName} (${agentId}).`,
    '',
    '## Execute',
    '',
    '1. Run `pnpm pipeline vital-check --format=json` and resolve any `needs_onboarding` or `needs_attention` result.',
    '2. Run `pnpm pipeline --input pipelines/baseline-check.json` and keep the result as the session health receipt.',
    '3. Review connection drafts under the active profile before enabling any external service.',
    '4. Create a governed mission for the first real task; do not turn the tutorial into work implicitly.',
    '5. Run `/ky-review` or the governed review phase after changing code, knowledge, or audit state.',
    '',
    '## Safety Boundaries',
    '',
    '- Keep credentials in the governed connection store; never copy secret values into this skill or a prompt.',
    '- Human approval remains required for contracts, payments, external publication, and authority changes.',
    '- Use `pnpm customer:switch <slug>` before operating on a customer overlay.',
    '- Treat this file as a generated runbook skill: update onboarding inputs and regenerate instead of editing identity facts here.',
    '',
    `Generated at: ${generatedAt}`,
    '',
  ].join('\n');
  const provenance = {
    version: 1,
    generated_by: 'onboarding-wizard',
    managed_by: 'onboarding',
    owner: 'sovereign_concierge',
    skill_ref: skillPath,
    generated_at: generatedAt,
    secret_values: false,
  };
  withExecutionContext('sovereign_concierge', () => {
    if (!safeExistsSync(skillDir)) safeMkdir(skillDir, { recursive: true });
    safeWriteFile(skillPath, skill);
    safeWriteFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  });
  return { skillPath, provenancePath };
}
