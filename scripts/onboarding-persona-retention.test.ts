import { expect, it } from 'vitest';
import { useOnboardingAuthorityFixture } from '../tests/helpers/onboarding-authority-fixture.js';
const f = useOnboardingAuthorityFixture();

it('CLI re-onboarding preserves the existing persona mapping without rewriting its NHI', async () => {
  const state = await import('@agent/core/personal-identity-state');
  const { applyIdentity } = await import('./onboarding_apply.js');
  const file = `${f.root}/knowledge/personal/agent-identity.json`;
  const previous = f.run(() => state.readPersonalAgentIdentityStrictAtPath(file))!;
  const bindings = {
    version: 1,
    persona_id: previous.agent_id,
    accountable_human_id: 'user:owner',
    personal_nhi_id: previous.nhi_id,
    tenant_bindings: [],
  };
  f.run(() =>
    state.writePersonalAgentIdentityAtPath(file, {
      ...previous,
      persona_identity_bindings: bindings,
    })
  );
  await applyIdentity(
    {
      identity: {
        name: 'Synthetic Owner',
        language: 'en',
        interaction_style: 'Senior Partner',
        primary_domain: 'testing',
        vision: 'Synthetic fixture only',
        agent_id: String(previous.agent_id),
      },
    },
    new Date().toISOString()
  );
  expect(f.run(() => state.readPersonalAgentIdentityStrictAtPath(file))).toMatchObject({
    nhi_id: previous.nhi_id,
    persona_identity_bindings: bindings,
  });
});
