/** Bind a verified continuous owner handoff to its canonical mission, without changing process env. */
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { assertMissionOwnerPath } from '../mission/mission-git.js';
import { loadState } from '../mission/mission-state.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  narrowScopeEnvelope,
  withScopeEnvelope,
} from '../scope-envelope.js';
import type { ContinuousWorkOwnerScope } from './continuous-work-owner-state.js';

export function withContinuousMissionScope<T>(
  input: {
    mission_id: string;
    scope: ContinuousWorkOwnerScope;
    assertCurrent: () => void;
  },
  run: () => T
): T {
  assertMissionOwnerPath('bind a continuous mission execution scope');
  input.assertCurrent();
  const caller = currentExecutionScope();
  if (
    !caller ||
    caller.organizationId !== input.scope.organization_id ||
    (caller.tenantSlug ?? '') !== (input.scope.tenant_slug ?? '')
  )
    throw new Error('Continuous mission handoff differs from its verified owner scope');
  const state = loadState(input.mission_id);
  if (
    !state ||
    state.mission_id !== input.mission_id.toUpperCase() ||
    state.tier !== input.scope.tier ||
    state.organization_id !== input.scope.organization_id ||
    (state.tenant_slug ?? '') !== (input.scope.tenant_slug ?? '')
  )
    throw new Error('Continuous mission handoff differs from the canonical mission');
  const identity = {
    mission_id: state.mission_id,
    tier: state.tier,
    organization_id: state.organization_id,
    ...(state.tenant_slug ? { tenant_slug: state.tenant_slug } : {}),
  };
  const parent = currentScopeEnvelope();
  if (parent && parent.identity.tier !== state.tier)
    throw new Error('Continuous mission cannot change an existing envelope tier');
  const envelope = parent
    ? narrowScopeEnvelope(parent, { identity })
    : mintScopeEnvelope({
        identity,
        policy: { purpose: 'continuous mission owner' },
        // This owner-only composition boundary already validated the handoff.
        // A copy removes stale supervisor mission hints; the process is untouched.
        env: {
          ...process.env,
          MISSION_ID: state.mission_id,
          KYBERION_TIER: state.tier,
          KYBERION_ORGANIZATION_ID: state.organization_id,
          KYBERION_TENANT: state.tenant_slug ?? '',
          KYBERION_PROJECT_ID: '',
          KYBERION_TASK_ID: '',
        },
      });
  return withScopeEnvelope(envelope, () => {
    input.assertCurrent();
    return run();
  });
}
