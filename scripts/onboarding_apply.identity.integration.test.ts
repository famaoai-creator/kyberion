import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { useOnboardingAuthorityFixture } from '../tests/helpers/onboarding-authority-fixture.js';
import { safeReadFile, safeWriteFile } from '@agent/core/secure-io';
const f = useOnboardingAuthorityFixture();
let onboarding: typeof import('./onboarding_apply.js');
let cli: typeof import('./onboarding_authority.js');
let runtime: typeof import('@agent/core/organization/onboarding-runtime-identity');
beforeAll(async () => {
  onboarding = await import('./onboarding_apply.js');
  cli = await import('./onboarding_authority.js');
  runtime = await import('@agent/core/organization/onboarding-runtime-identity');
}, 60000);
const input = (agent_id = 'Reviewed_CLI_Agent') => ({
  identity: {
    name: 'Synthetic operator',
    language: 'en',
    interaction_style: 'Senior Partner' as const,
    primary_domain: 'integration-testing',
    vision: 'Synthetic isolated onboarding',
    agent_id,
    persona: 'sovereign' as const,
  },
});
const profile = () =>
  JSON.parse(String(safeReadFile(path.join(f.root, 'knowledge/personal/agent-identity.json')))) as {
    agent_id: string;
    nhi_id: string;
  };
describe('CLI identity provisioning with actual NHI and signed authority stores', () => {
  it('registers the reviewed human name on a fresh owner bootstrap instead of retaining a placeholder', async () => {
    const { safeRmSync } = await import('@agent/core/secure-io');
    f.run(() => safeRmSync(path.join(f.root, 'knowledge/personal/members/owner.json')));
    await onboarding.applyIdentity(onboarding.parseApplyInput(input()), new Date().toISOString());
    expect(f.run(() => f.members.readMemberProfile('owner'))).toMatchObject({
      member_id: 'owner',
      display_name: 'Synthetic operator',
      status: 'active',
    });
    expect(f.identities.getAgentIdentity(f.run(profile).nhi_id)?.accountable_human_id).toBe(
      'user:owner'
    );
  });
  it('rejects an invalid installed handle before provisioning or overwriting profiles', async () => {
    const before = f.identities.listAgentIdentities();
    const installed = f.run(profile);
    expect(() => onboarding.parseApplyInput(input('Invalid CLI Agent'))).toThrow(
      'installed identity schema'
    );
    await expect(
      onboarding.applyIdentity(input('Invalid CLI Agent'), new Date().toISOString())
    ).rejects.toThrow('installed identity schema');
    expect(f.identities.listAgentIdentities()).toEqual(before);
    expect(f.run(profile)).toEqual(installed);
  });
  it('provisions and persists the exact reviewed identity without activating it, idempotently', async () => {
    const raw = onboarding.parseApplyInput(input());
    await onboarding.applyIdentity(raw, new Date().toISOString());
    const installed = f.run(profile);
    expect(installed.agent_id).toBe(raw.identity.agent_id);
    expect(f.identities.getAgentIdentity(installed.nhi_id)).toMatchObject({
      lifecycle_status: 'provisioned',
      accountable_human_id: 'user:owner',
    });
    await onboarding.applyIdentity(raw, new Date().toISOString());
    expect(f.run(profile).nhi_id).toBe(installed.nhi_id);
    expect(f.identities.getAgentIdentity(installed.nhi_id)?.lifecycle_status).toBe('provisioned');
  });
  it.each(['suspended', 'retired'] as const)(
    'does not reactivate or rewrite an existing %s identity',
    async (status) => {
      const raw = onboarding.parseApplyInput(input());
      await onboarding.applyIdentity(raw, new Date().toISOString());
      const before = f.run(() =>
        String(safeReadFile(path.join(f.root, 'knowledge/personal/agent-identity.json')))
      );
      const installed = JSON.parse(before).nhi_id as string;
      f.governIdentity(() =>
        status === 'suspended'
          ? f.identities.suspendAgentIdentity(installed, 'Synthetic stop')
          : f.identities.retireAgentIdentity(installed, 'Synthetic retirement')
      );
      await expect(onboarding.applyIdentity(raw, new Date().toISOString())).rejects.toThrow(
        'suspended, retired'
      );
      expect(f.identities.getAgentIdentity(installed)?.lifecycle_status).toBe(status);
      expect(
        f.run(() =>
          String(safeReadFile(path.join(f.root, 'knowledge/personal/agent-identity.json')))
        )
      ).toBe(before);
    }
  );
  it('does not alias distinct reviewed names that previously normalized to the same slug', async () => {
    expect(runtime.normalizeOnboardingAgentSlug('Foo_Bar')).not.toBe(
      runtime.normalizeOnboardingAgentSlug('foo-bar')
    );
    await onboarding.applyIdentity(
      onboarding.parseApplyInput(input('Foo_Bar')),
      new Date().toISOString()
    );
    const first = f.run(profile).nhi_id;
    await onboarding.applyIdentity(
      onboarding.parseApplyInput(input('foo-bar')),
      new Date().toISOString()
    );
    expect(f.run(profile).nhi_id).not.toBe(first);
    expect(f.identities.getAgentIdentity(first)?.lifecycle_status).toBe('provisioned');
  });
  it('runs actual CLI preview/request/status/apply, with activation only after a real human decision', async () => {
    await onboarding.applyIdentity(onboarding.parseApplyInput(input()), new Date().toISOString());
    const installed = f.run(profile).nhi_id;
    vi.stubEnv('KYBERION_AGENT_ID', installed);
    const file = path.join(f.root, 'active/shared/tmp/reviewed-authority.json');
    safeWriteFile(file, JSON.stringify(f.input()), { mkdir: true });
    const printed: unknown[] = [];
    await cli.main(['preview', '--file', file, '--json'], (value) => printed.push(value));
    const reviewed = printed.pop() as Record<string, unknown>;
    expect(reviewed.statement).toContain(installed);
    safeWriteFile(file, JSON.stringify(reviewed));
    await cli.main(['request', '--file', file, '--json'], (value) => printed.push(value));
    const request = printed.pop() as { request_id: string; status: string };
    expect(request.status).toBe('pending');
    expect(f.identities.getAgentIdentity(installed)?.lifecycle_status).toBe('provisioned');
    f.approve(request.request_id);
    await cli.main(['status', '--request-id', request.request_id, '--json'], (value) =>
      printed.push(value)
    );
    expect(printed.pop()).toMatchObject({ status: 'approved', can_apply: true });
    await cli.main(['apply', '--request-id', request.request_id, '--json'], (value) =>
      printed.push(value)
    );
    expect(printed.pop()).toMatchObject({ ok: true });
    expect(f.identities.getAgentIdentity(installed)?.lifecycle_status).toBe('active');
  });
});
