import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { inspectPersonalIdentityRegistration } from '@agent/core/organization/onboarding-runtime-identity';
import { resolveInstallationGovernanceRoot } from '@agent/core/vcs/governance-host';
import { isVitestProcess } from '@agent/core/foundation/env';
import { withExecutionContext } from '@agent/core/authority';
import { assertAgentIdentityJournalIntegrity } from '@agent/core/agent/agent-identity';
import { applyIdentity, prepareActivationSetup, readInput } from './onboarding_apply.js';
import { defineScript, isDirectScript } from '../lib/harness.js';

const usage = 'pnpm onboarding check [--json] [--repair --identity <reviewed-file>]';

export async function main(args: string[], print: (value: unknown) => void): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      repair: { type: 'boolean' },
      identity: { type: 'string' },
    },
  });
  if (values.help) {
    print(usage);
    return;
  }
  if (Boolean(values.repair) !== Boolean(values.identity)) throw new Error(usage);
  const root = pathResolver.rootDir();
  if (
    !isVitestProcess() &&
    path.resolve(resolveInstallationGovernanceRoot(root)) !== path.resolve(root)
  ) {
    throw new Error('Run this check from the installed checkout.');
  }
  if (resolveActiveProfileRoot() !== pathResolver.knowledge('personal')) {
    throw new Error(
      'Run this check from the personal stance. Tenant NHI repair uses its scoped onboarding flow.'
    );
  }

  const before = inspectPersonalIdentityRegistration();
  const repairable =
    (before.owner === 'missing' || before.nhi === 'missing' || before.profile === 'missing') &&
    before.owner !== 'suspended' &&
    !['conflict', 'suspended', 'retired'].includes(before.nhi) &&
    (before.profile === 'missing' || before.nhi !== 'unresolved');
  if (values.repair && repairable) {
    const input = await readInput(values.identity);
    if (JSON.stringify(inspectPersonalIdentityRegistration()) !== JSON.stringify(before)) {
      throw new Error('Identity registration changed; run onboarding check again.');
    }
    if (before.profileHandle && before.profileHandle !== input.identity.agent_id) {
      throw new Error('The reviewed agent handle differs from the installed handle.');
    }
    const now = new Date();
    withExecutionContext('sovereign_concierge', assertAgentIdentityJournalIntegrity);
    await applyIdentity(
      input,
      now.toISOString(),
      before.nhi === 'missing' && before.explicitNhiBinding ? before.agentId : undefined
    );
    await prepareActivationSetup(now);
  }
  const after = values.repair && repairable ? inspectPersonalIdentityRegistration() : before;
  const registered = after.owner === 'active' && ['active', 'provisioned'].includes(after.nhi);
  const next =
    after.nhi === 'provisioned' && registered
      ? 'pnpm onboarding authority show --scope person --json'
      : registered
        ? undefined
        : repairable
          ? 'pnpm onboarding check --repair --identity <reviewed-file>'
          : 'Inspect the existing member and NHI binding in the installed checkout.';
  const result = {
    status: registered
      ? values.repair && repairable
        ? 'repaired'
        : 'registered'
      : repairable
        ? 'repair_needed'
        : 'blocked',
    registration: { owner: after.owner, profile: after.profile, nhi: after.nhi },
    ...(next ? { next } : {}),
  };
  print(
    values.json
      ? JSON.stringify(result, null, 2)
      : [
          `Onboarding identity: ${result.status}`,
          `Owner: ${after.owner} · Profile: ${after.profile} · NHI: ${after.nhi}`,
          next,
        ]
          .filter(Boolean)
          .join('\n')
  );
}

const script = defineScript({
  name: 'onboarding-identity-check',
  flags: ['json'],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'onboarding_identity_check.ts') ||
  isDirectScript(import.meta.url, 'onboarding_identity_check.js')
)
  void script();
